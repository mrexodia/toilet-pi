#!/usr/bin/env node
// End-to-end check of the Claude Code bridge against a real Toilet-Pi hub and CLI:  npm run claude:e2e
//
// This script plays the part of the `claude` process: it spawns the plugin's MCP server (start.js), runs the hook through
// `sh -c` as Claude Code does, writes a transcript, and reacts to channel notifications the way Claude would. The
// hub (server/), the CLI (cli/) and the bridge are the real ones. Needs `npm run setup` first. Linux/macOS.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const T = mkdtempSync(join(tmpdir(), "toilet-pi-claude-e2e-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: join(T, "pi"), TOILET_PI_CLAUDE_RUN_DIR: join(T, "run"),
	TOILET_PI_HOST_ID: "testbox", TOILET_PI_CLAUDE_DELIVERY_MS: "4000" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures++; };

// --- real hub
const server = spawn("npx", ["tsx", "src/node/entry.ts"], { cwd: join(ROOT, "server"), env: { ...env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
// Take the hub down with this script however it ends, including a crashed or timed-out check.
process.on("exit", () => { try { process.kill(-server.pid); } catch {} });
process.on("unhandledRejection", (error) => { console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 100 && !/listening|Admin login/i.test(serverLog); i++) await sleep(200);
const adminToken = JSON.parse(readFileSync(join(T, "pi", "toilet-pi-server.json"), "utf8")).token;
const base = `http://127.0.0.1:${PORT}`;
const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: adminToken }) });
const cookie = login.headers.get("set-cookie").split(";")[0];
const minted = await (await fetch(`${base}/auth/machine-token`, { method: "POST", headers: { cookie, origin: base } })).json();
const { parseToiletPiInput, writeToiletPiConfig } = await import(`${ROOT}/toilet-pi-config.js`);
process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
await writeToiletPiConfig(parseToiletPiInput(`ws://127.0.0.1:${PORT}/ws?token=${minted.token}`), env.PI_CODING_AGENT_DIR);
check(typeof minted.token === "string", "hub up, machine connect URL minted");

// --- CLI against the hub
function cli(...args) {
	return new Promise((resolve) => {
		const p = spawn("node", [join(ROOT, "cli/toilet-pi.js"), "--timeout", "15", ...args], { env: { ...env, TOILET_PI_CLI_SERVER: base, TOILET_PI_ADMIN_TOKEN: adminToken } });
		let out = ""; let err = "";
		p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
		p.on("close", (code) => resolve({ code, out, err }));
	});
}

// --- transcript
const SID = randomUUID();
const TP = join(T, `${SID}.jsonl`);
let parent = null;
const now = () => new Date().toISOString();
function entry(type, message, extra = {}) {
	const uuid = randomUUID();
	appendFileSync(TP, JSON.stringify({ parentUuid: parent, isSidechain: false, type, message, uuid, timestamp: now(), cwd: "/work/demo", sessionId: SID, ...extra }) + "\n");
	parent = uuid;
}
const user = (text) => entry("user", { role: "user", content: text });
// How Claude Code 2.1.x records a channel message (checked against a real session).
const channelUser = (inputId, text) => entry("user", { role: "user", content: `<channel source="toilet-pi" input_id="${inputId}">\n${text}\n</channel>` },
	{ isMeta: true, origin: { kind: "channel", server: "toilet-pi" }, promptSource: "system" });
const assistant = (content, stop = "end_turn") => entry("assistant", { id: `msg_${randomUUID()}`, model: "claude-opus-5-5", role: "assistant", content, stop_reason: stop,
	usage: { input_tokens: 3, cache_read_input_tokens: 41000, cache_creation_input_tokens: 900, output_tokens: 120 } });
const cost = (usd) => appendFileSync(TP, JSON.stringify({ type: "cost-state", sessionId: SID, totalCostUSD: usd }) + "\n");
user("hello"); assistant([{ type: "text", text: "Hi! What are we working on?" }]); cost(0.012);

