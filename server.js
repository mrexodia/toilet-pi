import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number.parseInt(process.env.PORT || "3457", 10);
const WS_PATH = "/ws";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_SESSION_HISTORY = Math.max(
  1,
  Number.parseInt(
    process.env.TOILET_PI_SERVER_HISTORY_LIMIT ||
      process.env.TOILET_PI_HISTORY_LIMIT ||
      "200",
    10,
  ) || 200,
);

const hosts = new Map();
const hostCatalogs = new Map();
const sessions = new Map();
const webClients = new Map();
const clients = new Map();
const pendingSessionSnapshotLoads = new Map();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || `localhost:${PORT}`}`,
    );
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
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || `localhost:${PORT}`}`,
  );
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
      await handleWebMessage(ws, message);
      return;
    }

    if (client.role === "host-supervisor") {
      await handleHostMessage(ws, message);
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
    broadcastNotice({
      type: "notice",
      level: "info",
      message: `Host connected: ${message.hostname || message.hostId}`,
    });
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

async function handleWebMessage(ws, message) {
  if (message.type === "attach") {
    const sessionGuid =
      typeof message.sessionGuid === "string" ? message.sessionGuid : null;
    const state = webClients.get(ws);
    if (state) state.attachedSessionGuid = sessionGuid;
    send(ws, {
      type: "session_snapshot",
      session: buildSessionSnapshot(sessionGuid),
    });
    if (sessionGuid) {
      await requestSessionSnapshotFromHost(sessionGuid);
    }
    return;
  }

  if (message.type === "input") {
    const text = String(message.text || "").trim();
    if (!message.sessionGuid || !text) return;

    const session = getKnownSession(message.sessionGuid);
    if (!session) {
      send(ws, {
        type: "error",
        message: `Unknown session ${message.sessionGuid}`,
      });
      return;
    }

    const inputId = createId();
    const target = getOwnerConnection(session);
    const shouldQueueVisibly = !target || session.busy;

    if (shouldQueueVisibly) {
      addQueuedInput(session, {
        inputId,
        text,
        timestamp: Date.now(),
      });
    }

    if (target) {
      send(target, { type: "input", text, inputId });
      return;
    }

    session.pendingInputs.push({ inputId, text });
    const started = ensureBackgroundSession(session);
    if (!started) {
      session.pendingInputs.pop();
      if (shouldQueueVisibly) removeQueuedInput(session, inputId);
      send(ws, {
        type: "error",
        message: "This session cannot be started in background right now",
      });
      return;
    }

    send(ws, {
      type: "notice",
      level: "info",
      message: `Starting background runner for ${formatSessionLabel(session)}`,
    });
    return;
  }

  if (message.type === "abort") {
    const session = getKnownSession(message.sessionGuid);
    const target = getOwnerConnection(session);
    if (!target) {
      send(ws, {
        type: "error",
        message: "Session is not currently owned by an active runner",
      });
      return;
    }
    send(target, { type: "abort" });
    return;
  }

  if (message.type === "start_background_session") {
    const session =
      getKnownSession(message.sessionGuid) ||
      getOrCreateSession(message.sessionGuid);
    if (message.hostId) session.hostId = message.hostId;
    if (message.sessionFile) session.sessionFile = message.sessionFile;
    if (message.cwd) session.cwd = message.cwd;
    const started = ensureBackgroundSession(session, {
      requestId: message.requestId || null,
    });
    if (!started) {
      send(ws, {
        type: "error",
        message: "Could not start background session",
      });
    }
    return;
  }

  if (message.type === "create_background_session") {
    const host = hosts.get(message.hostId);
    const cwd = typeof message.cwd === "string" ? message.cwd : null;
    if (!host?.conn || !isOpen(host.conn)) {
      send(ws, {
        type: "error",
        message: `Host ${message.hostId} is not connected`,
      });
      return;
    }
    if (!cwd) {
      send(ws, { type: "error", message: "Missing cwd for new session" });
      return;
    }

    send(host.conn, {
      type: "start_background_session",
      hostId: message.hostId,
      requestId: message.requestId || null,
      cwd,
      createNew: true,
    });

    send(ws, {
      type: "notice",
      level: "info",
      message: `Starting new background session in ${cwd}`,
    });
    return;
  }

  if (message.type === "refresh_host_sessions") {
    const host = hosts.get(message.hostId);
    if (!host?.conn || !isOpen(host.conn)) {
      send(ws, {
        type: "error",
        message: `Host ${message.hostId} is not connected`,
      });
      return;
    }
    send(host.conn, { type: "list_sessions" });
    return;
  }
}

async function handleHostMessage(_ws, message) {
  if (message.type === "host_sessions") {
    hostCatalogs.set(message.hostId, {
      hostId: message.hostId,
      updatedAt: Date.now(),
      sessions: Array.isArray(message.sessions) ? message.sessions : [],
    });
    broadcastOverview();
    return;
  }

  if (message.type === "session_snapshot_data") {
    mergeLoadedSessionSnapshot(message.hostId, message.session);
    return;
  }

  if (message.type === "session_snapshot_error") {
    clearPendingSessionSnapshotLoad(message.sessionGuid);
    sendToAttached(message.sessionGuid, {
      type: "notice",
      level: "error",
      message: message.message || "Failed to load session history",
    });
    return;
  }

  if (message.type === "runner_status") {
    if (message.sessionGuid) {
      const session = getOrCreateSession(message.sessionGuid);
      session.hostId = message.hostId || session.hostId;
      session.runnerStatus = message.status || null;
      session.updatedAt = Date.now();
    }

    if (message.requestId) {
      broadcastWeb({
        type: "launch_status",
        requestId: message.requestId,
        status: message.status,
        sessionGuid: message.sessionGuid || null,
        error: message.error || null,
      });
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
      session.runnerStatus = "released";
      promoteSessionOwner(session);
      deliverPendingInputs(session);
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

  if (
    ["message", "busy", "model", "tool_start", "tool_end"].includes(
      message.event?.type,
    )
  ) {
    broadcastOverview();
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
  session.preview =
    getSessionPreview({
      history: Array.isArray(message.history) ? message.history : [],
    }) || session.preview;
  session.model = message.model || session.model;
  session.busy = !!message.busy;
  session.history = Array.isArray(message.history)
    ? message.history.slice(-MAX_SESSION_HISTORY)
    : session.history;
  session.streamingText =
    typeof message.streamingText === "string" ? message.streamingText : null;
  session.runnerStatus = "running";
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
    if (
      (session.interactiveConn && isOpen(session.interactiveConn)) ||
      (session.pendingInteractiveConn && isOpen(session.pendingInteractiveConn))
    ) {
      session.owner = "interactive";
      send(ws, { type: "abort_and_release" });
    } else {
      session.owner = "background";
    }
  }

  if (message.launchRequestId) {
    broadcastWeb({
      type: "background_session_started",
      requestId: message.launchRequestId,
      sessionGuid: session.sessionGuid,
      hostId: session.hostId,
      cwd: session.cwd,
    });
  }

  deliverPendingInputs(session);
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
      if (event.message) {
        session.history.push(event.message);
        trimSessionHistory(session);
      }
      if (event.message?.role === "user" && event.message.remoteInputId) {
        removeQueuedInput(session, event.message.remoteInputId);
      }
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
          args: event.args,
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

    case "remote_input_failed":
      removeQueuedInput(session, event.inputId || null);
      break;
  }
}

function promoteSessionOwner(session) {
  if (
    session.pendingInteractiveConn &&
    isOpen(session.pendingInteractiveConn)
  ) {
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
    hostCatalogs.delete(client.hostId);
    pruneInactiveSessionsForHost(client.hostId);
    broadcastOverview();
    broadcastNotice({
      type: "notice",
      level: "error",
      message: `Host disconnected: ${host?.hostname || client.hostId}`,
    });
    return;
  }

  const session = sessions.get(client.sessionGuid);
  if (!session) return;
  const previousOwner = session.owner;

  if (client.role === "interactive") {
    if (session.interactiveConn === ws) session.interactiveConn = null;
    if (session.pendingInteractiveConn === ws)
      session.pendingInteractiveConn = null;
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
    session.runnerStatus = "exited";
  }

  promoteSessionOwner(session);
  deliverPendingInputs(session);
  const removed = maybeRemoveSession(session);
  broadcastOverview();
  if (!removed) notifySessionMeta(session.sessionGuid);

  const roleLabel =
    client.role === "interactive" ? "Interactive session" : "Background runner";
  const level = previousOwner === client.role ? "error" : "info";
  broadcastNotice({
    type: "notice",
    level,
    message: `${roleLabel} disconnected: ${formatSessionLabel(session)}`,
  });
}

function getKnownSession(sessionGuid) {
  if (!sessionGuid) return null;
  const existing = sessions.get(sessionGuid);
  if (existing) return existing;

  const found = findCatalogSession(sessionGuid);
  if (!found) return null;

  const session = createSessionState(sessionGuid);
  session.hostId = found.hostId;
  session.sessionFile = found.session.sessionFile || null;
  session.sessionName = found.session.sessionName || null;
  session.cwd = found.session.cwd || null;
  session.preview = found.session.preview || null;
  session.model = found.session.model || null;
  session.busy = !!found.session.busy;
  session.updatedAt = found.session.updatedAt || Date.now();
  sessions.set(sessionGuid, session);
  return session;
}

function getOrCreateSession(sessionGuid) {
  return sessions.get(sessionGuid) || createAndStoreSession(sessionGuid);
}

function createAndStoreSession(sessionGuid) {
  const session = createSessionState(sessionGuid);
  sessions.set(sessionGuid, session);
  return session;
}

function createSessionState(sessionGuid) {
  return {
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
    preview: null,
    busy: false,
    history: [],
    streamingText: null,
    activeTools: new Map(),
    runnerStatus: null,
    pendingInputs: [],
    queuedInputs: [],
    updatedAt: Date.now(),
  };
}

function buildEmptySessionSnapshot(sessionGuid) {
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
    queuedInputs: [],
  };
}

function buildSessionSnapshot(sessionGuid) {
  const session = getKnownSession(sessionGuid);
  if (!session) return buildEmptySessionSnapshot(sessionGuid);

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
    queuedInputs: session.queuedInputs,
  };
}

