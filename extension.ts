import os from "node:os";
import { WebSocket } from "ws";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  buildConnectUrl,
  parseToiletPiInput,
  readToiletPiConfig,
  toBrowserBaseUrl,
  writeToiletPiConfig,
} from "./toilet-pi-config.js";

const HOST_ID = process.env.TOILET_PI_HOST_ID || os.hostname();
const ROLE =
  process.env.TOILET_PI_ROLE === "background" ? "background" : "interactive";
const REQUIRE_SERVER = ROLE === "background";
const STATUS_KEY = "toilet-pi";
const LAUNCH_REQUEST_ID = process.env.TOILET_PI_LAUNCH_REQUEST_ID || null;
const MAX_SERVER_TEXT_BYTES = 50 * 1024;
const SERVER_TEXT_TRUNCATION_SUFFIX = "\n... (truncated for toilet-pi at 50KB)";

interface ServerMessage {
  type: "input" | "abort" | "abort_and_release" | "terminate_session";
  text?: string;
  inputId?: string;
}

interface WebMessage {
  role: "user" | "assistant";
  timestamp?: number;
  text: string;
  thinkingText?: string;
  stopReason?: string;
  remoteInputId?: string;
}

interface WebToolResultMessage {
  role: "toolResult";
  timestamp?: number;
  toolCallId?: string;
  toolName: string;
  text: string;
  isError: boolean;
  args?: unknown;
  details?: unknown;
  durationMs?: number;
}

interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  startedAt?: number;
  text?: string;
  details?: unknown;
  durationMs?: number;
}

type SanitizedMessage = WebMessage | WebToolResultMessage;

