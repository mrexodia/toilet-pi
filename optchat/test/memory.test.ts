// The memory on a durable conversation, with a faux model: indexing, building, merging, turns, restarts.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
	type FauxResponseFactory,
	type Message,
} from "@earendil-works/pi-ai";
import { type Conversation, createRegistry, Harness, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeDoc, Optchat, tree } from "../src/optchat/index.ts";
import { contentText } from "../src/optchat/memory.ts";
import { HEAD } from "../src/optchat/prompt.ts";

const context = BACKGROUND_CONTEXT;
const { cut, flat, halves, key, nbytes, roots, span } = tree;

function text(message: Message | undefined): string {
	return message === undefined || message.role === "system" ? "" : contentText(message.content as Message["content"]);
}

/** A model that compresses deterministically, answers over the limit one time in five, and replies to turns. */
function fauxModel(seen: string[]): { faux: FauxProviderHandle; models: ReturnType<typeof createModels> } {
	let calls = 0;
	const factory: FauxResponseFactory = (transcript) => {
		calls += 1;
		const messages = transcript.messages;
		const last = text(messages[messages.length - 1]);
		if (last.startsWith("Too long")) {
			const line = text(messages[messages.length - 2]);
			return fauxAssistantMessage(`shorter: ${cut(line).slice(0, 200)}`);
		}
		if (last.startsWith("<chat>\n") && last.includes("\nCompaction: ")) {
			assert.ok(last.includes("</chat>\n") && last.endsWith("</input>"), last.slice(0, 200));
			const body = last.split("<input>\n", 2)[1]!.replace(/\n<\/input>$/, "");
			const line = `S[${flat(body)}`;
			if (calls % 5 === 0) return fauxAssistantMessage(line.slice(0, 650).padEnd(650, "x"));
			return fauxAssistantMessage(`${cut(line.slice(0, 480))}]`);
		}
		seen.push(text(messages.find((m) => m.role === "user")));
		return fauxAssistantMessage(`ok: ${last.slice(-30)}`);
	};
	const faux = fauxProvider();
	faux.appendResponses(Array.from({ length: 5000 }, () => factory));
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

async function open(storage: Storage, models: ReturnType<typeof createModels>, home: string) {
	const registry = createRegistry();
	Optchat.install(registry, { home });
	const reports: unknown[] = [];
	const harness = await Harness.open(storage, { models, registry, onReport: (e) => reports.push(e) }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: home } });
	const optchat = new Optchat(harness, root, { home, onReport: (e) => reports.push(e) });
	harness.resume();
	await optchat.start();
	return { harness, root, optchat, reports };
}

function random(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return s / 0x7fffffff;
	};
}

async function fill(optchat: Optchat, n: number, rng: () => number): Promise<void> {
	const alphabet = "abcdefgh \n";
	for (let k = 0; k < n; k++) {
		const size = [20, 100, 400, 700, 2000][Math.floor(rng() * 5)]!;
		let body = "";
		for (let c = 0; c < size; c++) body += alphabet[Math.floor(rng() * alphabet.length)];
		await (await optchat.note(`m${k} ${body}`)).wait(context);
	}
}

async function checkTree(harness: Harness, root: Conversation, count: number): Promise<number> {
	let nodes = 0;
	for (const r of roots(count)) {
		const stack = [r];
		while (stack.length > 0) {
			const p = stack.pop()!;
			const node = await harness.snapshot(NodeDoc, root.id, key(p), context);
			assert.ok(node !== undefined && node.text !== "", `node ${key(p)} unbuilt`);
			assert.ok(nbytes(node.text) <= 512 + 8, `node ${key(p)} is ${nbytes(node.text)} bytes`);
			nodes += 1;
			stack.push(...halves(p));
		}
	}
	return nodes;
}

function checkView(parts: readonly tree.Part[], sizes: Record<string, number>, count: number, high: number): void {
	let at = 0;
	for (const p of parts) {
		const [a, z] = span(p);
		assert.equal(a, at, `gap at ${at}`);
		assert.ok(key(p) in sizes, `part ${key(p)} has no size`);
		at = z + 1;
	}
	assert.equal(at, count);
	assert.ok(tree.vsize(sizes, parts) <= high);
}

let home: string;
before(async () => {
	home = await mkdtemp(join(tmpdir(), "optchat-agent-"));
	tree.limits.high = 20_000;
	tree.limits.seen = 10_000;
});
after(async () => {
	tree.limits.high = tree.HIGH;
	tree.limits.seen = tree.SEEN;
	await rm(home, { recursive: true, force: true }).catch(() => {});
});