function trimSessionHistory(session) {
  if (!Array.isArray(session.history) || session.history.length <= MAX_SESSION_HISTORY) {
    return;
  }
  session.history.splice(0, session.history.length - MAX_SESSION_HISTORY);
}

function hasConnectedSupervisor(hostId) {
  if (!hostId) return false;
  const host = hosts.get(hostId);
  return !!host?.conn && isOpen(host.conn);
}

function maybeRemoveSession(session) {
  if (!session) return false;
  if (session.owner) return false;
  if (
    (session.interactiveConn && isOpen(session.interactiveConn)) ||
    (session.backgroundConn && isOpen(session.backgroundConn)) ||
    (session.pendingInteractiveConn && isOpen(session.pendingInteractiveConn))
  ) {
    return false;
  }
  if (hasConnectedSupervisor(session.hostId)) return false;

  clearPendingSessionSnapshotLoad(session.sessionGuid);
  sessions.delete(session.sessionGuid);
  sendToAttached(session.sessionGuid, {
    type: "session_snapshot",
    session: buildEmptySessionSnapshot(session.sessionGuid),
  });
  log(`pruned inactive session without supervisor: ${session.sessionGuid}`);
  return true;
}

function pruneInactiveSessionsForHost(hostId) {
  if (!hostId) return;
  for (const session of Array.from(sessions.values())) {
    if (session.hostId !== hostId) continue;
    maybeRemoveSession(session);
  }
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

async function requestSessionSnapshotFromHost(sessionGuid) {
  if (!sessionGuid) return false;
  const session = getKnownSession(sessionGuid);
  if (!session || session.history.length > 0) return false;
  if (pendingSessionSnapshotLoads.has(sessionGuid)) return true;

  const found = findCatalogSession(sessionGuid);
  const hostId = session.hostId || found?.hostId || null;
  const host = hostId ? hosts.get(hostId) : null;
  if (!host?.conn || !isOpen(host.conn)) return false;

  const timeout = setTimeout(() => {
    pendingSessionSnapshotLoads.delete(sessionGuid);
  }, 10000);
  pendingSessionSnapshotLoads.set(sessionGuid, timeout);

  send(host.conn, {
    type: "read_session_snapshot",
    sessionGuid,
    sessionFile: session.sessionFile || found?.session?.sessionFile || null,
  });
  return true;
}

function clearPendingSessionSnapshotLoad(sessionGuid) {
  const timeout = pendingSessionSnapshotLoads.get(sessionGuid);
  if (timeout) clearTimeout(timeout);
  pendingSessionSnapshotLoads.delete(sessionGuid);
}

function mergeLoadedSessionSnapshot(hostId, snapshot) {
  const sessionGuid = snapshot?.sessionGuid;
  if (!sessionGuid) return;
  clearPendingSessionSnapshotLoad(sessionGuid);

  const session = getOrCreateSession(sessionGuid);
  session.hostId = hostId || session.hostId;
  session.sessionFile = snapshot.sessionFile || session.sessionFile;
  session.sessionName = snapshot.sessionName || session.sessionName;
  session.cwd = snapshot.cwd || session.cwd;
  session.model = snapshot.model || session.model;

  const loadedHistory = Array.isArray(snapshot.history) ? snapshot.history : [];
  if (
    session.history.length === 0 ||
    loadedHistory.length > session.history.length
  ) {
    session.history = loadedHistory.slice(-MAX_SESSION_HISTORY);
  }

  session.preview =
    getSessionPreview({ history: session.history }) || session.preview;
  session.updatedAt = Math.max(
    session.updatedAt || 0,
    snapshot.updatedAt || 0,
    Date.now(),
  );

  sendToAttached(sessionGuid, {
    type: "session_snapshot",
    session: buildSessionSnapshot(sessionGuid),
  });
  broadcastOverview();
  notifySessionMeta(sessionGuid);
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

function broadcastWeb(payload) {
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
        queuedInputCount: 0,
      });
    }

    for (const session of sessions.values()) {
      if (session.hostId !== hostId) continue;
      const current = merged.get(session.sessionGuid) || {
        sessionGuid: session.sessionGuid,
      };
      merged.set(session.sessionGuid, {
        ...current,
        sessionGuid: session.sessionGuid,
        sessionFile: session.sessionFile || current.sessionFile || null,
        sessionName: session.sessionName || current.sessionName || null,
        cwd: session.cwd || current.cwd || null,
        preview:
          getSessionPreview(session) ||
          session.preview ||
          current.preview ||
          null,
        updatedAt: session.updatedAt || current.updatedAt || 0,
        owner: session.owner,
        busy: session.busy,
        model: session.model,
        runnerStatus: session.runnerStatus || null,
        queuedInputCount: session.queuedInputs.length,
      });
    }

    const sessionsForHost = Array.from(merged.values()).sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    );
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

