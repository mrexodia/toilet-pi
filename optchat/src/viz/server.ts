/**
 * The visualizer: a local web page that plays how the memory was built, commit by commit, shows what goes into each
 * model request as colored blocks, and opens any request whole. It only reads the home, beside a running agent.
 *
 *   node main.ts --home DIR viz [--port N] [--host ADDR] [--no-open]
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Message } from "@earendil-works/pi-ai";
import { readConfig } from "../config.ts";
import { HEAD } from "../optchat/prompt.ts";
import { chatBlock, lines, type Part, span, WAIT } from "../optchat/tree.ts";
import { contentText } from "../optchat/memory.ts";
import { RequestLog, REQUESTS_FILE } from "../requests.ts";
import { segmentsOf } from "./segments.ts";
import { DurableReader, History } from "./store.ts";

const UI = fileURLToPath(new URL("./ui/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const STATIC = new Set(["index.html", "app.js", "style.css"]);

export type VizOptions = { home: string; port?: number; host?: string };

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function int(url: URL, name: string, fallback?: number): number {
	const raw = url.searchParams.get(name);
	if (raw === null) {
		if (fallback !== undefined) return fallback;
		throw new HttpError(400, `missing ${name}`);
	}
	const n = Number(raw);
	if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be an integer`);
	return n;
}

function partOf(raw: string | null): Part {
	const m = /^(\d+)\/(\d+)$/.exec(raw ?? "");
	if (m === null) throw new HttpError(400, "key must be l/i");
	return [Number(m[1]), Number(m[2])];
}

function loopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export class Viz {
	readonly home: string;
	readonly reader: DurableReader;
	readonly history: History;
	#requests: RequestLog | undefined;
	#updated = 0;

	constructor(home: string) {
		this.home = home;
		this.reader = new DurableReader(join(home, ".optchat", "agent.sqlite"));
		this.history = new History(this.reader);
	}

	close(): void {
		this.#requests?.close();
		this.reader.close();
	}

	/** Read new commits, at most a few times a second however many clients ask. */
	refresh(): void {
		const now = Date.now();
		if (now - this.#updated < 300) return;
		this.#updated = now;
		this.history.update();
	}

	requests(): RequestLog | undefined {
		this.#requests ??= RequestLog.openReadOnly(join(this.home, ".optchat", REQUESTS_FILE));
		return this.#requests;
	}

	async state(): Promise<unknown> {
		this.refresh();
		const chat = this.history.chat;
		const config = await readConfig(this.home).catch(() => ({}));
		return {
			home: this.home,
			config,
			seq: this.history.seq,
			frames: this.history.frames.length,
			count: chat.count,
			nodes: this.history.nodes,
			view: { parts: chat.view.parts.length, bytes: chat.view.parts.reduce((n, p) => n + (chat.sizes[`${p[0]}/${p[1]}`] ?? 0), 0), batch: chat.view.batch },
			seen: { parts: chat.seen.parts.length },
			usage: chat.usage,
			compactor: chat.compactor ?? null,
			pending: this.history.pending(),
			failed: Object.keys(chat.failed ?? {}),
			requests: { recording: (config as { recordRequests?: boolean }).recordRequests !== false, found: this.requests() !== undefined },
		};
	}

	/**
	 * Frames from index `from` on. Only the last frame can change after it was sent (a failure burst that goes on), so
	 * clients ask again from their last frame and replace from `from`.
	 */
	historyFrom(from: number): unknown {
		this.refresh();
		const start = Math.max(0, Math.min(from, this.history.frames.length));
		return { from: start, frames: this.history.frames.slice(start), seq: this.history.seq, pending: this.history.pending() };
	}

	/** Messages a to z, each cut to `chars` characters. */
	messages(a: number, z: number, chars: number, limit: number): unknown {
		const out = [];
		const last = Math.min(z, a + limit - 1, this.history.chat.count - 1);
		for (let id = Math.max(0, a); id <= last; id++) {
			const m = this.reader.message(id);
			if (m === undefined) continue;
			const cut = m.text.length > chars;
			out.push({ ...m, text: cut ? m.text.slice(0, chars) : m.text, length: m.text.length, cut });
		}
		return { from: a, to: z, total: z - a + 1, messages: out };
	}

	node(p: Part): unknown {
		const key = `${p[0]}/${p[1]}`;
		const node = this.reader.node(key);
		const [a, z] = span(p);
		const first = this.reader.messageRecord(a);
		const last = this.reader.messageRecord(z);
		return {
			key,
			part: p,
			span: [a, z],
			text: node?.text ?? null,
			size: node?.size ?? null,
			createdAt: node?.createdAt ?? null,
			dates: [first?.date ?? null, last?.date ?? null],
		};
	}

	/** What a request would hold at frame k: the turn it froze, or the view a new turn would get. */
	context(k: number): unknown {
		this.refresh();
		const frames = this.history.frames;
		if (k < 0 || k >= frames.length) throw new HttpError(404, `no frame ${k}`);
		const frame = frames[k]!;
		let count = 0;
		for (let j = 0; j <= k; j++) {
			const msgs = frames[j]!.msgs;
			if (msgs !== undefined) count = msgs.from + msgs.kinds.length;
		}
		const turn = frame.turn;
		const parts = turn?.parts ?? this.history.viewAt(k);
		const upto = turn?.first ?? count;
		const texts = new Map<string, string>();
		for (const p of parts) if (span(p)[1] < upto) texts.set(`${p[0]}/${p[1]}`, this.reader.node(`${p[0]}/${p[1]}`)?.text ?? WAIT);
		const view = chatBlock(lines(parts, upto, (p) => texts.get(`${p[0]}/${p[1]}`)));
		const end = this.history.seq;
		const system = turn
			? (this.reader.entries("pi.system", frame.seq, end, 1, "ASC")[0] ?? this.reader.entries("pi.system", 0, frame.seq, 1, "DESC")[0])
			: this.reader.entries("pi.system", 0, frame.seq, 1, "DESC")[0];
		const input = turn ? this.reader.entries("pi.user", frame.seq, end, 1, "ASC")[0] : undefined;
		const inputMessage = input?.record.model?.[0];
		const inputText = inputMessage?.role === "user" ? contentText(inputMessage.content) : turn ? "(the turn's message)" : "(the next message)";
		const messages: Message[] = [];
		const sys = system?.record.model?.[0];
		if (sys?.role === "system") messages.push(sys);
		messages.push({ role: "user", content: `${view}${turn?.state ?? ""}${HEAD}${inputText}`, timestamp: frame.t });
		const context: Context = { messages };
		return {
			mode: turn ? "turn" : "view",
			frame: k,
			seq: frame.seq,
			t: frame.t,
			note: turn
				? "Reconstructed: the system prompt, the view this turn froze and its message, as its first request had them. Later requests of the run add its tool calls."
				: "Reconstructed: what a turn starting at this moment would get, with the latest system prompt. Its message goes at the end.",
			segments: segmentsOf(context),
			context,
		};
	}

	request(id: number): unknown {
		const log = this.requests();
		const request = log?.get(id);
		if (request === undefined) throw new HttpError(404, `no request ${id}`);
		return { ...request, segments: segmentsOf(request.context) };
	}

	async handle(req: IncomingMessage, res: ServerResponse, bound: string): Promise<void> {
		// Refuse other hosts' names, so a web page cannot reach this one through DNS rebinding.
		const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
		if (loopback(bound) && !loopback(host)) throw new HttpError(403, "forbidden host");
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;
		if (req.method !== "GET") throw new HttpError(405, "GET only");
		if (path === "/" || STATIC.has(path.slice(1))) {
			const name = path === "/" ? "index.html" : path.slice(1);
			const body = await readFile(join(UI, name));
			res.writeHead(200, { "content-type": TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream", "cache-control": "no-store" });
			res.end(body);
			return;
		}
		const json = (value: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
			res.end(JSON.stringify(value));
		};
		switch (path) {
			case "/api/state":
				return json(await this.state());
			case "/api/history":
				return json(this.historyFrom(int(url, "from", 0)));
			case "/api/node":
				return json(this.node(partOf(url.searchParams.get("key"))));
			case "/api/messages": {
				const a = int(url, "from");
				return json(this.messages(a, int(url, "to", a), Math.min(int(url, "chars", 2000), 200_000), Math.min(int(url, "limit", 32), 256)));
			}
			case "/api/message": {
				const message = this.reader.message(int(url, "id"));
				if (message === undefined) throw new HttpError(404, "no such message");
				return json(message);
			}
			case "/api/task": {
				const task = this.reader.task(int(url, "id"));
				if (task === undefined) throw new HttpError(404, "no such task");
				return json(task);
			}
			case "/api/context":
				return json(this.context(int(url, "frame")));
			case "/api/requests": {
				const log = this.requests();
				if (log === undefined) return json({ requests: [], running: [] });
				const after = int(url, "after", 0);
				// Rows still running when the client last asked change; send them again.
				const again = (url.searchParams.get("again") ?? "").split(",").filter((s) => /^\d+$/.test(s)).map(Number).slice(0, 200);
				return json({ requests: [...log.byIds(again.filter((id) => id <= after)), ...log.list(after, int(url, "limit", 2000))] });
			}
			case "/api/request":
				return json(this.request(int(url, "id")));
			case "/api/request/payload": {
				const id = int(url, "id");
				const request = this.requests()?.get(id);
				if (request === undefined) throw new HttpError(404, `no request ${id}`);
				const part = url.searchParams.get("part") ?? "payload";
				const value = part === "context" ? request.context : part === "response" ? request.response : request.payload;
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"content-disposition": `attachment; filename="optchat-request-${id}-${part}.json"`,
					"cache-control": "no-store",
				});
				res.end(JSON.stringify(value, null, 2));
				return;
			}
			default:
				throw new HttpError(404, "not found");
		}
	}
}

/** Serve the visualizer for a home; resolves once it listens. */
export async function startViz(options: VizOptions): Promise<{ url: string; viz: Viz; close: () => Promise<void> }> {
	const viz = new Viz(options.home);
	viz.history.update();
	const host = options.host ?? "127.0.0.1";
	const server = createServer((req, res) => {
		viz.handle(req, res, host).catch((error: unknown) => {
			const status = error instanceof HttpError ? error.status : 500;
			if (!res.headersSent) res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 4777, host, () => resolve());
	});
	const address = server.address() as AddressInfo;
	const shown = address.family === "IPv6" ? `[${address.address}]` : address.address;
	return {
		url: `http://${loopback(host) ? "localhost" : shown}:${address.port}/`,
		viz,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			viz.close();
		},
	};
}
