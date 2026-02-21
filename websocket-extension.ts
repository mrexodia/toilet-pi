/**
 * WebSocket Client Extension for pi
 *
 * Connects pi to the toilet-pi server, enabling:
 * - Live message streaming to web UI
 * - Sending messages from web UI (appears as user-typed)
 * - Aborting operations from web UI
 *
 * =============================================
 * HOW IT WORKS
 * =============================================
 *
 * This extension connects to the toilet-pi server and:
 *
 * 1. Sends session info (sessionId, cwd, model) when connected
 * 2. Sends all messages (user, assistant, tool results) to server
 * 3. Receives message/abort commands from web UI
 *
 * =============================================
 * MESSAGE FLOW
 * =============================================
 *
 * Phone (web UI) → Server → Extension → pi Agent
 * Extension → Server → Phone (web UI)
 *
 * Forwarding messages TO web UI:
 * - turn_end event → Extension sends to server → Server broadcasts to web UI
 * - tool_result event → Extension sends to server → Server broadcasts to web UI
 *
 * Receiving commands FROM web UI:
 * - User sends message → Server → Extension → pi.sendMessage()
 * - User clicks abort → Server → Extension → ctx.abort()
 *
 * =============================================
 * USAGE
 * =============================================
 *
 * 1. Start the server:
 *    cd ~/Projects/toilet-pi && npm start
 *
 * 2. Run pi with the extension:
 *    pi -e ~/Projects/toilet-pi/websocket-extension.ts
 *
 * 3. Open web UI:
 *    http://localhost:3457
 *
 * 4. Use from anywhere (phone, etc.)
 *    - ngrok: ngrok http 3457
 *    - cloudflared: cloudflared tunnel --url http://localhost:3457
 *    - Local: http://192.168.1.XX:3457
 *
 * =============================================
 * CONFIGURATION
 * =============================================
 *
 * Set custom WebSocket URL:
 *    PI_WS_URL=ws://your-server:3456 pi -e ~/Projects/toilet-pi/websocket-extension.ts
 *
 * Set server token (for authentication):
 *    TOKEN=your-token npm start
 *    Then access: http://localhost:3457?token=your-token
 */

import { WebSocket } from "ws";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const WS_URL = process.env.PI_WS_URL || "ws://localhost:3456";

interface WSMessage {
	type: "message" | "abort";
	content?: string;
}

export default function (pi: ExtensionAPI) {
	let ws: WebSocket | null = null;
	let reconnectTimeout: NodeJS.Timeout | null = null;
	let ctx: ExtensionContext | null = null;
	let retryCount = 0;

	const sendToServer = (data: unknown) => {
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(data));
		}
	};

	const updateStatus = (status: string, connected = false) => {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const icon = connected ? theme.fg("success", "●") : theme.fg("warning", "○");
		// Short form to fit on footer line
		ctx.ui.setStatus("ws", `${icon} WS:${status}`);
	};

	const connect = () => {
		// Clear any existing reconnect timeout
		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
			reconnectTimeout = null;
		}

		updateStatus(`connecting... (attempt ${retryCount + 1})`, false);

		try {
			ws = new WebSocket(WS_URL);

			ws.on("open", () => {
				retryCount = 0; // Reset retry count on successful connection
				updateStatus("connected", true);

				// Send session info when connected
				if (ctx) {
					const sessionId = ctx.sessionManager.getSessionFile() ?? "ephemeral";
					sendToServer({
						type: "session_start",
						sessionId,
						cwd: ctx.cwd,
						model: ctx.model?.id,
					});

					// Send existing messages
					const entries = ctx.sessionManager.getEntries();
					for (const entry of entries) {
						if (entry.type === "message") {
							sendToServer({
								type: "message",
								sessionId,
								message: entry.message,
							});
						}
					}
				}
			});

			ws.on("message", async (data: Buffer) => {
				try {
					const msg: WSMessage = JSON.parse(data.toString());

					if (msg.type === "abort") {
						// Abort current agent operation
						ctx?.abort();
					} else if (msg.type === "message" && msg.content) {
						// Send user message to agent
						pi.sendMessage(
							{
								customType: "websocket-message",
								content: msg.content,
								display: true,
							},
							{ triggerTurn: true }, // Wake up agent if idle
						);
					}
				} catch {
					// Invalid message, silently ignore
				}
			});

			ws.on("error", () => {
				// Silently ignore connection errors
				ws = null;
				scheduleReconnect();
			});

			ws.on("close", () => {
				ws = null;
				updateStatus(`retry ${retryCount + 1}`, false);
				scheduleReconnect();
			});
		} catch {
			// Silently ignore connection errors
			ws = null;
			scheduleReconnect();
		}
	};

	const scheduleReconnect = () => {
		if (reconnectTimeout) return; // Already scheduled
		reconnectTimeout = setTimeout(() => {
			reconnectTimeout = null;
			retryCount++;
			connect();
		}, 5000); // Reconnect after 5 seconds
	};

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		updateStatus("connecting...", false);
		connect();
	});

	// Forward all messages to server
	pi.on("turn_end", async (event, context) => {
		sendToServer({
			type: "message",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
			message: event.message,
		});
	});

	pi.on("tool_result", async (event, context) => {
		sendToServer({
			type: "tool_result",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			content: event.content,
			isError: event.isError,
		});
	});

	// === Streaming events for live web UI updates ===

	let lastUpdateTime = 0;

	pi.on("agent_start", async (_event, context) => {
		sendToServer({
			type: "agent_start",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
		});
	});

	pi.on("agent_end", async (_event, context) => {
		sendToServer({
			type: "agent_end",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
		});
	});

	pi.on("message_start", async (event, context) => {
		sendToServer({
			type: "message_start",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
			role: event.message.role,
		});
	});

	pi.on("message_update", async (event, context) => {
		const now = Date.now();
		if (now - lastUpdateTime < 150) return;
		lastUpdateTime = now;

		const content = event.message.content;
		const text = Array.isArray(content)
			? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
			: "";
		sendToServer({
			type: "message_update",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
			text,
		});
	});

	pi.on("message_end", async (_event, context) => {
		sendToServer({
			type: "message_end",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
		});
	});

	pi.on("tool_execution_start", async (event, context) => {
		sendToServer({
			type: "tool_execution_start",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		});
	});

	pi.on("tool_execution_end", async (event, context) => {
		sendToServer({
			type: "tool_execution_end",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		});
	});

	pi.on("model_select", async (event, context) => {
		sendToServer({
			type: "model_select",
			sessionId: context.sessionManager.getSessionFile() ?? "ephemeral",
			modelId: event.model.id,
		});
	});

	pi.on("session_shutdown", async () => {
		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
		}
		if (ws) {
			ws.close();
			ws = null;
		}
		if (ctx?.hasUI) {
			ctx.ui.setStatus("ws", undefined); // Clear status
		}
	});

	// Custom command to show WebSocket status
	pi.registerCommand("ws", {
		description: "Show WebSocket connection status",
		handler: async (_args, context) => {
			if (!context.hasUI) return;

			const status = ws?.readyState === WebSocket.OPEN
				? "connected"
				: ws?.readyState === WebSocket.CONNECTING
					? "connecting..."
					: "disconnected";
			context.ui.notify(`WebSocket: ${status} (${WS_URL})`, "info");
		},
	});
}
