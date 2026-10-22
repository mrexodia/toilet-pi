/**
 * A read-only view of an agent's durable store, for the visualizer: it runs beside the agent that writes it, takes no
 * lock and never writes.
 *
 * It reads pi-durable's SQLite tables directly (no Harness: opening one would load the home's extensions and models).
 * The memory's history comes from the chat document's revisions: pi-durable stores every commit to it as a delta, so
 * replaying them gives the exact chat state after each commit: when messages were indexed, when each node was built,
 * how the views changed and which view each turn froze. Commits that only start or fail a compaction are folded away.
 */

import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { apply, type Op } from "@earendil-works/chord/delta";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { type ChatState, initialChat, type Kind, type MessageState, type NodeState } from "../optchat/docs.ts";
import { blockOf, pageText } from "../optchat/memory.ts";
import { clipPages, type Part } from "../optchat/tree.ts";

/** `parts.splice(at, del, ...ins)`: how a view changed in one commit. */
export type Splice = [at: number, del: number, ins: Part[]];

export type Build = {
	key: string;
	/** Bytes of the node's text. */
	size: number;
	/** The commit that started its compaction; absent when the node needed no call. */
	from?: number;
	/** How long the compaction took, in milliseconds. */
	ms?: number;
};

/** One commit to the memory, as the visualizer plays it. */
export type Frame = {
	seq: number;
	/** Unix milliseconds: the commit's time where the store records it, else the last time known before it. */
	t: number;
	/** Messages indexed: ids `from` on, one kind each. */
	msgs?: { from: number; kinds: Kind[] };
	built?: Build[];
	view?: Splice;
	seen?: Splice;
	/** A turn froze the view; `parts` only when it is not the view of this same frame. */
	turn?: { first: number; state: string; parts?: Part[] };
	/** Compactions that failed in a row, with nothing else in between. */
	fail?: { keys: string[]; n: number; task: number; until: number; error?: string };
};

export type Pending = { key: string; from: number; task: number };

type Revision = { seq: number; kind: string; content: string };

function diff(before: readonly Part[], after: readonly Part[]): Splice | undefined {
	const same = (a: Part, b: Part) => a[0] === b[0] && a[1] === b[1];
	let head = 0;
	while (head < before.length && head < after.length && same(before[head]!, after[head]!)) head++;
	let tail = 0;
	while (tail < before.length - head && tail < after.length - head && same(before[before.length - 1 - tail]!, after[after.length - 1 - tail]!)) tail++;
	const del = before.length - head - tail;
	const ins = after.slice(head, after.length - tail).map((p) => [p[0], p[1]] as Part);
	return del === 0 && ins.length === 0 ? undefined : [head, del, ins];
}

function copyParts(parts: readonly Part[] | undefined): Part[] {
	return (parts ?? []).map((p) => [p[0], p[1]] as Part);
}

function sameParts(a: readonly Part[], b: readonly Part[]): boolean {
	return a.length === b.length && a.every((p, k) => p[0] === b[k]![0] && p[1] === b[k]![1]);
}

export class DurableReader {
	readonly file: string;
	readonly #db: DatabaseSync;
	readonly #statements = new Map<string, StatementSync>();
	/** The root conversation that holds the memory, once it exists. */
	conversationId: number | undefined;
	#chatDoc: number | undefined;

	constructor(file: string) {
		this.file = file;
		if (!existsSync(file)) throw new Error(`no memory at ${file}: is this an optchat home?`);
		let db: DatabaseSync;
		try {
			db = new DatabaseSync(file, { readOnly: true });
			db.prepare("SELECT 1 FROM documents LIMIT 1").get();
		} catch (error) {
			// A WAL database whose -shm file is gone cannot be opened read-only; read it without ever writing.
			if (String(error).includes("no such table")) throw new Error(`${file} is not an optchat store`);
			db = new DatabaseSync(file);
			db.exec("PRAGMA query_only = 1");
		}
		db.exec("PRAGMA busy_timeout = 5000");
		this.#db = db;
	}

