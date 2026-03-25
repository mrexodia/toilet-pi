import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { getDefaultSessionDir, scanSessions } from "./session-scanner.js";

const SERVER_URL = process.env.TOILET_PI_SERVER_URL || "ws://localhost:3457/ws";
const HOST_ID = process.env.TOILET_PI_HOST_ID || os.hostname();
const PI_COMMAND = process.env.TOILET_PI_PI_COMMAND || "pi";
const SESSION_DIR = process.env.TOILET_PI_SESSION_DIR || getDefaultSessionDir();
const EXTENSION_PATH = process.env.TOILET_PI_EXTENSION_PATH
	|| fileURLToPath(new URL("./websocket-extension.ts", import.meta.url));
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));

const children = new Map();
let ws = null;
let reconnectTimer = null;
let shuttingDown = false;

function log(message) {
	console.log(`[supervisor ${HOST_ID}] ${message}`);
}

function isOpen(socket) {
	return socket?.readyState === WebSocket.OPEN;
}

function send(message) {
	if (!isOpen(ws)) return;
	ws.send(JSON.stringify(message));
}

async function sendSessionCatalog() {
	const sessions = await scanSessions(SESSION_DIR);
	send({
		type: "host_sessions",
		hostId: HOST_ID,
		sessions,
	});
}

function scheduleReconnect() {
	if (shuttingDown || reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, 3000);
}

function connect() {
	if (shuttingDown) return;
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

	log(`connecting to ${SERVER_URL}`);
	ws = new WebSocket(SERVER_URL);

	ws.on("open", async () => {
		log("connected");
		send({
			type: "hello",
			role: "host-supervisor",
			hostId: HOST_ID,
			hostname: os.hostname(),
			platform: `${os.platform()} ${os.release()}`,
			pid: process.pid,
		});
		await sendSessionCatalog();
	});

	ws.on("message", async (data) => {
		let message;
		try {
			message = JSON.parse(data.toString());
		} catch {
			return;
		}

		if (message.type === "list_sessions") {
			await sendSessionCatalog();
			return;
		}

		if (message.type === "start_background_session") {
			startBackgroundRunner(message);
		}
	});

	ws.on("close", () => {
		log("disconnected");
		ws = null;
		scheduleReconnect();
	});

	ws.on("error", (error) => {
		log(`socket error: ${error.message}`);
	});
}

function startBackgroundRunner(message) {
	const sessionRef = message.sessionFile || message.sessionGuid;
	if (!sessionRef) {
		send({
			type: "runner_status",
			hostId: HOST_ID,
			sessionGuid: message.sessionGuid || null,
			status: "error",
			error: "Missing session reference",
		});
		return;
	}

	const existing = children.get(message.sessionGuid);
	if (existing && existing.exitCode === null && !existing.killed) {
		log(`background runner already active for ${message.sessionGuid}`);
		send({
			type: "runner_status",
			hostId: HOST_ID,
			sessionGuid: message.sessionGuid,
			status: "already-running",
			pid: existing.pid,
		});
		return;
	}

	const args = ["--mode", "rpc", "--session", sessionRef, "-e", EXTENSION_PATH];
	if (process.env.TOILET_PI_SESSION_DIR) {
		args.push("--session-dir", SESSION_DIR);
	}

	log(`starting background runner for ${message.sessionGuid}`);
	const child = spawn(PI_COMMAND, args, {
		cwd: message.cwd || PROJECT_DIR,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			TOILET_PI_SERVER_URL: SERVER_URL,
			TOILET_PI_HOST_ID: HOST_ID,
			TOILET_PI_ROLE: "background",
			TOILET_PI_SESSION_DIR: SESSION_DIR,
		},
	});

	children.set(message.sessionGuid, child);
	send({
		type: "runner_status",
		hostId: HOST_ID,
		sessionGuid: message.sessionGuid,
		status: "starting",
		pid: child.pid,
	});

	child.stdout.on("data", () => {
		// Intentionally drain RPC stdout so the child cannot block on a full pipe.
	});

	child.stderr.on("data", (chunk) => {
		const text = chunk.toString().trim();
		if (text) log(`child ${message.sessionGuid}: ${text}`);
	});

	child.on("error", (error) => {
		log(`failed to start ${message.sessionGuid}: ${error.message}`);
		send({
			type: "runner_status",
			hostId: HOST_ID,
			sessionGuid: message.sessionGuid,
			status: "error",
			error: error.message,
		});
	});

	child.on("exit", (code, signal) => {
		children.delete(message.sessionGuid);
		log(`background runner exited for ${message.sessionGuid} (code=${code}, signal=${signal})`);
		send({
			type: "runner_status",
			hostId: HOST_ID,
			sessionGuid: message.sessionGuid,
			status: "exited",
			code,
			signal,
		});
	});
}

function killChildren() {
	for (const [sessionGuid, child] of children) {
		log(`stopping background runner for ${sessionGuid}`);
		try {
			child.kill("SIGTERM");
		} catch {
			// Ignore.
		}
	}
}

function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	if (reconnectTimer) clearTimeout(reconnectTimer);
	log(`${signal} received, shutting down`);
	killChildren();
	if (ws) {
		try {
			ws.close();
		} catch {
			// Ignore.
		}
	}
	setTimeout(() => process.exit(0), 250);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

connect();
