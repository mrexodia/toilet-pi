/**
 * UniiChat's Anthropic cache layout, applied after pi-ai's wire conversion. A single text block containing the
 * entire view cannot reuse yesterday's prefix when even one line is appended. Four-line blocks can: mark only
 * the last whole block (or the opening), leaving the partial block and the compaction task uncached.
 */
import type { Models } from "@earendil-works/pi-ai";

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
	const lines = text.slice(7, close).split("\n").filter((line) => line !== "");
	const whole = Math.floor(lines.length / BLOCK);
	const blocks: Block[] = [{ type: "text", text: "<chat>\n" }];
	for (let k = 0; k < whole; k++) blocks.push({ type: "text", text: lines.slice(k * BLOCK, (k + 1) * BLOCK).join("\n") + "\n" });
	blocks[blocks.length - 1]!.cache_control = mark;
	const task = text.slice(close + "</chat>\n".length);
	blocks.push({ type: "text", text: lines.slice(whole * BLOCK).map((line) => line + "\n").join("") + "</chat>\n" + task });
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

/** Keep callbacks outside durable JSON checkpoints. All other methods stay bound to the real Models instance. */
export function withMemoryCache(models: Models): Models {
	const streamSimple: Models["streamSimple"] = (model, context, options) => {
		if (model.api !== "anthropic-messages") return models.streamSimple(model, context, options);
		return models.streamSimple(model, context, {
			...options,
			onPayload: async (payload, resolved) => {
				cacheView(payload);
				return (await options?.onPayload?.(payload, resolved)) ?? payload;
			},
		});
	};
	return new Proxy(models, {
		get(target, name) {
			if (name === "streamSimple") return streamSimple;
			const value = Reflect.get(target, name, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
