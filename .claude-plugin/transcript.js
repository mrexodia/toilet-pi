/**
 * Claude Code transcript (`~/.claude/projects/<slug>/<session>.jsonl`) → Toilet-Pi sanitized messages.
 *
 * Claude Code writes one JSON entry per line. Assistant turns are split into one entry per content block, and tool
 * results come back as user entries carrying `tool_result` blocks. This module turns those entries into the hub's
 * user / assistant / toolResult messages, and reports the live signals the runner needs (tool start/end, model,
 * context size, cost). It is pure: the bridge feeds it lines, it returns what to publish.
 */

import { open, stat } from "node:fs/promises";

const MAX_TEXT_BYTES = 50 * 1024;

/**
 * `<channel source="toilet-pi" input_id="…">text</channel>`: a message the bridge pushed into the session. As a
 * plugin server the source can carry a namespaced name (such as `plugin:toilet-pi:toilet-pi`), so any source that
 * mentions toilet-pi matches.
 */
const CHANNEL_RE = /<channel\s+source="[^"]*toilet-pi[^"]*"([^>]*)>([\s\S]*?)<\/channel>/g;
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g;

function truncate(text) {
	if (Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") + 48 <= MAX_TEXT_BYTES) low = mid;
		else high = mid - 1;
	}
	return `${text.slice(0, low)}\n... (truncated for toilet-pi at 50KB)`;
}

function normalize(text) {
	return truncate(String(text ?? "").replace(/\r\n/g, "\n").trim());
}

function timestampOf(entry) {
	const value = Date.parse(entry?.timestamp ?? "");
	return Number.isFinite(value) ? value : Date.now();
}

/** Text of a user/tool_result content value (string or blocks), without Claude Code's injected reminders. */
export function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			if (block?.type === "text" && typeof block.text === "string") return [block.text];
			if (block?.type === "image") return ["[image]"];
			return [];
		})
		.filter((text) => !/^\s*<system-reminder>/.test(text))
		.join("\n");
}

/**
 * Remote inputs arrive wrapped in a channel tag. Unwrap them so the hub shows what the user typed, and return the
 * input ids so the bridge can confirm delivery and tag the message with `remoteInputId`.
 */
export function unwrapChannel(text) {
	const inputIds = [];
	const unwrapped = text.replace(CHANNEL_RE, (_, attrs, body) => {
		for (const [, key, value] of attrs.matchAll(ATTR_RE)) if (key === "input_id") inputIds.push(value);
		return body.trim();
	});
	return { text: unwrapped, inputIds };
}

/** Local slash-command plumbing that Claude Code stores as user entries; not conversation. */
function isPlumbing(text) {
	return /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/.test(text);
}

const STOP_REASONS = { end_turn: "stop", tool_use: "toolUse", max_tokens: "length", stop_sequence: "stop", refusal: "refusal", pause_turn: "stop" };

export class Transcript {
	constructor() {
		/** @type {Array<Record<string, unknown>>} */
		this.messages = [];
		/** toolCallId → what the hub needs to label its result. */
		this.tools = new Map();
		this.model = null;
		this.contextTokens = null;
		this.costUsd = null;
		this.cwd = null;
	}

