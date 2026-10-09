/**
 * The tree and the view of optchat.md, as pure functions.
 *
 * A part is `[l, i]`: node(l, i) covers the 2^l messages from i*2^l on, and the model names it "id+n". Level 0 is a
 * message; level l merges (l-1, 2i) and (l-1, 2i+1). Sizes are UTF-8 bytes, never tokens.
 */

export type Part = [number, number];

export const NODE = 512; // a node's limit, in bytes
export const HIGH = 128_000; // the view merges once it passes this, down to HIGH/2
export const SEEN = 32_000; // the compactions' view: the same sawtooth, a quarter the size
/** The views' ceilings, adjustable for tests. */
export const limits = { high: HIGH, seen: SEEN };
export const JOBS = 8; // compactions running at once
export const TRIES = 5; // attempts at a line under NODE bytes
export const CAP = 30_000; // a tool output's limit, and a page of a long text, in characters

export const WAIT = "(not summarized yet: zoom it)";

// ---------------------------------------------------------------- text

const encoder = new TextEncoder();

export function nbytes(s: string): number {
	return encoder.encode(s).length;
}

/** A node as one line: newlines, with the space around them, become spaces. */
export function flat(s: string): string {
	return s.includes("\n") ? s.replace(/\s*\n\s*/g, " ") : s;
}

/** The first NODE bytes of s, on a character boundary. */
export function cut(s: string, limit = NODE): string {
	const bytes = encoder.encode(s);
	if (bytes.length <= limit) return s;
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, limit)).replace(/�+$/u, "");
}

/** A tool output: its head and tail, `cap` characters in all. */
export function clip(s: string, cap = CAP): string {
	if (s.length <= cap) return s;
	const half = Math.floor(cap / 2);
	const keep = half - 64;
	const gone = s.length - half - keep;
	return `${s.slice(0, half)}\n[... ${gone} characters cut ...]\n${s.slice(s.length - keep)}`;
}

/** Where the page of s starting at `at` ends: CAP characters, at a newline if one is near. */
export function clipEnd(s: string, at: number): number {
	if (s.length - at <= CAP) return s.length;
	const nl = s.lastIndexOf("\n", at + CAP - 1);
	return nl >= at ? nl + 1 : at + CAP;
}

/** A long text as pages of at most CAP characters. "" is one empty page. */
export function clipPages(s: string): string[] {
	const pages: string[] = [];
	let at = 0;
	for (;;) {
		const end = clipEnd(s, at);
		pages.push(s.slice(at, end));
		at = end;
		if (at >= s.length) return pages;
	}
}

/** One page of s from character `at`, saying where to go on. */
export function clipPage(s: string, at: number): string {
	const from = Math.max(0, Math.min(Math.floor(at), s.length));
	const end = clipEnd(s, from);
	const more = `\n[characters ${from + 1}-${end} of ${s.length}; go on with at ${end}]`;
	return s.slice(from, end) + (end < s.length ? more : "");
}

// ---------------------------------------------------------------- parts

export function span(p: Part): [number, number] {
	const [l, i] = p;
	const a = i * 2 ** l;
	return [a, a + 2 ** l - 1];
}

export function ref(p: Part): string {
	const [l, i] = p;
	return `${i * 2 ** l}+${2 ** l}`;
}

export function key(p: Part): string {
	return `${p[0]}/${p[1]}`;
}

export function halves(p: Part): Part[] {
	const [l, i] = p;
	return l === 0 ? [] : [[l - 1, 2 * i], [l - 1, 2 * i + 1]];
}

export function parent(p: Part): Part {
	return [p[0] + 1, p[1] >> 1];
}

export function sibling(p: Part): Part {
	return [p[0], p[1] ^ 1];
}

/** The messages a compaction of p may see: those before message i, or up to a merge's end. */
export function ctx(p: Part): number {
	const [l, i] = p;
	return l === 0 ? i : (i + 1) * 2 ** l;
}

/** The largest aligned nodes covering [0, count): one per bit of count. */
export function roots(count: number): Part[] {
	const out: Part[] = [];
	let at = 0;
	for (let l = 30; l >= 0; l--) {
		if (at + 2 ** l <= count) {
			out.push([l, at / 2 ** l]);
			at += 2 ** l;
		}
	}
	return out;
}

export function samePart(a: Part, b: Part): boolean {
	return a[0] === b[0] && a[1] === b[1];
}

// ---------------------------------------------------------------- the view

/** A list of parts covering the chat, oldest first, bounded in bytes. */
export type ViewState = {
	parts: Part[];
	/** Merging at each message, until the floor is reached. */
	batch: boolean;
};

export function viewEnd(parts: readonly Part[]): number {
	return parts.length === 0 ? 0 : span(parts[parts.length - 1]!)[1] + 1;
}

