/**
 * A model request as colored blocks: what each part of its context is, and how big. Works on the provider-neutral
 * context, the one every provider's payload is converted from, so turns and compactions read the same everywhere.
 */

import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import { HEAD } from "../optchat/prompt.ts";
import { nbytes, type Part } from "../optchat/tree.ts";

export type SegmentKind =
	| "prompt" // the system prompt
	| "section" // another system section: instructions, skills, ...
	| "tool" // a tool's definition
	| "view" // a line of the memory's view
	| "state" // the per-turn state: date, working directory
	| "head" // the turn's header
	| "input" // the user's message that started the turn
	| "steer" // a message that reached a running turn
	| "work" // another agent's report
	| "assistant" // the model's reply text
	| "thinking" // the model's reasoning
	| "call" // a tool call
	| "result" // a tool's output
	| "task" // a compaction's instructions
	| "source" // what a compaction compresses
	| "retry" // a compaction's retry note
	| "other";

export type Segment = {
	kind: SegmentKind;
	label: string;
	bytes: number;
	text: string;
	/** The view line's node. */
	part?: Part;
	/** Index of the context message it is in. */
	msg: number;
};

function seg(kind: SegmentKind, label: string, text: string, msg: number, extra: Partial<Segment> = {}): Segment {
	return { kind, label, bytes: nbytes(text), text, msg, ...extra };
}

function toolText(tool: Tool): string {
	return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }, null, 2);
}

/** The `<chat>` block's lines, each a view segment with its node. */
function viewLines(block: string, msg: number): Segment[] {
	const out: Segment[] = [];
	for (const line of block.split("\n")) {
		if (line === "") continue;
		const m = /^(\d+)\+(\d+)\|/.exec(line);
		if (m === null) {
			out.push(seg("other", "view", `${line}\n`, msg));
			continue;
		}
		const id = Number(m[1]);
		const n = Number(m[2]);
		const level = Math.round(Math.log2(n));
		out.push(seg("view", `${id}+${n}`, `${line}\n`, msg, { part: [level, Math.floor(id / n)] }));
	}
	return out;
}

/** The first user message of a turn or a compaction: the view, then what follows it. */
function firstUser(text: string, msg: number): Segment[] {
	const close = text.indexOf("\n</chat>\n");
	if (!text.startsWith("<chat>\n") || close < 0) return [seg("input", "message", text, msg)];
	const out: Segment[] = [seg("other", "<chat>", "<chat>\n", msg), ...viewLines(text.slice(7, close + 1), msg), seg("other", "</chat>", "</chat>\n", msg)];
	const tail = text.slice(close + "\n</chat>\n".length);
	if (tail.startsWith("Compaction:")) {
		const open = tail.indexOf("<input>\n");
		const task = open < 0 ? tail : tail.slice(0, open + "<input>\n".length);
		const source = open < 0 ? "" : tail.slice(open + "<input>\n".length);
		const what = /^Compaction: (compress message \d+|merge lines \S+ and [^,\s]+)/.exec(tail)?.[1] ?? "compaction";
		out.push(seg("task", what, task, msg));
		if (source !== "") out.push(seg("source", "<input>", source, msg));
		return out;
	}
	const at = tail.indexOf(HEAD);
	if (at < 0) {
		if (tail !== "") out.push(seg("input", "message", tail, msg));
		return out;
	}
	if (at > 0) out.push(seg("state", "state", tail.slice(0, at), msg));
	out.push(seg("head", "turn header", HEAD, msg));
	out.push(seg("input", "your message", tail.slice(at + HEAD.length), msg));
	return out;
}

function userText(message: Message & { role: "user" | "toolResult" }): { text: string; images: number } {
	if (typeof message.content === "string") return { text: message.content, images: 0 };
	let text = "";
	let images = 0;
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
		else images += 1;
	}
	return { text, images };
}

/** The context's segments, in the order the model reads them. */
export function segmentsOf(context: Pick<Context, "messages" | "systemPrompt" | "tools">): Segment[] {
	const out: Segment[] = [];
	if (context.systemPrompt) out.push(seg("prompt", "system prompt", context.systemPrompt, -1));
	for (const tool of context.tools ?? []) out.push(seg("tool", tool.name, toolText(tool), -1));
	const compaction = context.messages.some(
		(m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<chat>\n") && m.content.includes("\n</chat>\nCompaction:"),
	);
	let firstSeen = false;
	context.messages.forEach((message, k) => {
		switch (message.role) {
			case "system": {
				const content = typeof message.content === "string" ? message.content : message.content.map((b) => b.text).join("");
				if (content !== "") out.push(seg("prompt", "system", content, k));
				for (const [name, text] of Object.entries(message.sections ?? {})) {
					if (text === null || text === undefined) continue;
					out.push(seg(name === "prompt" ? "prompt" : "section", name, text, k));
				}
				for (const tool of message.toolsAdded ?? []) out.push(seg("tool", tool.name, toolText(tool), k));
				break;
			}
			case "user": {
				const { text, images } = userText(message);
				if (!firstSeen) {
					firstSeen = true;
					out.push(...firstUser(text, k));
				} else if (compaction) out.push(seg("retry", text.startsWith("Too long") ? "too long" : "retry", text, k));
				else if (/^\[[^\]\n]+\]/.test(text)) out.push(seg("work", /^\[([^\]\n]+)\]/.exec(text)![1]!, text, k));
				else out.push(seg("steer", "message", text, k));
				for (let i = 0; i < images; i++) out.push({ kind: "other", label: "image", bytes: 0, text: "(an image)", msg: k });
				break;
			}
			case "assistant": {
				for (const block of message.content) {
					if (block.type === "text") out.push(seg("assistant", "reply", block.text, k));
					else if (block.type === "thinking") {
						const shown = block.thinking !== "" ? block.thinking : "(reasoning the provider keeps encrypted)";
						const signature = (block as { thinkingSignature?: string }).thinkingSignature ?? "";
						out.push({ ...seg("thinking", "thinking", shown, k), bytes: nbytes(block.thinking) + nbytes(signature) });
					} else if (block.type === "toolCall") out.push(seg("call", block.name, JSON.stringify(block.arguments, null, 2), k));
				}
				break;
			}
			case "toolResult": {
				const { text } = userText(message);
				out.push(seg("result", message.toolName, text, k));
				break;
			}
		}
	});
	return out;
}
