/**
 * The compactor: the indexer that turns transcript entries into numbered messages, the pump that starts what is ready
 * to build, and the durable `Build` task that makes one node with a model call (optchat.md, section 4).
 */

import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message, SystemMessage, ThinkingLevel, Tool, UserMessage, Usage as AiUsage } from "@earendil-works/pi-ai";
import {
	type Agent,
	type Conversation,
	type ConversationId,
	defineTask,
	type EntryId,
	type EntryRecord,
	type Harness,
	ProviderDoc,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { ChatDoc, type ChatState, MessageDoc, NodeDoc } from "./docs.ts";
import {
	appendMessages,
	before,
	blocksOf,
	built,
	candidates,
	first,
	fit,
	mergeSource,
	pageText,
	pagesOf,
	running,
	show,
	storeNode,
	taskOf,
} from "./memory.ts";
import { tooLong } from "./prompt.ts";
import { chatBlock, ctx, cut, flat, halves, JOBS, key, lines, nbytes, NODE, type Part, ref, TRIES } from "./tree.ts";

// ---------------------------------------------------------------- the indexer

/** Index the entries appended since the last run, in batches; returns how many messages were added. */
export async function index(harness: Harness, root: Conversation, context: Context): Promise<number> {
	let added = 0;
	for (;;) {
		const known = await harness.snapshot(ChatDoc, root.id, context);
		const indexed = known?.indexed ?? 0;
		const result = await root.commit(async (tx) => {
			const page = await tx.scanEntries(
				{ conversationId: root.id, minEntryId: (indexed + 1) as EntryId, order: "ascending" },
				128,
			);
			const chat = await tx.doc(ChatDoc, root.id);
			if (chat.indexed !== indexed) return { added: 0, more: true };
			if (page.items.length === 0) return { added: 0, more: false };
			let n = 0;
			for (const entry of page.items) {
				for (const block of blocksOf(entry)) {
					for (const state of pagesOf(entry.id, block)) {
						await tx.doc(MessageDoc, root.id, String(chat.count + n), state);
						n += 1;
					}
				}
			}
			appendMessages(chat, n);
			chat.indexed = page.items[page.items.length - 1]!.id;
			return { added: n, more: page.next !== undefined };
		}, context);
		added += result.added;
		if (!result.more) return added;
	}
}

// ---------------------------------------------------------------- the pump

/** What a compaction of p compresses: the message, or its two halves joined; undefined when not ready. */
async function sourceOf(tx: Tx, conversationId: ConversationId, p: Part): Promise<string | undefined> {
	const [l, i] = p;
	if (l === 0) {
		const record = await tx.doc(MessageDoc, conversationId, String(i), {
			entry: 0,
			block: 0,
			page: 0,
			kind: "user",
			size: 0,
			date: 0,
			more: false,
		});
		if (record.entry === 0) return undefined;
		const entry = await tx.entry(record.entry as EntryId);
		if (entry === undefined) return undefined;
		const text = pageText(entry, record);
		return text === undefined ? undefined : show(record.kind, text);
	}
	const texts: string[] = [];
	for (const half of halves(p)) {
		const node = await tx.doc(NodeDoc, conversationId, key(half), { text: "", size: 0 });
		if (node.text === "") return undefined;
		texts.push(node.text);
	}
	return mergeSource(texts[0]!, texts[1]!);
}

/**
 * Start the ready nodes' compactions, up to JOBS at once, and store the ones that need no call (a source within
 * NODE bytes is its own node). Repeats while free nodes complete new pairs.
 */
export async function pump(harness: Harness, root: Conversation, context: Context): Promise<void> {
	for (;;) {
		const chat = await harness.snapshot(ChatDoc, root.id, context);
		if (chat === undefined) return;
		const picked = candidates(chat).slice(0, 64);
		if (picked.length === 0) return;
		const stored = await root.commit(async (tx) => {
			const sources = new Map<string, string>();
			for (const p of picked) {
				const source = await sourceOf(tx, root.id, p);
				if (source !== undefined) sources.set(key(p), source);
			}
			const live = await tx.doc(ChatDoc, root.id);
			let stored = 0;
			for (const p of picked) {
				const k = key(p);
				const source = sources.get(k);
				if (source === undefined || built(live, p) || k in live.busy) continue;
				if (nbytes(source) <= NODE) {
					const node = await tx.doc(NodeDoc, root.id, k, { text: source, size: nbytes(source) });
					node.text = source;
					node.size = nbytes(source);
					storeNode(live, p, source);
					stored += 1;
				} else if (running(live) < JOBS) {
					const id = await tx.createTask(
						Build,
						{ l: p[0], i: p[1], source },
						{ ownership: { kind: "conversation" }, background: true },
					);
					live.busy[k] = id as number;
				}
			}
			fit(live);
			return stored;
		}, context);
		if (stored === 0) return;
	}
}

// ---------------------------------------------------------------- the build task

export type BuildInput = { l: number; i: number; source: string };
type BuildState = { phase: "call"; attempt: number } | { phase: "wait"; attempt: number; until: number };
type Runtime = TaskRuntime<BuildInput, BuildState, null, object>;

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function textOf(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("")
		.trim();
}

/** The same leading system message a turn gets: the agent's sections in order, and its tools. */
export async function systemMessage(
	agent: Agent,
	conversationId: ConversationId,
	read: Runtime | { snapshot: Runtime["snapshot"]; snapshotAsOf: Runtime["snapshotAsOf"] },
	timestamp: number,
	context: Context,
): Promise<SystemMessage> {
	const sections: Record<string, string> = {};
	for (const section of agent.sections) {
		const text = await section.render({ conversationId, agent, env: undefined, shown: {}, read }, context);
		if (text === undefined) continue;
		sections[section.key] = section.tag === false ? text : `<${section.key}>\n${text}\n</${section.key}>`;
	}
	const toolsAdded: Tool[] = agent.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	}));
	return { role: "system", content: "", sections, toolsAdded, timestamp };
}