/** The index of the first part whose span reaches message `id`. */
export function cover(parts: readonly Part[], id: number): number {
	let a = 0;
	let z = parts.length;
	while (a < z) {
		const m = (a + z) >> 1;
		if (span(parts[m]!)[1] < id) a = m + 1;
		else z = m;
	}
	return a;
}

/** Cut the view at `end`, then append a line per message up to it. */
export function reach(view: ViewState, end: number): void {
	view.parts.splice(cover(view.parts, end));
	for (let i = viewEnd(view.parts); i < end; i++) view.parts.push([0, i]);
}

/** Sizes of the built nodes a view may need: its parts, their ancestors, and nodes just built. */
export type Sizes = Readonly<Record<string, number>>;

export function psize(sizes: Sizes, p: Part): number {
	return sizes[key(p)] ?? 0;
}

export function vsize(sizes: Sizes, parts: readonly Part[]): number {
	let n = 0;
	for (const p of parts) n += psize(sizes, p);
	return n;
}

type Heap = { d: number; k: number; a: Part; b: Part }[];

function heapLess(x: Heap[number], y: Heap[number]): boolean {
	return x.d > y.d || (x.d === y.d && x.k < y.k);
}

function heapPush(heap: Heap, item: Heap[number]): void {
	heap.push(item);
	for (let x = heap.length - 1; x > 0; ) {
		const up = (x - 1) >> 1;
		if (!heapLess(heap[x]!, heap[up]!)) break;
		[heap[x], heap[up]] = [heap[up]!, heap[x]!];
		x = up;
	}
}

function heapPop(heap: Heap): Heap[number] {
	const top = heap[0]!;
	const last = heap.pop()!;
	if (heap.length > 0) {
		heap[0] = last;
		for (let x = 0; ; ) {
			let m = x;
			for (const c of [2 * x + 1, 2 * x + 2]) if (c < heap.length && heapLess(heap[c]!, heap[m]!)) m = c;
			if (m === x) break;
			[heap[x], heap[m]] = [heap[m]!, heap[x]!];
			x = m;
		}
	}
	return top;
}

/**
 * Merge the most due sibling pairs whose parent is built until the view is at most `low` bytes. A pair's due is
 * `(T + 1) / 2^l - i`: how long ago it ended, in its own line size; ties go to the oldest pair.
 */
export function merge(
	parts: readonly Part[],
	sizes: Sizes,
	low: number,
	built: (p: Part) => boolean = (p) => Object.hasOwn(sizes, key(p)),
): { parts: Part[]; size: number; gone: Part[] } {
	const t = viewEnd(parts);
	const list: (Part | null)[] = [...parts];
	const n = list.length;
	const next = list.map((_, k) => k + 1);
	const prev = list.map((_, k) => k - 1);
	const heap: Heap = [];
	const gone: Part[] = [];
	const offer = (k: number): void => {
		if (k < 0 || k >= n || list[k] === null) return;
		const j = next[k]!;
		if (j >= n || list[j] === null) return;
		const a = list[k]!;
		const b = list[j]!;
		if (a[1] % 2 !== 0 || b[0] !== a[0] || b[1] !== a[1] + 1 || !built(parent(a))) return;
		heapPush(heap, { d: (t + 1) / 2 ** a[0] - a[1], k, a, b });
	};
	let size = vsize(sizes, parts);
	for (let k = 0; k < n; k++) offer(k);
	while (heap.length > 0 && size > low) {
		const { k, a, b } = heapPop(heap);
		const j = next[k]!;
		if (list[k] === null || !samePart(list[k]!, a) || j >= n || list[j] === null || !samePart(list[j]!, b)) continue;
		const up = parent(a);
		size += psize(sizes, up) - psize(sizes, a) - psize(sizes, b);
		list[k] = up;
		list[j] = null;
		next[k] = next[j]!;
		if (next[j]! < n) prev[next[j]!] = k;
		gone.push(a, b);
		offer(prev[k]!);
		offer(k);
	}
	return { parts: list.filter((p): p is Part => p !== null), size, gone };
}

/** Whether p is a part of one of the views, or an ancestor of one, so its size stays known. */
export function held(views: readonly (readonly Part[])[], p: Part): boolean {
	const a = span(p)[0];
	for (const parts of views) {
		const k = cover(parts, a);
		if (k === parts.length || parts[k]![0] <= p[0]) return true;
	}
	return false;
}

/** The view's lines for the parts ending before message `upto`, each `id+n|text`. */
export function lines(parts: readonly Part[], upto: number, textOf: (p: Part) => string | undefined): string[] {
	const out: string[] = [];
	for (const p of parts) {
		if (span(p)[1] >= upto) break;
		const text = textOf(p);
		if (text !== undefined) out.push(`${ref(p)}|${flat(text)}`);
	}
	return out;
}

export function chatBlock(lines: readonly string[]): string {
	return `<chat>\n${lines.map((line) => `${line}\n`).join("")}</chat>\n`;
}
