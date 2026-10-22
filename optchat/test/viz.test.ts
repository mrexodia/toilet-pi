// The request log and the visualizer: recording real calls of a durable agent, and replaying its memory from SQLite.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseFactory,
	type Message,
	type Models,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { withMemoryCache } from "../src/optchat/cache.ts";
import { Optchat, tree } from "../src/optchat/index.ts";
import { contentText } from "../src/optchat/memory.ts";
import { HEAD } from "../src/optchat/prompt.ts";
import { classify, recordRequests, RequestLog, REQUESTS_FILE } from "../src/requests.ts";
import { segmentsOf } from "../src/viz/segments.ts";
import { startViz } from "../src/viz/server.ts";
import type { Frame } from "../src/viz/store.ts";

const context = BACKGROUND_CONTEXT;

let dir: string;
before(async () => {
	dir = await mkdtemp(join(tmpdir(), "optchat-viz-"));
	tree.limits.high = 6_000;
	tree.limits.seen = 3_000;
});
after(async () => {
	tree.limits.high = tree.HIGH;
	tree.limits.seen = tree.SEEN;
	await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function text(message: Message | undefined): string {
	return message === undefined || message.role === "system" || message.role === "assistant" ? "" : contentText(message.content);
}

/** Faux compacts deterministically and answers turns; it never builds a wire payload, so this stands in for one. */
function withPayloads(models: Models): Models {
	return new Proxy(models, {
		get(target, name) {
			if (name === "streamSimple") {
				return ((model, ctx, options) => {
					const stream = target.streamSimple(model, ctx, options);
					void options?.onPayload?.({ wire: model.api, messages: ctx.messages.length, first: text(ctx.messages.find((m) => m.role === "user")) }, model);
					return stream;
				}) satisfies Models["streamSimple"];
			}
			const value = Reflect.get(target, name, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function fauxModels(): Models {
	const factory: FauxResponseFactory = (transcript) => {
		const last = text(transcript.messages.at(-1));
		if (last.startsWith("<chat>\n") && last.includes("\nCompaction: ")) {
			const body = last.split("<input>\n", 2)[1]!.replace(/\n<\/input>$/, "");
			return fauxAssistantMessage(`S[${tree.cut(tree.flat(body), 300)}]`);
		}
		return fauxAssistantMessage(`ok: ${last.slice(-20)}`);
	};
	const faux = fauxProvider();
	faux.appendResponses(Array.from({ length: 2000 }, () => factory));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

test("classify names turns, compactions and their retries", () => {
	const turn: Context = {
		messages: [{ role: "user", content: `<chat>\n0+1|user: hi\n</chat>\nNow: x\n${HEAD}fix the build please`, timestamp: 0 }],
	};
	assert.deepEqual(classify(turn), { kind: "turn", label: "fix the build please" });
	const merge: Context = {
		messages: [
			{ role: "user", content: "<chat>\n</chat>\nCompaction: merge lines 0+4 and 4+4, adjacent, into one line\n<input>\na\nb\n</input>", timestamp: 0 },
			{ role: "user", content: "Too long: your line is 600 bytes", timestamp: 0 },
		],
	};
	assert.deepEqual(classify(merge), { kind: "compaction", label: "merge 0+4 and 4+4 (retry: too long)" });
	const segments = segmentsOf(merge);
	assert.deepEqual(
		segments.map((s) => s.kind),
		["other", "other", "task", "source", "retry"],
	);
	assert.equal(segments[2]!.label, "merge lines 0+4 and 4+4");
	const view = segmentsOf({ messages: [{ role: "user", content: `<chat>\n0+8|eight\n8+2|two\n10+1|one\n</chat>\n${HEAD}go`, timestamp: 0 }] });
	assert.deepEqual(
		view.filter((s) => s.kind === "view").map((s) => s.part),
		[
			[3, 0],
			[1, 4],
			[0, 10],
		],
	);
	assert.equal(view.find((s) => s.kind === "input")?.text, "go");
});

test("the request log stores long strings once and prunes the oldest requests", () => {
	const file = join(dir, "prune.sqlite");
	const log = RequestLog.open(file, { maxMB: 0.3 });
	const model = { provider: "p", id: "m", api: "a" };
	const shared = "s".repeat(50_000);
	const first = log.begin(model, { messages: [{ role: "user", content: shared, timestamp: 0 }] }, {})!;
	const again = log.begin(model, { messages: [{ role: "user", content: shared, timestamp: 0 }] }, {})!;
	log.payload(again, { body: shared });
	const before = log.size();
	assert.ok(before < 150_000, `${before} bytes: the shared text is stored once`);
	assert.equal((log.get(again)!.payload as { body: string }).body, shared);
	const ids = [first, again];
	for (let k = 0; k < 40; k++) ids.push(log.begin(model, { messages: [{ role: "user", content: `${k}`.repeat(20_000), timestamp: k }] }, {})!);
	log.prune();
	assert.ok(log.size() <= 300_000, `${log.size()} bytes after pruning`);
	const kept = log.list().map((r) => r.id);
	assert.ok(!kept.includes(first), "the oldest request went first");
	assert.equal(kept.at(-1), ids.at(-1));
	const last = log.get(ids.at(-1)!)!;
	assert.equal(text(last.context.messages[0]), "39".repeat(20_000));
	log.close();
	const reader = RequestLog.openReadOnly(file)!;
	assert.deepEqual(
		reader.list().map((r) => r.id),
		kept,
	);
	reader.close();
});

test("a durable agent's calls are recorded, and the visualizer replays its memory exactly", async () => {
	const home = join(dir, "home");
	await mkdir(join(home, ".optchat"), { recursive: true });
	const log = RequestLog.open(join(home, ".optchat", REQUESTS_FILE));
	const registry = createRegistry();
	Optchat.install(registry, { home });
	const storage = await openNodeSqliteStorage(join(home, ".optchat", "agent.sqlite"));
	const models = recordRequests(withMemoryCache(withPayloads(fauxModels())), log);
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: home } });
	const optchat = new Optchat(harness, root, { home });
	harness.resume();
	await optchat.start();
	for (let k = 0; k < 24; k++) await (await optchat.note(`note ${k} ${"abcdefgh ".repeat(40 + (k % 5) * 30)}`)).wait(context);
	await optchat.idle({ signal: AbortSignal.timeout(20_000) });
	assert.equal((await (await optchat.turn("what do you remember?")).wait(context)).status, "done");
	await optchat.idle({ signal: AbortSignal.timeout(20_000) });
	const chat = await optchat.state();
	await optchat.stop();
	await harness.close(context);
	log.close();

	const viz = await startViz({ home, port: 0 });
	try {
		const base = viz.url;
		const get = async <T>(path: string): Promise<T> => {
			const res = await fetch(new URL(path, base));
			assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
			return (await res.json()) as T;
		};

		// The history: every message, every node, and the views exactly as the store has them now.
		const history = await get<{ frames: Frame[] }>("/api/history?from=0");
		const frames = history.frames;
		const messages = frames.reduce((n, f) => n + (f.msgs?.kinds.length ?? 0), 0);
		assert.equal(messages, chat.count);
		const built = frames.flatMap((f) => f.built ?? []);
		assert.equal(new Set(built.map((b) => b.key)).size, built.length, "each node is built once");
		assert.ok(built.some((b) => b.ms !== undefined && b.from !== undefined), "compactions carry their start and duration");
		assert.deepEqual(viz.viz.history.viewAt(frames.length - 1), chat.view.parts);
		assert.deepEqual(viz.viz.history.viewAt(frames.length - 1, "seen"), chat.seen.parts);
		assert.ok(frames.some((f) => f.view !== undefined && f.view[1] > f.view[2].length), "the view merged");
		const turn = frames.findIndex((f) => f.turn !== undefined);
		assert.ok(turn >= 0);
		for (let k = 1; k < frames.length; k++) assert.ok(frames[k]!.t >= frames[k - 1]!.t, "frame times never go back");
		const later = await get<{ from: number; frames: Frame[] }>(`/api/history?from=${frames.length - 1}`);
		assert.equal(later.from, frames.length - 1);
		assert.equal(later.frames.length, 1);

		// The rebuilt first request of the turn: its view and its message.
		const rebuilt = await get<{ mode: string; segments: { kind: string; text: string }[] }>(`/api/context?frame=${turn}`);
		assert.equal(rebuilt.mode, "turn");
		assert.equal(rebuilt.segments.find((s) => s.kind === "input")?.text, "what do you remember?");
		assert.ok(rebuilt.segments.some((s) => s.kind === "prompt"));
		assert.ok(rebuilt.segments.some((s) => s.kind === "tool" && s.text.includes('"zoom"')));

		// The recorded requests: compactions and the turn, each with its context, payload and response.
		const { requests } = await get<{ requests: { id: number; kind: string; label: string; hasPayload: boolean; ended: number | null; stop: string }[] }>("/api/requests");
		const turns = requests.filter((r) => r.kind === "turn");
		assert.ok(requests.some((r) => r.kind === "compaction" && /^(compress message \d+|merge \d+\+\d+ and \d+\+\d+)/.test(r.label)));
		assert.equal(turns.length, 1);
		assert.equal(turns[0]!.label, "what do you remember?");
		assert.ok(requests.every((r) => r.hasPayload && r.ended !== null && r.stop === "stop"));
		const detail = await get<{
			payload: { first: string };
			response: { content: { type: string; text: string }[] };
			segments: { kind: string; part?: [number, number]; text: string }[];
		}>(`/api/request?id=${turns[0]!.id}`);
		assert.ok(detail.payload.first.endsWith("what do you remember?"));
		assert.match(detail.response.content[0]!.text, /^ok: /);
		const parts = detail.segments.filter((s) => s.kind === "view").map((s) => s.part);
		assert.deepEqual(
			parts,
			chat.turn!.parts.filter((p) => tree.span(p)[1] < chat.turn!.first),
		);
		assert.equal(detail.segments.find((s) => s.kind === "input")?.text, "what do you remember?");

		// What hovering shows: a node's summary and the real messages under it.
		const top = chat.view.parts[0]!;
		const node = await get<{ text: string; span: [number, number] }>(`/api/node?key=${top[0]}/${top[1]}`);
		assert.ok(node.text.length > 0);
		const shown = await get<{ messages: { id: number; kind: string; text: string }[] }>(`/api/messages?from=${node.span[0]}&to=${node.span[1]}&chars=40`);
		assert.equal(shown.messages[0]!.id, node.span[0]);
		assert.ok(shown.messages[0]!.text.startsWith("note "));

		// Only local names are served.
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const url = new URL("/api/state", base);
			request({ host: "127.0.0.1", port: url.port, path: url.pathname, headers: { host: "attacker.example" } }, (res) => {
				res.resume();
				resolve(res.statusCode);
			})
				.on("error", reject)
				.end();
		});
		assert.equal(status, 403);
		const page = await fetch(new URL("/", base));
		assert.match(await page.text(), /optchat · memory/);
	} finally {
		await viz.close();
	}
});
