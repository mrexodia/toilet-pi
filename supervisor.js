import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  buildConnectUrl,
  parseToiletPiInput,
  readToiletPiConfig,
} from "./toilet-pi-config.js";
import {
  findSessionFile,
  getDefaultSessionDir,
  readSessionSnapshot,
  scanSessions,
} from "./session-scanner.js";

const HOST_ID = process.env.TOILET_PI_HOST_ID || os.hostname();
const PI_COMMAND = process.env.TOILET_PI_PI_COMMAND || "pi";
const SESSION_DIR = process.env.TOILET_PI_SESSION_DIR || getDefaultSessionDir();
const SCAN_INTERVAL_MS = Number.parseInt(
  process.env.TOILET_PI_SCAN_INTERVAL_MS || "15000",
  10,
);
const EXTENSION_PATH =
  process.env.TOILET_PI_EXTENSION_PATH ||
  fileURLToPath(new URL("./extension.ts", import.meta.url));
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHILD_SHUTDOWN_GRACE_MS = Number.parseInt(
  process.env.TOILET_PI_CHILD_SHUTDOWN_GRACE_MS || "3000",
  10,
);
const CHILD_SHUTDOWN_FORCE_MS = Number.parseInt(
  process.env.TOILET_PI_CHILD_SHUTDOWN_FORCE_MS || "8000",
  10,
);
const USE_PROCESS_GROUPS = process.platform !== "win32";

const children = new Map();
let ws = null;
let reconnectTimer = null;
let shuttingDown = false;
let catalogTimer = null;
let shutdownForceTimer = null;
let shutdownExitTimer = null;
let shutdownFinished = false;
let currentConnectUrl = null;

function log(message) {
  console.log(`[supervisor ${HOST_ID}] ${message}`);
}

function isOpen(socket) {
  return socket?.readyState === WebSocket.OPEN;
}

