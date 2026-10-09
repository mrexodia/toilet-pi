/**
 * The memory as a pi-durable extension: the system prompt, the zoom and date tools, the hook that gives each request
 * the frozen view of its turn, the hook that clips tool output, and the build task.
 */

import type { Context } from "@earendil-works/chord";
import { type Message, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	GenerationTask,
	hook,
	section,
	ToolTask,
} from "@earendil-works/pi-durable";
import { Build } from "./compactor.ts";
import { ChatDoc, type ChatState, initialChat, MessageDoc, NodeDoc } from "./docs.ts";
import { before, contentText, headOf, pageText } from "./memory.ts";
import { HEAD, PROMPT } from "./prompt.ts";
import { CAP, chatBlock, clip, clipPage, flat, halves, key, lines, type Part, ref, roots, WAIT } from "./tree.ts";

type Reader = {
	snapshot<T extends object>(token: typeof NodeDoc, conversationId: ConversationId, key: string, context: Context): Promise<Readonly<T> | undefined>;
};

/** The <chat> block for some parts, from the node documents. */
export async function renderParts(
	read: { snapshot: Reader["snapshot"] },
	conversationId: ConversationId,
	parts: readonly Part[],
	upto: number,
	context: Context,
): Promise<string> {
	const texts = new Map<string, string>();
	for (const p of before(parts, upto)) {
		const node = await read.snapshot<{ text: string }>(NodeDoc, conversationId, key(p), context);
		if (node !== undefined) texts.set(key(p), node.text);
	}
	return chatBlock(lines(parts, upto, (p) => texts.get(key(p))));
}

/** The per-turn state shown after the view: never in the system prompt (optchat.md, section 6). */
export function stateLine(home: string, now = new Date()): string {
	const date = now.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
	return `Now: ${date}\nWorking directory: ${home} (${process.platform})\n`;
}

const zoomTool = defineTool({
	name: "zoom",
	description:
		"Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. " +
		"A long text comes in pages from character at, saying where to go on.",
	parameters: Type.Object({
		id: Type.Number(),
		n: Type.Optional(Type.Number()),
		at: Type.Optional(Type.Number()),
	}),
	replay: "safe",
	outputLimits: { maxBytes: 8 * CAP, maxLines: 1_000_000 },
	execute: async (args, api, context) => {
		const chat = (await api.snapshot(ChatDoc, api.conversationId, context)) ?? initialChat();
		const id = Math.floor(args.id);
		const n = Math.floor(args.n ?? 1);
		const ok = Number.isInteger(id) && n >= 1 && (n & (n - 1)) === 0 && id >= 0 && id % n === 0 && id + n <= chat.count;
		const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
		if (!ok) {
			const names = roots(chat.count).map(ref).join(", ");
			return reply(
				`No line ${args.id}+${args.n ?? 1}: n is a power of 2, id a multiple of n, and id+n at most ${chat.count}. The tree's roots: ${names}.`,
			);
		}
		if (n === 1) {
			const record = await api.snapshot(MessageDoc, api.conversationId, String(id), context);
			const entry = record === undefined ? undefined : await api.commit((tx) => tx.entry(record.entry as EntryId), context);
			const text = record === undefined || entry === undefined ? undefined : pageText(entry, record);
			if (record === undefined || text === undefined) return reply(`Message ${id} is not readable.`);
			return reply(`${id}+1|${record.kind}: ${clipPage(text, args.at ?? 0)}`);
		}
		const p: Part = [Math.log2(n), id / n];
		const out: string[] = [];
		for (const half of halves(p)) {
			const node = await api.snapshot(NodeDoc, api.conversationId, key(half), context);
			out.push(`${ref(half)}|${flat(node?.text ?? WAIT)}`);
		}
		return reply(out.join("\n"));
	},
});

const dateTool = defineTool({
	name: "date",
	description: "The date and time of message id.",
	parameters: Type.Object({ id: Type.Number() }),
	replay: "safe",
	execute: async (args, api, context) => {
		const record = await api.snapshot(MessageDoc, api.conversationId, String(Math.floor(args.id)), context);
		const text = record === undefined ? `No message ${args.id}.` : new Date(record.date).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
		return { content: [{ type: "text" as const, text }] };
	},
});

/** The first user message of a run: the one after the leading system messages. */
function splitRun(messages: readonly Message[]): { system: Message[]; rest: Message[]; input: number } {
	const system: Message[] = [];
	let k = 0;
	while (k < messages.length && messages[k]!.role === "system") system.push(messages[k++]!);
	const rest = messages.slice(k);
	return { system, rest, input: rest.findIndex((m) => m.role === "user") };
}

export function optchatExtension(options: { home: string }): Extension {
	return defineExtension({
		name: "optchat",
		sections: [section("prompt", () => PROMPT, { tag: false })],
		tools: [zoomTool, dateTool],
		tasks: [Build],
		hooks: [
			hook(GenerationTask, {
				/** [tools] [system] [view] [state + message] ...: the view frozen when the turn began, or the live one. */
				beforeRequest: async ({ messages }, api, context) => {
					const chat = await api.snapshot(ChatDoc, api.conversationId, context);
					if (chat === undefined) return undefined;
					const { system, rest } = splitRun(messages);
					// The run's first message: the newest user message the frozen turn names, else the first one in context.
					let input = -1;
					let turn = chat.turn;
					if (turn !== undefined) {
						for (let k = rest.length - 1; k >= 0; k--) {
							const m = rest[k]!;
							if (m.role === "user" && headOf(contentText(m.content)) === turn.head) {
								input = k;
								break;
							}
						}
					}
					if (input < 0) {
						turn = undefined;
						input = rest.findIndex((m) => m.role === "user");
					}
					if (input < 0) return undefined;
					const first = rest[input]!;
					if (first.role !== "user") return undefined;
					const text = contentText(first.content);
					const parts = turn?.parts ?? chat.view.parts;
					const upto = turn?.first ?? chat.count;
					const view = await renderParts(api, api.conversationId, parts, upto, context);
					const state = turn?.state ?? stateLine(options.home);
					const content = `${view}${state}${HEAD}${text}`;
					const replaced: Message =
						typeof first.content === "string"
							? { ...first, content }
							: { ...first, content: [{ type: "text", text: content }, ...first.content.filter((b) => b.type !== "text")] };
					// Messages before the run's input are in the view already.
					return { messages: [...system, replaced, ...rest.slice(input + 1)] };
				},
			}),
			hook(ToolTask, {
				/** A tool's output is clipped to its head and tail, 30,000 characters in all. zoom's pages are already sized. */
				afterTool: (call, result) => {
					if (call.name === "zoom" || call.name === "date" || result.content === undefined) return undefined;
					let changed = false;
					const content = result.content.map((block) => {
						if (block.type !== "text" || block.text.length <= 30_000) return block;
						changed = true;
						return { ...block, text: clip(block.text) };
					});
					return changed ? { ...result, content } : undefined;
				},
			}),
		],
	});
}

export type { ChatState };
