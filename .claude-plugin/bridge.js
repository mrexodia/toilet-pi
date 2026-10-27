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
import WebSocket from "ws";
import { buildHistoryPage } from "../history-page.js";
import { createRunnerSocketFactory } from "../runner-socket.js";
import { buildConnectUrl, parseToiletPiInput, readToiletPiConfig, redactUrlTokens } from "../toilet-pi-config.js";
import { runDir, socketPath } from "./ipc.js";
import { log, logToFile } from "./log.js";
import { Tail, Transcript, unwrapChannel } from "./transcript.js";

const PING_MS = 25_000;
const PONG_MS = 10_000;
const MAX_RECONNECT_MS = 30_000;
const HELLO_MESSAGES = 300;
const DELIVERY_TIMEOUT_MS = Number(process.env.TOILET_PI_CLAUDE_DELIVERY_MS) || 30_000;
const POLL_MS = 1000;

/** `yes abcde`, `no abcde`, or a bare `yes`/`no` when exactly one prompt is open. IDs never contain `l`. */
const VERDICT_RE = /^\s*(y|yes|allow|n|no|deny)(?:\s+([a-km-z]{5}))?\s*[.!]?\s*$/i;


// ---------------------------------------------------------------------------------------------------------------

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
	#reconnectAttempt = 0;
	#reconnectTimer;
	#heartbeat;
	#pongTimeout;
	#connectedAt = 0;
	#lastPongAt = 0;
	#ipc;
	#timers = [];

	/** @param {{ mcp: import("./mcp.js").StdioMcp }} options */
	constructor({ mcp }) {
		this.#mcp = mcp;
		mcp.onNotification = (method, params) => this.#onClaudeNotification(method, params);
		mcp.onClose = () => void this.stop();
	}

	async start() {
		mkdirSync(runDir(), { recursive: true, mode: 0o700 });
		const path = socketPath(process.ppid);
		try {
			unlinkSync(path);
		} catch {
			// none left over
		}
		this.#ipc = createServer((socket) => {
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
		});
		await new Promise((resolve, reject) => {
			this.#ipc.once("error", reject);
			this.#ipc.listen(path, resolve);
		});
		this.#socketPath = path;
		this.#timers.push(setInterval(() => void this.#pull(), POLL_MS));
		this.#timers.push(setInterval(() => this.#checkDelivery(), 2000));
		log(`listening for hooks of Claude process ${process.ppid}`);
	}

	#socketPath;

	async stop() {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const timer of this.#timers) clearInterval(timer);
		this.#watcher?.close();
		this.#disconnect("shutdown");
		this.#ipc?.close();
		if (this.#socketPath) {
			try {
				unlinkSync(this.#socketPath);
			} catch {
				// already gone
			}
		}
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
				this.#permissions.clear();
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
				this.#permissions.clear();
				return this.#abortRequested ? this.#endAborted(event) : null;
			case "Notification":
				// Claude is waiting for the user: whatever turn we thought was running has ended.
				if (input.notification_type === "idle_prompt") this.#setBusy(false, this.#abortRequested ? "aborted" : "settled");
				return null;
			case "Stop": {
				const aborted = this.#abortRequested;
				this.#permissions.clear();
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
		this.#permissions.clear();
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
			if (!this.#session.transcriptPath && input.transcript_path) this.#follow(input.transcript_path);
			return;
		}
		const previous = this.#session?.sessionGuid;
		this.#session = { sessionGuid, transcriptPath: null, cwd: typeof input.cwd === "string" ? input.cwd : process.cwd() };
		this.#transcript = new Transcript();
		this.#inputs.clear();
		this.#permissions.clear();
		this.#busy = false;
		this.#abortRequested = false;
		if (input.transcript_path) this.#follow(input.transcript_path);
		// Catch up silently: the hello carries the history.
		await this.#pull({ silent: true });
		log(previous ? `session changed ${previous} → ${sessionGuid}` : `session ${sessionGuid}`);
		this.#disconnect("session changed");
		this.#reconnectAttempt = 0;
		await this.#connect();
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
					if (event.type === "message") this.#emit({ type: "message", message: event.message });
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
		this.#permissions.clear();
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
		// The plugin's connect URL setting arrives here; empty (or an unsubstituted placeholder) means "not set".
		const configured = process.env.TOILET_PI_SERVER_URL?.trim();
		if (configured && !configured.startsWith("${")) return buildConnectUrl(parseToiletPiInput(configured));
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
					case "terminate":
						reply({ status: "requested" });
						return await this.#abort();
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
		if (type === "abort" || type === "abort_and_release" || type === "terminate_session") return this.#abort();
		if (type === "start_background_session") {
			return this.#send({ type: "runner_status", requestId: message.requestId, status: "error", error: "Claude Code sessions cannot launch new sessions" });
		}
	}
}
