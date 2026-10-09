// The tree and the view: the merge order against Taelin's rollback push, and the text helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, clipPages, cut, flat, merge, nbytes, type Part, ref, roots, span, viewEnd } from "../src/optchat/tree.ts";

type States = { keep: number; state: number; older: States | null } | null;

/** rollback_state_list.js (2022), with life always 0. */
function push(state: number, states: States): States {
	if (states === null) return { keep: 0, state, older: null };
	if (states.keep === 0) return { keep: 1, state: states.state, older: states.older };
	return { keep: 0, state, older: push(states.state, states.older) };
}

/** The list read as a view: each state starts a line that runs to the next newer one. */
function pushLines(states: States, count: number): Part[] {
	const starts: number[] = [];
	for (let s = states; s !== null; s = s.older) starts.push(s.state);
	starts.reverse();
	return starts.map((a, k) => {
		const end = k + 1 < starts.length ? starts[k + 1]! : count;
		const n = end - a;
		const l = Math.log2(n);
		assert.ok(Number.isInteger(l) && a % n === 0, `${a}+${n}`);
		return [l, a / n] as Part;
	});
}

test("the merge order matches the rollback push at every step", () => {
	let states: States = null;
	let parts: Part[] = [];
	for (let t = 0; t < 4000; t++) {
		states = push(t, states);
		const want = pushLines(states, t + 1);
		parts.push([0, t]);
		// Every parent is built and every line weighs 1: merge by line count down to the push list's length.
		const sizes = Object.fromEntries(parts.map((p) => [`${p[0]}/${p[1]}`, 1]));
		parts = merge(parts, sizes, want.length, () => true).parts;
		assert.deepEqual(parts, want, `at t=${t}`);
	}
	assert.equal(viewEnd(parts), 4000);
});

test("the push examples of optchat.md", () => {
	let states: States = null;
	const shown: Record<number, string[]> = {};
	for (let t = 0; t < 10; t++) {
		states = push(t, states);
		shown[t] = pushLines(states, t + 1).map(ref);
	}
	assert.deepEqual(shown[9], ["0+4", "4+4", "8+2"]);
	assert.deepEqual(shown[4], ["0+4", "4+1"]);
});

test("roots and spans", () => {
	assert.deepEqual(roots(0), []);
	assert.deepEqual(roots(13), [
		[3, 0],
		[2, 2],
		[0, 12],
	]);
	assert.deepEqual(roots(13).map(span), [
		[0, 7],
		[8, 11],
		[12, 12],
	]);
});

test("text helpers", () => {
	assert.equal(clip("short"), "short");
	const long = "x".repeat(100_000);
	assert.ok(clip(long).length <= 30_000 + 60);
	assert.match(clip(long), /characters cut/);
	assert.deepEqual(clipPages(""), [""]);
	const lines = "line\n".repeat(20_000);
	const pages = clipPages(lines);
	assert.equal(pages.join(""), lines);
	assert.ok(pages.every((p) => p.length <= 30_000));
	assert.ok(pages.slice(0, -1).every((p) => p.endsWith("\n")));
	assert.ok(nbytes(cut("é".repeat(600))) <= 512);
	assert.equal(flat("a \n  b\nc"), "a b c");
});