function findCatalogSession(sessionGuid) {
  for (const [hostId, catalog] of hostCatalogs) {
    for (const session of catalog.sessions || []) {
      if (session.sessionGuid === sessionGuid) {
        return { hostId, session };
      }
    }
  }
  return null;
}

function getSessionPreview(session) {
  for (const message of session.history) {
    if (message.role === "user" && message.text) return message.text;
  }
  return null;
}

function getOwnerConnection(session) {
  if (!session) return null;
  if (session.owner === "interactive" && isOpen(session.interactiveConn))
    return session.interactiveConn;
  if (session.owner === "background" && isOpen(session.backgroundConn))
    return session.backgroundConn;
  return null;
}

function deliverPendingInputs(session) {
  const target = getOwnerConnection(session);
  if (!target || session.pendingInputs.length === 0) return;
  while (session.pendingInputs.length > 0) {
    const input = session.pendingInputs.shift();
    if (!input?.text) continue;
    send(target, { type: "input", text: input.text, inputId: input.inputId });
  }
}

function ensureBackgroundSession(session, options = {}) {
  const host = hosts.get(options.hostId || session.hostId);
  if (!host?.conn || !isOpen(host.conn)) return false;
  if (session.backgroundConn && isOpen(session.backgroundConn)) return true;
  if (session.runnerStatus === "starting") return true;

  session.runnerStatus = "starting";
  session.updatedAt = Date.now();
  broadcastOverview();

  send(host.conn, {
    type: "start_background_session",
    hostId: host.hostId,
    sessionGuid: session.sessionGuid,
    sessionFile: options.sessionFile || session.sessionFile || null,
    cwd: options.cwd || session.cwd || null,
    requestId: options.requestId || null,
    createNew: false,
  });

  return true;
}

