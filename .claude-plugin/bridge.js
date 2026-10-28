/**
 * Claude Code as a Toilet-Pi runner.
 *
 * The plugin's MCP server (start.js) runs this for every Claude Code session. It is three things at once:
 *
 *  - A Claude Code **channel** (MCP over stdio): hub inputs are pushed into the live interactive session as
 *    `notifications/claude/channel`, and tool permission prompts are relayed to the hub and answered from it.
 *  - A Toilet-Pi **runner**: it connects to the hub with the machine connect URL saved by `/toilet-pi setup`, speaks
 *    the same session protocol as `toilet-pi.ts` and optchat, and mirrors the session's transcript as hub messages.
 *  - A **hook listener**: Claude Code's hooks (hook.js) tell it the session id and transcript path, when a turn starts
 *    and stops, and give it a place to stop a run that was aborted remotely.
 *
 * Remote input only reaches Claude when the session was started with the channel enabled
 * (`--dangerously-load-development-channels plugin:toilet-pi@<marketplace>` during the channels research preview). Without it,
 * the session still shows up live on the hub; inputs fail with an explanation instead of hanging.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, watch } from "node:fs";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { resolve } from "node:path";
import WebSocket from "ws";
import { buildHistoryPage } from "../history-page.js";
import { createRunnerSocketFactory } from "../runner-socket.js";
import { buildConnectUrl, parseToiletPiInput, readToiletPiConfig, redactUrlTokens } from "../toilet-pi-config.js";
import { endpoint, endpointIsFile, isClaudeCode, parentOf, runDir, sessionEndpoint, windowsParentOf } from "./ipc.js";
import { log, logToFile } from "./log.js";
import { locateTranscript, Tail, Transcript, unwrapChannel } from "./transcript.js";

const PING_MS = 25_000;
const PONG_MS = 10_000;
const MAX_RECONNECT_MS = 30_000;
const HELLO_MESSAGES = 300;
const DELIVERY_TIMEOUT_MS = Number(process.env.TOILET_PI_CLAUDE_DELIVERY_MS) || 30_000;
const POLL_MS = 1000;
/** Like pi's terminateSession: how long an aborted run gets to stop before Claude Code is ended anyway. */
const TERMINATE_GRACE_MS = 5000;

/** `yes abcde`, `no abcde`, or a bare `yes`/`no` when exactly one prompt is open. IDs never contain `l`. */
const VERDICT_RE = /^\s*(y|yes|allow|n|no|deny)(?:\s+([a-km-z]{5}))?\s*[.!]?\s*$/i;


// ---------------------------------------------------------------------------------------------------------------

/**
 * The Claude Code process when it is not this process's parent: on macOS/Linux the nearest ancestor that is Claude
 * Code; on Windows, where processes can't be identified that way, the grandparent (harmless if it isn't Claude).
 */
async function claudeBehindShim() {
	if (process.platform === "win32") return windowsParentOf(process.ppid);
	if (isClaudeCode(process.ppid)) return null;
	let pid = parentOf(process.ppid);
	for (let depth = 0; pid && depth < 4; depth++, pid = parentOf(pid)) if (isClaudeCode(pid)) return pid;
	return null;
}

/** Whether two paths name the same file; Windows paths compare without case. */
function samePath(a, b) {
	const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
	return norm(a) === norm(b);
}

export class Bridge {
	#mcp;
	#createSocket = createRunnerSocketFactory({ log: (text) => log(text) });
	#hostId = process.env.TOILET_PI_HOST_ID || hostname();
	#name = process.env.TOILET_PI_SESSION_NAME || null;

	/** @type {{ sessionGuid: string, transcriptPath: string | null, cwd: string | null } | null} */
	#session = null;
	#transcript = new Transcript();
	/** @type {Tail | null} */
	#tail = null;
	#watcher = null;
	#pulling = Promise.resolve();

	#busy = false;
	#idleSince = Date.now();
	#abortRequested = false;
	/** inputId → { state, text, sentAt } */
	#inputs = new Map();
	/** request_id → { tool_name, description, input_preview } */
	#permissions = new Map();

	#ws;
	#stopped = false;
	#terminating = false;
	#reconnectAttempt = 0;
	#reconnectTimer;
	#heartbeat;
	#pongTimeout;
	#connectedAt = 0;
	#lastPongAt = 0;
	#timers = [];