function addUsage(total: AiUsage | undefined, usage: AiUsage): AiUsage {
	if (total === undefined) return { ...usage, cost: { ...usage.cost } };
	return {
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		totalTokens: total.totalTokens + usage.totalTokens,
		cost: {
			input: total.cost.input + usage.cost.input,
			output: total.cost.output + usage.cost.output,
			cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
			total: total.cost.total + usage.cost.total,
		},
	};
}

/** One compaction: the compactions' view up to the node, the task, up to TRIES lines; keep the shortest. */
async function compact(
	runtime: Runtime,
	p: Part,
	source: string,
	context: Context,
): Promise<{ line: string; usage: AiUsage | undefined; calls: number }> {
	const conversationId = runtime.conversationId;
	const chat = await runtime.snapshot(ChatDoc, conversationId, context);
	if (chat === undefined) throw new Error("the chat has no memory document");
	const upto = Math.min(ctx(p), first(chat));
	const parts = before(chat.seen.parts, upto);
	const texts = new Map<string, string>();
	for (const q of parts) {
		const node = await runtime.snapshot(NodeDoc, conversationId, key(q), context);
		if (node !== undefined) texts.set(key(q), node.text);
	}
	const view = chatBlock(lines(parts, upto, (q) => texts.get(key(q))));
	const agent = await runtime.agent(context);
	const choice = chat.compactor ?? agent.model;
	if (choice === undefined) throw new Error("the chat has no model");
	const model = runtime.models.getModel(choice.provider, choice.modelId);
	if (model === undefined) throw new Error(`no model ${choice.provider}/${choice.modelId}`);
	const reasoning = chat.compactor?.thinkingLevel ?? agent.thinkingLevel;
	const sessionId = (await runtime.snapshot(ProviderDoc, conversationId, context))?.sessionId;
	const system = await systemMessage(agent, conversationId, runtime, runtime.now(), context);
	const messages: Message[] = [system, user(`${view}${taskOf(p)}${source}\n</input>`, runtime.now())];
	const found: string[] = [];
	let usage: AiUsage | undefined;
	let calls = 0;
	for (let tries = 0; tries < TRIES; tries++) {
		const stream = runtime.models.streamSimple(
			model,
			{ messages },
			{
				...runtime.settings.stream,
				signal: runtime.signal,
				...(sessionId === undefined ? {} : { sessionId }),
				...(reasoning === "off" || reasoning === undefined ? {} : { reasoning: reasoning as ThinkingLevel }),
			},
		);
		const reply = await stream.result();
		calls += 1;
		usage = addUsage(usage, reply.usage);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			throw new Error(reply.errorMessage ?? `the model stopped: ${reply.stopReason}`);
		}
		const text = textOf(reply);
		if (text === "" && reply.content.some((block) => block.type === "toolCall")) {
			messages.push(user("You called a tool. Call no tools: output only the line, for the same <input>.", runtime.now()));
			continue;
		}
		if (text === "") break;
		found.push(text);
		if (nbytes(text) <= NODE) break;
		messages.push(reply, user(tooLong(text), runtime.now()));
	}
	if (found.length === 0) {
		runtime.report(new Error(`compactor: node ${ref(p)}: an empty line; clipped`));
		return { line: cut(flat(source)), usage, calls };
	}
	return { line: found.reduce((a, b) => (nbytes(b) < nbytes(a) ? b : a)), usage, calls };
}