function clearFinishedTools(session) {
  if (!(session.activeTools instanceof Map)) {
    session.activeTools = new Map();
  }
}

function formatSessionLabel(session) {
  return (
    session.sessionName ||
    getSessionPreview(session) ||
    session.preview ||
    session.sessionGuid.slice(0, 8)
  );
}

function send(ws, payload) {
  if (!isOpen(ws)) return false;
  try {
    ws.send(JSON.stringify(payload));
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

function isOpen(ws) {
  return ws?.readyState === WebSocket.OPEN;
}

function addQueuedInput(session, queuedInput) {
  if (!queuedInput?.inputId || !queuedInput.text) return;
  session.queuedInputs.push(queuedInput);
  session.updatedAt = Date.now();
  sendToAttached(session.sessionGuid, {
    type: "session_event",
    sessionGuid: session.sessionGuid,
    event: {
      type: "queued_input_add",
      queuedInput,
    },
  });
  broadcastOverview();
}

function removeQueuedInput(session, inputId = null) {
  if (!Array.isArray(session.queuedInputs) || session.queuedInputs.length === 0) {
    return;
  }

  const index = inputId
    ? session.queuedInputs.findIndex((entry) => entry.inputId === inputId)
    : 0;
  if (index < 0) return;

  const [queuedInput] = session.queuedInputs.splice(index, 1);
  session.updatedAt = Date.now();
  sendToAttached(session.sessionGuid, {
    type: "session_event",
    sessionGuid: session.sessionGuid,
    event: {
      type: "queued_input_remove",
      inputId: queuedInput?.inputId || inputId || null,
    },
  });
  broadcastOverview();
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatRunnerStatus(message) {
  if (message.status === "starting") {
    return `Starting background runner${message.sessionGuid ? ` for ${message.sessionGuid}` : ""}`;
  }
  if (message.status === "already-running") {
    return `Background runner already active for ${message.sessionGuid}`;
  }
  if (message.status === "error") {
    return `Background runner error${message.sessionGuid ? ` for ${message.sessionGuid}` : ""}: ${message.error}`;
  }
  if (message.status === "exited") {
    return `Background runner exited${message.sessionGuid ? ` for ${message.sessionGuid}` : ""}`;
  }
  if (message.status === "released") {
    return `Background runner released${message.sessionGuid ? ` for ${message.sessionGuid}` : ""}`;
  }
  return `Runner status${message.sessionGuid ? ` for ${message.sessionGuid}` : ""}: ${message.status}`;
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