// --- the bridge, as Claude Code would start it
const bridge = spawn("node", [join(ROOT, ".claude-plugin/start.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stderr.on("data", (d) => (bridgeLog += d));
const notifications = [];
let waiters = [];
let buf = "";
bridge.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
		notifications.push(msg);
		waiters = waiters.filter((w) => !w(msg));
	}
});
const next = (pred, ms = 10000) => new Promise((resolve, reject) => {
	const hit = notifications.find(pred); if (hit) { notifications.splice(notifications.indexOf(hit), 1); return resolve(hit); }
	const t = setTimeout(() => reject(new Error("timed out waiting for MCP message")), ms);
	waiters.push((m) => { if (!pred(m)) return false; clearTimeout(t); notifications.splice(notifications.indexOf(m), 1); resolve(m); return true; });
});
const mcp = (m) => bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
mcp({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.311" } } });
const init = await next((m) => m.id === 1);
check(init.result.capabilities.experimental["claude/channel"] && init.result.capabilities.experimental["claude/channel/permission"], "MCP initialize declares channel + permission relay");
mcp({ method: "notifications/initialized" });

function hook(event, extra = {}) {
	return new Promise((resolve) => {
		const p = spawn("sh", ["-c", `node ${join(ROOT, ".claude-plugin/hook.js")}`], { env });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.on("close", () => resolve(out.trim() ? JSON.parse(out) : null));
		p.stdin.end(JSON.stringify({ hook_event_name: event, session_id: currentSid, transcript_path: currentTp, cwd: "/work/demo", ...extra }));
	});
}
let currentSid = SID, currentTp = TP;
// The bridge keys its socket by its parent's pid: this process.

// 1. session appears with history
await hook("SessionStart", { source: "startup" });
await sleep(800);
let r = await cli("sessions");
const hostsOut = (await cli("hosts")).out;
check(r.out.includes(SID) && r.out.includes("/work/demo") && /sessions=1/.test(hostsOut), "session listed on the hub with its cwd, grouped under the machine");
r = await cli("history", SID, "--last", "5");
check(r.out.includes("hello") && r.out.includes("What are we working on"), "existing transcript visible via history");

// Simulated Claude: answer channel messages like a turn would
async function claudeTurn({ inputId, text }, { permission = false, tools = 1 } = {}) {
	channelUser(inputId, text);
	for (let k = 0; k < tools; k++) {
		const pre = await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } });
		if (pre?.continue === false) return { stopped: pre };
		const id = `toolu_${randomUUID().slice(0, 8)}`;
		assistant([{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }], "tool_use");
		if (permission && k === 0) {
			mcp({ method: "notifications/claude/channel/permission_request", params: { request_id: "abcde", tool_name: "Bash", description: "Delete the build folder", input_preview: '{"command": "rm -rf build"}' } });
			const verdict = await next((m) => m.method === "notifications/claude/channel/permission");
			permission = verdict.params;
		}
		entry("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "12 passing", is_error: false }] });
		await hook("PostToolUse", { tool_name: "Bash" });
		await sleep(300);
	}
	assistant([{ type: "text", text: `Done: ${text}` }]); cost(0.05);
	await hook("Stop", {});
	return { permission };
}

// 2. remote prompt → channel → turn → settled
const sending = cli("send", SID, "run the tests", "--wait");
const pushed = await next((m) => m.method === "notifications/claude/channel");
check(pushed.params.content === "run the tests" && /^[\w-]+$/.test(pushed.params.meta.input_id), "remote prompt pushed into the session as a channel event");
await claudeTurn({ inputId: pushed.params.meta.input_id, text: pushed.params.content });
r = await sending;
check(r.code === 0, `send --wait settles when Claude stops (exit ${r.code}${r.err ? `: ${r.err.trim()}` : ""})`);
r = await cli("history", SID, "--last", "6");
check(r.out.includes("run the tests") && !r.out.includes("<channel") && r.out.includes("12 passing") && r.out.includes("Done: run the tests"), "turn mirrored: unwrapped prompt, tool result, reply");
r = await cli("status", SID);
check(/claude-opus-5-5/.test(r.out), "status shows the model");

// 3. permission prompt answered from the hub with a bare "yes"
const s2 = cli("send", SID, "clean the build", "--wait");
const p2 = await next((m) => m.method === "notifications/claude/channel");
const turn2 = claudeTurn({ inputId: p2.params.meta.input_id, text: p2.params.content }, { permission: true });
await sleep(1200);
r = await cli("history", SID, "--last", "3");
check(r.out.includes("yes abcde"), "permission prompt shown on the hub with its reply format");
const yes = await cli("send", SID, "yes", "--steer");
const t2 = await turn2;
check(t2.permission?.request_id === "abcde" && t2.permission?.behavior === "allow", `bare "yes" from the hub became an allow verdict (${JSON.stringify(t2.permission)})`);
check(!notifications.some((m) => m.method === "notifications/claude/channel" && m.params.content === "yes"), "the verdict was not also sent to Claude as chat");
check((await s2).code === 0 && yes.code === 0, "both inputs settled");

