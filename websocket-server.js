/**
 * Simple JavaScript WebSocket Server (no TypeScript needed)
 *
 * Same as websocket-server.ts but doesn't require compilation.
 */

import { WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT || "3456", 10);
const TOKEN = process.env.TOKEN; // Optional authentication token

const wss = new WebSocketServer({ port: PORT });

console.log("=".repeat(60));
console.log("Toilet-Pi WebSocket Server");
console.log("=".repeat(60));
console.log(`Running on ws://localhost:${PORT}`);
console.log(`Authentication: ${TOKEN ? "Enabled (TOKEN required)" : "Disabled"}`);
console.log("");
console.log("Connect a client:");
console.log(`  wscat -c ws://localhost:${PORT}${TOKEN ? `?token=${TOKEN}` : ""}`);
console.log("");
console.log("Message formats:");
console.log('  {"type":"message","content":"your message"}');
console.log('  {"type":"abort"}');
console.log("=".repeat(60));

wss.on("connection", (ws, req) => {
	const clientIp = req.socket.remoteAddress;
	console.log(`[${new Date().toISOString()}] Client connected from ${clientIp}`);

	// Check authentication token if set
	if (TOKEN) {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const clientToken = url.searchParams.get("token");

		if (clientToken !== TOKEN) {
			console.log(`[${new Date().toISOString()}] Rejected connection: invalid token`);
			ws.send(JSON.stringify({ error: "Invalid token" }));
			ws.close(1008, "Invalid token");
			return;
		}
		console.log(`[${new Date().toISOString()}] Client authenticated`);
	}

	ws.on("message", (data) => {
		console.log(`[${new Date().toISOString()}] Received: ${data.toString()}`);

		// Broadcast to all other clients
		wss.clients.forEach((client) => {
			if (client !== ws && client.readyState === WebSocket.OPEN) {
				client.send(data);
			}
		});
	});

	ws.on("close", () => {
		console.log(`[${new Date().toISOString()}] Client disconnected`);
	});

	ws.on("error", (error) => {
		console.error(`[${new Date().toISOString()}] Client error:`, error);
	});
});

wss.on("error", (error) => {
	console.error("Server error:", error);
	process.exit(1);
});

// Graceful shutdown
let isShuttingDown = false;

const shutdown = (signal) => {
	if (isShuttingDown) return; // Prevent multiple shutdowns
	isShuttingDown = true;
	console.log(`${signal} received, closing server...`);

	// Close all client connections immediately
	wss.clients.forEach((client) => {
		client.terminate();
	});

	wss.close(() => {
		console.log("Server closed");
		process.exit(0);
	});

	// Force exit after 1 second if close doesn't complete
	setTimeout(() => {
		console.log("Forcing exit");
		process.exit(1);
	}, 1000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
