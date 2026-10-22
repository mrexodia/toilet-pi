import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { WebSocketServer } from "ws";
import type { Agent } from "../src/host.ts";
import { Runner } from "../src/runner.ts";

const context = BACKGROUND_CONTEXT;

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		assert.ok(Date.now() < deadline, "timed out waiting for runner");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

for (const busy of [true, false]) {
	test(`hub follow-ups ${busy ? "steer without waiting for run_end" : "start turns when idle"}`, async (t) => {
		const home = await mkdtemp(join(tmpdir(), "optchat-runner-"));
		let runner: Runner | undefined;
		let server: WebSocketServer | undefined;
		let harness: Harness | undefined;
		t.after(async () => {
			await runner?.stop();
			if (server !== undefined) {
				for (const client of server.clients) client.terminate();
				await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
			}
			await harness?.close(context);
			await rm(home, { recursive: true, force: true });
		});
		await mkdir(join(home, ".optchat"));
		harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
		const root = await harness.root(context);
		const calls: { method: string; text: string; requestId?: string }[] = [];
		const submit = async (method: string, text: string, requestId?: string) => {
			calls.push({ method, text, requestId });
			if (text === "fail") throw new Error("submission failed");
			// Immediate durable settlement exercises the runner's input-status tracking without a model run.
			return root.submit({ type: "write", entry: { kind: "test.input", data: text } }, context);
		};
		const agent = {
			home, harness, root,
			optchat: {
				busy: async () => busy,
				steer: (text: string, requestId?: string) => submit("steer", text, requestId),
				turn: (text: string, options: { requestId?: string }) => submit("turn", text, options.requestId),
			},
			modelRuntime: { getModel: () => undefined },
		} as unknown as Agent;
		server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(server, "listening");
		const connected = once(server, "connection");
		const logs: string[] = [];
		runner = new Runner({ agent, connectUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/connect?token=test`, log: (text) => logs.push(text) });
		await runner.start();
		const [socket] = await connected;
		const messages: any[] = [];
		socket.on("message", (data: unknown) => messages.push(JSON.parse(String(data))));
		await until(() => messages.some((m) => m.type === "hello"));
		assert.ok(messages.find((m) => m.type === "hello").capabilities.includes("launch_new_v1"));
		socket.send(JSON.stringify({ type: "start_background_session", requestId: "invalid-launch", cwd: "relative", createNew: true }));
		await until(() => messages.some((m) => m.type === "runner_status" && m.requestId === "invalid-launch"));
		assert.equal(messages.find((m) => m.requestId === "invalid-launch").status, "error");
		const send = (inputId: string, text: string, mode = "followUp") => socket.send(JSON.stringify({
			type: "control_command", operation: "send", sessionGuid: runner!.sessionGuid, inputId, text, mode,
		}));
		const states = (id: string): string[] => messages.filter((m) => m.event?.type === "input_status" && m.event.input.inputId === id).map((m) => m.event.input.state);

		send("one", "first follow-up");
		await until(() => states("one").includes("settled"));
		send("two", "second follow-up");
		await until(() => states("two").includes("settled"));
		assert.deepEqual(calls, [
			{ method: busy ? "steer" : "turn", text: "first follow-up", requestId: "one" },
			{ method: busy ? "steer" : "turn", text: "second follow-up", requestId: "two" },
		]);
		assert.deepEqual(states("one"), ["submitted", "running", "settled"]);
		assert.deepEqual(states("two"), ["submitted", "running", "settled"]);
		assert.ok(messages.some((m) => m.event?.type === "queued_input_remove" && m.event.inputId === "one"));

		// Replayed hub requests must not inject the same steering twice.
		send("one", "duplicate");
		send("three", "explicit steer", "steer");
		await until(() => states("three").includes("settled"));
		assert.equal(calls.length, 3);
		assert.equal(calls[2]!.method, busy ? "steer" : "turn");
		send("bad", "fail");
		await until(() => states("bad").includes("failed"));
		assert.deepEqual(states("bad"), ["submitted", "failed"]);
		if (busy) {
			send("prompt", "idle-only prompt", "prompt");
			await until(() => states("prompt").includes("failed"));
			assert.equal(calls.length, 4, "busy prompt rejection should remain unchanged");
		}
		// The web UI sends legacy inputs without a mode; these also steer a busy turn.
		socket.send(JSON.stringify({ type: "input", inputId: "web", text: "web follow-up" }));
		await until(() => states("web").includes("settled"));
		assert.deepEqual(calls.at(-1), { method: busy ? "steer" : "turn", text: "web follow-up", requestId: "web" });

		const identity = runner.sessionGuid;
		const callCount = calls.length;
		const reconnected = once(server, "connection");
		socket.terminate();
		await until(() => logs.some((line) => line.includes("disconnected (1006)")));
		const [replacement] = await reconnected;
		const restored: any[] = [];
		replacement.on("message", (data: unknown) => restored.push(JSON.parse(String(data))));
		await until(() => restored.some((m) => m.type === "hello"));
		assert.equal(restored.find((m) => m.type === "hello").sessionGuid, identity);
		assert.equal(calls.length, callCount, "reconnect must not replay submissions");
		assert.ok(logs.some((line) => line.includes("reconnecting in")));
		assert.ok(logs.some((line) => line.includes("last pong")));
		assert.ok(logs.some((line) => line.includes("connecting to")));
		assert.ok(logs.some((line) => line.includes("connected as")));
		for (const line of logs) {
			assert.match(line, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] /);
			assert.ok(!line.includes("token=test"), "connect tokens must remain redacted");
		}
	});
}
