/**
 * The agent as a Toilet-Pi runner: it connects to the hub with the machine's connect URL and speaks the session
 * protocol of `toilet-pi.ts`, so the web UI and the CLI see one always-active interactive session. Inputs become
 * turns or steers of the durable conversation, with the hub's input ids as durable request ids, so tracking and
 * settlement come from durable submissions rather than a visible marker.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type Cursor,
	type EntryRecord,
	type Submission,
	type SubmissionId,
	UsageDoc,
	watchEvents,
} from "@earendil-works/pi-durable";
import WebSocket from "ws";
import { buildHistoryPage } from "../../history-page.js";
import { createModelController } from "../../model-control.js";
import { buildConnectUrl, parseToiletPiInput, readToiletPiConfig, redactUrlTokens } from "../../toilet-pi-config.js";
import type { Agent } from "./host.ts";
import { contentText, NOTE_KIND } from "./optchat/memory.ts";
import { StreamedMessage } from "./stream.ts";

const context = BACKGROUND_CONTEXT;
const PING_MS = 25_000;
const PONG_MS = 10_000;
const MAX_RECONNECT_MS = 30_000;
const MAX_TEXT_BYTES = 50 * 1024;
const HELLO_ENTRIES = 300;

type Identity = { sessionGuid: string };

type Tracked = {
	inputId: string;
	state: string;
	submissionId?: number;
};

type SanitizedMessage = Record<string, unknown> & { role: "user" | "assistant" | "toolResult"; text: string };

export type RunnerOptions = {
	readonly agent: Agent;
	/** The session's name on the hub; default: the home's optchat.json, else none (the hub shows the first message). */
	readonly name?: string;
	/** A machine connect URL; default: the one `/toilet-pi setup` saved, or TOILET_PI_SERVER_URL. */
	readonly connectUrl?: string;
	readonly log?: (text: string) => void;
};

function truncate(text: string): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= MAX_TEXT_BYTES) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") + 48 <= MAX_TEXT_BYTES) low = mid;
		else high = mid - 1;
	}
	return `${text.slice(0, low)}\n... (truncated for toilet-pi at 50KB)`;
}

function normalize(text: string): string {
	return truncate(text.replace(/\r\n/g, "\n").trim());
}

