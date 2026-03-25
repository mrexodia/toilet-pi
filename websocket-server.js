import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number.parseInt(process.env.PORT || "3457", 10);
const WS_PATH = "/ws";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

const hosts = new Map();
const hostCatalogs = new Map();
const sessions = new Map();
const webClients = new Map();
const clients = new Map();

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${PORT}`}`);
		const filePath = resolvePublicPath(url.pathname);
		if (!filePath) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}

		const content = await readFile(filePath);
		res.writeHead(200, { "Content-Type": getContentType(filePath) });
		res.end(content);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
	}
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${PORT}`}`);
	if (url.pathname !== WS_PATH) {
		socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
		socket.destroy();
		return;
	}

	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
});

wss.on("connection", (ws, req) => {
	const remote = req.socket.remoteAddress || "unknown";
	log(`client connected from ${remote}`);

	ws.on("message", async (data) => {
		let message;
		try {
			message = JSON.parse(data.toString());
		} catch {
			send(ws, { type: "error", message: "Invalid JSON" });
			return;
		}

		if (!clients.has(ws) && message.type !== "hello") {
			send(ws, { type: "error", message: "Send hello first" });
			return;
		}

		if (message.type === "hello") {
			handleHello(ws, message);
			return;
		}

		const client = clients.get(ws);
		if (!client) return;

		if (client.role === "web") {
			handleWebMessage(ws, message);
			return;
		}

		if (client.role === "host-supervisor") {
			handleHostMessage(ws, message);
			return;
		}

		handleRunnerMessage(ws, message, client);
	});

	ws.on("close", () => {
		handleClose(ws);
	});

	ws.on("error", (error) => {
		log(`socket error: ${error.message}`);
	});
});

server.listen(PORT, () => {
	console.log("=".repeat(60));
	console.log("Toilet-Pi v2 Server");
	console.log("=".repeat(60));
	console.log(`Web UI: http://localhost:${PORT}`);
	console.log(`WebSocket: ws://localhost:${PORT}${WS_PATH}`);
	console.log("State: in-memory only");
	console.log("=".repeat(60));
});

function handleHello(ws, message) {
	const role = message.role;
	if (!["web", "host-supervisor", "interactive", "background"].includes(role)) {
		send(ws, { type: "error", message: `Unknown role: ${role}` });
		ws.close(1008, "Unknown role");
		return;
	}

	if (role === "web") {
		clients.set(ws, { role: "web" });
		webClients.set(ws, { attachedSessionGuid: null });
		sendOverview(ws);
		return;
	}

	if (role === "host-supervisor") {
		clients.set(ws, {
			role,
			hostId: message.hostId,
		});
		hosts.set(message.hostId, {
			hostId: message.hostId,
			hostname: message.hostname || message.hostId,
			platform: message.platform || null,
			pid: message.pid || null,
			conn: ws,
			connectedAt: Date.now(),
		});
		broadcastOverview();
		return;
	}

	if (!message.sessionGuid) {
		send(ws, { type: "error", message: "Missing sessionGuid" });
		ws.close(1008, "Missing sessionGuid");
		return;
	}

	clients.set(ws, {
		role,
		hostId: message.hostId || null,
		sessionGuid: message.sessionGuid,
	});
	registerRunner(ws, message);
}

function handleWebMessage(ws, message) {
	if (message.type === "attach") {
		const state = webClients.get(ws);
		if (state) state.attachedSessionGuid = message.sessionGuid || null;
		send(ws, {
			type: "session_snapshot",
			session: buildSessionSnapshot(message.sessionGuid),
		});
		return;
	}

	if (message.type === "input") {
		const session = sessions.get(message.sessionGuid);
		const target = getOwnerConnection(session);
		if (!target) {
			send(ws, { type: "error", message: "Session is not currently owned by an active runner" });
			return;
		}
		send(target, { type: "input", text: String(message.text || "") });
		return;
	}

	if (message.type === "abort") {
		const session = sessions.get(message.sessionGuid);
		const target = getOwnerConnection(session);
		if (!target) {
			send(ws, { type: "error", message: "Session is not currently owned by an active runner" });
			return;
		}
		send(target, { type: "abort" });
		return;
	}

	if (message.type === "start_background_session") {
		const host = hosts.get(message.hostId);
		if (!host?.conn || !isOpen(host.conn)) {
			send(ws, { type: "error", message: `Host ${message.hostId} is not connected` });
			return;
		}

		send(host.conn, {
			type: "start_background_session",
			hostId: message.hostId,
			sessionGuid: message.sessionGuid,
			sessionFile: message.sessionFile || null,
			cwd: message.cwd || null,
		});
		return;
	}

	if (message.type === "refresh_host_sessions") {
		const host = hosts.get(message.hostId);
		if (!host?.conn || !isOpen(host.conn)) {
			send(ws, { type: "error", message: `Host ${message.hostId} is not connected` });
			return;
		}
		send(host.conn, { type: "list_sessions" });
		return;
	}
}