function send(message) {
  if (!isOpen(ws)) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    log(
      `socket send failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      ws.close();
    } catch {
      // Ignore.
    }
    return false;
  }
}

async function sendSessionCatalog() {
  const sessions = await scanSessions(SESSION_DIR);
  send({
    type: "host_sessions",
    hostId: HOST_ID,
    sessions,
  });
}

function ensureCatalogTimer() {
  if (catalogTimer) return;
  catalogTimer = setInterval(() => {
    sendSessionCatalog().catch((error) => {
      log(`catalog scan failed: ${error.message}`);
    });
  }, SCAN_INTERVAL_MS);
}

function clearCatalogTimer() {
  if (!catalogTimer) return;
  clearInterval(catalogTimer);
  catalogTimer = null;
}

function scheduleReconnect(delayMs = 3000) {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

async function loadConnectionConfig() {
  if (process.env.TOILET_PI_SERVER_URL) {
    try {
      return parseToiletPiInput(process.env.TOILET_PI_SERVER_URL);
    } catch {
      return null;
    }
  }

  return readToiletPiConfig();
}

async function connect() {
  if (shuttingDown) return;
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  )
    return;

  const config = await loadConnectionConfig();
  if (!config) {
    currentConnectUrl = null;
    scheduleReconnect(5000);
    return;
  }

  currentConnectUrl = buildConnectUrl(config);
  log(`connecting to ${config.serverUrl}`);
  ws = new WebSocket(currentConnectUrl);

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
    ensureCatalogTimer();
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
      return;
    }

    if (message.type === "read_session_snapshot") {
      await sendSessionSnapshot(message);
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

async function sendSessionSnapshot(message) {
  const sessionGuid =
    typeof message.sessionGuid === "string" ? message.sessionGuid : null;
  let sessionFile =
    typeof message.sessionFile === "string" ? message.sessionFile : null;

  if (!sessionFile && sessionGuid) {
    sessionFile = await findSessionFile(sessionGuid, SESSION_DIR);
  }

  if (!sessionFile) {
    send({
      type: "session_snapshot_error",
      hostId: HOST_ID,
      sessionGuid,
      message: "Session file not found",
    });
    return;
  }

  try {
    const session = await readSessionSnapshot(sessionFile);
    if (!session) {
      send({
        type: "session_snapshot_error",
        hostId: HOST_ID,
        sessionGuid,
        message: "Failed to parse session history",
      });
      return;
    }

    send({
      type: "session_snapshot_data",
      hostId: HOST_ID,
      session,
    });
    return;
  } catch (error) {
    send({
      type: "session_snapshot_error",
      hostId: HOST_ID,
      sessionGuid,
      message:
        error instanceof Error
          ? error.message
          : "Failed to load session history",
    });
    return;
  }
}

function startBackgroundRunner(message) {
  if (shuttingDown) return;

  const requestId = message.requestId || null;
  const createNew = !!message.createNew;
  const sessionRef = !createNew
    ? message.sessionFile || message.sessionGuid
    : null;
  const childKey = message.sessionGuid
    ? `session:${message.sessionGuid}`
    : `launch:${requestId || randomUUID()}`;
  const existing = children.get(childKey);

  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    log(`background runner already active for ${childKey}`);
    send({
      type: "runner_status",
      hostId: HOST_ID,
      sessionGuid: message.sessionGuid || null,
      requestId,
      status: "already-running",
      pid: existing.child.pid,
    });
    return;
  }

  if (!createNew && !sessionRef) {
    send({
      type: "runner_status",
      hostId: HOST_ID,
      sessionGuid: message.sessionGuid || null,
      requestId,
      status: "error",
      error: "Missing session reference",
    });
    return;
  }

  const args = ["--mode", "rpc", "-e", EXTENSION_PATH];
  if (!createNew && sessionRef) {
    args.push("--session", sessionRef);
  }
  if (process.env.TOILET_PI_SESSION_DIR) {
    args.push("--session-dir", SESSION_DIR);
  }

  log(
    `starting background runner (${createNew ? "new" : message.sessionGuid})`,
  );
  const child = spawn(PI_COMMAND, args, {
    cwd: message.cwd || PROJECT_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    detached: USE_PROCESS_GROUPS,
    env: {
      ...process.env,
      TOILET_PI_SERVER_URL: currentConnectUrl || "",
      TOILET_PI_HOST_ID: HOST_ID,
      TOILET_PI_ROLE: "background",
      TOILET_PI_SESSION_DIR: SESSION_DIR,
      TOILET_PI_LAUNCH_REQUEST_ID: requestId || "",
    },
  });

  children.set(childKey, {
    child,
    sessionGuid: message.sessionGuid || null,
    requestId,
    createNew,
    useProcessGroup: USE_PROCESS_GROUPS,
  });

  send({
    type: "runner_status",
    hostId: HOST_ID,
    sessionGuid: message.sessionGuid || null,
    requestId,
    status: "starting",
    pid: child.pid,
  });

  child.stdout.on("data", () => {
    // Drain RPC stdout so the child cannot block on a full pipe.
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text)
      log(`child ${message.sessionGuid || requestId || child.pid}: ${text}`);
  });

  child.on("error", (error) => {
    log(
      `failed to start ${message.sessionGuid || requestId || child.pid}: ${error.message}`,
    );
    send({
      type: "runner_status",
      hostId: HOST_ID,
      sessionGuid: message.sessionGuid || null,
      requestId,
      status: "error",
      error: error.message,
    });
  });

  child.on("exit", (code, signal) => {
    children.delete(childKey);
    log(
      `background runner exited (${message.sessionGuid || requestId || child.pid}, code=${code}, signal=${signal})`,
    );
    send({
      type: "runner_status",
      hostId: HOST_ID,
      sessionGuid: message.sessionGuid || null,
      requestId,
      status: "exited",
      code,
      signal,
    });
    sendSessionCatalog().catch(() => {});
    maybeFinishShutdown();
  });
}

function signalChild(record, signal) {
  const child = record?.child;
  if (!child || child.exitCode !== null) return false;

  if (signal !== "SIGKILL") {
    try {
      child.stdin?.end();
    } catch {
      // Ignore.
    }
  }

  try {
    if (record.useProcessGroup && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch {
    return false;
  }
}

function signalChildren(signal) {
  let activeChildren = 0;
  for (const [key, record] of children) {
    if (!record?.child || record.child.exitCode !== null) continue;
    activeChildren += 1;
    log(
      `${signal === "SIGTERM" ? "stopping" : "force killing"} background runner for ${key}`,
    );
    signalChild(record, signal);
  }
  return activeChildren;
}

function finishShutdown(exitCode) {
  if (shutdownFinished) return;
  shutdownFinished = true;
  if (shutdownForceTimer) clearTimeout(shutdownForceTimer);
  if (shutdownExitTimer) clearTimeout(shutdownExitTimer);
  process.exit(exitCode);
}

function maybeFinishShutdown() {
  if (!shuttingDown || shutdownFinished) return;
  if (children.size > 0) return;
  finishShutdown(0);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  clearCatalogTimer();
  log(`${signal} received, shutting down`);
  if (ws) {
    try {
      ws.close();
    } catch {
      // Ignore.
    }
  }

  const activeChildren = signalChildren("SIGTERM");
  if (activeChildren === 0) {
    finishShutdown(0);
    return;
  }

  shutdownForceTimer = setTimeout(() => {
    const remaining = signalChildren("SIGKILL");
    if (remaining > 0) {
      log(`forced shutdown for ${remaining} background runner(s)`);
    }
    maybeFinishShutdown();
  }, CHILD_SHUTDOWN_GRACE_MS);

  shutdownExitTimer = setTimeout(() => {
    if (children.size > 0) {
      log(`timed out waiting for ${children.size} background runner(s) to exit`);
      finishShutdown(1);
      return;
    }
    finishShutdown(0);
  }, CHILD_SHUTDOWN_FORCE_MS);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

connect();