test("notes and turns are indexed, built, merged and zoomable", async () => {
	const seen: string[] = [];
	const { models } = fauxModel(seen);
	const { harness, root, optchat, reports } = await open(new MemoryStorage(), models, home);
	const rng = random(1);
	await fill(optchat, 120, rng);
	await (await optchat.note("L".repeat(70_000))).wait(context);
	await fill(optchat, 40, rng);
	const submission = await optchat.turn("hello there");
	const settled = await submission.wait(context);
	assert.equal(settled.status, "done");
	await optchat.idle();
	const chat = await optchat.state();
	assert.deepEqual(reports, []);
	assert.equal(chat.count, 120 + 3 + 40 + 2);
	assert.equal(chat.ready.reduce((n, q) => n + q.length, 0), 0);
	assert.deepEqual(chat.busy, {});
	checkView(chat.view.parts, chat.sizes, chat.count, tree.limits.high);
	checkView(chat.seen.parts, chat.sizes, chat.count, tree.limits.seen);
	assert.ok(chat.view.parts.some((p) => p[0] > 0), "nothing merged");
	assert.ok(chat.view.parts.length > chat.seen.parts.length);
	const nodes = await checkTree(harness, root, chat.count);
	assert.ok(nodes > chat.count);
	// the turn's request: [system] [view + state + header + message]
	assert.equal(seen.length, 1);
	assert.ok(seen[0]!.startsWith("<chat>\n"), seen[0]!.slice(0, 100));
	assert.ok(seen[0]!.includes("\n</chat>\nNow: "));
	assert.ok(seen[0]!.endsWith(`${HEAD}hello there`));
	const viewLines = seen[0]!.split("</chat>")[0]!.split("\n").length - 2;
	assert.ok(viewLines >= 1 && viewLines <= chat.view.parts.length);
	// the paged note: three messages, the first two continued
	const page = await optchat.zoom(120, 1);
	assert.ok(page.startsWith("120+1|note: LLLL"));
	assert.ok(!page.includes("go on with at"));
	// the kinds of the turn's messages
	assert.ok((await optchat.zoom(chat.count - 2, 1)).startsWith(`${chat.count - 2}+1|user: hello there`));
	assert.ok((await optchat.zoom(chat.count - 1, 1)).startsWith(`${chat.count - 1}+1|optchat: ok:`));
	assert.equal((await optchat.zoom(0, 2)).split("\n").length, 2);
	assert.match(await optchat.zoom(3, 2), /^No line/);
	assert.match(await optchat.date(0), /^\d{4}-\d{2}-\d{2}T/);
	// short messages are their own nodes, word for word
	const short = await harness.snapshot(NodeDoc, root.id, key([0, chat.count - 2]), context);
	assert.equal(short?.text, "note: m0 ".length > 0 ? short?.text : "");
	assert.equal((await harness.snapshot(NodeDoc, root.id, key([0, chat.count - 2]), context))?.text, "user: hello there");
	await optchat.stop();
	await harness.close(context);
});

test("a restart keeps the view and finishes the builds it interrupted", async () => {
	const seen: string[] = [];
	const { models } = fauxModel(seen);
	const file = join(home, "restart.sqlite");
	const first = await open(await openNodeSqliteStorage(file), models, home);
	await fill(first.optchat, 60, random(2));
	await first.optchat.flush();
	const before = await first.optchat.state();
	assert.equal(before.count, 60);
	await first.optchat.stop();
	await first.harness.close(context);
	const second = await open(await openNodeSqliteStorage(file), models, home);
	await second.optchat.idle();
	const after = await second.optchat.state();
	assert.equal(after.count, 60);
	assert.deepEqual(after.busy, {});
	assert.equal(after.ready.reduce((n, q) => n + q.length, 0), 0);
	checkView(after.view.parts, after.sizes, 60, tree.limits.high);
	await checkTree(second.harness, second.root, 60);
	// what was already merged before the restart is still merged: the view was never rebuilt
	for (const p of before.view.parts) {
		if (p[0] === 0) continue;
		assert.ok(
			after.view.parts.some((q) => q[0] >= p[0] && span(q)[0] <= span(p)[0] && span(q)[1] >= span(p)[1]),
			`part ${key(p)} was split after the restart`,
		);
	}
	assert.deepEqual(second.reports, []);
	await second.optchat.stop();
	await second.harness.close(context);
});
