import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, Type } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { cacheView, cacheViewOpenAI, compactionPrefixKeys, withMemoryCache } from "../src/optchat/cache.ts";
import { chatBlock } from "../src/optchat/tree.ts";

function payload(n: number, task = "Compaction: compress message 40") {
	return {
		model: "test-model", tools: [], reasoning: { effort: "medium" },
		input: [
			{ role: "developer", content: "shared instructions" as any },
			{ role: "user", content: [{ type: "input_text", text: chatBlock(Array.from({ length: n }, (_, i) => `${i}+1|note: żółw 🐢 ${i}`)) + task }] as any },
		],
	} as any;
}

for (const n of [0, 1, 3, 4, 5, 8, 9, 101]) test(`OpenAI's ${n}-line view preserves text and marks only its stable block`, () => {
	for (const task of ["Compaction: compress message 40", "Turn (not a compaction): hi"]) {
		const body = payload(n, task);
		const original = body.input[1].content[0].text;
		cacheViewOpenAI(body);
		const blocks = body.input[1].content;
		assert.equal(blocks.map((b: any) => b.text).join(""), original);
		assert.equal(blocks.length, Math.floor(n / 4) + 2);
		assert.equal(blocks.filter((b: any) => b.prompt_cache_breakpoint).length, 1);
		assert.deepEqual(blocks[Math.floor(n / 4)].prompt_cache_breakpoint, { mode: "explicit" });
		assert.equal(blocks.at(-1).prompt_cache_breakpoint, undefined);
		assert.equal(body.prompt_cache_options?.mode, task.startsWith("Compaction:") ? "explicit" : undefined);
		const once = structuredClone(body);
		cacheViewOpenAI(body);
		assert.deepEqual(body, once, "adapter must be idempotent");
	}
});

test("view splitting keeps blank lines, images, preceding blocks, tools, reasoning and long-cache TTL", () => {
	const text = "<chat>\n0+1|żółw\n\n2+1|🐢\n3+1|text\n\n</chat>\nCompaction: compress message 4";
	const body = payload(1);
	body.prompt_cache_options = { ttl: "30m" };
	body.tools = [{ type: "function", name: "keep" }];
	const before = { type: "input_text", text: "prefix" };
	const image = { type: "input_image", image_url: "data:image/png;base64,AAAA" };
	body.input[1].content = [before, { type: "input_text", text }, image];
	const tools = structuredClone(body.tools), reasoning = structuredClone(body.reasoning);
	cacheViewOpenAI(body);
	assert.equal(body.input[1].content.filter((b: any) => b.type === "input_text").map((b: any) => b.text).join(""), "prefix" + text);
	assert.deepEqual(body.input[1].content[0], before);
	assert.deepEqual(body.input[1].content.at(-1), image);
	assert.deepEqual(body.tools, tools);
	assert.deepEqual(body.reasoning, reasoning);
	assert.deepEqual(body.prompt_cache_options, { ttl: "30m", mode: "explicit" });
	const anthropic = { system: [], messages: [{ role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] }] };
	cacheView(anthropic);
	assert.equal(anthropic.messages[0]!.content.map(b => b.text).join(""), text);
});

test("OpenAI non-memory/malformed payloads are unchanged, and string user content is supported", () => {
	for (const body of [null, {}, { input: "hi" }, { input: [{ role: "user", content: "ordinary text" }] },
		{ input: [{ role: "user", content: [{ type: "input_text", text: "<chat>\nunclosed" }] }] }]) {
		const original = structuredClone(body); cacheViewOpenAI(body); assert.deepEqual(body, original);
	}
	const body = payload(4);
	const text = body.input[1].content[0].text;
	body.input[1].content = text;
	cacheViewOpenAI(body);
	assert.equal(body.input[1].content.map((b: any) => b.text).join(""), text);
});

