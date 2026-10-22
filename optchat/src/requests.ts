/**
 * The request log: every model call the agent makes, turns and compactions alike, recorded as it went to the provider,
 * for the visualizer. Each row holds the provider-neutral context, the exact wire payload (after the cache layout of
 * cache.ts), the settings that shaped it, and the response with its usage.
 *
 * Requests repeat themselves: every call of a run carries the same view, and every tool round the whole run so far. Long
 * strings are therefore stored once, content-addressed, and the log keeps under a size limit by dropping its oldest
 * requests. It lives in `.optchat/requests.sqlite`, apart from the durable store, so it can be deleted at any time.
 *
 * Recording never gets in a call's way: a failure to record is reported once and the call goes on.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage, Context, Message, Models } from "@earendil-works/pi-ai";
import { HEAD } from "./optchat/prompt.ts";

export const REQUESTS_FILE = "requests.sqlite";
export const DEFAULT_REQUEST_LOG_MB = 256;

/** Strings at least this long are stored once, by hash. */
const BLOB_MIN = 1024;
const BLOB_KEY = "$optchatBlob";
/** How many writes between two checks of the size limit. */
const PRUNE_EVERY = 16;

export type RequestKind = "turn" | "compaction" | "other";

export type RequestUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };

export type RequestMeta = {
	id: number;
	/** Unix milliseconds. */
	started: number;
	ended: number | null;
	kind: RequestKind;
	/** A turn's input, or what a compaction builds. */
	label: string;
	provider: string;
	model: string;
	api: string;
	usage: RequestUsage | null;
	stop: string | null;
	error: string | null;
	hasPayload: boolean;
	/** About how many bytes the context, the payload and the response are, before deduplication. */
	bytes: number;
};

export type StoredRequest = RequestMeta & {
	context: Context;
	settings: Record<string, unknown>;
	payload: unknown;
	response: AssistantMessage | null;
};

// ---------------------------------------------------------------- what a request is

function textOf(content: Message["content"] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return (content as { type: string; text?: string }[]).flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : [])).join("");
}