export const Build = defineTask<BuildInput, BuildState, null>({
	name: "optchat.build",
	version: 1,
	initial: () => ({ phase: "call", attempt: 1 }),
	phases: {
		call: async (task, runtime, context) => {
			const p: Part = [task.input.l, task.input.i];
			let made: Awaited<ReturnType<typeof compact>>;
			try {
				made = await compact(runtime, p, task.input.source, context);
			} catch (error) {
				if (runtime.signal.aborted) throw error;
				runtime.report(error);
				// The slot is freed and the node stays ready: it is tried again at the next message (optchat.md, section 4).
				const message = error instanceof Error ? error.message : String(error);
				await runtime.commit(async (tx) => {
					const chat = await tx.doc(ChatDoc, runtime.conversationId);
					delete chat.busy[key(p)];
					return { status: "terminal", outcome: { status: "failed", error: { message } } };
				}, context);
				return;
			}
			await runtime.commit(async (tx) => {
				const chat = await tx.doc(ChatDoc, runtime.conversationId);
				const k = key(p);
				if (!built(chat, p)) {
					const node = await tx.doc(NodeDoc, runtime.conversationId, k, { text: made.line, size: nbytes(made.line) });
					node.text = made.line;
					node.size = nbytes(made.line);
				}
				storeNode(chat, p, made.line);
				chat.usage.calls += made.calls;
				if (made.usage !== undefined) {
					chat.usage.input += made.usage.input;
					chat.usage.output += made.usage.output;
					chat.usage.cacheRead += made.usage.cacheRead;
					chat.usage.cacheWrite += made.usage.cacheWrite;
					chat.usage.cost += made.usage.cost.total;
				}
				fit(chat);
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
		wait: async (task, runtime, context) => {
			await runtime.sleep(task.state.checkpoint.until, context);
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "call", attempt: task.state.checkpoint.attempt } }),
				context,
			);
		},
	},
	abort: async (task, runtime, context) => {
		await runtime.commit(async (tx) => {
			const chat = await tx.doc(ChatDoc, runtime.conversationId);
			delete chat.busy[key([task.input.l, task.input.i])];
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** Whether every message before `end` is summarized, as the state says. */
export function settled(chat: ChatState | undefined, end: number): boolean {
	return chat === undefined ? end === 0 : first(chat) >= end;
}

export type { EntryRecord };