function handleHostMessage(_ws, message) {
	if (message.type === "host_sessions") {
		hostCatalogs.set(message.hostId, {
			hostId: message.hostId,
			updatedAt: Date.now(),
			sessions: Array.isArray(message.sessions) ? message.sessions : [],
		});
		broadcastOverview();
		return;
	}

	if (message.type === "runner_status") {
		if (message.sessionGuid) {
			const session = getOrCreateSession(message.sessionGuid);
			session.hostId = message.hostId || session.hostId;
			session.runnerStatus = message.status || null;
			session.updatedAt = Date.now();
		}

		broadcastOverview();
		broadcastNotice({
			type: "notice",
			level: message.status === "error" ? "error" : "info",
			message: formatRunnerStatus(message),
		});
		return;
	}
}

function handleRunnerMessage(ws, message, client) {
	const session = sessions.get(client.sessionGuid);
	if (!session) return;

	if (message.type === "released") {
		if (client.role === "background" && session.backgroundConn === ws) {
			session.backgroundConn = null;
			session.busy = false;
			session.streamingText = null;
			session.activeTools.clear();
			promoteSessionOwner(session);
			try {
				ws.close(1000, "released");
			} catch {
				// Ignore.
			}
			broadcastOverview();
			notifySessionMeta(session.sessionGuid);
		}
		return;
	}

	if (message.type !== "session_event") return;
	if (message.sessionGuid && message.sessionGuid !== client.sessionGuid) return;

	applySessionEvent(session, message.event);
	sendToAttached(session.sessionGuid, {
		type: "session_event",
		sessionGuid: session.sessionGuid,
		event: message.event,
	});

	if (["message", "busy", "model", "tool_start", "tool_end"].includes(message.event?.type)) {
		notifySessionMeta(session.sessionGuid);
	}
}

function registerRunner(ws, message) {
	const session = getOrCreateSession(message.sessionGuid);
	if (message.role === "interactive") {
		replaceConnection(session, "interactiveConn", ws);
		session.pendingInteractiveConn = ws;
	} else {
		replaceConnection(session, "backgroundConn", ws);
	}

	session.hostId = message.hostId || session.hostId;
	session.sessionFile = message.sessionFile || session.sessionFile;
	session.sessionName = message.sessionName || session.sessionName;
	session.cwd = message.cwd || session.cwd;
	session.model = message.model || session.model;
	session.busy = !!message.busy;
	session.history = Array.isArray(message.history) ? message.history : session.history;
	session.streamingText = typeof message.streamingText === "string" ? message.streamingText : null;
	session.runnerStatus = null;
	session.updatedAt = Date.now();
	clearFinishedTools(session);

	if (message.role === "interactive") {
		if (session.backgroundConn && isOpen(session.backgroundConn)) {
			session.owner = "background";
			send(session.backgroundConn, { type: "abort_and_release" });
		} else {
			session.pendingInteractiveConn = null;
			session.owner = "interactive";
		}
	} else {
		if ((session.interactiveConn && isOpen(session.interactiveConn))
			|| (session.pendingInteractiveConn && isOpen(session.pendingInteractiveConn))) {
			session.owner = "interactive";
			send(ws, { type: "abort_and_release" });
		} else {
			session.owner = "background";
		}
	}

	broadcastOverview();
	notifySessionMeta(session.sessionGuid);
}

function replaceConnection(session, key, ws) {
	const previous = session[key];
	if (previous && previous !== ws && isOpen(previous)) {
		try {
			previous.close(1000, "replaced");
		} catch {
			// Ignore.
		}
	}
	session[key] = ws;
}

