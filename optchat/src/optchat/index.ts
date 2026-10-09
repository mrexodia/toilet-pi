/**
 * Optchat: the never-ending chat's memory on a pi-durable conversation. The host opens a Harness, installs the
 * extension, and drives one of these: it indexes new entries, pumps the compactor, freezes a view for each turn, and
 * waits for the tree before a turn starts.
 */

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import {
	type Conversation,
	type EntryId,
	type Harness,
	LiveDoc,
	type Registry,
	type Submission,
	watchEvents,
} from "@earendil-works/pi-durable";
import { index, pump, settled } from "./compactor.ts";
import { ChatDoc, type ChatState, initialChat, MessageDoc, type ModelChoice, NodeDoc } from "./docs.ts";
import { optchatExtension, renderParts, stateLine } from "./extension.ts";
import { headOf, idle, NOTE_KIND, pageText } from "./memory.ts";
import { clipPage, flat, halves, key, type Part, ref, roots, WAIT } from "./tree.ts";

export { ChatDoc, MessageDoc, NodeDoc, type ChatState, type ModelChoice } from "./docs.ts";
export { optchatExtension } from "./extension.ts";
export { Build, index, pump } from "./compactor.ts";
export * as tree from "./tree.ts";

export type OptchatOptions = {
	/** The agent's working directory, named to the model in each turn. */
	readonly home: string;
	readonly context?: Context;
	/** Receives failures of the background drive. */
	readonly onReport?: (error: unknown) => void;
	/** Runs before each turn starts, for example to pick up changed instructions. */
	readonly beforeTurn?: () => Promise<void>;
};

export class Optchat {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly home: string;
	readonly #context: Context;
	readonly #report: (error: unknown) => void;
	readonly #beforeTurn: (() => Promise<void>) | undefined;
	#kicked = false;
	#driving: Promise<void> | undefined;
	#stops: (() => Promise<unknown>)[] = [];
	#cancel: (() => void) | undefined;
	#beat: NodeJS.Timeout | undefined;

	constructor(harness: Harness, root: Conversation, options: OptchatOptions) {
		this.harness = harness;
		this.root = root;
		this.home = options.home;
		this.#context = options.context ?? BACKGROUND_CONTEXT;
		this.#report = options.onReport ?? ((error) => console.error(error));
		this.#beforeTurn = options.beforeTurn;
	}

	/** The context this memory's reads and commits run under. */
	get context(): Context {
		return this.#context;
	}

	/** Install the memory's extension in a registry, before the Harness opens. */
	static install(registry: Registry, options: { home: string }): void {
		registry.install(optchatExtension(options));
	}

