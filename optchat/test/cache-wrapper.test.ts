import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, type Model, type Api, type Models } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { CacheFlights } from "../src/optchat/cache-flight.ts";
import { withMemoryCache } from "../src/optchat/cache.ts";
import { chatBlock } from "../src/optchat/tree.ts";

type Options = NonNullable<Parameters<Models["streamSimple"]>[2]>;
const base = openaiProvider().getModels().find(m => m.id === "gpt-6-luna")!;
const context = (task: string) => ({ systemPrompt: "shared instructions", messages: [{ role: "user" as const,
	content: chatBlock(Array.from({ length: 8 }, (_, i) => `${i}+1|memory ${i}`)) + task, timestamp: 0 }] });

function fake(api: string = "openai-responses", waitMs = 500, explicitAuth: boolean | null = true) {
	const model: Model<Api> = { ...base, api };
	type Sent = { payload: any; event(type: string): Promise<void>; finish(text?: string): void; fail(error: unknown): void };
	const sent: Sent[] = [];
	const flights = new CacheFlights({ waitMs });
	const source = createModels();
	const streamSimple: Models["streamSimple"] = (model, ctx, options) => {
		const stream = createAssistantMessageEventStream();
		const message = fauxAssistantMessage("answer");
		let ended = false;
		const fail = (error: unknown) => {
			if (ended) return; ended = true;
			options?.signal?.removeEventListener("abort", aborted);
			const reply = fauxAssistantMessage("", { stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: String(error) });
			stream.push({ type: "error", reason: reply.stopReason as "error" | "aborted", error: reply }); stream.end();
		};
		const aborted = () => fail(options?.signal?.reason);
		void (async () => {
			try {
				await options?.transformHeaders?.({ "test-account": "one" });
				const user = ctx.messages.find(m => m.role === "user")!;
				const text = typeof user.content === "string" ? user.content : "";
				const payload = api === "anthropic-messages"
					? { model: model.id, system: [{ type: "text", text: ctx.systemPrompt, cache_control: { type: "ephemeral" } }],
						messages: [{ role: "user", content: [{ type: "text", text }] }] }
					: { model: model.id, tools: [], input: [{ role: "developer", content: ctx.systemPrompt },
						{ role: "user", content: [{ type: "input_text", text }] }] };
				const wire = (await options?.onPayload?.(payload, model)) ?? payload;
				options?.signal?.throwIfAborted();
				options?.signal?.addEventListener("abort", aborted, { once: true });
				stream.push({ type: "start", partial: message }); // Headers arrived; this is NOT cache readiness.
				sent.push({ payload: wire,
					async event(type) {
						try { await options?.onProviderStreamEvent?.({ type }, model); } catch (error) { fail(error); }
					},
					finish(text = "answer") {
						if (ended) return; ended = true;
						options?.signal?.removeEventListener("abort", aborted);
						stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage(text) }); stream.end();
					}, fail,
				});
			} catch (error) { fail(error); }
		})();
		return stream;
	};
	const models = withMemoryCache(new Proxy(source, { get(target, name) {
		if (name === "streamSimple") return streamSimple;
		const value = Reflect.get(target, name, target);
		return typeof value === "function" ? value.bind(target) : value;
	} }), { flights, ...(explicitAuth === null ? {} : { allowOpenAIExplicit: () => explicitAuth }) });
	async function until(n: number) {
		for (let i = 0; i < 1000 && sent.length < n; i++) await sleep(1);
		assert.equal(sent.length, n);
	}
	return { model, models, sent, flights, until,
		call(task: string, options: Options = {}, chosen = model) { return models.streamSimple(chosen, context(task), { sessionId: "same-home", ...options }); },
	};
}

for (const api of ["openai-responses", "anthropic-messages"]) test(`${api}: ready event, not headers/start, releases followers; all calls keep distinct results`, async () => {
	const f = fake(api);
	let observed = 0;
	const first = f.call("Compaction: first", { onProviderStreamEvent: () => { observed++; } });
	await f.until(1);
	const second = f.call("Compaction: second");
	await sleep(5);
	assert.equal(f.sent.length, 1);
	await f.sent[0]!.event("response.created");
	await sleep(5);
	assert.equal(f.sent.length, 1);
	await f.sent[0]!.event(api === "anthropic-messages" ? "message_start" : "response.output_item.added");
	await f.until(2);
	assert.equal(observed, 2);
	f.sent[0]!.finish("first answer"); f.sent[1]!.finish("second answer");
	assert.equal((await first.result()).content[0]?.type, "text");
	assert.notDeepEqual((await first.result()).content, (await second.result()).content);
	const events = []; for await (const e of first) events.push(e.type);
	assert.deepEqual(events, ["start", "done"], "wrapper must not consume or alter the public stream");
});