function oneLine(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A turn, a compaction or something else, and a short label for it, from the provider-neutral context. */
export function classify(context: Pick<Context, "messages">): { kind: RequestKind; label: string } {
	const users = context.messages.filter((m) => m.role === "user");
	const first = textOf(users[0]?.content);
	const close = first.indexOf("\n</chat>\n");
	if (first.startsWith("<chat>\n") && close >= 0) {
		const tail = first.slice(close + "\n</chat>\n".length);
		if (tail.startsWith("Compaction:")) {
			const what = /^Compaction: (compress message \d+|merge lines \S+ and [^,\s]+)/.exec(tail)?.[1] ?? "compaction";
			const last = textOf(users.at(-1)?.content);
			const retry = users.length > 1 ? (last.startsWith("Too long") ? " (retry: too long)" : " (retry)") : "";
			return { kind: "compaction", label: `${what.replace("merge lines", "merge")}${retry}` };
		}
		const at = tail.indexOf(HEAD);
		const input = at >= 0 ? tail.slice(at + HEAD.length) : tail;
		const rounds = context.messages.filter((m) => m.role === "assistant").length;
		return { kind: "turn", label: `${oneLine(input)}${rounds > 0 ? ` · round ${rounds + 1}` : ""}` };
	}
	return { kind: "other", label: oneLine(textOf(users.at(-1)?.content)) || "request" };
}

// ---------------------------------------------------------------- storage

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
	id INTEGER PRIMARY KEY,
	started INTEGER NOT NULL,
	ended INTEGER,
	kind TEXT NOT NULL,
	label TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	api TEXT NOT NULL,
	settings TEXT NOT NULL,
	context TEXT NOT NULL,
	payload TEXT,
	response TEXT,
	usage TEXT,
	stop TEXT,
	error TEXT,
	bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, text TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS refs (request INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (request, hash)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS refs_by_hash ON refs (hash);
`;

function hash(text: string): string {
	return createHash("sha256").update(text).digest("base64url").slice(0, 32);
}

/** JSON with every long string swapped for a reference to its blob, and about how many bytes the value is whole. */
function pack(value: unknown, blobs: Map<string, string>): { json: string; bytes: number } {
	let inline = 0;
	const json = JSON.stringify(value ?? null, (_key, v: unknown) => {
		if (typeof v !== "string" || v.length < BLOB_MIN) return v;
		const h = hash(v);
		blobs.set(h, v);
		inline += Buffer.byteLength(v);
		return { [BLOB_KEY]: h };
	});
	return { json, bytes: Buffer.byteLength(json) + inline };
}

function unpack(json: string | null, blobs: Map<string, string>): unknown {
	if (json === null) return null;
	return JSON.parse(json, (_key, v: unknown) => {
		if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			const ref = (v as Record<string, unknown>)[BLOB_KEY];
			if (typeof ref === "string" && Object.keys(v).length === 1) return blobs.get(ref) ?? `(missing blob ${ref})`;
		}
		return v;
	});
}

type Row = {
	id: number;
	started: number;
	ended: number | null;
	kind: string;
	label: string;
	provider: string;
	model: string;
	api: string;
	usage: string | null;
	stop: string | null;
	error: string | null;
	has_payload: number;
	bytes: number;
};

const META = "id, started, ended, kind, label, provider, model, api, usage, stop, error, payload IS NOT NULL AS has_payload, bytes";

function meta(row: Row): RequestMeta {
	return {
		id: row.id,
		started: row.started,
		ended: row.ended,
		kind: row.kind as RequestKind,
		label: row.label,
		provider: row.provider,
		model: row.model,
		api: row.api,
		usage: row.usage === null ? null : (JSON.parse(row.usage) as RequestUsage),
		stop: row.stop,
		error: row.error,
		hasPayload: row.has_payload === 1,
		bytes: row.bytes,
	};
}

export class RequestLog {
	readonly file: string;
	readonly #db: DatabaseSync;
	readonly #maxBytes: number;
	readonly #report: (error: unknown) => void;
	readonly #readonly: boolean;
	#writes = 0;
	#failed = false;

	private constructor(file: string, db: DatabaseSync, options: { maxBytes: number; report: (error: unknown) => void; readonly: boolean }) {
		this.file = file;
		this.#db = db;
		this.#maxBytes = options.maxBytes;
		this.#report = options.report;
		this.#readonly = options.readonly;
	}

	/** Open the log for writing, creating it. */
	static open(file: string, options: { maxMB?: number; report?: (error: unknown) => void } = {}): RequestLog {
		const db = new DatabaseSync(file);
		db.exec("PRAGMA auto_vacuum = INCREMENTAL");
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec("PRAGMA busy_timeout = 2000");
		db.exec(SCHEMA);
		return new RequestLog(file, db, {
			maxBytes: (options.maxMB ?? DEFAULT_REQUEST_LOG_MB) * 1_000_000,
			report: options.report ?? ((error) => console.error(error)),
			readonly: false,
		});
	}

	/** Open an existing log to read, beside the agent that writes it; undefined when there is none. */
	static openReadOnly(file: string): RequestLog | undefined {
		if (!existsSync(file)) return undefined;
		let db: DatabaseSync;
		try {
			db = new DatabaseSync(file, { readOnly: true });
			db.prepare("SELECT 1 FROM requests LIMIT 1").get();
		} catch {
			// A WAL database without its -shm file cannot be opened read-only; read it without ever writing.
			db = new DatabaseSync(file);
			db.exec("PRAGMA query_only = 1");
		}
		db.exec("PRAGMA busy_timeout = 2000");
		return new RequestLog(file, db, { maxBytes: Number.POSITIVE_INFINITY, report: () => {}, readonly: true });
	}

	close(): void {
		try {
			this.#db.close();
		} catch {}
	}

	// ------------------------------------------------------------ writing

	#guard<T>(what: string, run: () => T): T | undefined {
		try {
			return run();
		} catch (error) {
			if (!this.#failed) {
				this.#failed = true;
				this.#report(new Error(`request log: ${what}: ${error instanceof Error ? error.message : String(error)}`));
			}
			return undefined;
		}
	}

	#refs(id: number, blobs: Map<string, string>): void {
		const blob = this.#db.prepare("INSERT OR IGNORE INTO blobs (hash, text) VALUES (?, ?)");
		const ref = this.#db.prepare("INSERT OR IGNORE INTO refs (request, hash) VALUES (?, ?)");
		for (const [h, text] of blobs) {
			blob.run(h, text);
			ref.run(id, h);
		}
	}

	#write<T>(what: string, run: () => T): T | undefined {
		if (this.#readonly) return undefined;
		return this.#guard(what, () => {
			this.#db.exec("BEGIN IMMEDIATE");
			try {
				const out = run();
				this.#db.exec("COMMIT");
				if (++this.#writes % PRUNE_EVERY === 0) this.prune();
				return out;
			} catch (error) {
				this.#db.exec("ROLLBACK");
				throw error;
			}
		});
	}

	/** A request is about to be sent: its row, with the context. */
	begin(model: { provider: string; id: string; api: string }, context: Context, settings: Record<string, unknown>, now = Date.now()): number | undefined {
		return this.#write("begin", () => {
			const blobs = new Map<string, string>();
			const { json, bytes } = pack(context, blobs);
			const { kind, label } = classify(context);
			const result = this.#db
				.prepare(
					"INSERT INTO requests (started, kind, label, provider, model, api, settings, context, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(now, kind, label, model.provider, model.id, model.api, JSON.stringify(settings), json, bytes);
			const id = Number(result.lastInsertRowid);
			this.#refs(id, blobs);
			return id;
		});
	}

	/** The exact payload, as the provider adapter built it. */
	payload(id: number, payload: unknown): void {
		this.#write("payload", () => {
			const blobs = new Map<string, string>();
			const { json, bytes } = pack(payload, blobs);
			this.#db.prepare("UPDATE requests SET payload = ?, bytes = bytes + ? WHERE id = ?").run(json, bytes, id);
			this.#refs(id, blobs);
		});
	}

	/** The call's response, its usage and how it stopped. */
	end(id: number, message: AssistantMessage, now = Date.now()): void {
		this.#write("end", () => {
			const blobs = new Map<string, string>();
			const { json, bytes } = pack(message, blobs);
			const u = message.usage;
			const usage: RequestUsage | null =
				u === undefined
					? null
					: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, cost: u.cost?.total ?? 0 };
			this.#db
				.prepare("UPDATE requests SET ended = ?, response = ?, usage = ?, stop = ?, error = ?, bytes = bytes + ? WHERE id = ?")
				.run(now, json, JSON.stringify(usage), message.stopReason ?? null, message.errorMessage ?? null, bytes, id);
			this.#refs(id, blobs);
		});
	}

	fail(id: number, error: unknown, now = Date.now()): void {
		this.#write("fail", () => {
			const text = error instanceof Error ? error.message : String(error);
			this.#db.prepare("UPDATE requests SET ended = ?, stop = 'error', error = ? WHERE id = ?").run(now, text, id);
		});
	}

	/** Bytes the database holds, free pages excluded. */
	size(): number {
		const pages = (this.#db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
		const free = (this.#db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
		const page = (this.#db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
		return (pages - free) * page;
	}

	/** Drop the oldest requests, and the blobs only they used, until the log is under 90% of its limit. */
	prune(): void {
		if (this.#readonly || this.size() <= this.#maxBytes) return;
		this.#guard("prune", () => {
			for (let round = 0; round < 64 && this.size() > this.#maxBytes * 0.9; round++) {
				const total = (this.#db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n;
				if (total <= 1) break;
				const cut = Math.max(1, Math.floor(total / 10));
				const last = (this.#db.prepare("SELECT id FROM requests ORDER BY id LIMIT 1 OFFSET ?").get(cut - 1) as { id: number }).id;
				this.#db.exec("BEGIN IMMEDIATE");
				try {
					this.#db.prepare("DELETE FROM refs WHERE request <= ?").run(last);
					this.#db.prepare("DELETE FROM requests WHERE id <= ?").run(last);
					this.#db.exec("DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM refs WHERE refs.hash = blobs.hash)");
					this.#db.exec("COMMIT");
				} catch (error) {
					this.#db.exec("ROLLBACK");
					throw error;
				}
				this.#db.exec("PRAGMA incremental_vacuum");
			}
		});
	}

	// ------------------------------------------------------------ reading

	/** Requests after id `after`, oldest first. */
	list(after = 0, limit = 1000): RequestMeta[] {
		const rows = this.#db.prepare(`SELECT ${META} FROM requests WHERE id > ? ORDER BY id LIMIT ?`).all(after, limit) as Row[];
		return rows.map(meta);
	}

	/** The ids of the requests still running: their rows will change. */
	running(): number[] {
		return (this.#db.prepare("SELECT id FROM requests WHERE ended IS NULL ORDER BY id").all() as { id: number }[]).map((r) => r.id);
	}

	byIds(ids: readonly number[]): RequestMeta[] {
		if (ids.length === 0) return [];
		const rows = this.#db.prepare(`SELECT ${META} FROM requests WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).all(...ids) as Row[];
		return rows.map(meta);
	}

	get(id: number): StoredRequest | undefined {
		const row = this.#db.prepare(`SELECT ${META}, settings, context, payload, response FROM requests WHERE id = ?`).get(id) as
			| (Row & { settings: string; context: string; payload: string | null; response: string | null })
			| undefined;
		if (row === undefined) return undefined;
		const blobs = new Map<string, string>();
		for (const b of this.#db.prepare("SELECT b.hash AS hash, b.text AS text FROM refs r JOIN blobs b ON b.hash = r.hash WHERE r.request = ?").all(id) as {
			hash: string;
			text: string;
		}[]) {
			blobs.set(b.hash, b.text);
		}
		return {
			...meta(row),
			settings: JSON.parse(row.settings) as Record<string, unknown>,
			context: unpack(row.context, blobs) as Context,
			payload: unpack(row.payload, blobs),
			response: unpack(row.response, blobs) as AssistantMessage | null,
		};
	}
}

