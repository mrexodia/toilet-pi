/**
 * The memory's operations on its state: what the transcript's entries mean as messages, and the pure steps of
 * optchat.md over `ChatState`: queue a message, store a node, pick what to build, fit the views.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ChatState, Kind, MessageState, NoteData } from "./docs.ts";
import { LEAF, MERGE } from "./prompt.ts";
import {
	clipPages,
	ctx,
	flat,
	held,
	JOBS,
	key,
	limits,
	merge,
	nbytes,
	type Part,
	parent,
	reach,
	sibling,
	span,
	vsize,
} from "./tree.ts";

export const NOTE_KIND = "optchat.note";

// ---------------------------------------------------------------- entries as messages

/** The text of a user or tool-result message's content. */
export function contentText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** The kind and text of block `block` of an entry, or undefined when the entry has no such message. */
export function blockOf(entry: EntryRecord, block: number): { kind: Kind; text: string; date: number } | undefined {
	if (entry.kind === NOTE_KIND) {
		const data = entry.data as NoteData | undefined;
		return block === 0 && data !== undefined ? { kind: "note", text: data.text, date: data.date } : undefined;
	}
	const message = entry.model?.[0];
	if (message === undefined) return undefined;
	if (message.role === "user") {
		if (block !== 0) return undefined;
		const text = contentText(message.content);
		return { kind: /^\[[^\]\n]+\]/.test(text) ? "work" : "user", text, date: message.timestamp };
	}
	if (message.role === "toolResult") {
		return block === 0 ? { kind: "echo", text: contentText(message.content), date: message.timestamp } : undefined;
	}
	if (message.role === "assistant") {
		const part = message.content[block];
		if (part === undefined) return undefined;
		if (part.type === "text") return { kind: "optchat", text: part.text, date: message.timestamp };
		if (part.type === "toolCall") {
			return { kind: "tool", text: `${part.name} ${JSON.stringify(part.arguments)}`, date: message.timestamp };
		}
	}
	return undefined;
}

/** Every message an entry contributes to the log, in order: thoughts are never logged, blank texts neither. */
export function blocksOf(entry: EntryRecord): { kind: Kind; text: string; block: number; date: number }[] {
	const count = entry.model?.[0]?.role === "assistant" ? (entry.model[0] as { content: unknown[] }).content.length : 1;
	const out: { kind: Kind; text: string; block: number; date: number }[] = [];
	for (let block = 0; block < count; block++) {
		const found = blockOf(entry, block);
		if (found === undefined) continue;
		if (found.kind === "optchat" && found.text.trim() === "") continue;
		out.push({ ...found, block });
	}
	return out;
}

/** The message records of one block: one per page of its text. */
export function pagesOf(entryId: number, found: ReturnType<typeof blocksOf>[number]): MessageState[] {
	const pages = clipPages(found.text);
	return pages.map((page, k) => ({
		entry: entryId,
		block: found.block,
		page: k,
		kind: found.kind,
		size: nbytes(`${found.kind}: ${page}`),
		date: found.date,
		more: k < pages.length - 1,
	}));
}

/** A message's text, from its entry and record. */
export function pageText(entry: EntryRecord, record: MessageState): string | undefined {
	const found = blockOf(entry, record.block);
	return found === undefined ? undefined : clipPages(found.text)[record.page];
}

/** A message as its level-0 source. */
export function show(kind: Kind, text: string): string {
	return `${kind}: ${text}`;
}

export function mergeSource(a: string, b: string): string {
	return `${flat(a)}\n${flat(b)}`;
}

/** The start of a text, to recognize it later. */
export function headOf(text: string): string {
	return text.slice(0, 200);
}

// ---------------------------------------------------------------- the state

export function built(chat: ChatState, p: Part): boolean {
	return key(p) in chat.sizes;
}

