/**
 * WebSocket Client Hook for pi
 *
 * Connects pi to a WebSocket server, allowing you to send messages and abort
 * operations remotely (e.g., from your phone while on the toilet).
 *
 * =============================================
 * HOW IT WORKS
 * =============================================
 *
 * This hook runs when pi starts and establishes a WebSocket connection to a
 * server you control. It listens for JSON messages in two formats:
 *
 * 1. Message injection:
 *    {"type":"message","content":"Run the tests"}
 *
 *    - Adds the message to the pi conversation
 *    - If agent is idle, wakes it up and triggers a response
 *    - Message is stored in the session history like a normal user message
 *    - Message appears in the TUI with purple styling
 *
 * 2. Abort current operation:
 *    {"type":"abort"}
 *
 *    - Immediately stops whatever pi is doing
 *    - Equivalent to pressing Ctrl+C
 *    - Works even during LLM streaming or tool execution
 *
 * =============================================
 * MESSAGE FLOW
 * =============================================
 *
 * Phone (on toilet) → WebSocket Server → This Hook → pi Agent
 *
 * Your phone sends JSON message to a WebSocket server. This hook (running in
 * pi) receives that message and calls the appropriate pi API:
 *
 * - For "message": calls pi.sendMessage() which:
 *   1. Creates a CustomMessageEntry in the session
 *   2. Adds it to the LLM context
 *   3. Displays it in the TUI
 *   4. If agent is idle, starts a new agent turn
 *
 * - For "abort": calls ctx.abort() which:
 *   1. Cancels any in-progress LLM request
 *   2. Aborts any running tool execution
 *   3. Returns control to the user
 *
 * =============================================
 * SESSION HISTORY INTEGRATION
 * =============================================
 *
 * Messages sent via WebSocket are NOT second-class citizens! They:
 *
 * - Are stored as CustomMessageEntry in the session file
 * - Appear in the conversation history
 * - Participate in LLM context just like regular user messages
 * - Are visible in /tree navigation
 * - Persist across pi restarts
 * - Can be branched from, compacted, etc.
 *
 * The only difference is they have customType="websocket-message" which gives
 * them purple styling in the TUI.
 *
 * =============================================
 * USAGE
 * =============================================
 *
 * 1. Install dependencies in this directory:
 *    npm install
 *
 * 2. Run pi with the hook:
 *    pi --hook ~/Projects/toilet-pi/websocket-hook.ts
 *
 *    Or set a custom server URL:
 *    PI_WS_URL=ws://your-server:3456 pi --hook ~/Projects/toilet-pi/websocket-hook.ts
 *
 * 3. From another terminal, connect a WebSocket client:
 *    wscat -c ws://localhost:3456
 *
 * 4. Send JSON messages:
 *    {"type":"message","content":"Check the build status"}
 *    {"type":"abort"}
 *
 * =============================================
 * FOR PHONE USE
 * =============================================
 *
 * To use this from your phone while on the toilet:
 *
 * Option A - Local network:
 * 1. Run WebSocket server on your desktop (same machine running pi)
 * 2. Find your desktop's local IP address: ifconfig | grep inet
 * 3. Point phone client to: ws://192.168.1.XX:3456
 *
 * Option B - Cloud tunnel (recommended for public networks):
 * 1. Install ngrok: brew install ngrok
 * 2. Run: ngrok tcp 3456
 * 3. Use the ngrok URL: ws://0.tcp.ngrok.io:12345
 *
 * Option C - Cloudflare tunnel (no account needed):
 * 1. Install cloudflared: brew install cloudflared
 * 2. Run: cloudflared tunnel --url ws://localhost:3456
 * 3. Use the provided URL
 *
 * Phone WebSocket client apps:
 * - Android: "Simple WebSocket Client"
 * - iOS: "Rocket WebSocket"
 * - Or any browser-based client
 *
 * =============================================
 * TROUBLESHOOTING
 * =============================================
 *
 * Connection refused?
 * - Make sure the WebSocket server is running
 * - Check the port (default 3456) isn't already in use
 * - Verify PI_WS_URL is correct
 *
 * Messages not appearing?
 * - Check pi is running with the hook: pi --hook ...
 * - Try /ws command to see connection status
 * - Check console for errors
 *
 * Can't abort?
 * - Make sure agent is actually doing something
 * - Try regular Ctrl+C first to confirm it works
 * - Check for error messages
 *
 * =============================================
 * SECURITY CONSIDERATIONS
 * =============================================
 *
 * This hook provides REMOTE CONTROL of your pi instance. Be careful:
 *
 * - Anyone connected to your WebSocket server can send messages
 * - They can inject commands, abort work, etc.
 * - For public access, add authentication to your server
 * - Use HTTPS/WSS for encrypted connections
 * - Consider IP whitelisting
 *
 * Basic server auth example (see websocket-server.ts for implementation):
 * - Token-based auth in query string: ws://server?token=secret
 * - Or HTTP Basic Auth headers
 *
 * =============================================
 * EXTENDING THIS HOOK
 * =============================================
 *
 * Want more features? Here are ideas:
 *
 * 1. Receive pi output on phone:
 *    - Add pi.on("turn_end") to capture responses
 *    - Send them back via WebSocket
 *
 * 2. See full conversation history:
 *    - Add a "history" message type
 *    - Respond with JSON of recent messages
 *
 * 3. Branch/switch sessions remotely:
 *    - Add "branch" message type
 *    - Call ctx.branch() with entry ID
 *
 * 4. Get session stats:
 *    - Add "stats" message type
 *    - Respond with entry count, session info, etc.
 *
 * 5. Two-way sync:
 *    - Send phone's local draft state to pi
 *    - Keep editor in sync across devices
 *
 * See the HookAPI documentation for all available methods.
 */

import { WebSocket } from "ws";
import type { HookAPI, HookContext } from "@mariozechner/pi-coding-agent";

const WS_URL = process.env.PI_WS_URL || "ws://localhost:3456";

interface WSMessage {
	type: "message" | "abort";
	content?: string;
}

export default function (pi: HookAPI) {
	let ws: WebSocket | null = null;
	let reconnectTimeout: NodeJS.Timeout | null = null;
	let ctx: HookContext | null = null;
	let retryCount = 0;

	const updateStatus = (status: string, connected = false) => {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const icon = connected ? theme.fg("success", "●") : theme.fg("warning", "○");
		// Short form to fit on footer line
		ctx.ui.setStatus("a-ws", `${icon} WS:${status}`);
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
			});

			ws.on("message", async (data: Buffer) => {
				try {
					const msg: WSMessage = JSON.parse(data.toString());

					if (msg.type === "abort") {
						// Abort current agent operation
						await ctx?.abort();
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

	pi.on("session_shutdown", async () => {
		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
		}
		if (ws) {
			ws.close();
			ws = null;
		}
		if (ctx?.hasUI) {
			ctx.ui.setStatus("websocket", undefined); // Clear status
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