// 3b. parallel tool calls: a Read finishing must not drop the Bash call's pending permission prompt
const s5 = cli("send", SID, "read and clean", "--wait");
const p5 = await next((m) => m.method === "notifications/claude/channel" && m.params.content === "read and clean");
channelUser(p5.params.meta.input_id, "read and clean");
await hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/work/demo/Makefile" } });
await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "make clean" } });
mcp({ method: "notifications/claude/channel/permission_request", params: { request_id: "fghij", tool_name: "Bash", description: "Clean", input_preview: '{"command": "make clean"}' } });
await sleep(300);
await hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "/work/demo/Makefile" } });
const yes5 = cli("send", SID, "yes fghij", "--steer");
const v5 = await next((m) => m.method === "notifications/claude/channel/permission", 8000).catch(() => null);
check(v5?.params?.request_id === "fghij" && v5.params.behavior === "allow", `a pending Bash prompt survives a parallel Read finishing (${JSON.stringify(v5?.params ?? null)})`);
check(!notifications.some((m) => m.method === "notifications/claude/channel" && m.params.content === "yes fghij"), "that verdict was not sent to Claude as chat");
await hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "make clean" } });
assistant([{ type: "text", text: "Cleaned." }]);
await hook("Stop", {});
await s5; await yes5;
for (const m of notifications.filter((m) => m.method === "notifications/claude/channel" && m.params.content === "yes fghij")) notifications.splice(notifications.indexOf(m), 1);

// 4. abort stops the run at the next tool boundary (real Claude Code fires no Stop after continue:false)
const s3 = cli("send", SID, "long refactor", "--wait");
const p3 = await next((m) => m.method === "notifications/claude/channel" && m.params.content === "long refactor");
channelUser(p3.params.meta.input_id, "long refactor");
check((await hook("PreToolUse", { tool_name: "Bash" })) === null, "tools run normally before an abort");
await sleep(500);
r = await cli("abort", SID);
check(r.code === 0, "abort accepted by the hub");
await sleep(500);
const stopped = await hook("PreToolUse", { tool_name: "Bash" });
check(stopped?.continue === false && stopped?.hookSpecificOutput?.permissionDecision === "deny", "next PreToolUse stops the run (continue:false + deny)");
// Real Claude Code fires no Stop after continue:false: the bridge must settle the turn itself.
const after = await hook("PreToolUse", { tool_name: "Bash" });
check(after === null, "abort is one-shot: the next run is not stopped");
await hook("Stop", {});
r = await s3;
check(r.code === 3, `aborted input reports aborted (exit ${r.code}, expected 3)`);

// 5. channel not enabled: nobody picks the message up → fails with an explanation instead of hanging
const s4 = cli("send", SID, "nobody home", "--wait");
await next((m) => m.method === "notifications/claude/channel" && m.params.content === "nobody home");
r = await s4;
check(r.code !== 0, `undelivered input fails instead of hanging (exit ${r.code}: ${(r.out + r.err).trim().split("\n").pop()})`);
r = await cli("history", SID, "--last", "2");
check(r.out.includes("dangerously-load-development-channels"), "hub history shows how to enable the channel");

// 6. /rename shows on the hub; /clear → new session id → bridge reconnects as the new session, without the old name
appendFileSync(TP, JSON.stringify({ type: "custom-title", customTitle: "Renamed work", sessionId: SID }) + "\n");
await sleep(1500);
r = await cli("status", SID);
check(/Name: Renamed work/.test(r.out), `a /rename title becomes the hub session name (${r.out.split("\n").find((l) => l.startsWith("Name")) ?? r.err.trim()})`);
const SID2 = randomUUID();
currentSid = SID2; currentTp = join(T, `${SID2}.jsonl`); writeFileSync(currentTp, "");
await hook("SessionStart", { source: "clear" });
await sleep(1000);
r = await cli("sessions");
check(r.out.includes(SID2), "after /clear the new session id is live on the hub");
r = await cli("status", SID2);
check(/^Name: -$/m.test(r.out), `the new session does not inherit the old session's title (${r.out.split("\n").find((l) => l.startsWith("Name")) ?? r.err.trim()})`);

// 7. exit: stdin closes → bridge exits, socket removed
const sock = join(T, "run", `${process.pid}.sock`);
check(existsSync(sock), "bridge socket keyed by the claude pid exists");
bridge.stdin.end();
await sleep(800);
check(bridge.exitCode !== null && !existsSync(sock), "bridge exits and removes its socket when Claude exits");

if (failures) { console.log("\n--- bridge log\n" + bridgeLog.slice(-3000)); }
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