function applySessionEvent(session, event) {
	if (!event || typeof event !== "object") return;
	session.updatedAt = Date.now();

	switch (event.type) {
		case "message":
			if (event.message) session.history.push(event.message);
			if (event.message?.role === "assistant") session.streamingText = null;
			break;

		case "assistant_stream_start":
			session.streamingText = "";
			break;

		case "assistant_stream_update":
			session.streamingText = typeof event.text === "string" ? event.text : "";
			break;

		case "assistant_stream_end":
			break;

		case "tool_start":
			if (event.toolCallId) {
				session.activeTools.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName || "tool",
				});
			}
			break;

		case "tool_end":
			if (event.toolCallId) session.activeTools.delete(event.toolCallId);
			break;

		case "busy":
			session.busy = !!event.busy;
			if (!session.busy) {
				session.streamingText = null;
				session.activeTools.clear();
			}
			break;

		case "model":
			session.model = event.modelId || null;
			break;

		case "session_name":
			session.sessionName = event.sessionName || null;
			break;
	}
}

function promoteSessionOwner(session) {
	if (session.pendingInteractiveConn && isOpen(session.pendingInteractiveConn)) {
		session.interactiveConn = session.pendingInteractiveConn;
		session.pendingInteractiveConn = null;
		session.owner = "interactive";
		return;
	}

	if (session.interactiveConn && isOpen(session.interactiveConn)) {
		session.owner = "interactive";
		return;
	}

	if (session.backgroundConn && isOpen(session.backgroundConn)) {
		session.owner = "background";
		return;
	}

	session.owner = null;
}

function handleClose(ws) {
	const client = clients.get(ws);
	clients.delete(ws);

	if (!client) return;

	if (client.role === "web") {
		webClients.delete(ws);
		return;
	}

	if (client.role === "host-supervisor") {
		const host = hosts.get(client.hostId);
		if (host?.conn === ws) hosts.delete(client.hostId);
		broadcastOverview();
		return;
	}

	const session = sessions.get(client.sessionGuid);
	if (!session) return;

	if (client.role === "interactive") {
		if (session.interactiveConn === ws) session.interactiveConn = null;
		if (session.pendingInteractiveConn === ws) session.pendingInteractiveConn = null;
	} else if (client.role === "background") {
		if (session.backgroundConn === ws) session.backgroundConn = null;
	}

	if (!session.interactiveConn && session.pendingInteractiveConn) {
		session.pendingInteractiveConn = null;
	}

	if (client.role === "background") {
		session.busy = false;
		session.streamingText = null;
		session.activeTools.clear();
	}

	promoteSessionOwner(session);
	broadcastOverview();
	notifySessionMeta(session.sessionGuid);
}

function getOrCreateSession(sessionGuid) {
	let session = sessions.get(sessionGuid);
	if (!session) {
		session = {
			sessionGuid,
			interactiveConn: null,
			backgroundConn: null,
			pendingInteractiveConn: null,
			owner: null,
			hostId: null,
			sessionFile: null,
			sessionName: null,
			cwd: null,
			model: null,
			busy: false,
			history: [],
			streamingText: null,
			activeTools: new Map(),
			runnerStatus: null,
			updatedAt: Date.now(),
		};
		sessions.set(sessionGuid, session);
	}
	return session;
}

function buildSessionSnapshot(sessionGuid) {
	const session = sessionGuid ? sessions.get(sessionGuid) : null;
	if (!session) {
		return {
			sessionGuid: sessionGuid || null,
			owner: null,
			hostId: null,
			sessionFile: null,
			sessionName: null,
			cwd: null,
			model: null,
			busy: false,
			history: [],
			streamingText: null,
			activeTools: [],
		};
	}

	return {
		sessionGuid: session.sessionGuid,
		owner: session.owner,
		hostId: session.hostId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		cwd: session.cwd,
		model: session.model,
		busy: session.busy,
		history: session.history,
		streamingText: session.streamingText,
		activeTools: Array.from(session.activeTools.values()),
	};
}

function notifySessionMeta(sessionGuid) {
	const session = sessions.get(sessionGuid);
	if (!session) return;
	sendToAttached(sessionGuid, {
		type: "session_meta",
		sessionGuid,
		owner: session.owner,
		hostId: session.hostId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		cwd: session.cwd,
		model: session.model,
		busy: session.busy,
	});
}

function sendToAttached(sessionGuid, payload) {
	for (const [ws, state] of webClients) {
		if (state.attachedSessionGuid === sessionGuid) send(ws, payload);
	}
}

function broadcastNotice(payload) {
	for (const ws of webClients.keys()) {
		send(ws, payload);
	}
}

function sendOverview(ws) {
	send(ws, {
		type: "overview",
		hosts: buildOverviewHosts(),
	});
}