/** An entry as the hub's sanitized message; null for entries the hub does not show. */
export function sanitize(entry: EntryRecord, tools: Map<string, { toolName: string; args?: unknown; startedAt?: number }>): SanitizedMessage | null {
	if (entry.kind === NOTE_KIND) {
		const data = entry.data as { text: string; date: number } | undefined;
		return data === undefined ? null : { role: "user", timestamp: data.date, text: normalize(`[note] ${data.text}`) };
	}
	const message = entry.model?.[0];
	if (message === undefined) return null;
	if (message.role === "user") {
		const text = normalize(contentText(message.content));
		return text === "" ? null : { role: "user", timestamp: message.timestamp, text };
	}
	if (message.role === "assistant") {
		const text = normalize(message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
		const thinkingText = normalize(message.content.flatMap((b) => (b.type === "thinking" ? [b.thinking] : [])).join("\n\n"));
		if (text === "" && thinkingText === "" && message.stopReason === "toolUse") return null;
		const error = message.stopReason === "error" && message.errorMessage ? normalize(message.errorMessage) : "";
		const shown = error
			? normalize(`${text ? `${text}\n\n` : ""}${/^error\s*:/i.test(error) ? error : `Error: ${error}`}`)
			: text || (message.stopReason === "toolUse" ? "" : `[${message.stopReason}]`);
		return {
			role: "assistant",
			timestamp: message.timestamp,
			text: shown,
			...(thinkingText === "" ? {} : { thinkingText }),
			stopReason: message.stopReason,
		};
	}
	if (message.role === "toolResult") {
		const started = tools.get(message.toolCallId);
		return {
			role: "toolResult",
			timestamp: message.timestamp,
			toolCallId: message.toolCallId,
			toolName: message.toolName || started?.toolName || "tool",
			text: normalize(contentText(message.content)),
			isError: message.isError,
			...(started?.args === undefined ? {} : { args: started.args }),
			...(started?.startedAt === undefined ? {} : { durationMs: Date.now() - started.startedAt }),
		};
	}
	return null;
}

export class Runner {
	readonly #agent: Agent;
	readonly #name: string | undefined;
	readonly #log: (text: string) => void;
	readonly #connectUrlOption: string | undefined;
	#identity: Identity | undefined;
	#ws: WebSocket | undefined;
	#stopped = false;
	#reconnectAttempt = 0;
	#reconnectTimer: NodeJS.Timeout | undefined;
	#heartbeat: NodeJS.Timeout | undefined;
	#pongTimeout: NodeJS.Timeout | undefined;
	#connectedAt = 0;
	#busy = false;
	readonly #partial = new StreamedMessage();
	#lastStreamAt = 0;
	#contextTokens: number | null = null;
	#costUsd: number | null = null;
	#config: { provider: string | null; modelId: string | null; thinkingLevel: string | null } = { provider: null, modelId: null, thinkingLevel: null };
	readonly #inputs = new Map<string, Tracked>();
	readonly #bySubmission = new Map<number, string>();
	readonly #queue: { inputId: string; text: string }[] = [];
	readonly #tools = new Map<string, { toolName: string; args?: unknown; startedAt?: number }>();
	#events: { stop(): Promise<unknown> } | undefined;
	#controller: ReturnType<typeof createModelController> | undefined;
	/** What the model controller sees as pi's context: live getters over this runner's state. */
	readonly #context = {
		runner: this,
		get model() {
			return { provider: this.runner.#config.provider, id: this.runner.#config.modelId };
		},
		get thinkingLevel() {
			return this.runner.#config.thinkingLevel;
		},
		sessionManager: { getSessionId: (): string | undefined => this.#identity?.sessionGuid },
		isIdle: (): boolean => !this.#busy,
		hasPendingMessages: (): boolean => this.#queue.length > 0,
		modelRegistry: { getAvailable: async () => this.#agent.modelRuntime.getAvailableSnapshot() },
	};

	constructor(options: RunnerOptions) {
		this.#agent = options.agent;
		this.#name = options.name ?? options.agent.name;
		this.#log = options.log ?? ((text) => console.error(text));
		this.#connectUrlOption = options.connectUrl;
	}

	get sessionGuid(): string | undefined {
		return this.#identity?.sessionGuid;
	}

	// --- lifecycle

	async start(): Promise<void> {
		this.#identity = await this.#loadIdentity();
		const agent = await this.#agent.root.agent(context);
		this.#config = {
			provider: agent.model?.provider ?? null,
			modelId: agent.model?.modelId ?? null,
			thinkingLevel: agent.thinkingLevel ?? null,
		};
		this.#costUsd = await this.#totalCost();
		this.#controller = createModelController({
			pi: {
				getThinkingLevel: () => this.#config.thinkingLevel,
				setModel: async (model: { provider: string; id: string }) => {
					this.#config = { ...this.#config, provider: model.provider, modelId: model.id };
					await this.#agent.root.configure({ model: { provider: model.provider, modelId: model.id } }, context);
					await this.#agent.saveConfig({ model: `${model.provider}/${model.id}` }).catch((error) => this.#log(String(error)));
					return true;
				},
				setThinkingLevel: (level: string) => {
					this.#config = { ...this.#config, thinkingLevel: level };
					void this.#agent.root
						.configure({ thinkingLevel: level as never }, context)
						.then(() => this.#agent.saveConfig({ thinking: level }))
						.catch((error) => this.#log(String(error)));
				},
			},
			// One stable object: the controller compares its identity to detect a session change.
			getContext: () => this.#context,
			loadThinkingLevels: async () => getSupportedThinkingLevels,
			hasPendingInput: () => [...this.#inputs.values()].some((input) => input.state === "submitted" || input.state === "running"),
		});
		const events = await watchEvents(this.#agent.harness, this.#agent.root.id, context);
		events.start(async (batch) => {
			for (const event of batch) await this.#onEvent(event);
		});
		this.#events = events;
		this.#busy = await this.#agent.optchat.busy();
		await this.#connect();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
		this.#clearHeartbeat();
		await this.#events?.stop().catch(() => {});
		const ws = this.#ws;
		this.#ws = undefined;
		if (ws !== undefined) {
			ws.removeAllListeners();
			ws.on("error", () => {});
			ws.close(1000, "shutdown");
		}
	}

	async #loadIdentity(): Promise<Identity> {
		const file = join(this.#agent.home, ".optchat", "runner.json");
		try {
			const saved = JSON.parse(await readFile(file, "utf8")) as Partial<Identity>;
			if (typeof saved.sessionGuid === "string" && saved.sessionGuid !== "") return { sessionGuid: saved.sessionGuid };
		} catch {
			// a new identity
		}
		const identity = { sessionGuid: randomUUID() };
		await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
		return identity;
	}

	async #connectUrl(): Promise<string | undefined> {
		if (this.#connectUrlOption !== undefined) return buildConnectUrl(parseToiletPiInput(this.#connectUrlOption));
		if (process.env.TOILET_PI_SERVER_URL) return buildConnectUrl(parseToiletPiInput(process.env.TOILET_PI_SERVER_URL));
		const config = await readToiletPiConfig();
		return config === null ? undefined : buildConnectUrl(config);
	}

	// --- the socket

	async #connect(): Promise<void> {
		if (this.#stopped || this.#ws !== undefined) return;
		const url = await this.#connectUrl();
		if (url === undefined) {
			this.#log("toilet-pi: no connect URL; run `/toilet-pi setup <url>` in pi, or set TOILET_PI_SERVER_URL");
			this.#scheduleReconnect();
			return;
		}
		this.#log(`toilet-pi: connecting to ${redactUrlTokens(url)}${this.#reconnectAttempt > 0 ? ` (attempt ${this.#reconnectAttempt + 1})` : ""}`);
		const ws = new WebSocket(url);
		this.#ws = ws;
		ws.on("open", () => {
			if (this.#ws !== ws) return;
			this.#connectedAt = Date.now();
			this.#startHeartbeat(ws);
			this.#log(`toilet-pi: connected as ${this.#name ?? "(unnamed)"} (${this.#identity?.sessionGuid})`);
			void this.#sendHello();
		});
		ws.on("message", (data) => {
			if (this.#ws !== ws) return;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(String(data));
			} catch {
				return;
			}
			void this.#onServerMessage(message).catch((error) => this.#log(`toilet-pi: ${error instanceof Error ? error.message : String(error)}`));
		});
		ws.on("close", (code, reason) => {
			if (this.#ws !== ws) return;
			this.#ws = undefined;
			this.#clearHeartbeat();
			const lifetime = this.#connectedAt ? Date.now() - this.#connectedAt : 0;
			this.#connectedAt = 0;
			if (lifetime >= 30_000) this.#reconnectAttempt = 0;
			const why = reason.toString();
			this.#log(`toilet-pi: disconnected (${code}${why ? `: ${why}` : ""})`);
			for (const input of this.#inputs.values()) if (input.state === "submitted") input.state = "unknown";
			if (this.#stopped) return;
			if (why === "replaced") {
				this.#log("toilet-pi: another runner connected with this session id; reconnecting in a minute");
				this.#scheduleReconnect(60_000);
				return;
			}
			this.#scheduleReconnect();
		});
		ws.on("error", (error) => {
			if (this.#ws === ws) this.#log(`toilet-pi: socket error: ${error.message}`);
		});
	}

	#scheduleReconnect(delay?: number): void {
		if (this.#reconnectTimer !== undefined || this.#stopped) return;
		const base = delay ?? Math.min(MAX_RECONNECT_MS, 1000 * 2 ** Math.min(this.#reconnectAttempt, 5));
		const ms = Math.round(base * (0.8 + Math.random() * 0.4));
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#reconnectAttempt += 1;
			void this.#connect();
		}, ms);
	}

	#startHeartbeat(ws: WebSocket): void {
		this.#clearHeartbeat();
		ws.on("pong", () => {
			if (this.#pongTimeout !== undefined) clearTimeout(this.#pongTimeout);
			this.#pongTimeout = undefined;
		});
		this.#heartbeat = setInterval(() => {
			if (this.#ws !== ws || ws.readyState !== WebSocket.OPEN) {
				this.#clearHeartbeat();
				return;
			}
			try {
				ws.ping();
				if (this.#pongTimeout !== undefined) clearTimeout(this.#pongTimeout);
				this.#pongTimeout = setTimeout(() => {
					this.#pongTimeout = undefined;
					if (this.#ws !== ws) return;
					this.#log("toilet-pi: heartbeat timed out; reconnecting");
					ws.terminate();
				}, PONG_MS);
			} catch {
				ws.terminate();
			}
		}, PING_MS);
	}

	#clearHeartbeat(): void {
		if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
		if (this.#pongTimeout !== undefined) clearTimeout(this.#pongTimeout);
		this.#heartbeat = undefined;
		this.#pongTimeout = undefined;
	}

	#send(payload: unknown): void {
		const ws = this.#ws;
		if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(payload));
		} catch {
			ws.terminate();
		}
	}

	#emit(event: Record<string, unknown>): void {
		if (this.#identity === undefined) return;
		this.#send({ type: "session_event", sessionGuid: this.#identity.sessionGuid, event });
	}

	// --- hello and history

	async #entries(limit: number): Promise<EntryRecord[]> {
		const out: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await this.#agent.root.entries({}, Math.min(256, limit - out.length), cursor, context);
			out.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined && out.length < limit);
		return out.reverse();
	}

	async #history(limit: number): Promise<SanitizedMessage[]> {
		const entries = await this.#entries(limit);
		const history: SanitizedMessage[] = [];
		for (const entry of entries) {
			const message = sanitize(entry, this.#tools);
			if (message !== null) history.push({ ...message, entryId: String(entry.id) });
		}
		return history;
	}

	async #historyPage(since: string | undefined, last: number): Promise<Record<string, unknown>> {
		const entries = await this.#entries(5000);
		const rows = entries.flatMap((entry) => {
			const message = sanitize(entry, this.#tools);
			if (message === null) return [];
			const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
			return [
				{
					type: "message",
					id: String(entry.id),
					timestamp: new Date(timestamp).toISOString(),
					message: {
						role: message.role,
						content: message.text,
						timestamp,
						...(message.role === "assistant" ? { stopReason: message.stopReason } : {}),
						...(message.role === "toolResult" ? { toolName: message.toolName, isError: message.isError } : {}),
					},
				},
			];
		});
		const leafId = rows.length > 0 ? rows[rows.length - 1]!.id : null;
		return buildHistoryPage(rows, { source: "runtime-branch", leafId, ...(since === undefined ? {} : { since }), last });
	}

	async #totalCost(): Promise<number | null> {
		const usage = await this.#agent.harness.snapshot(UsageDoc, this.#agent.root.id, context);
		if (usage === undefined) return null;
		let total = 0;
		for (const each of Object.values((usage as { models?: Record<string, { cost?: { total?: number } }> }).models ?? {})) {
			total += each.cost?.total ?? 0;
		}
		return total;
	}

	async #sendHello(): Promise<void> {
		if (this.#identity === undefined) return;
		const model = this.#config.provider && this.#config.modelId ? this.#agent.modelRuntime.getModel(this.#config.provider, this.#config.modelId) : undefined;
		this.#send({
			type: "hello",
			role: "interactive",
			capabilities: ["model_control_v1", "input_tracking_v1", "history_v1", "agent_settled_v1"],
			configuration: this.#controller?.configuration(),
			hostId: process.env.TOILET_PI_HOST_ID || hostname(),
			hostname: hostname(),
			launchRequestId: null,
			sessionGuid: this.#identity.sessionGuid,
			sessionFile: null,
			sessionName: this.#name ?? null,
			cwd: this.#agent.home,
			model: this.#config.modelId,
			contextWindowTokens: model?.contextWindow ?? null,
			contextTokens: this.#contextTokens,
			costUsd: this.#costUsd,
			busy: this.#busy,
			streamingText: this.#busy ? this.#partial.text : null,
			streamingThinkingText: this.#busy ? this.#partial.thinking : null,
			history: await this.#history(HELLO_ENTRIES),
			updatedAt: Date.now(),
		});
	}

	// --- from the hub

	async #onServerMessage(message: Record<string, unknown>): Promise<void> {
		const type = message.type;
		if (type === "control_command") {
			const reply = (data: Record<string, unknown>) => this.#send({ type: "control_response", requestId: message.requestId, success: true, data });
			const fail = (code: string, text: string) =>
				this.#send({ type: "control_response", requestId: message.requestId, success: false, error: { code, message: text } });
			if (message.sessionGuid !== this.#identity?.sessionGuid) return fail("session_changed", "Session changed before execution");
			try {
				switch (message.operation) {
					case "send":
						await this.#dispatch(String(message.inputId), String(message.text ?? ""), String(message.mode ?? "prompt"));
						return;
					case "history":
						return reply({ history: await this.#historyPage(typeof message.since === "string" ? message.since : undefined, typeof message.last === "number" ? message.last : 100) });
					case "abort":
						reply({ status: "requested" });
						await this.#abort();
						return;
					case "terminate":
						reply({ status: "requested" });
						this.#log("toilet-pi: terminate requested; the agent aborts its run and stays up");
						await this.#abort();
						return;
					default:
						return fail("unsupported", "Unsupported control operation");
				}
			} catch (error) {
				const code = (error as { code?: string })?.code === "cursor_not_found" ? "cursor_not_found" : "runtime_error";
				return fail(code, "Operation failed; inspect session state before retrying");
			}
		}
		if (type === "session_request") {
			const response = await this.#controller!.run(message);
			this.#send(response);
			if (message.operation === "configure") this.#emit({ type: "configuration", configuration: this.#controller!.configuration() });
			return;
		}
		if (type === "input") {
			await this.#dispatch(typeof message.inputId === "string" ? message.inputId : randomUUID(), String(message.text ?? ""), "prompt");
			return;
		}
		if (type === "abort" || type === "abort_and_release") {
			await this.#abort();
			return;
		}
		if (type === "terminate_session") {
			this.#log("toilet-pi: terminate requested; the agent aborts its run and stays up");
			await this.#abort();
		}
	}

	async #abort(): Promise<void> {
		this.#queue.splice(0);
		await this.#agent.root.abort(context);
	}

	#publish(inputId: string, state: string): void {
		const input = this.#inputs.get(inputId);
		if (input === undefined) return;
		input.state = state;
		this.#emit({ type: "input_status", input: { inputId, sessionGuid: this.#identity?.sessionGuid, state, updatedAt: Date.now() } });
		if (state !== "submitted" && state !== "running") {
			if (this.#inputs.size > 1024) {
				for (const [id, each] of this.#inputs) if (each.state !== "submitted" && each.state !== "running") this.#inputs.delete(id);
			}
		}
	}

	/** An input from the hub: a turn when idle, a steer while busy, or a follow-up kept for the next idle moment. */
	async #dispatch(inputId: string, text: string, mode: string): Promise<void> {
		if (this.#inputs.has(inputId)) return;
		this.#inputs.set(inputId, { inputId, state: "submitted" });
		if (this.#controller?.isConfiguring()) return this.#publish(inputId, "failed");
		this.#publish(inputId, "submitted");
		if (this.#busy && mode === "followUp") {
			this.#queue.push({ inputId, text });
			return;
		}
		if (this.#busy && mode === "prompt") return this.#publish(inputId, "failed");
		await this.#submit(inputId, text);
	}

	async #submit(inputId: string, text: string): Promise<void> {
		let submission: Submission;
		try {
			submission = this.#busy ? await this.#agent.optchat.steer(text, inputId) : await this.#agent.optchat.turn(text, { requestId: inputId });
		} catch (error) {
			this.#log(`toilet-pi: input ${inputId} failed: ${error instanceof Error ? error.message : String(error)}`);
			this.#publish(inputId, "failed");
			return;
		}
		const tracked = this.#inputs.get(inputId);
		if (tracked !== undefined) tracked.submissionId = submission.id as number;
		this.#bySubmission.set(submission.id as number, inputId);
		this.#emit({ type: "queued_input_remove", inputId });
		// The run may have started before this handle came back: a placed input is running.
		const status = await submission.status(context).catch(() => undefined);
		if (status !== undefined && status.status !== "queued") this.#running(inputId);
		void submission
			.wait(context)
			.then((settled) => {
				this.#bySubmission.delete(submission.id as number);
				this.#running(inputId);
				if (settled.status === "done") this.#publish(inputId, "settled");
				else this.#publish(inputId, settled.reason === "aborted" ? "aborted" : "failed");
			})
			.catch(() => this.#publish(inputId, "unknown"));
	}

	/** The hub accepts only submitted → running → a terminal state: publish "running" once, on the way. */
	#running(inputId: string): void {
		const input = this.#inputs.get(inputId);
		if (input !== undefined && input.state === "submitted") this.#publish(inputId, "running");
	}

	// --- from the conversation

	async #onEvent(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "run_start":
				this.#busy = true;
				this.#emit({ type: "busy", busy: true });
				for (const id of event.inputs) {
					const inputId = this.#bySubmission.get(id as unknown as number);
					if (inputId !== undefined) this.#running(inputId);
				}
				return;
			case "run_end": {
				this.#busy = false;
				this.#emit({ type: "busy", busy: false });
				const next = this.#queue.shift();
				if (next !== undefined) await this.#submit(next.inputId, next.text);
				return;
			}
			case "message_start":
				if (event.message.role === "assistant") {
					this.#partial.reset();
					this.#emit({ type: "assistant_stream_start" });
				}
				return;
			case "message_update": {
				this.#partial.apply(event.changes);
				const now = Date.now();
				if (now - this.#lastStreamAt < 120) return;
				this.#lastStreamAt = now;
				this.#emit({ type: "assistant_stream_update", text: this.#partial.text, thinkingText: this.#partial.thinking });
				return;
			}
			case "message_end": {
				const message = event.entry.model?.[0];
				if (message?.role === "assistant") {
					this.#emit({ type: "assistant_stream_end" });
					if (Number.isFinite(message.usage?.totalTokens)) this.#contextTokens = message.usage.totalTokens;
					if (Number.isFinite(message.usage?.cost?.total)) this.#costUsd = (this.#costUsd ?? 0) + message.usage.cost.total;
					this.#emit({ type: "usage", contextTokens: this.#contextTokens, costUsd: this.#costUsd });
				}
				const sanitized = sanitize(event.entry, this.#tools);
				if (sanitized !== null) {
					if (sanitized.role === "user") {
						const placed = [...this.#inputs.values()].find((input) => input.state === "running" && input.submissionId !== undefined);
						if (placed !== undefined) sanitized.remoteInputId = placed.inputId;
					}
					this.#emit({ type: "message", message: { ...sanitized, entryId: String(event.entry.id) } });
					if (sanitized.role === "toolResult") this.#tools.delete(String(sanitized.toolCallId));
				}
				return;
			}
			case "tool_execution_start":
				this.#tools.set(event.toolCallId, { toolName: event.toolName, args: event.args, startedAt: Date.now() });
				this.#emit({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
				return;
			case "tool_execution_end": {
				const result = event.entry?.model?.[0];
				this.#emit({
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: result?.role === "toolResult" ? result.isError : false,
				});
				return;
			}
			case "agent_changed": {
				const agent = event.agent;
				this.#config = {
					provider: agent.model?.provider ?? this.#config.provider,
					modelId: agent.model?.modelId ?? this.#config.modelId,
					thinkingLevel: agent.thinkingLevel ?? this.#config.thinkingLevel,
				};
				if (!this.#controller?.isConfiguring()) this.#emit({ type: "configuration", configuration: this.#controller?.configuration() });
				return;
			}
			default:
				return;
		}
	}
}

export type { SubmissionId };
