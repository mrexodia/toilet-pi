/**
 * WebSocket Server + Web UI for toilet-pi
 *
 * This server provides:
 * - WebSocket endpoint for pi hook connection
 * - HTTP server for mobile-first web UI
 * - Session tracking in memory (no disk persistence)
 */

import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const WS_PORT = Number.parseInt(process.env.WS_PORT || "3456", 10);
const HTTP_PORT = Number.parseInt(process.env.HTTP_PORT || "3457", 10);
const TOKEN = process.env.TOKEN; // Optional authentication

// In-memory session storage
const sessions = new Map(); // sessionId -> { messages: [], connected: false, cwd: null, model: null }
const hookClients = new Set(); // WebSocket connections from pi hooks
const webClients = new Set(); // WebSocket connections from web UI

// HTML for mobile-first web UI
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
	<title>Toilet-Pi</title>
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; height: 100vh; display: flex; flex-direction: column; }
		.header { background: #161b22; padding: 12px 16px; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; }
		.header h1 { font-size: 18px; font-weight: 600; }
		.status { font-size: 12px; padding: 4px 8px; border-radius: 12px; }
		.status.connected { background: #238636; color: #fff; }
		.status.disconnected { background: #da3633; color: #fff; }
		.session-info { font-size: 11px; color: #8b949e; }
		.messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
		.message { padding: 10px 12px; border-radius: 8px; max-width: 100%; word-wrap: break-word; font-size: 14px; line-height: 1.4; }
		.message.user { background: #1f6feb; color: #fff; align-self: flex-end; }
		.message.assistant { background: #21262d; border: 1px solid #30363d; align-self: flex-start; }
		.message.system { background: #21262d; color: #8b949e; font-style: italic; font-size: 12px; align-self: center; }
		.message.tool { background: #21262d; border-left: 3px solid #a371f7; padding-left: 10px; font-size: 12px; }
		.message.error { background: #21262d; border-left: 3px solid #da3633; padding-left: 10px; color: #ffa198; }
		.input-area { background: #161b22; padding: 12px; border-top: 1px solid #30363d; display: flex; gap: 8px; }
		#message-input { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; color: #c9d1d9; font-size: 14px; outline: none; }
		#message-input:focus { border-color: #58a6ff; }
		.btn { padding: 10px 16px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; }
		.btn-send { background: #238636; color: #fff; }
		.btn-send:disabled { background: #30363d; color: #6e7681; cursor: not-allowed; }
		.btn-abort { background: #da3633; color: #fff; padding: 8px 12px; font-size: 12px; }
		.btn-abort:disabled { background: #30363d; color: #6e7681; cursor: not-allowed; }
		.empty { text-align: center; color: #6e7681; padding: 40px 20px; }
		.loading { text-align: center; color: #8b949e; padding: 20px; }
		.timestamp { font-size: 10px; color: #6e7681; margin-bottom: 4px; }
	</style>
</head>
<body>
	<div class="header">
		<div>
			<h1>Toilet-Pi 🚽</h1>
			<div class="session-info" id="session-info">Not connected</div>
		</div>
		<div>
			<span class="status disconnected" id="connection-status">Disconnected</span>
		</div>
	</div>
	<div class="messages" id="messages">
		<div class="empty">Waiting for pi to connect...</div>
	</div>
	<div class="input-area">
		<button class="btn btn-abort" id="abort-btn" disabled>Abort</button>
		<input type="text" id="message-input" placeholder="Type a message..." autocomplete="off" />
		<button class="btn btn-send" id="send-btn" disabled>Send</button>
	</div>
	<script>
		// Connect to WebSocket server with ?web parameter to identify as web UI client
		let WS_URL;
		if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
			WS_URL = 'ws://localhost:${WS_PORT}?web';
		} else {
			// Use same host as page, just change protocol
			const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
			WS_URL = wsProtocol + '//' + location.host + '?web';
		}
		let ws = null;
		let currentSessionId = null;

		const messagesEl = document.getElementById('messages');
		const messageInput = document.getElementById('message-input');
		const sendBtn = document.getElementById('send-btn');
		const abortBtn = document.getElementById('abort-btn');
		const statusEl = document.getElementById('connection-status');
		const sessionInfoEl = document.getElementById('session-info');

		function addMessage(type, content, timestamp) {
			const msg = document.createElement('div');
			msg.className = 'message ' + type;

			if (timestamp) {
				const ts = document.createElement('div');
				ts.className = 'timestamp';
				ts.textContent = new Date(timestamp).toLocaleTimeString();
				msg.appendChild(ts);
			}

			if (type === 'tool') {
				msg.innerHTML = content;
			} else {
				msg.textContent = content;
			}

			messagesEl.appendChild(msg);
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}

		function updateConnection(connected) {
			statusEl.textContent = connected ? 'Connected' : 'Disconnected';
			statusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
			sendBtn.disabled = !connected;
			abortBtn.disabled = !connected;
		}

		function connect() {
			ws = new WebSocket(WS_URL);
			ws.onopen = () => {
				updateConnection(true);
				messagesEl.innerHTML = '<div class="loading">Connected. Waiting for session...</div>';
			};
			ws.onclose = () => {
				updateConnection(false);
				setTimeout(connect, 3000);
			};
			ws.onerror = () => {};
			ws.onmessage = (e) => {
				const msg = JSON.parse(e.data);
				if (msg.type === 'session_start') {
					currentSessionId = msg.sessionId;
					sessionInfoEl.textContent = msg.model ? \`\${msg.cwd} • \${msg.model}\` : msg.cwd;
					messagesEl.innerHTML = '<div class="empty">No messages yet</div>';
				} else if (msg.type === 'message') {
					if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
					const role = msg.message.role;
					const content = msg.message.content?.map(c => c.type === 'text' ? c.text : '[image]').join('') || '';
					addMessage(role === 'user' ? 'user' : 'assistant', content, msg.message.timestamp);
				} else if (msg.type === 'tool_result') {
					if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
					const content = msg.content?.map(c => c.type === 'text' ? c.text : '[image]').join('') || '';
					addMessage(msg.isError ? 'error' : 'tool', \`\${msg.toolName}: \${content}\`);
				}
			};
		}

		sendBtn.onclick = () => {
			const text = messageInput.value.trim();
			if (!text) return;
			ws.send(JSON.stringify({ type: 'message', content: text }));
			messageInput.value = '';
		};

		abortBtn.onclick = () => {
			ws.send(JSON.stringify({ type: 'abort' }));
		};

		messageInput.onkeypress = (e) => {
			if (e.key === 'Enter') sendBtn.onclick();
		};

		connect();
	</script>
</body>
</html>`;

// WebSocket server for hook connections
const wss = new WebSocketServer({ port: WS_PORT });

console.log("=".repeat(60));
console.log("Toilet-Pi Server");
console.log("=".repeat(60));
console.log(`WebSocket: ws://localhost:${WS_PORT}`);
console.log(`Web UI: http://localhost:${HTTP_PORT}`);
console.log(`Authentication: ${TOKEN ? "Enabled (TOKEN required)" : "Disabled"}`);
console.log("=".repeat(60));

wss.on("connection", (ws, req) => {
	const url = new URL(req.url || "", `http://${req.headers.host}`);
	const isWebClient = url.searchParams.has("web");
	const clientIp = req.socket.remoteAddress;

	// Check authentication token if set
	if (TOKEN) {
		const clientToken = url.searchParams.get("token");
		if (clientToken !== TOKEN) {
			console.log(`[${new Date().toISOString()}] Rejected connection: invalid token`);
			ws.send(JSON.stringify({ error: "Invalid token" }));
			ws.close(1008, "Invalid token");
			return;
		}
	}

	if (isWebClient) {
		// Web UI client
		webClients.add(ws);
		console.log(`[${new Date().toISOString()}] Web UI connected from ${clientIp}`);

		// Send current session state
		for (const [sessionId, session] of sessions) {
			if (session.connected) {
				ws.send(JSON.stringify({
					type: "session_start",
					sessionId,
					cwd: session.cwd,
					model: session.model,
				}));
				for (const msg of session.messages) {
					ws.send(JSON.stringify(msg));
				}
			}
		}

		ws.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString());

				// Forward message/abort from web UI to hook
				for (const hookWs of hookClients) {
					if (hookWs.readyState === 1) {
						hookWs.send(data);
					}
				}
			} catch (error) {
				console.error("Invalid message from web UI:", error);
			}
		});

		ws.on("close", () => {
			webClients.delete(ws);
			console.log(`[${new Date().toISOString()}] Web UI disconnected`);
		});
	} else {
		// pi hook client
		hookClients.add(ws);
		console.log(`[${new Date().toISOString()}] Hook connected from ${clientIp}`);

		ws.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString());

				if (msg.type === "session_start") {
					// Register session
					sessions.set(msg.sessionId, {
						messages: [],
						connected: true,
						cwd: msg.cwd,
						model: msg.model,
					});
					console.log(`[${new Date().toISOString()}] Session started: ${msg.sessionId}`);
				} else if (msg.type === "message") {
					// Store message and broadcast to web clients
					const session = sessions.get(msg.sessionId);
					if (session) {
						session.messages.push(msg);
						broadcastToWebClients(msg);
					}
				} else if (msg.type === "tool_result") {
					// Store and broadcast
					const session = sessions.get(msg.sessionId);
					if (session) {
						session.messages.push(msg);
						broadcastToWebClients(msg);
					}
				}
			} catch (error) {
				console.error("Invalid message from hook:", error);
			}
		});

		ws.on("close", () => {
			hookClients.delete(ws);
			console.log(`[${new Date().toISOString()}] Hook disconnected`);
			// Mark sessions as disconnected
			for (const [sessionId, session] of sessions) {
				if (session.connected) {
					session.connected = false;
					console.log(`[${new Date().toISOString()}] Session ${sessionId} marked as disconnected`);
				}
			}
		});
	}

	ws.on("error", (error) => {
		console.error(`[${new Date().toISOString()}] Client error:`, error);
	});
});

wss.on("error", (error) => {
	console.error("WebSocket server error:", error);
	process.exit(1);
});

// Broadcast to all web UI clients
function broadcastToWebClients(message) {
	for (const ws of webClients) {
		if (ws.readyState === 1) {
			ws.send(JSON.stringify(message));
		}
	}
}

// HTTP server for web UI
const httpServer = createServer((req, res) => {
	if (req.url === "/") {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(HTML);
	} else {
		res.writeHead(404);
		res.end("Not found");
	}
});

httpServer.listen(HTTP_PORT, () => {
	console.log(`HTTP server listening on http://localhost:${HTTP_PORT}`);
});

// Graceful shutdown
let isShuttingDown = false;

const shutdown = (signal) => {
	if (isShuttingDown) return;
	isShuttingDown = true;
	console.log(`${signal} received, closing servers...`);

	// Close all client connections
	for (const ws of hookClients) ws.terminate();
	for (const ws of webClients) ws.terminate();

	wss.close(() => {
		httpServer.close(() => {
			console.log("Servers closed");
			process.exit(0);
		});
	});

	setTimeout(() => {
		console.log("Forcing exit");
		process.exit(1);
	}, 1000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