test("prefix hashes ignore unique tasks, share growing view ancestors, and isolate all wire/scope differences", () => {
	const a = payload(8), b = payload(9, "Compaction: merge lines 8+1 and 9+1");
	cacheViewOpenAI(a); cacheViewOpenAI(b);
	const keys = compactionPrefixKeys(a, "openai-responses", "account/session");
	assert.deepEqual(compactionPrefixKeys(b, "openai-responses", "account/session"), keys);
	const larger = payload(12); cacheViewOpenAI(larger);
	assert.deepEqual(compactionPrefixKeys(larger, "openai-responses", "account/session").slice(0, keys.length), keys);
	for (const change of [
		(p: any) => { p.model = "different"; },
		(p: any) => { p.reasoning.effort = "high"; },
		(p: any) => { p.tools = [{ name: "different" }]; },
		(p: any) => { p.input[0].content = "different system"; },
		(p: any) => { p.input[1].content[1].text += "different view\n"; },
		(p: any) => { p.service_tier = "priority"; },
	]) {
		const different = structuredClone(a); change(different);
		assert.notDeepEqual(compactionPrefixKeys(different, "openai-responses", "account/session"), keys);
	}
	assert.notDeepEqual(compactionPrefixKeys(a, "openai-responses", "other-account/session"), keys);
	const turn = payload(8, "Turn (not a compaction): hello"); cacheViewOpenAI(turn);
	assert.deepEqual(compactionPrefixKeys(turn, "openai-responses", "account/session"), []);
	const override = payload(8); // Caller replaced our payload with an unmarked one.
	assert.deepEqual(compactionPrefixKeys(override, "openai-responses", "account/session"), []);
});

test("real pi-ai OpenAI conversion gates explicit caching on model support and respects disabled caching", async () => {
	const models = createModels(); models.setProvider(openaiProvider());
	const model = models.getModel("openai", "gpt-6-luna")!;
	assert.ok(model);
	const cached = withMemoryCache(models);
	for (const apiKey of ["sk-test-key", "chatgpt-access-token"]) for (const capable of [true, false]) for (const retention of ["short", "long", "none"] as const) {
		for (const task of ["Compaction: compress message 40", "Turn (not a compaction): hello"]) {
			let captured = false;
			const text = chatBlock(Array.from({ length: 9 }, (_, i) => `${i}+1|note: item ${i}`)) + task;
			const stream = cached.streamSimple({ ...model, compat: { ...model.compat, supportsExplicitPromptCacheMode: capable } }, {
				systemPrompt: "same system", tools: [{ name: "zoom", description: "zoom", parameters: Type.Object({}) }],
				messages: [{ role: "user", content: text, timestamp: 0 }],
			}, {
				apiKey, cacheRetention: retention,
				fetch: async () => { throw new Error("network must not be reached"); },
				onPayload: payload => {
					captured = true;
					const wire = payload as any;
					const blocks = wire.input.find((m: any) => m.role === "user").content;
					const enabled = capable && retention !== "none";
					const explicit = enabled && apiKey.startsWith("sk-");
					assert.equal(blocks.map((b: any) => b.text).join(""), text);
					assert.equal(blocks.length, enabled ? 4 : 1);
					assert.equal(blocks.filter((b: any) => b.prompt_cache_breakpoint).length, explicit ? 1 : 0);
					assert.equal(wire.tools.length, 1, "turn tool definitions must not be removed by the cache adapter");
					if (explicit && task.startsWith("Compaction:")) assert.equal(wire.prompt_cache_options.mode, "explicit");
					if (explicit && retention === "long") assert.equal(wire.prompt_cache_options.ttl, "30m");
					if (!apiKey.startsWith("sk-")) assert.equal(wire.prompt_cache_options, undefined, "OAuth must not regain fields pi-ai deliberately omitted");
					throw new Error("captured before network");
				},
			});
			const result = await stream.result();
			assert.ok(captured, result.errorMessage);
			assert.match(result.errorMessage!, /captured before network/);
		}
	}
});