	/** @param {{ mcp: import("./mcp.js").StdioMcp }} options */
	constructor({ mcp }) {
		this.#mcp = mcp;
		mcp.onNotification = (method, params) => this.#onClaudeNotification(method, params);
		mcp.onClose = () => void this.stop();
	}

	async start() {
		log(`starting: pid ${process.pid}, parent ${process.ppid}, ${process.platform}, node ${process.version}, ` +
			`session ${process.env.CLAUDE_CODE_SESSION_ID ?? "(not given)"}, project ${process.env.CLAUDE_PROJECT_DIR ?? process.cwd()}`);
		if (endpointIsFile) mkdirSync(runDir(), { recursive: true, mode: 0o700 });
		// Keyed by the claude process, which is normally this process's parent.
		await this.#listen(endpoint(process.ppid));
		this.#timers.push(setInterval(() => void this.#pull(), POLL_MS));
		this.#timers.push(setInterval(() => this.#checkDelivery(), 2000));
		// A `node` shim (Scoop, Volta, …) makes the parent the shim, not Claude: also listen under Claude's own pid,
		// so hooks looking up CLAUDE_PID still find this bridge, including after /clear.
		void claudeBehindShim().then((pid) => {
			if (pid !== null && !this.#stopped) return this.#listen(endpoint(pid));
		});
		// Claude Code tells its MCP servers the session id: join the hub now rather than waiting for the first hook.
		const sessionGuid = process.env.CLAUDE_CODE_SESSION_ID;
		if (sessionGuid) {
			await this.#bind({ session_id: sessionGuid, transcript_path: locateTranscript(sessionGuid), cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd() });
		}
	}

	/** path → server: every endpoint this bridge answers hooks on. */
	#listeners = new Map();

	/** Listen for hooks on `path`; a failure (such as another bridge already using it) is logged and skipped. */
	async #listen(path) {
		if (this.#listeners.has(path)) return true;
		if (endpointIsFile) {
			try {
				unlinkSync(path);
			} catch {
				// none left over
			}
		}
		const server = createServer((socket) => this.#onHookConnection(socket));
		try {
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(path, resolve);
			});
		} catch (error) {
			log(`could not listen on ${path}: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
		server.on("error", () => {});
		this.#listeners.set(path, server);
		log(`listening for hooks on ${path}`);
		return true;
	}

	#unlisten(path) {
		const server = this.#listeners.get(path);
		if (server === undefined) return;
		this.#listeners.delete(path);
		server.close();
		if (endpointIsFile) {
			try {
				unlinkSync(path);
			} catch {
				// already gone
			}
		}
	}

	#onHookConnection(socket) {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			let input;
			try {
				input = JSON.parse(buffer.slice(0, newline));
			} catch {
				socket.end("{}\n");
				return;
			}
			this.onHook(input)
				.catch((error) => {
					log(`hook ${input?.hook_event_name}: ${error instanceof Error ? error.message : String(error)}`);
					return null;
				})
				.then((output) => socket.end(`${JSON.stringify(output ? { output } : {})}\n`));
		});
		socket.on("error", () => {});
	}

	async stop() {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const timer of this.#timers) clearInterval(timer);
		this.#watcher?.close();
		this.#disconnect("shutdown");
		for (const path of [...this.#listeners.keys()]) this.#unlisten(path);
		setTimeout(() => process.exit(0), 200).unref();
	}

	// --- hooks -------------------------------------------------------------------------------------------------

	/** One hook event from hook.js. Returns hook output JSON, or null. */
	async onHook(input) {
		const event = input?.hook_event_name;
		if (logToFile) log(`hook ${event}${input?.tool_name ? ` ${input.tool_name}` : ""}`);
		if (event === "SessionEnd") {
			this.#disconnect("session ended");
			this.#session = null;
			return null;
		}
		if (typeof input?.session_id === "string" && input.session_id !== "") await this.#bind(input);
		await this.#pull();
		switch (event) {
			case "UserPromptSubmit":
				this.#setBusy(true);
				// A channel message starts its turn through UserPromptSubmit too: confirm delivery now, without waiting
				// for the transcript.
				if (typeof input.prompt === "string") for (const inputId of unwrapChannel(input.prompt).inputIds) this.#delivered(inputId, false);
				return null;
			case "PreToolUse":
				this.#setBusy(true);
				return this.#abortRequested ? this.#endAborted(event) : null;
			case "PostToolUse":
			case "PostToolUseFailure":
				// Only this tool's prompt is settled: with parallel tool calls another may still be waiting for one.
				this.#forgetPermission(input.tool_name);
				return this.#abortRequested ? this.#endAborted(event) : null;
			case "Notification":
				// Claude is waiting for the user: whatever turn we thought was running has ended.
				if (input.notification_type === "idle_prompt") this.#setBusy(false, this.#abortRequested ? "aborted" : "settled");
				return null;
			case "Stop": {
				const aborted = this.#abortRequested;
				this.#abortRequested = false;
				this.#setBusy(false, aborted ? "aborted" : "settled");
				return null;
			}
			default:
				return null;
		}
	}

	/**
	 * Stop the run at this tool boundary. Claude Code does not fire Stop after a hook ends the turn with
	 * `continue: false`, so the turn is over as far as the hub is concerned right here.
	 */
	#endAborted(event) {
		this.#abortRequested = false;
		this.#notice({ role: "assistant", stopReason: "aborted", text: "⏹ Stopped remotely from Toilet-Pi." });
		this.#setBusy(false, "aborted");
		return this.#stopOutput(event);
	}

	/** `continue: false` ends the turn; PreToolUse also refuses the tool it was about to run. */
	#stopOutput(event) {
		const output = { continue: false, stopReason: "Aborted remotely from Toilet-Pi" };
		if (event !== "PreToolUse") return output;
		return { ...output, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The user aborted this run remotely from Toilet-Pi." } };
	}

	async #bind(input) {
		const sessionGuid = input.session_id;
		if (this.#session?.sessionGuid === sessionGuid) {
			const path = input.transcript_path;
			if (!path || (this.#session.transcriptPath && samePath(path, this.#session.transcriptPath))) return;
			return this.#retarget(path);
		}
		const previous = this.#session?.sessionGuid;
		// Hooks can also find this bridge by session id: move that endpoint along with the session.
		if (previous) this.#unlisten(sessionEndpoint(previous));
		void this.#listen(sessionEndpoint(sessionGuid));
		this.#session = { sessionGuid, transcriptPath: null, cwd: typeof input.cwd === "string" ? input.cwd : process.cwd() };
		// A /rename title belongs to its session: start over, keeping an explicit override.
		this.#name = process.env.TOILET_PI_SESSION_NAME || null;
		this.#transcript = new Transcript();
		this.#inputs.clear();
		this.#permissions.clear();
		this.#busy = false;
		this.#abortRequested = false;
		if (input.transcript_path) this.#follow(input.transcript_path);
		// Catch up silently: the hello carries the history.
		await this.#pull({ silent: true });
		log(previous ? `session changed ${previous} → ${sessionGuid}` : `session ${sessionGuid} (transcript ${input.transcript_path ?? "unknown"})`);
		this.#disconnect("session changed");
		this.#reconnectAttempt = 0;
		await this.#connect();
	}

	/** entryIds the hub already has, while #retarget re-reads a transcript: those messages aren't sent again. */
	#shown = null;

	/**
	 * Same session, but its transcript is elsewhere (the path guessed at startup was wrong). Follow the right file
	 * without touching the live state: inputs, permission prompts, a pending abort and the hub connection all stay,
	 * since reconnecting would turn every input in flight into "unknown". What the hub hasn't seen yet is sent as
	 * ordinary messages; messages only the bridge made (prompts, notices) keep their place by time.
	 */
	async #retarget(path) {
		log(`transcript is ${path}, not ${this.#session.transcriptPath ?? "known yet"}: following it`);
		const previous = this.#transcript.messages;
		this.#shown = new Set(previous.map((message) => message.entryId).filter(Boolean));
		this.#transcript = new Transcript();
		this.#follow(path);
		try {
			await this.#pull();
		} finally {
			this.#shown = null;
		}
		const own = previous.filter((message) => message.entryId?.startsWith("toilet-pi-"));
		if (own.length > 0) {
			this.#transcript.messages.push(...own);
			this.#transcript.messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
		}
	}

	#follow(path) {
		this.#session.transcriptPath = path;
		this.#tail = new Tail(path);
		this.#watcher?.close();
		try {
			this.#watcher = watch(path, () => void this.#pull());
			this.#watcher.on("error", () => {});
		} catch {
			// not created yet: the poll covers it
			this.#watcher = null;
		}
	}

	/** Read new transcript lines and publish them; serialized so events keep their order. */
	#pull({ silent = false } = {}) {
		this.#pulling = this.#pulling.then(async () => {
			const tail = this.#tail;
			if (tail === null) return;
			const entries = await tail.read();
			if (tail !== this.#tail) return;
			for (const entry of entries) {
				if (entry?.type === "custom-title" && typeof entry.customTitle === "string" && !process.env.TOILET_PI_SESSION_NAME) {
					this.#name = entry.customTitle;
					if (!silent) this.#emit({ type: "session_name", sessionName: this.#name });
				}
				for (const event of this.#transcript.apply(entry)) {
					if (event.type === "delivered") {
						for (const inputId of event.inputIds) this.#delivered(inputId, silent);
						continue;
					}
					if (event.type === "interrupted") {
						// Esc in the terminal: Claude Code fires no Stop for a user interrupt.
						if (!silent) {
							this.#abortRequested = false;
							this.#setBusy(false, "aborted");
						}
						continue;
					}
					if (silent) continue;
					if (event.type === "message") {
						if (!this.#shown?.has(event.message.entryId)) this.#emit({ type: "message", message: event.message });
					}
					else if (event.type === "tool_start") this.#emit({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
					else if (event.type === "tool_end") this.#emit({ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
					else if (event.type === "usage") this.#emit({ type: "usage", contextTokens: this.#transcript.contextTokens, costUsd: this.#transcript.costUsd });
					else if (event.type === "model") this.#emit({ type: "model", modelId: this.#transcript.model });
				}
			}
		}).catch((error) => log(`transcript: ${error instanceof Error ? error.message : String(error)}`));
		return this.#pulling;
	}

	#setBusy(busy, outcome = "settled") {
		if (!busy) {
			// The turn is over (Stop, idle, Esc or abort), so no tool is still waiting for permission.
			this.#permissions.clear();
			for (const [inputId, input] of this.#inputs) if (input.state === "running") this.#publish(inputId, outcome);
		}
		if (this.#busy === busy) return;
		this.#busy = busy;
		if (!busy) this.#idleSince = Date.now();
		this.#emit({ type: "busy", busy });
	}

	// --- inputs from the hub -----------------------------------------------------------------------------------

	#publish(inputId, state) {
		const input = this.#inputs.get(inputId);
		if (input === undefined || input.state === state) return;
		input.state = state;
		this.#emit({ type: "input_status", input: { inputId, sessionGuid: this.#session?.sessionGuid, state, updatedAt: Date.now() } });
		if (!["submitted", "running"].includes(state) && this.#inputs.size > 1024) {
			for (const [id, each] of this.#inputs) if (!["submitted", "running"].includes(each.state)) this.#inputs.delete(id);
		}
	}

	/** The transcript shows Claude received an input: its turn is under way. */
	#delivered(inputId, silent) {
		const input = this.#inputs.get(inputId);
		if (input === undefined || input.state !== "submitted") return;
		if (silent) {
			input.state = "running";
			return;
		}
		this.#emit({ type: "queued_input_remove", inputId });
		this.#publish(inputId, "running");
		this.#setBusy(true);
	}

	async #dispatch(inputId, text, mode) {
		if (this.#inputs.has(inputId)) return;
		this.#inputs.set(inputId, { state: "accepted", text, sentAt: Date.now() });
		this.#publish(inputId, "submitted");
		if (await this.#maybeVerdict(inputId, text)) return;
		if (this.#busy && mode === "prompt") {
			this.#publish(inputId, "failed");
			this.#emit({ type: "remote_input_failed", inputId });
			return;
		}
		this.#inputs.get(inputId).sentAt = Date.now();
		this.#mcp.notify("notifications/claude/channel", { content: text, meta: { input_id: inputId } });
	}

	/** A reply to an open permission prompt answers it instead of becoming a message to Claude. */
	async #maybeVerdict(inputId, text) {
		if (this.#permissions.size === 0) return false;
		const match = VERDICT_RE.exec(text);
		if (!match) return false;
		const requestId = match[2]?.toLowerCase() ?? (this.#permissions.size === 1 ? [...this.#permissions.keys()][0] : undefined);
		if (requestId === undefined || !this.#permissions.has(requestId)) return false;
		const behavior = /^(y|yes|allow)$/i.test(match[1]) ? "allow" : "deny";
		this.#notice({ role: "user", text: text.trim(), remoteInputId: inputId });
		this.#answerPermission(requestId, behavior);
		this.#publish(inputId, "running");
		this.#publish(inputId, "settled");
		return true;
	}

	/** A tool finished (or failed): drop the oldest open permission prompt for that tool, if it had one. */
	#forgetPermission(toolName) {
		for (const [requestId, request] of this.#permissions) {
			if (request.tool_name === toolName) {
				this.#permissions.delete(requestId);
				return;
			}
		}
	}

	#answerPermission(requestId, behavior) {
		const request = this.#permissions.get(requestId);
		this.#permissions.delete(requestId);
		this.#mcp.notify("notifications/claude/channel/permission", { request_id: requestId, behavior });
		this.#notice({ role: "assistant", stopReason: "stop", text: `${behavior === "allow" ? "✅ Allowed" : "❌ Denied"} ${request?.tool_name ?? "tool"} (${requestId}).` });
	}

	/** A message that is not in Claude's transcript but belongs in the hub's view of the session. */
	#notice(message) {
		const full = { timestamp: Date.now(), ...message, entryId: `toilet-pi-${randomUUID()}` };
		this.#transcript.remember(full);
		this.#emit({ type: "message", message: full });
	}

	/** Inputs Claude never picked up while idle: the channel is not enabled for this session. */
	#checkDelivery() {
		if (this.#busy) return;
		const now = Date.now();
		for (const [inputId, input] of this.#inputs) {
			if (input.state !== "submitted") continue;
			if (now - Math.max(input.sentAt, this.#idleSince) < DELIVERY_TIMEOUT_MS) continue;
			this.#publish(inputId, "failed");
			this.#emit({ type: "remote_input_failed", inputId });
			this.#notice({
				role: "assistant", stopReason: "error",
				text: "Error: Claude Code did not pick up this message. Remote input needs the Toilet-Pi channel: start Claude with " +
					"`claude --dangerously-load-development-channels plugin:toilet-pi@<marketplace>` (see .claude-plugin/README.md in toilet-pi). " +
					"Watching the session works without it.",
			});
		}
	}

	/** Like pi's abort: stop the current run, leave queued input alone (Claude Code already holds it). */
	async #abort() {
		for (const requestId of [...this.#permissions.keys()]) this.#answerPermission(requestId, "deny");
		if (this.#busy) this.#abortRequested = true;
	}

	/** Terminate ends the Claude Code process, so it is only offered when the parent is verifiably Claude Code. */
	#canTerminate() {
		return isClaudeCode(process.ppid);
	}

	/**
	 * Close the session like pi's terminateSession: abort the run, give it a few seconds to stop, then end Claude
	 * Code with SIGTERM (it restores the terminal and exits). The transcript stays, so `claude --resume` continues
	 * it. Once Claude exits, the bridge's stdin closes and it disconnects from the hub.
	 */
	async #terminate() {
		if (this.#terminating) return;
		this.#terminating = true;
		this.#notice({ role: "assistant", stopReason: "stop", text: "⏏ Closing this Claude Code session from Toilet-Pi. Continue it in a terminal with `claude --resume`." });
		await this.#abort();
		const deadline = Date.now() + TERMINATE_GRACE_MS;
		while (this.#busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
		log(`terminate: sending SIGTERM to Claude process ${process.ppid}`);
		try {
			process.kill(process.ppid, "SIGTERM");
		} catch (error) {
			this.#terminating = false;
			log(`terminate failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#cannotTerminate() {
		if (process.platform === "win32") {
			// Windows can only hard-kill a process, which would leave the terminal Claude Code was drawing in a mess.
			return "Closing Claude Code sessions remotely isn't supported on Windows yet; close it in its terminal (/exit).";
		}
		return "This Claude Code session cannot be closed remotely: the bridge could not confirm its parent process is Claude Code.";
	}

	// --- from Claude Code ------------------------------------------------------------------------------------

	#onClaudeNotification(method, params) {
		if (method !== "notifications/claude/channel/permission_request") return;
		const requestId = String(params.request_id ?? "");
		if (!/^[a-km-z]{5}$/.test(requestId)) return;
		this.#permissions.set(requestId, params);
		const preview = String(params.input_preview ?? "").trim();
		const lines = [
			`🔐 Claude wants to use ${params.tool_name ?? "a tool"}: ${params.description ?? ""}`.trim(),
			...(preview ? ["", "```", preview, "```"] : []),
			"",
			`Reply \`yes ${requestId}\` or \`no ${requestId}\`${this.#permissions.size === 1 ? " (or just yes / no)" : ""}.`,
		];
		this.#notice({ role: "assistant", text: lines.join("\n"), stopReason: "permission" });
	}

	// --- the hub socket --------------------------------------------------------------------------------------

	async #connectUrl() {
		// The plugin's connect_url option arrives in its own variable, so an empty option can't mask
		// TOILET_PI_SERVER_URL from the environment. Empty (or an unsubstituted placeholder) means "not set".
		for (const name of ["TOILET_PI_CLAUDE_CONNECT_URL", "TOILET_PI_SERVER_URL"]) {
			const configured = process.env[name]?.trim();
			if (configured && !configured.startsWith("${")) return buildConnectUrl(parseToiletPiInput(configured));
		}
		const config = await readToiletPiConfig();
		return config === null ? undefined : buildConnectUrl(config);
	}

	async #connect() {
		if (this.#stopped || this.#ws !== undefined || this.#session === null) return;
		const url = await this.#connectUrl();
		if (this.#stopped || this.#ws !== undefined || this.#session === null) return;
		if (url === undefined) {
			log("no connect URL: set the plugin's machine connect URL (/plugin → toilet-pi → configure), run `/toilet-pi setup` in pi, or set TOILET_PI_SERVER_URL");
			this.#scheduleReconnect(30_000);
			return;
		}
		log(`connecting to ${redactUrlTokens(url)}${this.#reconnectAttempt > 0 ? ` (attempt ${this.#reconnectAttempt + 1})` : ""}`);
		this.#lastPongAt = 0;
		const ws = this.#createSocket(url);
		this.#ws = ws;
		ws.on("open", () => {
			if (this.#ws !== ws) return;
			this.#connectedAt = Date.now();
			this.#startHeartbeat(ws);
			log(`connected as ${this.#session?.sessionGuid}`);
			this.#sendHello();
		});
		ws.on("message", (data) => {
			if (this.#ws !== ws) return;
			let message;
			try {
				message = JSON.parse(String(data));
			} catch {
				return;
			}
			void this.#onServerMessage(message).catch((error) => log(error instanceof Error ? error.message : String(error)));
		});
		ws.on("close", (code, reason) => {
			if (this.#ws !== ws) return;
			this.#ws = undefined;
			this.#clearHeartbeat();
			const lifetime = this.#connectedAt ? Date.now() - this.#connectedAt : 0;
			this.#connectedAt = 0;
			if (lifetime >= 30_000) this.#reconnectAttempt = 0;
			const why = reason.toString();
			log(`disconnected (${code}${why ? `: ${why}` : ""}); connected for ${lifetime}ms`);
			for (const [inputId, input] of this.#inputs) if (input.state === "submitted" || input.state === "running") input.state = "unknown";
			if (this.#stopped || code === 1008) return;
			this.#scheduleReconnect(why === "replaced" ? 60_000 : undefined);
		});
		ws.on("error", (error) => {
			if (this.#ws === ws) log(`socket error: ${error.message}`);
		});
	}

	#disconnect(reason) {
		if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#clearHeartbeat();
		const ws = this.#ws;
		this.#ws = undefined;
		if (ws !== undefined) {
			ws.removeAllListeners("message");
			ws.on("error", () => {});
			ws.close(1000, reason);
		}
	}

	#scheduleReconnect(delay) {
		if (this.#reconnectTimer !== undefined || this.#stopped) return;
		const base = delay ?? Math.min(MAX_RECONNECT_MS, 1000 * 2 ** Math.min(this.#reconnectAttempt, 5));
		const ms = Math.round(base * (0.8 + Math.random() * 0.4));
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#reconnectAttempt += 1;
			void this.#connect();
		}, ms);
	}

	#startHeartbeat(ws) {
		this.#clearHeartbeat();
		ws.on("pong", () => {
			if (this.#ws !== ws) return;
			this.#lastPongAt = Date.now();
			if (this.#pongTimeout !== undefined) clearTimeout(this.#pongTimeout);
			this.#pongTimeout = undefined;
		});
		this.#heartbeat = setInterval(() => {
			if (this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return this.#clearHeartbeat();
			try {
				ws.ping();
				if (this.#pongTimeout !== undefined) clearTimeout(this.#pongTimeout);
				this.#pongTimeout = setTimeout(() => {
					this.#pongTimeout = undefined;
					if (this.#ws !== ws) return;
					log("heartbeat timed out; reconnecting");
					ws.terminate();
				}, PONG_MS);
			} catch {
				ws.terminate();
			}
		}, PING_MS);
	}

	#clearHeartbeat() {
		if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
		if (this.#pongTimeout !== undefined) clearTimeout(this.#pongTimeout);
		this.#heartbeat = undefined;
		this.#pongTimeout = undefined;
	}

	#send(payload) {
		const ws = this.#ws;
		if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(payload));
		} catch {
			ws.terminate();
		}
	}

	#emit(event) {
		if (this.#session === null) return;
		this.#send({ type: "session_event", sessionGuid: this.#session.sessionGuid, event });
	}

	#sendHello() {
		if (this.#session === null) return;
		this.#send({
			type: "hello",
			role: "interactive",
			capabilities: ["input_tracking_v1", "history_v1", "agent_settled_v1"],
			hostId: this.#hostId,
			hostname: hostname(),
			launchRequestId: null,
			sessionGuid: this.#session.sessionGuid,
			// Not a pi session file: never let a host supervisor try to resume it.
			sessionFile: null,
			sessionName: this.#name,
			cwd: this.#session.cwd ?? this.#transcript.cwd,
			model: this.#transcript.model,
			contextWindowTokens: null,
			contextTokens: this.#transcript.contextTokens,
			costUsd: this.#transcript.costUsd,
			busy: this.#busy,
			streamingText: null,
			streamingThinkingText: null,
			history: this.#transcript.messages.slice(-HELLO_MESSAGES),
			updatedAt: Date.now(),
		});
	}

	#historyPage(since, last) {
		const rows = this.#transcript.messages.flatMap((message) => message.entryId === undefined ? [] : [{
			type: "message",
			id: message.entryId,
			timestamp: new Date(message.timestamp).toISOString(),
			message: {
				role: message.role,
				content: message.text,
				timestamp: message.timestamp,
				...(message.role === "assistant" ? { stopReason: message.stopReason } : {}),
				...(message.role === "toolResult" ? { toolName: message.toolName, isError: message.isError } : {}),
			},
		}]);
		const leafId = rows.length > 0 ? rows[rows.length - 1].id : null;
		return buildHistoryPage(rows, { source: "runtime-branch", leafId, ...(since === undefined ? {} : { since }), last });
	}

	async #onServerMessage(message) {
		const type = message.type;
		if (type === "control_command") {
			const reply = (data) => this.#send({ type: "control_response", requestId: message.requestId, success: true, data });
			const fail = (code, text) => this.#send({ type: "control_response", requestId: message.requestId, success: false, error: { code, message: text } });
			if (message.sessionGuid !== this.#session?.sessionGuid) return fail("session_changed", "Session changed before execution");
			try {
				switch (message.operation) {
					case "send":
						return await this.#dispatch(String(message.inputId), String(message.text ?? ""), String(message.mode ?? "prompt"));
					case "history":
						await this.#pull();
						return reply({ history: this.#historyPage(typeof message.since === "string" ? message.since : undefined, typeof message.last === "number" ? message.last : 100) });
					case "abort":
						reply({ status: "requested" });
						return await this.#abort();
					case "terminate":
						// Acknowledges the shutdown request, not process exit, as for pi.
						if (!this.#canTerminate()) return fail("unsupported", this.#cannotTerminate());
						reply({ status: "requested" });
						return await this.#terminate();
					default:
						return fail("unsupported", "Unsupported control operation");
				}
			} catch (error) {
				return fail(error?.code === "cursor_not_found" ? "cursor_not_found" : "runtime_error", "Operation failed; inspect session state before retrying");
			}
		}
		if (type === "input") {
			// Web UI inputs carry no mode: queue behind a busy turn, like the interactive pi runner steers.
			return this.#dispatch(typeof message.inputId === "string" ? message.inputId : randomUUID(), String(message.text ?? ""), "steer");
		}
		if (type === "abort" || type === "abort_and_release") return this.#abort();
		if (type === "terminate_session") {
			// The web UI's close-session action: the hub has already told the user it is closing.
			if (this.#canTerminate()) return this.#terminate();
			return this.#notice({ role: "assistant", stopReason: "error", text: `Error: ${this.#cannotTerminate()}` });
		}
		if (type === "start_background_session") {
			return this.#send({ type: "runner_status", requestId: message.requestId, status: "error", error: "Claude Code sessions cannot launch new sessions" });
		}
	}
}