export function readySet(chat: ChatState, p: Part, on: boolean): void {
	const [l, i] = p;
	while (chat.ready.length <= l) chat.ready.push([]);
	const q = chat.ready[l]!;
	let a = 0;
	let z = q.length;
	while (a < z) {
		const m = (a + z) >> 1;
		if (q[m]! < i) a = m + 1;
		else z = m;
	}
	const present = a < q.length && q[a] === i;
	if (on && !present) q.splice(a, 0, i);
	else if (present && !on) q.splice(a, 1);
}

/** The k-th unbuilt message's id, or count. */
export function first(chat: ChatState, k = 0): number {
	const q = chat.ready[0] ?? [];
	return k < q.length ? q[k]! : chat.count;
}

export function pending(chat: ChatState): number {
	let n = 0;
	for (const q of chat.ready) n += q.length;
	return n;
}

export function idle(chat: ChatState): boolean {
	return pending(chat) === 0 && Object.keys(chat.busy).length === 0;
}

/** Append indexed messages: each gets its line in the views and its node is queued. */
export function appendMessages(chat: ChatState, n: number): number[] {
	const ids: number[] = [];
	for (let k = 0; k < n; k++) {
		ids.push(chat.count);
		readySet(chat, [0, chat.count], true);
		chat.count += 1;
	}
	fit(chat, true);
	return ids;
}

/** Record a built node: its size, its queue slot, and the parent it completes. True when it was new. */
export function storeNode(chat: ChatState, p: Part, text: string): boolean {
	delete chat.busy[key(p)];
	if (built(chat, p)) return false;
	chat.sizes[key(p)] = nbytes(text);
	readySet(chat, p, false);
	const up = parent(p);
	if (built(chat, sibling(p)) && !built(chat, up)) readySet(chat, up, true);
	return true;
}

/** The ready nodes whose turn it is, oldest context first, merges before messages at equal context. */
export function candidates(chat: ChatState): Part[] {
	const end = first(chat, JOBS - 1);
	const next: Part[] = [];
	chat.ready.forEach((q, l) => {
		for (const i of q) {
			if (ctx([l, i]) > end) break;
			next.push([l, i]);
		}
	});
	next.sort((a, b) => ctx(a) - ctx(b) || b[0] - a[0]);
	return next.filter((p) => !(key(p) in chat.busy));
}

export function running(chat: ChatState): number {
	return Object.keys(chat.busy).length;
}

/** Grow each view by the new lines, and merge in a batch once it passes its ceiling (optchat.md 3.2). */
export function fit(chat: ChatState, next = false): void {
	reach(chat.view, chat.count);
	reach(chat.seen, Math.min(chat.count, first(chat)));
	const gone: Part[] = [];
	let chatMerged = false;
	for (const [view, high] of [
		[chat.view, limits.high],
		[chat.seen, limits.seen],
	] as const) {
		let size = vsize(chat.sizes, view.parts);
		// The compactions' view merges on its own ceiling, and again whenever the chat's view merges.
		if (size > high || (next && view.batch) || (view === chat.seen && chatMerged)) {
			const merged = merge(view.parts, chat.sizes, high / 2);
			if (next || merged.size <= Math.max(high / 2, size - high) || (view === chat.seen && chatMerged)) {
				if (view === chat.view && merged.parts.length !== view.parts.length) chatMerged = true;
				view.parts = merged.parts;
				gone.push(...merged.gone);
				size = merged.size;
			}
			view.batch = size > high / 2;
		}
	}
	for (const p of gone) if (!held([chat.view.parts, chat.seen.parts], p)) delete chat.sizes[key(p)];
}

/** The compaction task for a node, filled in. */
export function taskOf(p: Part): string {
	const [l] = p;
	const [a, z] = span(p);
	const n = 2 ** l / 2;
	const fill: Record<string, string> = { "{a}": `${a}+${n}`, "{b}": `${a + n}+${n}`, "{id}": String(a), "{end}": String(z) };
	let text = l === 0 ? LEAF : MERGE;
	for (const [k, v] of Object.entries(fill)) text = text.replace(k, v);
	return text;
}

/** The parts of a view that end before message `upto`. */
export function before(parts: readonly Part[], upto: number): Part[] {
	return parts.filter((p) => span(p)[1] < upto);
}