function broadcastOverview() {
	const payload = {
		type: "overview",
		hosts: buildOverviewHosts(),
	};
	for (const ws of webClients.keys()) {
		send(ws, payload);
	}
}

function buildOverviewHosts() {
	const hostIds = new Set([...hosts.keys(), ...hostCatalogs.keys()]);
	for (const session of sessions.values()) {
		if (session.hostId) hostIds.add(session.hostId);
	}

	const list = [];
	for (const hostId of hostIds) {
		const host = hosts.get(hostId);
		const catalog = hostCatalogs.get(hostId);
		const merged = new Map();

		for (const entry of catalog?.sessions || []) {
			merged.set(entry.sessionGuid, {
				sessionGuid: entry.sessionGuid,
				sessionFile: entry.sessionFile || null,
				sessionName: entry.sessionName || null,
				cwd: entry.cwd || null,
				preview: entry.preview || null,
				updatedAt: entry.updatedAt || 0,
				owner: null,
				busy: false,
				model: null,
				runnerStatus: null,
			});
		}

		for (const session of sessions.values()) {
			if (session.hostId !== hostId) continue;
			const current = merged.get(session.sessionGuid) || { sessionGuid: session.sessionGuid };
			merged.set(session.sessionGuid, {
				...current,
				sessionGuid: session.sessionGuid,
				sessionFile: session.sessionFile || current.sessionFile || null,
				sessionName: session.sessionName || current.sessionName || null,
				cwd: session.cwd || current.cwd || null,
				preview: getSessionPreview(session) || current.preview || null,
				updatedAt: session.updatedAt || current.updatedAt || 0,
				owner: session.owner,
				busy: session.busy,
				model: session.model,
				runnerStatus: session.runnerStatus || null,
			});
		}

		const sessionsForHost = Array.from(merged.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
		list.push({
			hostId,
			hostname: host?.hostname || hostId,
			platform: host?.platform || null,
			connected: !!host,
			sessions: sessionsForHost,
		});
	}

	list.sort((a, b) => a.hostname.localeCompare(b.hostname));
	return list;
}

function getSessionPreview(session) {
	for (const message of session.history) {
		if (message.role === "user" && message.text) return message.text;
	}
	return null;
}

function getOwnerConnection(session) {
	if (!session) return null;
	if (session.owner === "interactive" && isOpen(session.interactiveConn)) return session.interactiveConn;
	if (session.owner === "background" && isOpen(session.backgroundConn)) return session.backgroundConn;
	return null;
}

function clearFinishedTools(session) {
	if (!(session.activeTools instanceof Map)) {
		session.activeTools = new Map();
	}
}

function send(ws, payload) {
	if (!isOpen(ws)) return;
	ws.send(JSON.stringify(payload));
}

function isOpen(ws) {
	return ws?.readyState === WebSocket.OPEN;
}

function formatRunnerStatus(message) {
	if (message.status === "starting") {
		return `Starting background runner for ${message.sessionGuid}`;
	}
	if (message.status === "already-running") {
		return `Background runner already active for ${message.sessionGuid}`;
	}
	if (message.status === "error") {
		return `Background runner error for ${message.sessionGuid}: ${message.error}`;
	}
	if (message.status === "exited") {
		return `Background runner exited for ${message.sessionGuid}`;
	}
	return `Runner status for ${message.sessionGuid}: ${message.status}`;
}

function resolvePublicPath(requestPath) {
	const pathname = requestPath === "/" ? "/index.html" : requestPath;
	const fullPath = path.normalize(path.join(PUBLIC_DIR, pathname));
	if (!fullPath.startsWith(PUBLIC_DIR)) return null;
	return fullPath;
}

function getContentType(filePath) {
	if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
	if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
	if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
	if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
	return "text/plain; charset=utf-8";
}

function log(message) {
	console.log(`[${new Date().toISOString()}] ${message}`);
}

let shuttingDown = false;

function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`${signal} received, shutting down server...`);
	for (const ws of webClients.keys()) {
		try {
			ws.close();
		} catch {
			// Ignore.
		}
	}
	for (const host of hosts.values()) {
		try {
			host.conn.close();
		} catch {
			// Ignore.
		}
	}
	for (const [ws, client] of clients) {
		if (client.role === "interactive" || client.role === "background") {
			try {
				ws.close();
			} catch {
				// Ignore.
			}
		}
	}
	wss.close(() => {
		server.close(() => {
			console.log("Server closed");
			process.exit(0);
		});
	});
	setTimeout(() => process.exit(1), 1000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
