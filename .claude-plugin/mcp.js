/**
 * MCP over stdio: just enough JSON-RPC for a Claude Code channel, with no SDK dependency, so start.js can answer
 * Claude Code's handshake before the bridge's own dependencies are in place.
 */

export const VERSION = "0.2.0";

export const INSTRUCTIONS = [
	"Messages from the toilet-pi channel (a <channel> tag with an input_id attribute) were typed by the user remotely, in the Toilet-Pi web UI or CLI.",
	"Treat each one exactly as if the user had typed it into this terminal: same trust, same intent, same follow-through.",
	"Your normal replies are mirrored back to Toilet-Pi automatically, so answer in plain text as usual; there is no reply tool.",
].join(" ");

export class StdioMcp {
	/** Set by the bridge once it exists; until then notifications are dropped and a closed stdin just exits. */
	onNotification = () => {};
	onClose = () => process.exit(0);

	constructor() {
		let buffer = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line === "") continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				this.#handle(message);
			}
		});
		process.stdin.on("end", () => this.onClose());
		process.stdin.on("close", () => this.onClose());
	}

	#write(payload) {
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	}

	#handle(message) {
		if (message.id !== undefined && typeof message.method === "string") {
			const respond = (result) => this.#write({ jsonrpc: "2.0", id: message.id, result });
			switch (message.method) {
				case "initialize":
					return respond({
						protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
						capabilities: { experimental: { "claude/channel": {}, "claude/channel/permission": {} } },
						serverInfo: { name: "toilet-pi", version: VERSION },
						instructions: INSTRUCTIONS,
					});
				case "ping":
					return respond({});
				case "tools/list":
					return respond({ tools: [] });
				default:
					return this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
			}
		}
		if (message.id === undefined && typeof message.method === "string") this.onNotification(message.method, message.params ?? {});
	}

	notify(method, params) {
		this.#write({ jsonrpc: "2.0", method, params });
	}
}
