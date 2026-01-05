/**
 * Simple WebSocket test client
 *
 * Connects to the WebSocket server and lets you send messages.
 */

import { WebSocket } from "ws";

const WS_URL = process.env.WS_URL || "ws://localhost:3456";
const TOKEN = process.env.TOKEN;

const url = TOKEN ? `${WS_URL}?token=${TOKEN}` : WS_URL;

const ws = new WebSocket(url);

ws.on("open", () => {
	console.log(`Connected to ${url}`);
	console.log("Type commands (one line at a time):");
	console.log('  message <text>  - Send a message');
	console.log('  abort           - Abort current operation');
	console.log('  quit            - Exit');
});

ws.on("message", (data) => {
	try {
		const msg = JSON.parse(data.toString());
		console.log("Received:", JSON.stringify(msg, null, 2));
	} catch {
		console.log("Received:", data.toString());
	}
});

ws.on("close", () => {
	console.log("Disconnected");
	process.exit(0);
});

ws.on("error", (error) => {
	console.error("WebSocket error:", error);
	process.exit(1);
});

process.stdin.setEncoding("utf8");
process.stdin.on("readable", () => {
	let chunk;
	while ((chunk = process.stdin.read()) !== null) {
		const line = chunk.trim();
		if (!line) continue;

		const [command, ...rest] = line.split(" ");
		const content = rest.join(" ");

		if (command === "quit") {
			ws.close();
		} else if (command === "message" && content) {
			ws.send(JSON.stringify({ type: "message", content }));
		} else if (command === "abort") {
			ws.send(JSON.stringify({ type: "abort" }));
		} else {
			console.log("Unknown command. Use: message <text>, abort, or quit");
		}
	}
});