export default function (pi: ExtensionAPI) {
  let ws: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let ctx: ExtensionContext | null = null;
  let currentSessionGuid: string | null = null;
  let lastStreamText: string | null = null;
  let lastThinkingText: string | null = null;
  let reconnectAttempt = 0;
  let shuttingDown = false;
  let releasing = false;
  let pendingAssistantAbortMessage = false;
  let sessionStatePoller: NodeJS.Timeout | null = null;
  let lastReportedSessionName: string | null = null;
  let lastReportedHasPendingMessages = false;
  let connectionConfig: { serverUrl: string; token: string } | null = null;
  let sessionContextTokens: number | null = null;
  let sessionCostUsd: number | null = null;
  const pendingRemoteInputIds: string[] = [];
  const pendingLocalQueuedInputs: Array<{ inputId: string; text: string }> = [];
  const pendingToolCalls = new Map<string, ToolCallInfo>();
  const completedToolCalls = new Map<string, ToolCallInfo>();
  const lastToolUpdateTimes = new Map<string, number>();

  function isOpen() {
    return ws?.readyState === WebSocket.OPEN;
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

  function getConnectUrl() {
    return connectionConfig ? buildConnectUrl(connectionConfig) : null;
  }

  function getMobileUrl() {
    return connectionConfig ? toBrowserBaseUrl(connectionConfig.serverUrl) : null;
  }

  function updateStatus(status: string, connected = false) {
    if (!ctx?.hasUI || ROLE === "background") return;
    const normalized = String(status || "").trim().toLowerCase();
    const isConnecting = normalized.startsWith("connecting");
    const isDisconnected = normalized === "disconnected";
    const isError = normalized.includes("error");

    if (!isConnecting && !isDisconnected && !isError) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const theme = ctx.ui.theme;
    const icon = connected
      ? theme.fg("success", "●")
      : theme.fg(isError ? "error" : "warning", isError ? "●" : "○");
    ctx.ui.setStatus(STATUS_KEY, `${icon} toilet-pi: ${status}`);
  }

  function send(payload: unknown) {
    if (!isOpen()) return;
    try {
      ws?.send(JSON.stringify(payload));
    } catch {
      // Best effort only. Never block pi on server send.
    }
  }

  function getSessionGuid(context: ExtensionContext | null = ctx) {
    return context?.sessionManager.getSessionId() || null;
  }

  function getSessionName(context: ExtensionContext | null = ctx) {
    try {
      const branch = context?.sessionManager.getBranch?.();
      if (Array.isArray(branch)) {
        for (let i = branch.length - 1; i >= 0; i -= 1) {
          const entry = branch[i] as any;
          if (entry?.type !== "session_info") continue;
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          return name || null;
        }
      }
    } catch {
      // Fall through to the session manager getter.
    }
    try {
      return context?.sessionManager.getSessionName() || null;
    } catch {
      return null;
    }
  }

  function buildHistory(context: ExtensionContext) {
    const branch = context.sessionManager.getBranch();
    const history: SanitizedMessage[] = [];
    const toolCalls = new Map<string, ToolCallInfo>();
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      for (const toolCall of extractToolCalls(entry.message?.content)) {
        toolCalls.set(toolCall.toolCallId, toolCall);
      }
      const message = sanitizeMessage(entry.message, toolCalls);
      if (message) history.push(message);
    }
    return history;
  }

  function getSessionUpdatedAt(context: ExtensionContext) {
    try {
      const branch = context.sessionManager.getBranch();
      for (let i = branch.length - 1; i >= 0; i -= 1) {
        const entry = branch[i] as any;
        const timestamp = normalizeTimestamp(entry?.timestamp);
        if (timestamp != null) return timestamp;
        const messageTimestamp = normalizeTimestamp(entry?.message?.timestamp);
        if (messageTimestamp != null) return messageTimestamp;
      }
    } catch {
      // Ignore and fall back to now.
    }
    return Date.now();
  }

  function getContextWindowTokens(model: any = ctx?.model) {
    const candidates = [
      model?.contextWindowTokens,
      model?.contextWindow,
      model?.context_window,
      model?.contextLength,
      model?.context_length,
      model?.maxContextTokens,
      model?.max_context_tokens,
      model?.maxInputTokens,
      model?.max_input_tokens,
      model?.inputTokenLimit,
      model?.input_token_limit,
      model?.tokenLimit,
      model?.token_limit,
      model?.maxTokens,
      model?.max_tokens,
    ];
    for (const value of candidates) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return null;
  }

  function getSessionUsageStats(context: ExtensionContext) {
    let contextTokens: number | null = null;
    let costUsd = 0;
    let sawUsage = false;
    try {
      const branch = context.sessionManager.getBranch();
      for (const entry of branch) {
        if (entry?.type !== "message") continue;
        const message = (entry as any)?.message;
        if (message?.role !== "assistant") continue;
        const usage = message?.usage;
        if (!usage) continue;
        sawUsage = true;
        if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
          contextTokens = usage.totalTokens;
        }
        const cost = usage?.cost?.total;
        if (typeof cost === "number" && Number.isFinite(cost)) {
          costUsd += cost;
        }
      }
    } catch {
      // Ignore.
    }
    return {
      contextTokens,
      costUsd: sawUsage ? costUsd : null,
    };
  }

  function sendHello() {
    if (!ctx) return;
    send({
      type: "hello",
      role: ROLE,
      hostId: HOST_ID,
      hostname: os.hostname(),
      launchRequestId: LAUNCH_REQUEST_ID,
      sessionGuid: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() || null,
      sessionName: getSessionName(ctx),
      cwd: ctx.sessionManager.getCwd(),
      model: ctx.model?.id || null,
      contextWindowTokens: getContextWindowTokens(ctx.model),
      contextTokens: sessionContextTokens,
      costUsd: sessionCostUsd,
      busy: !ctx.isIdle(),
      streamingText: lastStreamText,
      streamingThinkingText: lastThinkingText,
      history: buildHistory(ctx),
      updatedAt: getSessionUpdatedAt(ctx),
    });
  }

  function closeSocket(reason = "reset") {
    if (!ws) return;
    const socket = ws;
    ws = null;
    try {
      socket.removeAllListeners();
      socket.close(1000, reason);
    } catch {
      // Ignore.
    }
  }

  async function connect(force = false) {
    if (!ctx || shuttingDown) return;

    connectionConfig = await loadConnectionConfig();
    const connectUrl = getConnectUrl();
    if (!connectUrl) {
      updateStatus("unconfigured", false);
      if (REQUIRE_SERVER) ctx.shutdown();
      return;
    }

    if (force) closeSocket("reconfigure");
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    updateStatus(
      `connecting ${reconnectAttempt > 0 ? `(${reconnectAttempt + 1})` : ""}`.trim(),
      false,
    );
    ws = new WebSocket(connectUrl);

    ws.on("open", () => {
      reconnectAttempt = 0;
      updateStatus(`${ROLE}`, true);
      sendHello();
      syncSessionName(true);
      syncPendingMessages(true);
    });

    ws.on("message", async (data: Buffer) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      await handleServerMessage(message);
    });

    ws.on("close", async () => {
      ws = null;
      if (shuttingDown) return;
      updateStatus("disconnected", false);
      if (REQUIRE_SERVER) {
        await shutdownBackgroundProcess("server disconnected");
        return;
      }
      scheduleReconnect();
    });

    ws.on("error", () => {
      // The close handler handles reconnect/exit behavior.
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer || shuttingDown) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectAttempt += 1;
      connect();
    }, 3000);
  }

  async function verifyConnectionConfig(config: {
    serverUrl: string;
    token: string;
  }) {
    const connectUrl = buildConnectUrl(config);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(connectUrl);
      let finished = false;
      let helloSent = false;
      let helloAcceptedTimer: NodeJS.Timeout | null = null;
      const timeout = setTimeout(() => {
        finish(new Error("Timed out connecting to toilet-pi server"));
      }, 5000);

      function cleanup() {
        clearTimeout(timeout);
        if (helloAcceptedTimer) clearTimeout(helloAcceptedTimer);
        socket.removeAllListeners();
        try {
          socket.close();
        } catch {
          // Ignore.
        }
      }

      function finish(error?: Error) {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      }

      socket.on("open", () => {
        helloSent = true;
        socket.send(
          JSON.stringify({
            type: "hello",
            role: ROLE,
            hostId: HOST_ID,
            sessionGuid: `verify-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            history: [],
            busy: false,
          }),
        );
        helloAcceptedTimer = setTimeout(() => finish(), 350);
      });
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message?.type === "error") {
          finish(new Error(message.message || "toilet-pi rejected this connect URL"));
        }
      });
      socket.on("unexpected-response", (_request, response) => {
        finish(
          new Error(
            `toilet-pi server rejected the URL (${response.statusCode || "unknown"})`,
          ),
        );
      });
      socket.on("error", (error) => {
        finish(new Error(error.message || "Could not connect to toilet-pi server"));
      });
      socket.on("close", () => {
        if (!finished) {
          finish(
            new Error(
              helloSent
                ? "toilet-pi rejected this machine connect URL"
                : "toilet-pi server closed the connection",
            ),
          );
        }
      });
    });
  }

  async function configureToiletPi(input: string, context: ExtensionContext) {
    const config = parseToiletPiInput(input);
    await verifyConnectionConfig(config);
    connectionConfig = await writeToiletPiConfig(config);
    reconnectAttempt = 0;
    shuttingDown = false;
    await connect(true);
    if (context.hasUI) {
      context.ui.notify(`toilet-pi machine connect URL saved for ${connectionConfig.serverUrl}`, "info");
    }
  }

  async function promptForToiletPiUrl(context: ExtensionContext) {
    if (!context.hasUI) return;
    const input = await context.ui.input(
      "Paste your toilet-pi machine connect URL",
      getConnectUrl() || "wss://host/ws?token=...",
    );
    if (!input?.trim()) return;
    await configureToiletPi(input, context);
  }

  async function handleServerMessage(message: ServerMessage) {
    if (!ctx) return;

    if (message.type === "abort") {
      await Promise.resolve(ctx.abort());
      return;
    }

    if (message.type === "abort_and_release") {
      if (ROLE === "background") {
        await abortAndRelease();
      } else {
        await Promise.resolve(ctx.abort());
      }
      return;
    }

    if (message.type === "terminate_session") {
      await terminateSession();
      return;
    }

    if (message.type === "input" && message.text) {
      await dispatchIncomingInput(message.text, message.inputId || null);
    }
  }

  async function dispatchIncomingInput(text: string, inputId: string | null = null) {
    if (!ctx) return;
    if (inputId) pendingRemoteInputIds.push(inputId);
    try {
      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
      } else {
        pi.sendUserMessage(text, { deliverAs: "steer" });
      }
    } catch {
      if (inputId) {
        const index = pendingRemoteInputIds.indexOf(inputId);
        if (index >= 0) pendingRemoteInputIds.splice(index, 1);
        emitSessionEvent({ type: "remote_input_failed", inputId });
      }
      // Best effort. If the message cannot be injected we silently ignore it.
    }
  }

  async function abortAndRelease() {
    if (!ctx || releasing) return;
    releasing = true;
    try {
      await Promise.resolve(ctx.abort());
      await waitUntilIdle(ctx, 5000);
      send({
        type: "released",
        sessionGuid: getSessionGuid(ctx),
      });
      await sleep(100);
      await shutdownBackgroundProcess("released");
    } finally {
      releasing = false;
    }
  }

  async function terminateSession() {
    if (!ctx || shuttingDown) return;
    shuttingDown = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (sessionStatePoller) {
      clearInterval(sessionStatePoller);
      sessionStatePoller = null;
    }
    try {
      await Promise.resolve(ctx.abort());
    } catch {
      // Ignore.
    }
    await waitUntilIdle(ctx, 5000);
    ctx.shutdown();
  }

  async function shutdownBackgroundProcess(_reason: string) {
    if (!ctx || shuttingDown) return;
    shuttingDown = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      await Promise.resolve(ctx.abort());
    } catch {
      // Ignore.
    }
    try {
      await waitUntilIdle(ctx, 1500);
    } catch {
      // Ignore.
    }
    ctx.shutdown();
  }

  function emitSessionEvent(event: Record<string, unknown>) {
    const sessionGuid = getSessionGuid(ctx);
    if (!sessionGuid) return;
    send({
      type: "session_event",
      sessionGuid,
      event,
    });
  }

  function syncSessionName(force = false) {
    const nextName = getSessionName(ctx);
    if (!force && nextName === lastReportedSessionName) return;
    lastReportedSessionName = nextName;
    emitSessionEvent({
      type: "session_name",
      sessionName: nextName,
    });
  }

  function syncPendingMessages(force = false) {
    if (!ctx) return;
    const nextHasPendingMessages = !!ctx.hasPendingMessages();
    if (!force && nextHasPendingMessages === lastReportedHasPendingMessages) return;
    lastReportedHasPendingMessages = nextHasPendingMessages;

    const hasExplicitLocalQueue = pendingLocalQueuedInputs.length > 0;
    const hasKnownRemoteQueue = pendingRemoteInputIds.length > 0;
    if (nextHasPendingMessages && !hasExplicitLocalQueue && !hasKnownRemoteQueue) {
      emitSessionEvent({
        type: "queued_input_add",
        queuedInput: {
          inputId: "__local_pending__",
          text: "[queued local pi TUI message]",
          timestamp: Date.now(),
        },
      });
      return;
    }
    emitSessionEvent({
      type: "queued_input_remove",
      inputId: "__local_pending__",
    });
  }

  function startSessionStatePolling() {
    if (sessionStatePoller) clearInterval(sessionStatePoller);
    sessionStatePoller = setInterval(() => {
      syncSessionName();
      syncPendingMessages();
    }, 1000);
  }

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    currentSessionGuid = getSessionGuid(context);
    lastStreamText = null;
    lastThinkingText = null;
    pendingAssistantAbortMessage = false;
    pendingRemoteInputIds.length = 0;
    pendingLocalQueuedInputs.length = 0;
    pendingToolCalls.clear();
    completedToolCalls.clear();
    lastToolUpdateTimes.clear();
    shuttingDown = false;
    ({ contextTokens: sessionContextTokens, costUsd: sessionCostUsd } = getSessionUsageStats(context));
    lastReportedSessionName = getSessionName(context);
    lastReportedHasPendingMessages = !!context.hasPendingMessages();
    startSessionStatePolling();
    connectionConfig = await loadConnectionConfig();
    if (connectionConfig) {
      updateStatus("connecting", false);
      await connect();
      return;
    }
    updateStatus("unconfigured", false);
    if (REQUIRE_SERVER) context.shutdown();
  });

  pi.on("input", async (event, context) => {
    if (event.source !== "interactive") return;
    if (context.isIdle()) return;

    const text = String(event.text || "").trim();
    if (!text) return;

    const inputId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pendingLocalQueuedInputs.push({ inputId, text });
    emitSessionEvent({
      type: "queued_input_add",
      queuedInput: {
        inputId,
        text,
        timestamp: Date.now(),
      },
    });
    syncPendingMessages(true);
  });

  pi.on("agent_start", async () => {
    emitSessionEvent({ type: "busy", busy: true });
  });

  pi.on("agent_end", async (event) => {
    if (pendingAssistantAbortMessage) {
      const abortedAssistantMessage = Array.isArray((event as any)?.messages)
        ? [...(event as any).messages]
            .reverse()
            .find((message: any) => message?.role === "assistant" && message?.stopReason === "aborted")
        : null;
      const sanitizedAbortedMessage = sanitizeMessage(
        abortedAssistantMessage,
        pendingToolCalls,
        completedToolCalls,
      );
      if (sanitizedAbortedMessage?.role === "assistant") {
        emitSessionEvent({ type: "assistant_stream_end" });
        emitSessionEvent({
          type: "message",
          message: sanitizedAbortedMessage,
        });
      }
      pendingAssistantAbortMessage = false;
    }

    emitSessionEvent({ type: "busy", busy: false });
    lastStreamText = null;
    lastThinkingText = null;
  });

  pi.on("message_start", async (event) => {
    if (event.message.role === "user") {
      const text = extractUserText(event.message.content);
      const localIndex = text
        ? pendingLocalQueuedInputs.findIndex((entry) => entry.text === text)
        : -1;
      if (localIndex >= 0) {
        const [queuedInput] = pendingLocalQueuedInputs.splice(localIndex, 1);
        emitSessionEvent({
          type: "queued_input_remove",
          inputId: queuedInput?.inputId || null,
        });
        syncPendingMessages(true);
      }
    }

    if (event.message.role === "assistant") {
      pendingAssistantAbortMessage = true;
      lastStreamText = "";
      lastThinkingText = "";
      emitSessionEvent({ type: "assistant_stream_start" });
    }
  });

  let lastUpdateTime = 0;
  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    const now = Date.now();
    if (now - lastUpdateTime < 120) return;
    const nextStreamText = extractAssistantText(event.message.content);
    const nextThinkingText = extractAssistantThinkingText(event.message.content);
    if (nextStreamText === lastStreamText && nextThinkingText === lastThinkingText) return;
    lastUpdateTime = now;
    lastStreamText = nextStreamText;
    lastThinkingText = nextThinkingText;
    emitSessionEvent({
      type: "assistant_stream_update",
      text: lastStreamText || "",
      thinkingText: lastThinkingText || "",
    });
  });

  pi.on("message_end", async (event) => {
    if (event.message.role === "assistant") {
      pendingAssistantAbortMessage = false;
      emitSessionEvent({ type: "assistant_stream_end" });
      const usage = (event.message as any)?.usage;
      if (usage) {
        if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
          sessionContextTokens = usage.totalTokens;
        }
        const cost = usage?.cost?.total;
        if (typeof cost === "number" && Number.isFinite(cost)) {
          sessionCostUsd = (sessionCostUsd ?? 0) + cost;
        }
        emitSessionEvent({
          type: "usage",
          contextTokens: sessionContextTokens,
          costUsd: sessionCostUsd,
        });
      }
    }
    const message = sanitizeMessage(
      event.message,
      pendingToolCalls,
      completedToolCalls,
    );
    if (message) {
      if (message.role === "user" && pendingRemoteInputIds.length > 0) {
        message.remoteInputId = pendingRemoteInputIds.shift();
      }
      emitSessionEvent({ type: "message", message });
      if (message.role === "toolResult" && message.toolCallId) {
        pendingToolCalls.delete(message.toolCallId);
        completedToolCalls.delete(message.toolCallId);
      }
    }
    if (event.message.role === "assistant") {
      lastStreamText = null;
      lastThinkingText = null;
    }
    if (getSessionGuid() !== currentSessionGuid) {
      currentSessionGuid = getSessionGuid();
      sendHello();
    }
    syncSessionName();
  });

  pi.on("tool_execution_start", async (event) => {
    const toolCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: sanitizeStructuredData(event.args),
      startedAt: Date.now(),
    };
    pendingToolCalls.set(event.toolCallId, toolCall);
    emitSessionEvent({
      type: "tool_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: toolCall.args,
    });
  });

  pi.on("tool_execution_update", async (event) => {
    const previous = pendingToolCalls.get(event.toolCallId);
    const partial = sanitizePartialToolResult(event.partialResult);
    const nextToolCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: previous?.args ?? sanitizeStructuredData((event as any).args),
      startedAt: previous?.startedAt,
      text: partial.text || previous?.text,
      details: partial.details ?? previous?.details,
      durationMs: previous?.durationMs,
    };
    pendingToolCalls.set(event.toolCallId, nextToolCall);
    const now = Date.now();
    const lastUpdate = lastToolUpdateTimes.get(event.toolCallId) || 0;
    if (now - lastUpdate < 120) return;
    if (
      nextToolCall.text === previous?.text &&
      JSON.stringify(nextToolCall.details ?? null) === JSON.stringify(previous?.details ?? null)
    ) {
      return;
    }
    lastToolUpdateTimes.set(event.toolCallId, now);
    emitSessionEvent({
      type: "tool_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: nextToolCall.args,
      text: nextToolCall.text,
      details: nextToolCall.details,
    });
  });

  pi.on("tool_execution_end", async (event) => {
    const started = pendingToolCalls.get(event.toolCallId);
    lastToolUpdateTimes.delete(event.toolCallId);
    completedToolCalls.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: started?.args ?? sanitizeStructuredData((event as any).args),
      startedAt: started?.startedAt,
      text: extractToolResultText((event.result as any)?.content) || started?.text,
      details: sanitizeStructuredData((event.result as any)?.details) ?? started?.details,
      durationMs: started?.startedAt ? Date.now() - started.startedAt : undefined,
    });
    emitSessionEvent({
      type: "tool_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
    });
  });

  pi.on("model_select", async (event) => {
    emitSessionEvent({
      type: "model",
      modelId: event.model.id,
      contextWindowTokens: getContextWindowTokens(event.model),
    });
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    releasing = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (sessionStatePoller) {
      clearInterval(sessionStatePoller);
      sessionStatePoller = null;
    }
    closeSocket("session shutdown");
    if (ctx?.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    currentSessionGuid = null;
    lastStreamText = null;
    lastThinkingText = null;
    pendingAssistantAbortMessage = false;
    pendingRemoteInputIds.length = 0;
    pendingLocalQueuedInputs.length = 0;
    pendingToolCalls.clear();
    completedToolCalls.clear();
    lastToolUpdateTimes.clear();
    sessionContextTokens = null;
    sessionCostUsd = null;
    lastReportedSessionName = null;
    lastReportedHasPendingMessages = false;
    ctx = null;
  });

  pi.registerCommand("toilet-pi", {
    description: "Configure toilet-pi for this machine",
    handler: async (args, context) => {
      try {
        if (args.trim()) {
          await configureToiletPi(args.trim(), context);
          return;
        }
        await promptForToiletPiUrl(context);
      } catch (error) {
        if (!context.hasUI) return;
        context.ui.notify(
          error instanceof Error ? error.message : "Failed to configure toilet-pi",
          "error",
        );
      }
    },
  });

  pi.registerCommand("ws", {
    description: "Show toilet-pi connection status",
    handler: async (_args, context) => {
      if (!context.hasUI) return;
      const status = connectionConfig
        ? isOpen()
          ? "connected"
          : ws?.readyState === WebSocket.CONNECTING
            ? "connecting"
            : "disconnected"
        : "unconfigured";
      const mobileUrl = getMobileUrl();
      context.ui.notify(
        connectionConfig
          ? `toilet-pi ${ROLE}: ${status} (${connectionConfig.serverUrl})${mobileUrl ? ` · mobile: ${mobileUrl}` : ""}`
          : "toilet-pi is not configured yet. Run /toilet-pi.",
        "info",
      );
    },
  });
}

function sanitizeMessage(
  message: any,
  toolCalls: Map<string, ToolCallInfo> = new Map(),
  completedToolCalls: Map<string, ToolCallInfo> = new Map(),
): SanitizedMessage | null {
  if (!message || typeof message !== "object") return null;

  if (message.role === "user") {
    const text = extractUserText(message.content);
    if (!text) return null;
    return {
      role: "user",
      timestamp: message.timestamp,
      text,
    };
  }

  if (message.role === "assistant") {
    const text = extractAssistantText(message.content);
    const thinkingText = extractAssistantThinkingText(message.content);
    if (!text && !thinkingText && message.stopReason === "toolUse") return null;
    return {
      role: "assistant",
      timestamp: message.timestamp,
      text: text || (message.stopReason === "toolUse" ? "" : `[${message.stopReason || "done"}]`),
      thinkingText: thinkingText || undefined,
      stopReason: message.stopReason,
    };
  }

  if (message.role === "bashExecution") {
    const output = normalizeText(String(message.output || ""));
    const details = sanitizeStructuredData({
      exitCode: message.exitCode,
      cancelled: !!message.cancelled,
      truncated: !!message.truncated,
      fullOutputPath: message.fullOutputPath,
      excludeFromContext: !!message.excludeFromContext,
    });
    return {
      role: "toolResult",
      timestamp: message.timestamp,
      toolName: "bash",
      text: output,
      isError: !!message.cancelled || (typeof message.exitCode === "number" && message.exitCode !== 0),
      args: sanitizeStructuredData({
        command: String(message.command || ""),
        excludeFromContext: !!message.excludeFromContext,
      }),
      details,
    };
  }

  if (message.role === "toolResult") {
    const toolCall = message.toolCallId
      ? toolCalls.get(message.toolCallId) || completedToolCalls.get(message.toolCallId)
      : null;
    return {
      role: "toolResult",
      timestamp: message.timestamp,
      toolCallId: message.toolCallId,
      toolName: message.toolName || toolCall?.toolName || "tool",
      text: extractToolResultText(message.content) || toolCall?.text || "",
      isError: !!message.isError,
      args: toolCall?.args,
      details: sanitizeStructuredData(message.details) ?? toolCall?.details,
      durationMs: toolCall?.durationMs,
    };
  }

  return null;
}

function extractUserText(content: any) {
  if (typeof content === "string") return normalizeText(content);
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content.map(extractContentPart).filter(Boolean).join(""),
  );
}

function extractAssistantText(content: any) {
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text || "")
      .join(""),
  );
}

function extractAssistantThinkingText(content: any) {
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content
      .filter((part: any) => part?.type === "thinking")
      .map((part: any) => part.thinking || "")
      .join("\n\n"),
  );
}

function extractToolCalls(content: any): ToolCallInfo[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part: any) => part?.type === "toolCall" && part?.id && part?.name)
    .map((part: any) => ({
      toolCallId: String(part.id),
      toolName: String(part.name),
      args: sanitizeStructuredData(parseToolArguments(part.arguments)),
    }));
}

function extractToolResultText(content: any) {
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content.map(extractContentPart).filter(Boolean).join(""),
  );
}

function sanitizePartialToolResult(partialResult: any) {
  if (!partialResult || typeof partialResult !== "object") {
    return { text: "", details: undefined };
  }
  return {
    text: extractToolResultText((partialResult as any).content),
    details: sanitizeStructuredData((partialResult as any).details),
  };
}

function extractContentPart(part: any) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "text") return part.text || "";
  if (part.type === "image") return "\n[image]\n";
  return "";
}

function normalizeText(text: string) {
  return truncateTextForServer(
    String(text || "")
      .replace(/\r\n/g, "\n")
      .trim(),
  );
}

function parseToolArguments(argumentsValue: any) {
  if (typeof argumentsValue !== "string") return argumentsValue;
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return argumentsValue;
  }
}

function normalizeTimestamp(value: any) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function sanitizeStructuredData(value: any, depth = 0): any {
  if (value == null) return value;
  if (typeof value === "string") {
    return truncateTextForServer(value.replace(/\r\n/g, "\n"));
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 5) return "[truncated nested data]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeStructuredData(entry, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 50)) {
      result[key] = sanitizeStructuredData(entry, depth + 1);
    }
    return result;
  }
  return String(value);
}

async function waitUntilIdle(ctx: ExtensionContext, timeoutMs: number) {
  const start = Date.now();
  while (!ctx.isIdle()) {
    if (Date.now() - start > timeoutMs) return;
    await sleep(50);
  }
}

function truncateTextForServer(
  value: string,
  maxBytes = MAX_SERVER_TEXT_BYTES,
  suffix = SERVER_TEXT_TRUNCATION_SUFFIX,
) {
  const text = String(value || "");
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const safeSuffix = Buffer.byteLength(suffix, "utf8") >= maxBytes
    ? ""
    : suffix;
  const suffixBytes = Buffer.byteLength(safeSuffix, "utf8");
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (Buffer.byteLength(candidate, "utf8") + suffixBytes <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low)}${safeSuffix}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