// ---------------------------------------------------------------- the wrapper

/** The stream settings worth keeping: what shapes the request besides its context. */
function settingsOf(options: Record<string, unknown> | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["reasoning", "maxTokens", "temperature", "cacheRetention", "sessionId", "transport", "thinkingBudgets"]) {
		const value = options?.[key];
		if (value !== undefined && typeof value !== "function") out[key] = value;
	}
	return out;
}

/**
 * Models that record each `streamSimple` call in the log. Wrap it around `withMemoryCache`, so the payload recorded is
 * the one sent, after the cache layout. Every other method stays bound to the real Models instance.
 */
export function recordRequests(models: Models, log: RequestLog): Models {
	const streamSimple: Models["streamSimple"] = (model, context, options) => {
		const id = log.begin(model, context, settingsOf(options as Record<string, unknown> | undefined));
		if (id === undefined) return models.streamSimple(model, context, options);
		const stream = models.streamSimple(model, context, {
			...options,
			onPayload: async (payload, resolved) => {
				const out = (await options?.onPayload?.(payload, resolved)) ?? payload;
				log.payload(id, out);
				return out;
			},
		});
		stream.result().then(
			(message) => log.end(id, message),
			(error: unknown) => log.fail(id, error),
		);
		return stream;
	};
	return new Proxy(models, {
		get(target, name) {
			if (name === "streamSimple") return streamSimple;
			const value = Reflect.get(target, name, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
