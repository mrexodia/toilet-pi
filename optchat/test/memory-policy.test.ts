import assert from "node:assert/strict";
import { test } from "node:test";
import { initialChat } from "../src/optchat/docs.ts";
import { appendMessages, fit, storeNode } from "../src/optchat/memory.ts";
import { key, limits, merge, parent, type Part, span, viewEnd, vsize } from "../src/optchat/tree.ts";

test("the chat and compactor views merge on independent ceilings", () => {
	const saved = { ...limits };
	try {
		limits.high = 600;
		limits.seen = 500;
		const chat = initialChat();
		chat.count = 8;
		chat.view.parts = Array.from({ length: 8 }, (_, i) => [0, i]);
		chat.seen.parts = Array.from({ length: 4 }, (_, i) => [1, i]);
		for (let l = 0; l <= 3; l++) for (let i = 0; i < 8 / 2 ** l; i++) chat.sizes[key([l, i])] = 100;
		const seen = structuredClone(chat.seen);
		fit(chat);
		assert.ok(vsize(chat.sizes, chat.view.parts) <= limits.high / 2);
		assert.deepEqual(chat.seen, seen, "an unrelated chat batch rewrote the compactor prefix");
	} finally {
		Object.assign(limits, saved);
	}
});

/** Deliberately slow, independent oracle for UniiChat's most-due-pair rule. */
function oracle(input: Part[], sizes: Record<string, number>, low: number): Part[] {
	const parts = [...input];
	const t = viewEnd(parts);
	while (vsize(sizes, parts) > low) {
		let best = -1;
		let due = -Infinity;
		for (let k = 0; k + 1 < parts.length; k++) {
			const a = parts[k]!;
			const b = parts[k + 1]!;
			if (a[1] % 2 || a[0] !== b[0] || b[1] !== a[1] + 1 || !(key(parent(a)) in sizes)) continue;
			const d = (t + 1) / 2 ** a[0] - a[1];
			if (d > due) { best = k; due = d; }
		}
		if (best < 0) break;
		parts.splice(best, 2, parent(parts[best]!));
	}
	return parts;
}

test("decay heap agrees with the current UniiChat rule for uneven sizes and unavailable parents", () => {
	let seed = 42;
	const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
	for (let trial = 0; trial < 1000; trial++) {
		const count = 2 + Math.floor(rand() * 126);
		const parts: Part[] = Array.from({ length: count }, (_, i) => [0, i]);
		const sizes: Record<string, number> = {};
		for (let l = 0; 2 ** l <= count; l++) for (let i = 0; (i + 1) * 2 ** l <= count; i++) {
			if (l === 0 || rand() > 0.25) sizes[key([l, i])] = 20 + Math.floor(rand() * 493);
		}
		const low = Math.floor(rand() * vsize(sizes, parts));
		const result = merge(parts, sizes, low);
		assert.deepEqual(result.parts, oracle(parts, sizes, low));
		assert.equal(result.size, vsize(sizes, result.parts));
		let end = 0;
		for (const p of result.parts) { assert.equal(span(p)[0], end); end = span(p)[1] + 1; }
		assert.equal(end, count);
	}
});

test("out-of-order completed summaries keep both views contiguous and bounded after batches", () => {
	const saved = { ...limits };
	try {
		limits.high = 4000;
		limits.seen = 2000;
		const chat = initialChat();
		appendMessages(chat, 128);
		// The odd leaves finish before the even leaves. No missing prefix may be silently crossed by seen.
		for (const parity of [1, 0]) for (let i = parity; i < 128; i += 2) {
			storeNode(chat, [0, i], "x".repeat(200));
			fit(chat);
			if (parity === 1) assert.equal(viewEnd(chat.seen.parts), 0);
		}
		for (let l = 1; l <= 7; l++) for (let i = 0; i < 128 / 2 ** l; i++) {
			storeNode(chat, [l, i], "x".repeat(200));
			fit(chat);
		}
		for (const [view, high] of [[chat.view, limits.high], [chat.seen, limits.seen]] as const) {
			let end = 0;
			for (const p of view.parts) {
				assert.equal(span(p)[0], end);
				assert.ok(key(p) in chat.sizes);
				end = span(p)[1] + 1;
			}
			assert.equal(end, 128);
			assert.ok(vsize(chat.sizes, view.parts) <= high);
		}
	} finally {
		Object.assign(limits, saved);
	}
});