	/** Follow the conversation: index what gets appended, and build what becomes ready. */
	async start(): Promise<void> {
		const { context, cancel } = withCancel(this.#context);
		this.#cancel = cancel;
		const events = await watchEvents(this.harness, this.root.id, context);
		events.start(async (batch) => {
			if (batch.some((event) => event.type === "entry_appended" || event.type === "message_end")) this.kick();
		});
		this.#stops.push(() => events.stop());
		const doc = await this.harness.watchDoc(ChatDoc, this.root.id, context);
		if (doc !== undefined) {
			doc.start(async () => this.kick());
			this.#stops.push(() => doc.stop());
		}
		this.#beat = setInterval(() => {
			void this.state().then((chat) => {
				if (!idle(chat)) this.kick();
			});
		}, 30_000);
		this.#beat.unref();
		this.kick();
		await this.drained();
	}

	async stop(): Promise<void> {
		if (this.#beat !== undefined) clearInterval(this.#beat);
		this.#cancel?.();
		for (const stop of this.#stops.splice(0)) await stop().catch(() => {});
		await this.drained();
	}

	/** Index and pump soon, once per burst of changes. */
	kick(): void {
		this.#kicked = true;
		if (this.#driving !== undefined) return;
		this.#driving = (async () => {
			try {
				while (this.#kicked) {
					this.#kicked = false;
					await index(this.harness, this.root, this.#context);
					await pump(this.harness, this.root, this.#context);
				}
			} catch (error) {
				this.#report(error);
			} finally {
				this.#driving = undefined;
				if (this.#kicked) this.kick();
			}
		})();
	}

	/** Resolve once the current drive, if any, is done. */
	async drained(): Promise<void> {
		while (this.#driving !== undefined) await this.#driving;
	}

	/** Index everything appended so far and start what is ready, now. */
	async flush(): Promise<void> {
		this.kick();
		await this.drained();
	}

	async state(): Promise<ChatState> {
		return (await this.harness.snapshot(ChatDoc, this.root.id, this.#context)) ?? initialChat();
	}

	/** Whether a run is working on an input. */
	async busy(): Promise<boolean> {
		return (await this.harness.snapshot(LiveDoc, this.root.id, this.#context))?.run !== undefined;
	}

	/** Set the compactions' model; absent, the turns' model. */
	async configure(compactor: ModelChoice | undefined): Promise<void> {
		await this.root.commit(async (tx) => {
			const chat = await tx.doc(ChatDoc, this.root.id);
			if (compactor === undefined) delete chat.compactor;
			else chat.compactor = { ...compactor };
		}, this.#context);
	}

	/** Wait until every indexed message is summarized and nothing new waits to be indexed. */
	async settle(options: { readonly signal?: AbortSignal; readonly onWait?: (chat: ChatState) => void } = {}): Promise<void> {
		let said = false;
		for (;;) {
			this.kick();
			await this.drained();
			const chat = await this.state();
			if (settled(chat, chat.count) && !this.#kicked) return;
			if (!said && options.onWait !== undefined) {
				said = true;
				options.onWait(chat);
			}
			if (options.signal?.aborted) throw new Error("the wait was stopped");
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	/** Wait until nothing is left to index or build at all, merges included. */
	async idle(options: { readonly signal?: AbortSignal; readonly onWait?: (chat: ChatState) => void } = {}): Promise<void> {
		let said = false;
		for (;;) {
			this.kick();
			await this.drained();
			const chat = await this.state();
			if (idle(chat) && !this.#kicked) return;
			if (!said && options.onWait !== undefined) {
				said = true;
				options.onWait(chat);
			}
			if (options.signal?.aborted) throw new Error("the wait was stopped");
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	/**
	 * A turn: wait for the tree, freeze the view for the run, start a fresh context, and submit the message. While a run
	 * is busy, use `steer()` instead.
	 */
	async turn(
		text: string,
		options: { readonly onWait?: (chat: ChatState) => void; readonly requestId?: string } = {},
	): Promise<Submission> {
		await this.settle(options);
		await this.#beforeTurn?.();
		await this.root.commit(async (tx) => {
			const chat = await tx.doc(ChatDoc, this.root.id);
			chat.turn = { first: chat.count, parts: chat.view.parts.map((p) => [...p] as Part), head: headOf(text), state: stateLine(this.home) };
		}, this.#context);
		await this.root.reset(undefined, this.#context);
		return this.root.submit(
			{ type: "input", content: text, whenBusy: "steer", ...(options.requestId === undefined ? {} : { requestId: options.requestId }) },
			this.#context,
		);
	}

	/** A message for a running turn: it reaches the model between tool calls. */
	async steer(text: string, requestId?: string): Promise<Submission> {
		return this.root.submit(
			{ type: "input", content: text, whenBusy: "steer", ...(requestId === undefined ? {} : { requestId }) },
			this.#context,
		);
	}

	/** A memory from before the chat: logged as a `note`, read by the model only through the tree. */
	async note(text: string): Promise<Submission> {
		return this.root.submit(
			{ type: "write", entry: { kind: NOTE_KIND, data: { text, date: Date.now() } } },
			this.#context,
		);
	}

	/** The view as the model would see it now, whole. */
	async render(): Promise<string> {
		const chat = await this.state();
		return renderParts(this.harness, this.root.id, chat.view.parts, chat.count, this.#context);
	}

	async zoom(id: number, n = 1, at = 0): Promise<string> {
		const chat = await this.state();
		const ok = Number.isInteger(id) && n >= 1 && (n & (n - 1)) === 0 && id >= 0 && id % n === 0 && id + n <= chat.count;
		if (!ok) {
			return `No line ${id}+${n}: n is a power of 2, id a multiple of n, and id+n at most ${chat.count}. The tree's roots: ${roots(chat.count).map(ref).join(", ")}.`;
		}
		if (n === 1) {
			const record = await this.harness.snapshot(MessageDoc, this.root.id, String(id), this.#context);
			const entry = record === undefined ? undefined : await this.root.commit((tx) => tx.entry(record.entry as EntryId), this.#context);
			const text = record === undefined || entry === undefined ? undefined : pageText(entry, record);
			return record === undefined || text === undefined ? `Message ${id} is not readable.` : `${id}+1|${record.kind}: ${clipPage(text, at)}`;
		}
		const out: string[] = [];
		for (const half of halves([Math.log2(n), id / n])) {
			const node = await this.harness.snapshot(NodeDoc, this.root.id, key(half), this.#context);
			out.push(`${ref(half)}|${flat(node?.text ?? WAIT)}`);
		}
		return out.join("\n");
	}

	async date(id: number): Promise<string> {
		const record = await this.harness.snapshot(MessageDoc, this.root.id, String(id), this.#context);
		return record === undefined ? `No message ${id}.` : new Date(record.date).toISOString();
	}
}
