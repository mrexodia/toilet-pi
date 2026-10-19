import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createModels, Type } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { cacheView, withMemoryCache } from "../src/optchat/cache.ts";
import { chatBlock } from "../src/optchat/tree.ts";

const mark = { type: "ephemeral", ttl: "1h" };
function payload(lines: string[], task = "Now: different every turn\nTurn: hello") {
	return {
		system: [{ type: "text", text: "identity", cache_control: mark }, { type: "text", text: "system", cache_control: mark }],
		tools: [{ name: "zoom", cache_control: mark }],
		messages: [{ role: "user", content: [{ type: "text", text: chatBlock(lines) + task, cache_control: mark }] }],
	};
}
function blocks(body: ReturnType<typeof payload>) {
	return [...body.tools, ...body.system, ...body.messages.flatMap((m) => m.content)];
}

for (const n of [0, 1, 3, 4, 5, 8, 9]) {
	test(`Anthropic's ${n}-line view preserves text and marks only the last whole four-line block`, () => {
		const lines = Array.from({ length: n }, (_, k) => `${k}+1|note: text ${k}`);
		for (const task of ["Now: today\nTurn: hello", "Compaction: compress message 20"] ) {
			const body = payload(lines, task);
			const original = body.messages[0]!.content.map((b) => b.text).join("");
			cacheView(body);
			const content = body.messages[0]!.content;
			assert.equal(content.map((b) => b.text).join(""), original);
			const marked = content.filter((b) => b.cache_control !== undefined);
			assert.equal(marked.length, task.startsWith("Compaction:") ? 1 : 2);
			assert.equal(marked[0]!.text, n < 4 ? "<chat>\n" : lines.slice(Math.floor(n / 4) * 4 - 4, Math.floor(n / 4) * 4).join("\n") + "\n");
			assert.ok(blocks(body).filter((b) => b.cache_control).length <= 4);
			assert.deepEqual(marked[0]!.cache_control, mark);
		}
	});
}

test("disabled caching and non-memory requests are left alone", () => {
	const body = JSON.parse(JSON.stringify(payload(["0+1|hello"])));
	for (const b of blocks(body)) Reflect.deleteProperty(b, "cache_control");
	const original = structuredClone(body);
	cacheView(body);
	assert.deepEqual(body, original);
	const other = { messages: [{ role: "user", content: "hello" }] };
	cacheView(other);
	assert.deepEqual(other, { messages: [{ role: "user", content: "hello" }] });
});

test("a frozen view keeps its breakpoint through long tool histories", () => {
	const body = payload(Array.from({ length: 100 }, (_, k) => `${k}+1|text`));
	for (let k = 0; k < 40; k++) body.messages.push({ role: k % 2 ? "user" : "assistant", content: [{ type: "text", text: `step ${k}`, cache_control: mark }] });
	cacheView(body);
	assert.equal(body.messages[0]!.content.filter((b) => b.cache_control).length, 1);
	assert.equal(body.messages.at(-1)!.content.filter((b) => b.cache_control).length, 1);
	assert.equal(blocks(body).filter((b) => b.cache_control).length, 4);
});

test("growing views reuse >=95% of their input under Anthropic's 20-block lookup rules", () => {
	const cache = new Set<string>();
	const lines: string[] = [];
	let read = 0;
	let total = 0;
	for (let n = 0; n < 1000; n++) {
		lines.push(`${n}+1|note: ${"x".repeat(100)}`);
		for (const task of [`Now: ${n}\nTurn: ${n}`, `Compaction: ${n}`]) {
			const body = payload(lines, task);
			cacheView(body);
			const all = blocks(body);
			let prefix = "";
			const keys: string[] = [];
			const ends: number[] = [];
			const marks: number[] = [];
			all.forEach(({ cache_control, ...b }, k) => {
				prefix = createHash("sha256").update(prefix + JSON.stringify(b)).digest("hex");
				keys.push(prefix);
				ends.push((ends.at(-1) ?? 0) + JSON.stringify(b).length);
				if (cache_control) marks.push(k);
			});
			let hit = -1;
			for (const m of marks) for (let k = m; k >= 0 && k > m - 20; k--) if (cache.has(keys[k]!)) { hit = Math.max(hit, k); break; }
			read += ends[hit] ?? 0;
			total += ends.at(-1)!;
			for (const m of marks) cache.add(keys[m]!);
		}
	}
	assert.ok(read / total >= 0.95, `cache read share: ${read / total}`);
});

test("real pi-ai Anthropic conversion uses the cache adapter for both API keys and OAuth, without a network call", async () => {
	const models = createModels();
	models.setProvider(anthropicProvider());
	const model = models.getModels("anthropic")[0]!;
	assert.ok(model);
	const cached = withMemoryCache(models);
	assert.deepEqual(cached.getModels("anthropic"), models.getModels("anthropic"));
	for (const apiKey of ["test-key", "sk-ant-oat01-test"]) for (const task of ["Now: today\nTurn: hello", "Compaction: compress message 40"]) {
		let captured = false;
		const original = chatBlock(Array.from({ length: 101 }, (_, k) => `${k}+1|hello`)) + task;
		const stream = cached.streamSimple(model, {
			systemPrompt: "shared prompt",
			tools: [{ name: "zoom", description: "zoom", parameters: Type.Object({}) }],
			messages: [{ role: "user", content: original, timestamp: 1 }],
		}, {
			apiKey,
			onPayload: (wire) => {
				captured = true;
				const body = wire as ReturnType<typeof payload>;
				assert.equal(body.messages[0]!.content.map((b) => b.text).join(""), original);
				assert.equal(body.messages[0]!.content.length, 27);
				const marked = body.messages[0]!.content.filter((b) => b.cache_control);
				assert.equal(marked.length, task.startsWith("Compaction:") ? 1 : 2);
				assert.ok(marked[0]!.text.endsWith("99+1|hello\n"));
				assert.ok(blocks(body).filter((b) => b.cache_control).length <= 4);
				throw new Error("captured before network");
			},
		});
		const result = await stream.result();
		assert.ok(captured, result.errorMessage);
		assert.match(result.errorMessage!, /captured before network/);
	}
});
