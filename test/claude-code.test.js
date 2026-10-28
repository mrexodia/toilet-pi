import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { bridgeCandidates, endpoint, isClaudeCode, parentOf } from "../.claude-plugin/ipc.js";
import { contentText, Tail, Transcript, unwrapChannel } from "../.claude-plugin/transcript.js";

const at = "2026-10-27T15:00:00.000Z";

test("channel messages are unwrapped and keep their input ids", () => {
	const { text, inputIds } = unwrapChannel('<channel source="toilet-pi" input_id="abc-123">\nrun the tests\n</channel>');
	assert.equal(text, "run the tests");
	assert.deepEqual(inputIds, ["abc-123"]);
	// Other channels are left as they are.
	assert.equal(unwrapChannel('<channel source="telegram" chat_id="1">hi</channel>').text, '<channel source="telegram" chat_id="1">hi</channel>');
});

test("injected reminders are not shown as user text", () => {
	assert.equal(contentText([{ type: "text", text: "do it" }, { type: "text", text: "<system-reminder>\nnoise\n</system-reminder>" }]), "do it");
});

test("a remote input stored as a channel meta entry becomes a user message with its input id", () => {
	// The shape real Claude Code 2.1.311 writes for a channel notification.
	const t = new Transcript();
	const events = t.apply({
		type: "user", isMeta: true, origin: { kind: "channel", server: "toilet-pi" }, uuid: "u1", timestamp: at,
		message: { role: "user", content: '<channel source="toilet-pi" input_id="in-1">\nhello remote\n</channel>' },
	});
	assert.deepEqual(events.find((e) => e.type === "delivered"), { type: "delivered", inputIds: ["in-1"] });
	assert.deepEqual(events.find((e) => e.type === "message").message, {
		role: "user", timestamp: Date.parse(at), text: "hello remote", entryId: "u1", remoteInputId: "in-1",
	});
	// Other meta entries (command caveats and the like) stay hidden.
	assert.deepEqual(t.apply({ type: "user", isMeta: true, uuid: "u2", timestamp: at, message: { role: "user", content: "caveat" } }), []);
});

