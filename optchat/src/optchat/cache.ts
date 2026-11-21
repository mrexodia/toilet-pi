/**
 * UniiChat's stable view blocks, applied after pi-ai's wire conversion. Anthropic uses cache_control;
 * explicitly capable OpenAI Responses models use prompt_cache_breakpoint. The node's task stays unmarked.
 * Background calls coordinate cold prefix writers, never their answers; normal user turns do not wait.
 */
import { createHash } from "node:crypto";
import { hasApi, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import { CacheFlights, type CacheFlight } from "./cache-flight.ts";

const BLOCK = 4;
type CacheControl = { type: string; ttl?: string };
type Block = { type?: string; text?: string; cache_control?: CacheControl; [key: string]: unknown };
type Payload = {
	system?: Block[];
	tools?: Block[];
	messages?: { role: string; content: string | Block[] }[];
	cache_control?: CacheControl;
};

/** Mutates only Anthropic wire blocks, not transcript entries or nested tool arguments. */
export function cacheView(payload: unknown): void {
	if (payload === null || typeof payload !== "object") return;
	const body = payload as Payload;
	const first = body.messages?.find((m) => m.role === "user");
	if (first === undefined) return;
	const content: Block[] = typeof first.content === "string" ? [{ type: "text", text: first.content }] : first.content;
	const at = content.findIndex((b) => b.type === "text" && b.text?.startsWith("<chat>\n"));
	if (at < 0) return;
	const text = content[at]!.text!;
	const end = text.indexOf("\n</chat>\n");
	if (end < 0) return;
	const close = end + 1;
	const all = [...(body.system ?? []), ...(body.tools ?? []), ...body.messages!.flatMap((m) => Array.isArray(m.content) ? m.content : [])];
	const mark = all.find((b) => b.cache_control !== undefined)?.cache_control ?? body.cache_control;
	if (mark === undefined) return; // Respect cacheRetention: "none".
	const toolMark = body.tools?.findLast((b) => b.cache_control !== undefined);
	for (const block of all) delete block.cache_control;
	delete body.cache_control;
	const split = splitView(text, close);
	const blocks: Block[] = split.texts.map(text => ({ type: "text", text }));
	blocks[split.mark]!.cache_control = mark;
	const task = split.task;
	first.content = [...content.slice(0, at), ...blocks, ...content.slice(at + 1)];
	// At most four breakpoints, even for OAuth's two system blocks. Do not cache a compaction's unique task.
	const system = body.system?.at(-1);
	if (system !== undefined) system.cache_control = mark;
	if (toolMark !== undefined) toolMark.cache_control = mark;
	if (!task.startsWith("Compaction:")) {
		const last = body.messages!.at(-1)!;
		if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
		const tail = last.content.at(-1);
		if (tail !== undefined && ["text", "image", "tool_result", "tool_addition", "tool_removal"].includes(tail.type ?? "")) tail.cache_control = mark;
	}
}

/** Split without rewriting a single character, including blank lines and multibyte text. */
function splitView(text: string, close: number): { texts: string[]; mark: number; task: string } {
	const lines = text.slice(7, close).match(/[^\n]*\n/g) ?? [];
	const whole = Math.floor(lines.length / BLOCK);
	const texts = ["<chat>\n"];
	for (let k = 0; k < whole; k++) texts.push(lines.slice(k * BLOCK, (k + 1) * BLOCK).join(""));
	const task = text.slice(close + "</chat>\n".length);
	texts.push(lines.slice(whole * BLOCK).join("") + "</chat>\n" + task);
	return { texts, mark: whole, task };
}

type Input = { role?: string; content?: string | Block[]; [key: string]: unknown };
type ResponsesPayload = {
	input?: Input[];
	prompt_cache_options?: { mode?: string; ttl?: string; [key: string]: unknown };
	[key: string]: unknown;
};

/** Only call for capable OpenAI Responses models with caching enabled. ChatGPT OAuth gets ordinary text blocks:
 * pi-ai intentionally omits explicit cache options for that auth path, even on models declaring the capability.
 */
export function cacheViewOpenAI(payload: unknown, explicit = true): void {
	if (payload === null || typeof payload !== "object") return;
	const body = payload as ResponsesPayload;
	if (!Array.isArray(body.input)) return;
	const first = body.input.find(m => m.role === "user");
	if (first === undefined) return;
	const content = typeof first.content === "string" ? [{ type: "input_text", text: first.content }] : first.content;
	if (!Array.isArray(content)) return;
	const at = content.findIndex(b => b.type === "input_text" && b.text?.startsWith("<chat>\n"));
	if (at < 0) return;
	const text = content[at]!.text!;
	const end = text.indexOf("\n</chat>\n");
	if (end < 0) return;
	const split = splitView(text, end + 1);
	const { prompt_cache_breakpoint: _mark, ...original } = content[at]!;
	const blocks: Block[] = split.texts.map(text => ({ ...original, text }));
	if (explicit) blocks[split.mark]!.prompt_cache_breakpoint = { mode: "explicit" };
	first.content = [...content.slice(0, at), ...blocks, ...content.slice(at + 1)];
	if (explicit && split.task.startsWith("Compaction:")) {
		// Disable the implicit end-of-request write, not the stable view write. Preserve a requested TTL.
		body.prompt_cache_options = { ...body.prompt_cache_options, mode: "explicit" };
	}
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Hash the actual wire prefix after caller replacements, excluding only cache markers and the changing task.
 * Per-wrapper storage isolates homes. Scope also includes the resolved endpoint/model, affinity, and request
 * credential/header/env overrides. Raw credentials and memory text are never retained in the coordinator.
 */
export function compactionPrefixKeys(payload: unknown, api: string, scope: unknown, implicitOpenAI = false): string[] {
	if (payload === null || typeof payload !== "object") return [];
	const field = api === "anthropic-messages" ? "messages" : "input";
	const body = payload as Record<string, unknown>;
	const messages = body[field];
	if (!Array.isArray(messages)) return [];
	const at = messages.findIndex((m: Input) => m.role === "user");
	if (at < 0) return [];
	const first = messages[at] as Input;
	const content = first.content;
	if (!Array.isArray(content)) return [];
	const opening = content.findIndex(b => b.text === "<chat>\n");
	if (opening < 0) return [];
	const tail = content.findIndex((b, i) => i > opening && typeof b.text === "string" && /(?:^|\n)<\/chat>\n/.test(b.text));
	if (tail < 0) return [];
	const text = content[tail]!.text!;
	const closing = text.startsWith("</chat>\n") ? 0 : text.indexOf("\n</chat>\n") + 1;
	if (!text.slice(closing + "</chat>\n".length).startsWith("Compaction:")) return [];
	const marker = api === "anthropic-messages" ? "cache_control" : "prompt_cache_breakpoint";
	const end = implicitOpenAI && api === "openai-responses" ? tail - 1
		: content.findLastIndex((b, i) => i >= opening && i < tail && b[marker] !== undefined);
	if (end < opening) return [];
	const { [field]: _messages, ...head } = body;
	const { content: _content, ...envelope } = first;
	let key = hash(JSON.stringify([scope, head, messages.slice(0, at), envelope, content.slice(0, opening)]));
	return content.slice(opening, end + 1).map(({ cache_control: _cache, prompt_cache_breakpoint: _breakpoint, ...block }) => {
		key = hash(key + JSON.stringify(block));
		return key;
	});
}

export type MemoryCacheOptions = {
	flights?: CacheFlights;
	/** A host's non-secret auth-state check; do not resolve/refresh credentials a second time to answer this.
	 * Unknown direct-OpenAI auth is conservative: split text only, without explicit cache fields.
	 */
	allowOpenAIExplicit?: (model: Model<Api>) => boolean;
};

/** Keep callbacks outside durable JSON checkpoints. All other methods stay bound to the real Models instance. */
export function withMemoryCache(models: Models, config: MemoryCacheOptions = {}): Models {
	const flights = config.flights ?? new CacheFlights();
	const streamSimple: Models["streamSimple"] = (model, context, options) => {
		if (model.api !== "anthropic-messages" && model.api !== "openai-responses") return models.streamSimple(model, context, options);
		let flight: CacheFlight | undefined;
		let headersHash: string | undefined;
		try {
			const stream = models.streamSimple(model, context, {
				...options,
				transformHeaders: async headers => {
					const out = options?.transformHeaders ? await options.transformHeaders(headers) : headers;
					headersHash = hash(JSON.stringify(out));
					return out;
				},
				onPayload: async (payload, resolved) => {
					flight?.end(false);
					flight = undefined;
					const enabled = options?.cacheRetention !== "none" && (resolved.api === "anthropic-messages" ||
						(hasApi(resolved, "openai-responses") && resolved.compat?.supportsExplicitPromptCacheMode === true));
					// Match pi-ai's direct OpenAI auth distinction: non-sk credentials are ChatGPT access tokens.
					const directOpenAI = resolved.provider === "openai" && resolved.baseUrl === "https://api.openai.com/v1";
					const explicit = !directOpenAI || (options?.apiKey !== undefined
						? options.apiKey.startsWith("sk-") : config.allowOpenAIExplicit?.(resolved) === true);
					if (enabled) {
						if (resolved.api === "anthropic-messages") cacheView(payload);
						else cacheViewOpenAI(payload, explicit);
					}
					const out = (await options?.onPayload?.(payload, resolved)) ?? payload;
					if (enabled) {
						const scope = [resolved.provider, resolved.api, resolved.id, resolved.baseUrl, resolved.headers, headersHash,
							options?.apiKey, options?.headers, options?.env, options?.sessionId, options?.cacheRetention, options?.reasoning];
						const keys = compactionPrefixKeys(out, resolved.api, scope, !explicit);
						if (keys.length) flight = await flights.acquire(keys, options?.signal);
					}
					options?.signal?.throwIfAborted();
					return out;
				},
				onProviderStreamEvent: async (event, resolved) => {
					await options?.onProviderStreamEvent?.(event, resolved);
					const type = (event as { type?: string } | null)?.type;
					// HTTP headers / pi's generic "start" may precede prefill. Use the upstream wire's ready events.
					if (!options?.signal?.aborted && ((resolved.api === "anthropic-messages" && type === "message_start") ||
						(resolved.api === "openai-responses" && type === "response.output_item.added"))) flight?.ready();
				},
			});
			void stream.result().then(
				message => flight?.end(!options?.signal?.aborted && ["stop", "length", "toolUse"].includes(message.stopReason)),
				() => flight?.end(false),
			);
			return stream;
		} catch (error) {
			flight?.end(false);
			throw error;
		}
	};
	return new Proxy(models, {
		get(target, name) {
			if (name === "streamSimple") return streamSimple;
			const value = Reflect.get(target, name, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