	/**
	 * Apply one transcript entry. Returns events for the hub, in order:
	 * `{ type: "message", message }`, `{ type: "tool_start", … }`, `{ type: "tool_end", … }`,
	 * `{ type: "usage" }`, `{ type: "model" }`, `{ type: "delivered", inputIds }`, `{ type: "interrupted" }`.
	 */
	apply(entry) {
		const out = [];
		if (!entry || typeof entry !== "object") return out;
		if (entry.type === "cost-state" && Number.isFinite(entry.totalCostUSD)) {
			this.costUsd = entry.totalCostUSD;
			out.push({ type: "usage" });
			return out;
		}
		// Channel messages (including our own remote inputs) are stored as meta entries with a channel origin.
		const fromChannel = entry.origin?.kind === "channel";
		if (entry.isSidechain || entry.isCompactSummary || (entry.isMeta && !fromChannel)) return out;
		if (typeof entry.cwd === "string") this.cwd = entry.cwd;
		const message = entry.message;
		if (!message || (entry.type !== "user" && entry.type !== "assistant")) return out;
		const entryId = typeof entry.uuid === "string" ? entry.uuid : undefined;
		const timestamp = timestampOf(entry);

		if (entry.type === "assistant") {
			if (typeof message.model === "string" && message.model !== "<synthetic>" && message.model !== this.model) {
				this.model = message.model;
				out.push({ type: "model" });
			}
			const usage = message.usage;
			if (usage && Number.isFinite(usage.input_tokens) && (usage.input_tokens > 0 || usage.cache_read_input_tokens > 0)) {
				this.contextTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) +
					(usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
				out.push({ type: "usage" });
			}
			const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
			const text = normalize(blocks.flatMap((b) => (b?.type === "text" ? [b.text] : [])).join(""));
			const thinkingText = normalize(blocks.flatMap((b) => (b?.type === "thinking" ? [b.thinking] : [])).join("\n\n"));
			const stopReason = STOP_REASONS[message.stop_reason] ?? (typeof message.stop_reason === "string" ? message.stop_reason : undefined);
			if (text !== "" || thinkingText !== "") {
				out.push({ type: "message", message: {
					role: "assistant", timestamp, text, ...(entryId ? { entryId } : {}),
					...(thinkingText === "" ? {} : { thinkingText }),
					...(stopReason ? { stopReason } : {}),
				} });
			}
			for (const block of blocks) {
				if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
				this.tools.set(block.id, { toolName: block.name || "tool", args: block.input, startedAt: timestamp });
				out.push({ type: "tool_start", toolCallId: block.id, toolName: block.name || "tool", args: block.input });
			}
			for (const each of out) if (each.type === "message") this.remember(each.message);
			return out;
		}

		// user
		const content = message.content;
		const results = Array.isArray(content) ? content.filter((b) => b?.type === "tool_result") : [];
		for (const block of results) {
			const started = this.tools.get(block.tool_use_id);
			this.tools.delete(block.tool_use_id);
			const isError = block.is_error === true;
			const result = {
				role: "toolResult", timestamp, ...(entryId ? { entryId: `${entryId}:${block.tool_use_id}` } : {}),
				toolCallId: String(block.tool_use_id ?? ""), toolName: started?.toolName || "tool",
				text: normalize(contentText(block.content)), isError,
				...(started?.args === undefined ? {} : { args: started.args }),
				...(started?.startedAt === undefined ? {} : { durationMs: Math.max(0, timestamp - started.startedAt) }),
			};
			out.push({ type: "tool_end", toolCallId: result.toolCallId, toolName: result.toolName, isError });
			out.push({ type: "message", message: result });
		}
		if (results.length === 0) {
			const raw = contentText(content);
			if (raw.trim() !== "" && !isPlumbing(raw)) {
				const { text, inputIds } = unwrapChannel(raw);
				if (inputIds.length > 0) out.push({ type: "delivered", inputIds });
				if (/^\s*\[Request interrupted by user/.test(text)) out.push({ type: "interrupted" });
				const shown = normalize(text);
				if (shown !== "") {
					out.push({ type: "message", message: {
						role: "user", timestamp, text: shown, ...(entryId ? { entryId } : {}),
						...(inputIds.length > 0 ? { remoteInputId: inputIds[0] } : {}),
					} });
				}
			}
		}
		for (const each of out) if (each.type === "message") this.remember(each.message);
		return out;
	}

	/** Keep a message for hello and history (the last 5000). */
	remember(message) {
		this.messages.push(message);
		if (this.messages.length > 5000) this.messages.splice(0, this.messages.length - 5000);
	}
}

/** Follows a growing JSONL file from a byte offset, yielding whole lines only. */
export class Tail {
	constructor(path) {
		this.path = path;
		this.offset = 0;
		this.partial = "";
	}

	async read() {
		let size;
		try {
			size = (await stat(this.path)).size;
		} catch {
			return [];
		}
		if (size < this.offset) {
			// Rewritten (or replaced) underneath us: start over.
			this.offset = 0;
			this.partial = "";
		}
		if (size === this.offset) return [];
		const handle = await open(this.path, "r");
		try {
			const length = size - this.offset;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
			this.offset += bytesRead;
			const text = this.partial + buffer.subarray(0, bytesRead).toString("utf8");
			const lines = text.split("\n");
			this.partial = lines.pop() ?? "";
			const entries = [];
			for (const line of lines) {
				if (line.trim() === "") continue;
				try {
					entries.push(JSON.parse(line));
				} catch {
					// a corrupt line: skip it rather than stall the tail
				}
			}
			return entries;
		} finally {
			await handle.close();
		}
	}
}