test("assistant blocks, tool calls and results map to hub messages and live tool events", () => {
	const t = new Transcript();
	const call = t.apply({
		type: "assistant", uuid: "a1", timestamp: at,
		message: { model: "claude-opus-5-5", role: "assistant", stop_reason: "tool_use",
			usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 5 },
			content: [{ type: "thinking", thinking: "hmm" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
	});
	assert.deepEqual(call.map((e) => e.type), ["model", "usage", "message", "tool_start"]);
	assert.equal(t.model, "claude-opus-5-5");
	assert.equal(t.contextTokens, 1017);
	assert.equal(call[2].message.thinkingText, "hmm");
	assert.equal(call[2].message.stopReason, "toolUse");

	const result = t.apply({
		type: "user", uuid: "r1", timestamp: "2026-10-27T15:00:02.000Z",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a\nb" }], is_error: false }] },
	});
	assert.deepEqual(result[0], { type: "tool_end", toolCallId: "toolu_1", toolName: "Bash", isError: false });
	assert.deepEqual(result[1].message, {
		role: "toolResult", timestamp: Date.parse("2026-10-27T15:00:02.000Z"), entryId: "r1:toolu_1", toolCallId: "toolu_1",
		toolName: "Bash", text: "a\nb", isError: false, args: { command: "ls" }, durationMs: 2000,
	});

	const reply = t.apply({ type: "assistant", uuid: "a2", timestamp: at, message: { model: "claude-opus-5-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } });
	assert.deepEqual(reply.at(-1).message, { role: "assistant", timestamp: Date.parse(at), text: "Done.", entryId: "a2", stopReason: "stop" });
	assert.equal(t.messages.length, 3);
});

test("cost, sidechains and slash-command plumbing", () => {
	const t = new Transcript();
	assert.deepEqual(t.apply({ type: "cost-state", totalCostUSD: 0.42 }), [{ type: "usage" }]);
	assert.equal(t.costUsd, 0.42);
	assert.deepEqual(t.apply({ type: "assistant", isSidechain: true, uuid: "s", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } }), []);
	assert.deepEqual(t.apply({ type: "user", uuid: "c", timestamp: at, message: { role: "user", content: "<command-name>/clear</command-name>" } }), []);
	assert.deepEqual(t.apply({ type: "summary", summary: "x" }), []);
});

test("Tail yields only complete lines and resumes where it stopped", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tp-tail-"));
	const file = join(dir, "t.jsonl");
	const tail = new Tail(file);
	assert.deepEqual(await tail.read(), []);
	writeFileSync(file, '{"a":1}\n{"b":');
	assert.deepEqual(await tail.read(), [{ a: 1 }]);
	appendFileSync(file, '2}\nnot json\n{"c":3}\n');
	assert.deepEqual(await tail.read(), [{ b: 2 }, { c: 3 }]);
	writeFileSync(file, '{"d":4}\n'); // rewritten, shorter: start over
	assert.deepEqual(await tail.read(), [{ d: 4 }]);
});

test("hook candidates: CLAUDE_PID first, then the parent, then ancestors with an endpoint", () => {
	const dir = mkdtempSync(join(tmpdir(), "tp-run-"));
	process.env.TOILET_PI_CLAUDE_RUN_DIR = dir;
	try {
		assert.deepEqual(bridgeCandidates({ CLAUDE_PID: "4242" }, process.pid), [endpoint(4242), endpoint(process.pid)]);
		assert.deepEqual(bridgeCandidates({}, process.pid), [endpoint(process.pid)], "no endpoints up the tree yet");
		// A Claude Code without CLAUDE_PID that runs hooks through a shell: found by walking up.
		const parent = parentOf(process.pid);
		assert.ok(Number.isInteger(parent) && parent > 1, "parent pid resolves");
		writeFileSync(endpoint(parent), "");
		assert.deepEqual(bridgeCandidates({}, process.pid), [endpoint(process.pid), endpoint(parent)]);
	} finally {
		delete process.env.TOILET_PI_CLAUDE_RUN_DIR;
	}
});

test("hook.js reaches the bridge through CLAUDE_PID alone and prints its answer", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tp-hook-"));
	const fakeClaude = 4_000_000 + (process.pid % 1000); // no such process: only CLAUDE_PID links the two
	const env = { ...process.env, TOILET_PI_CLAUDE_RUN_DIR: dir, CLAUDE_PID: String(fakeClaude) };
	process.env.TOILET_PI_CLAUDE_RUN_DIR = dir;
	const path = endpoint(fakeClaude);
	delete process.env.TOILET_PI_CLAUDE_RUN_DIR;
	let received;
	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		socket.once("data", (line) => {
			received = JSON.parse(line);
			socket.end(`${JSON.stringify({ output: { continue: false } })}\n`);
		});
	});
	await new Promise((resolve) => server.listen(path, resolve));
	try {
		const hook = spawn(process.execPath, [fileURLToPath(new URL("../.claude-plugin/hook.js", import.meta.url))], { env });
		let out = "";
		hook.stdout.on("data", (d) => (out += d));
		hook.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash" }));
		await new Promise((resolve) => hook.on("close", resolve));
		assert.equal(received?.tool_name, "Bash");
		assert.deepEqual(JSON.parse(out), { continue: false });
	} finally {
		server.close();
	}
});

test("a user interrupt (Esc) is reported so the bridge can end the turn", () => {
	const t = new Transcript();
	const events = t.apply({ type: "user", uuid: "i1", timestamp: at, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
	assert.ok(events.some((e) => e.type === "interrupted"));
});

test("a plugin channel's namespaced source still unwraps", () => {
	// The source real Claude Code 2.1.311 writes for the plugin's channel.
	const { text, inputIds } = unwrapChannel('<channel source="plugin:toilet-pi:toilet-pi" input_id="in-9">\nhi\n</channel>');
	assert.equal(text, "hi");
	assert.deepEqual(inputIds, ["in-9"]);
});

test("Tail keeps a multibyte character that a read splits in half", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tp-utf8-"));
	const file = join(dir, "t.jsonl");
	const tail = new Tail(file);
	const line = Buffer.from('{"t":"héllo 🚽 done"}\n');
	const cut = line.indexOf(Buffer.from("🚽")) + 2; // inside the 4-byte emoji
	writeFileSync(file, line.subarray(0, cut));
	assert.deepEqual(await tail.read(), []);
	appendFileSync(file, line.subarray(cut));
	assert.deepEqual(await tail.read(), [{ t: "héllo 🚽 done" }]);
});

test("terminate only targets a process that is Claude Code", async () => {
	assert.equal(isClaudeCode(process.pid), false, "a plain node process is not Claude Code");
	const dir = mkdtempSync(join(tmpdir(), "tp-claude-"));
	const claude = join(dir, "claude");
	symlinkSync(process.execPath, claude);
	const child = spawn(claude, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
	try {
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(isClaudeCode(child.pid), true, "an executable named claude is");
	} finally {
		child.kill();
	}
	assert.equal(isClaudeCode(2 ** 22 + 12345), false, "a missing process is not");
});