	close(): void {
		this.#db.close();
	}

	#q(sql: string): StatementSync {
		let statement = this.#statements.get(sql);
		if (statement === undefined) {
			statement = this.#db.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}

	/** Run reads against one snapshot of the store. */
	read<T>(run: () => T): T {
		this.#db.exec("BEGIN");
		try {
			return run();
		} finally {
			this.#db.exec("COMMIT");
		}
	}

	/** The chat document's id, found once it exists. */
	chatDoc(): number | undefined {
		if (this.#chatDoc !== undefined) return this.#chatDoc;
		const row = this.#q(
			`SELECT d.id AS id, d.owner_id AS owner FROM documents d JOIN conversations c ON c.id = d.owner_id
			 WHERE d.kind = '"optchat.chat"' AND d.scope_kind = 'conversation' AND d.retired_at IS NULL
			 ORDER BY (c.owner_conversation_id IS NOT NULL), (c.owner_task_id IS NOT NULL), d.id LIMIT 1`,
		).get() as { id: number; owner: number } | undefined;
		if (row !== undefined) {
			this.#chatDoc = row.id;
			this.conversationId = row.owner;
		}
		return this.#chatDoc;
	}

	/** The newest commit in the store. */
	lastSeq(): number {
		return (this.#q("SELECT next_seq AS n FROM durable_metadata").get() as { n: number } | undefined)?.n ?? 0;
	}

	revisions(doc: number, after: number): Revision[] {
		return this.#q("SELECT seq, kind, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq").all(doc, after) as Revision[];
	}

	/** A document's value now: its last base and the deltas after it. */
	#materialize(id: number): unknown {
		const base = this.#q("SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(id) as
			| { seq: number; content: string }
			| undefined;
		if (base === undefined) return undefined;
		let value = JSON.parse(base.content) as unknown;
		for (const r of this.#q("SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq").all(id, base.seq) as { content: string }[]) {
			value = apply(value, JSON.parse(r.content) as Op[]);
		}
		return value;
	}

	#family<T>(kind: string, key: string): (T & { createdAt: number }) | undefined {
		if (this.chatDoc() === undefined) return undefined;
		const row = this.#q(
			`SELECT id, created_at AS created FROM documents WHERE kind = ? AND scope_kind = 'conversation' AND owner_id = ? AND family = 1
			 AND key_value = ? AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`,
		).get(JSON.stringify(kind), this.conversationId!, JSON.stringify(key)) as { id: number; created: number } | undefined;
		if (row === undefined) return undefined;
		const value = this.#materialize(row.id) as T | undefined;
		return value === undefined ? undefined : { ...value, createdAt: row.created };
	}

	node(key: string): (NodeState & { createdAt: number }) | undefined {
		return this.#family<NodeState>("optchat.node", key);
	}

	messageRecord(id: number): MessageState | undefined {
		return this.#family<MessageState>("optchat.message", String(id));
	}

	entry(id: number): EntryRecord | undefined {
		const row = this.#q("SELECT record FROM entries WHERE id = ?").get(id) as { record: string } | undefined;
		return row === undefined ? undefined : (JSON.parse(row.record) as EntryRecord);
	}

	/** Message `id` whole (one page of a long text), with what it is. */
	message(id: number): { id: number; kind: Kind; date: number; size: number; more: boolean; page: number; pages: number; text: string } | undefined {
		const record = this.messageRecord(id);
		if (record === undefined) return undefined;
		const entry = this.entry(record.entry);
		const text = entry === undefined ? undefined : pageText(entry, record);
		const whole = entry === undefined ? undefined : blockOf(entry, record.block);
		return {
			id,
			kind: record.kind,
			date: record.date,
			size: record.size,
			more: record.more,
			page: record.page,
			pages: whole === undefined ? 1 : clipPages(whole.text).length,
			text: text ?? "(not readable)",
		};
	}

	/** Entries of the memory's conversation of one kind, committed after `after` up to `upto`: their commit and record. */
	entries(kind: string, after: number, upto: number, limit = 1, order: "ASC" | "DESC" = "ASC"): { seq: number; record: EntryRecord }[] {
		if (this.chatDoc() === undefined) return [];
		const rows = this.#q(
			`SELECT commit_seq AS seq, record FROM entries WHERE conversation_id = ? AND commit_seq > ? AND commit_seq <= ?
			 AND json_extract(record, '$.kind') = ? ORDER BY commit_seq ${order} LIMIT ?`,
		).all(this.conversationId!, after, upto, kind, limit) as { seq: number; record: string }[];
		return rows.map((r) => ({ seq: r.seq, record: JSON.parse(r.record) as EntryRecord }));
	}

	/** When things happened: each entry's commit and its message's time, after `after` up to `upto`. */
	anchors(after: number, upto: number): [seq: number, time: number][] {
		if (this.chatDoc() === undefined) return [];
		const rows = this.#q(
			`SELECT commit_seq AS seq, COALESCE(json_extract(record, '$.model[0].timestamp'), json_extract(record, '$.data.date')) AS t
			 FROM entries WHERE conversation_id = ? AND commit_seq > ? AND commit_seq <= ? ORDER BY commit_seq`,
		).all(this.conversationId!, after, upto) as { seq: number; t: number | null }[];
		return rows.flatMap((r) => (typeof r.t === "number" ? [[r.seq, r.t] as [number, number]] : []));
	}

	/** Nodes built in commits after `after` up to `upto`, by commit. */
	nodesBuilt(after: number, upto: number): Map<number, { key: string; size: number }[]> {
		const out = new Map<number, { key: string; size: number }[]>();
		if (this.chatDoc() === undefined) return out;
		const rows = this.#q(
			`SELECT d.created_at AS seq, d.key_value AS key, json_extract(r.content, '$.size') AS size
			 FROM documents d JOIN document_revisions r ON r.document_id = d.id AND r.seq = d.created_at
			 WHERE d.kind = '"optchat.node"' AND d.scope_kind = 'conversation' AND d.owner_id = ? AND d.created_at > ? AND d.created_at <= ?
			 ORDER BY d.created_at, d.id`,
		).all(this.conversationId!, after, upto) as { seq: number; key: string; size: number | null }[];
		for (const row of rows) {
			const list = out.get(row.seq) ?? [];
			list.push({ key: JSON.parse(row.key) as string, size: row.size ?? 0 });
			out.set(row.seq, list);
		}
		return out;
	}

	/** The kinds of messages indexed in commits after `after` up to `upto`, by message id. */
	messageKinds(after: number, upto: number): Map<number, Kind> {
		const out = new Map<number, Kind>();
		if (this.chatDoc() === undefined) return out;
		const rows = this.#q(
			`SELECT d.key_value AS key, json_extract(r.content, '$.kind') AS kind
			 FROM documents d JOIN document_revisions r ON r.document_id = d.id AND r.seq = d.created_at
			 WHERE d.kind = '"optchat.message"' AND d.scope_kind = 'conversation' AND d.owner_id = ? AND d.created_at > ? AND d.created_at <= ?`,
		).all(this.conversationId!, after, upto) as { key: string; kind: Kind }[];
		for (const row of rows) out.set(Number(JSON.parse(row.key)), row.kind);
		return out;
	}

	task(id: number): { id: number; kind: string; status: string; startedAt?: number; endedAt?: number; outcome?: string; error?: string } | undefined {
		const row = this.#q(
			`SELECT kind, status, json_extract(record, '$.startedAt') AS s, json_extract(record, '$.endedAt') AS e,
			 json_extract(record, '$.state.outcome.status') AS o, json_extract(record, '$.state.outcome.error.message') AS err
			 FROM tasks WHERE id = ?`,
		).get(id) as { kind: string; status: string; s: number | null; e: number | null; o: string | null; err: string | null } | undefined;
		if (row === undefined) return undefined;
		return {
			id,
			kind: JSON.parse(row.kind) as string,
			status: row.status,
			...(row.s === null ? {} : { startedAt: row.s }),
			...(row.e === null ? {} : { endedAt: row.e }),
			...(row.o === null ? {} : { outcome: row.o }),
			...(row.err === null ? {} : { error: row.err }),
		};
	}
}