test("ChatGPT/unknown auth uses ordinary text blocks and bounded coordination, never explicit cache fields", async () => {
	for (const known of [false, null]) {
		const f = fake("openai-responses", 500, known);
		const a = f.call("Compaction: a"); await f.until(1);
		const b = f.call("Compaction: b");
		await sleep(5); assert.equal(f.sent.length, 1);
		const wire = f.sent[0]!.payload;
		assert.equal(wire.input[1].content.length, 4);
		assert.equal(wire.prompt_cache_options, undefined);
		assert.ok(wire.input[1].content.every((block: any) => block.prompt_cache_breakpoint === undefined));
		await f.sent[0]!.event("response.output_item.added");
		await f.until(2);
		for (const sent of f.sent) sent.finish();
		await Promise.all([a.result(), b.result()]);
		// Explicit per-request keys take precedence over host auth state.
		const c = f.call("Compaction: c", { apiKey: "sk-test-key" }); await f.until(3);
		assert.equal(f.sent[2]!.payload.prompt_cache_options.mode, "explicit");
		f.sent[2]!.finish(); await c.result();
	}
});

test("cache coordination never delays ordinary turns and isolates credential, endpoint, model and header scopes", async () => {
	const f = fake();
	const streams = [f.call("Compaction: first")];
	await f.until(1);
	streams.push(f.call("Turn (not a compaction): hello"));
	streams.push(f.call("Compaction: different credential", { apiKey: "sk-other" }));
	streams.push(f.call("Compaction: different home", { sessionId: "other" }));
	streams.push(f.call("Compaction: different reasoning", { reasoning: "high" }));
	streams.push(f.call("Compaction: different account header", { transformHeaders: () => ({ "test-account": "two" }) }));
	streams.push(f.call("Compaction: different endpoint", {}, { ...f.model, baseUrl: "https://other.invalid" }));
	streams.push(f.call("Compaction: different model", {}, { ...f.model, id: "other-model" }));
	await f.until(streams.length);
	for (const sent of f.sent) sent.finish();
	await Promise.all(streams.map(s => s.result()));
});

test("unsupported APIs/models and disabled caching do not add OpenAI cache fields or wait", async () => {
	for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses", "openai-completions"]) {
		for (const disabled of [false, true]) {
			const f = fake(api);
			const model = { ...f.model, compat: { supportsExplicitPromptCacheMode: disabled } };
			const opts: Options = disabled ? { cacheRetention: "none" } : {};
			const streams = [f.call("Compaction: one", opts, model), f.call("Compaction: two", opts, model)];
			await f.until(2);
			for (const sent of f.sent) {
				assert.equal(sent.payload.prompt_cache_options, undefined);
				assert.equal(sent.payload.input[1].content.length, 1);
				sent.finish();
			}
			await Promise.all(streams.map(s => s.result()));
			assert.equal(f.flights.size, 0);
		}
	}
});

test("caller replacement payloads are authoritative and are rechecked before coordinating", async () => {
	const f = fake();
	let calls = 0;
	const onPayload: Options["onPayload"] = payload => {
		calls++;
		assert.equal((payload as any).input[1].content.length, 4);
		return { input: [{ role: "user", content: "a replacement without memory" }] };
	};
	const a = f.call("Compaction: a", { onPayload }), b = f.call("Compaction: b", { onPayload });
	await f.until(2);
	assert.equal(calls, 2); assert.equal(f.flights.size, 0);
	for (const sent of f.sent) { assert.equal(sent.payload.input[0].content, "a replacement without memory"); sent.finish(); }
	await Promise.all([a.result(), b.result()]);
});

test("aborted waiters never send, failed writers release followers, and errors keep their original result", async () => {
	const f = fake();
	const a = f.call("Compaction: a"); await f.until(1);
	const abort = new AbortController();
	const b = f.call("Compaction: b", { signal: abort.signal });
	await sleep(5); abort.abort(new Error("cancel waiting"));
	assert.equal((await b.result()).stopReason, "aborted");
	assert.equal(f.sent.length, 1);
	const c = f.call("Compaction: c");
	f.sent[0]!.fail(new Error("provider outage"));
	assert.match((await a.result()).errorMessage!, /provider outage/);
	await f.until(2);
	f.sent[1]!.finish(); await c.result();
});

test("success without a readiness callback releases followers; a stalled stream has a bounded lease", async () => {
	const f = fake("openai-responses", 25);
	const a = f.call("Compaction: a"); await f.until(1);
	const b = f.call("Compaction: b"); await f.until(2); // Lease expires without any provider event.
	f.sent[1]!.finish(); await b.result();
	f.sent[0]!.finish(); await a.result();
	const g = fake();
	const c = g.call("Compaction: c"); await g.until(1);
	const d = g.call("Compaction: d");
	g.sent[0]!.finish(); await c.result();
	await g.until(2); g.sent[1]!.finish(); await d.result();
});

test("an observer failure before readiness does not leave a cached success or stranded followers", async () => {
	const f = fake();
	const a = f.call("Compaction: a", { onProviderStreamEvent: () => { throw new Error("observer failed"); } });
	await f.until(1);
	const b = f.call("Compaction: b");
	await f.sent[0]!.event("response.output_item.added");
	assert.match((await a.result()).errorMessage!, /observer failed/);
	await f.until(2); f.sent[1]!.finish(); await b.result();
});