/**
 * The memory's history as frames, replayed from the chat document's revisions. `update()` reads what was committed
 * since, so a viewer can follow a running agent.
 */
export class History {
	readonly reader: DurableReader;
	readonly frames: Frame[] = [];
	/** The chat state after the last commit read. */
	chat: ChatState = initialChat();
	/** The last commit read. */
	seq = 0;
	/** Nodes built so far. */
	nodes = 0;
	/** Compactions running now, and the commit that started each. */
	readonly #pending = new Map<string, Pending>();
	#clock = 0;
	/** The failure burst still open at the end of `frames`, if any. */
	#burst: Frame | undefined;

	constructor(reader: DurableReader) {
		this.reader = reader;
	}

	pending(): Pending[] {
		return [...this.#pending.values()];
	}

	/** Read the commits since the last update. Returns the index of the first frame that is new or changed. */
	update(): number {
		const changed = { from: this.frames.length };
		this.reader.read(() => {
			const doc = this.reader.chatDoc();
			if (doc === undefined) return;
			const revisions = this.reader.revisions(doc, this.seq);
			if (revisions.length === 0) return;
			const after = this.seq;
			const upto = revisions.at(-1)!.seq;
			const nodes = this.reader.nodesBuilt(after, upto);
			const kinds = this.reader.messageKinds(after, upto);
			const anchors = this.reader.anchors(after, upto);
			let a = 0;
			if (this.#burst !== undefined) changed.from = Math.min(changed.from, this.frames.length - 1);
			for (const revision of revisions) {
				while (a < anchors.length && anchors[a]![0] <= revision.seq) this.#tick(anchors[a++]![1]);
				this.#step(revision, nodes.get(revision.seq) ?? [], kinds);
			}
			this.seq = upto;
			this.#closeBurst();
			// Commits before the first recorded time take it.
			const known = this.frames.find((f) => f.t > 0)?.t;
			if (known !== undefined) for (const f of this.frames) if (f.t === 0) f.t = known;
		});
		return changed.from;
	}

	#tick(t: number | undefined): void {
		if (t !== undefined && t > this.#clock) this.#clock = t;
	}

	#closeBurst(): void {
		const fail = this.#burst?.fail;
		if (fail === undefined) return;
		const task = this.reader.task(fail.task);
		fail.until = Math.max(this.#burst!.t, task?.endedAt ?? this.#clock);
		if (task?.error !== undefined) fail.error = task.error.slice(0, 500);
		this.#tick(fail.until);
	}

	#push(frame: Frame): void {
		if (this.#burst !== undefined) {
			this.#closeBurst();
			this.#burst = undefined;
			frame.t = Math.max(frame.t, this.#clock);
		}
		this.frames.push(frame);
	}

	#step(revision: Revision, built: { key: string; size: number }[], kinds: Map<number, Kind>): void {
		const chat = this.chat;
		const beforeCount = chat.count;
		const started: [string, number][] = [];
		const ended: string[] = [];
		const ops = revision.kind === "base" ? undefined : (JSON.parse(revision.content) as Op[]);
		// Most commits only start or end a compaction: copy what they cannot change only when they touch it.
		const touched = new Set<string | number>();
		for (const op of ops ?? [["r", null] as Op]) {
			if (op[0] === "r" || op[1].length === 0) {
				touched.add("*");
				continue;
			}
			const path = op[1];
			touched.add(path[0]!);
			if (path[0] !== "busy") continue;
			if (op[0] === "s" && path.length === 2) started.push([String(path[1]), Number(op[2])]);
			else if (op[0] === "d" && path.length === 2) ended.push(String(path[1]));
		}
		const touches = (key: string) => touched.has(key) || touched.has("*");
		const beforeView = touches("view") ? copyParts(chat.view?.parts) : undefined;
		const beforeSeen = touches("seen") ? copyParts(chat.seen?.parts) : undefined;
		const beforeTurn = touches("turn") ? JSON.stringify(chat.turn ?? null) : undefined;
		this.chat = ops === undefined ? { ...initialChat(), ...(JSON.parse(revision.content) as ChatState) } : apply(chat, ops);
		const now = this.chat;
		for (const [key, task] of started) this.#pending.set(key, { key, from: revision.seq, task });

		const frame: Frame = { seq: revision.seq, t: this.#clock };
		if (built.length > 0) {
			this.nodes += built.length;
			frame.built = built.map(({ key, size }) => {
				const pending = this.#pending.get(key);
				if (pending === undefined) return { key, size };
				this.#pending.delete(key);
				const task = this.reader.task(pending.task);
				this.#tick(task?.endedAt);
				const ms = task?.startedAt !== undefined && task.endedAt !== undefined ? task.endedAt - task.startedAt : undefined;
				return { key, size, from: pending.from, ...(ms === undefined ? {} : { ms }) };
			});
			frame.t = this.#clock;
		}
		const failed: [string, number][] = [];
		for (const key of ended) {
			const pending = this.#pending.get(key);
			if (pending === undefined) continue;
			this.#pending.delete(key);
			failed.push([key, pending.task]);
		}
		if (now.count > beforeCount) {
			const ids = Array.from({ length: now.count - beforeCount }, (_, k) => beforeCount + k);
			frame.msgs = { from: beforeCount, kinds: ids.map((id) => kinds.get(id) ?? "note") };
		}
		const view = beforeView === undefined ? undefined : diff(beforeView, now.view?.parts ?? []);
		if (view !== undefined) frame.view = view;
		const seen = beforeSeen === undefined ? undefined : diff(beforeSeen, now.seen?.parts ?? []);
		if (seen !== undefined) frame.seen = seen;
		if (beforeTurn !== undefined && now.turn !== undefined && JSON.stringify(now.turn) !== beforeTurn) {
			frame.turn = { first: now.turn.first, state: now.turn.state };
			if (!sameParts(now.turn.parts, now.view.parts)) frame.turn.parts = copyParts(now.turn.parts);
		}

		const eventful = frame.msgs !== undefined || frame.built !== undefined || frame.view !== undefined || frame.seen !== undefined || frame.turn !== undefined;
		if (eventful) this.#push(frame);
		if (failed.length === 0) return;
		// Failures fold into one burst until something else happens: a provider outage can fail thousands in a row.
		const fail = this.#burst?.fail;
		if (fail === undefined || eventful) {
			const first = this.reader.task(failed[0]![1]);
			this.#tick(first?.startedAt);
			this.#burst = { seq: revision.seq, t: this.#clock, fail: { keys: [], n: 0, task: 0, until: this.#clock } };
			this.frames.push(this.#burst);
		}
		const burst = this.#burst!.fail!;
		for (const [key, task] of failed) {
			if (!burst.keys.includes(key) && burst.keys.length < 64) burst.keys.push(key);
			burst.n += 1;
			burst.task = task;
		}
	}

	/** The view's parts after frame `index` (the turn's frozen parts with `turn: true`). */
	viewAt(index: number, which: "view" | "seen" = "view"): Part[] {
		const parts: Part[] = [];
		for (let k = 0; k <= index && k < this.frames.length; k++) {
			const splice = this.frames[k]![which];
			if (splice !== undefined) parts.splice(splice[0], splice[1], ...copyParts(splice[2]));
		}
		return parts;
	}
}
