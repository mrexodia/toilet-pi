import { createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_HISTORY_LIMIT = Number.parseInt(
  process.env.TOILET_PI_HISTORY_LIMIT || "200",
  10,
);
const DEFAULT_MESSAGE_LIMIT = Number.parseInt(
  process.env.TOILET_PI_MESSAGE_LIMIT || "4000",
  10,
);

export function getDefaultSessionDir() {
  return (
    process.env.TOILET_PI_SESSION_DIR ||
    path.join(homedir(), ".pi", "agent", "sessions")
  );
}

export async function scanSessions(sessionDir = getDefaultSessionDir()) {
  try {
    await access(sessionDir);
  } catch {
    return [];
  }

  const files = [];
  await collectJsonlFiles(sessionDir, files);

  const sessions = [];
  for (const file of files) {
    const summary = await summarizeSessionFile(file);
    if (summary) sessions.push(summary);
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

export async function findSessionFile(
  sessionGuid,
  sessionDir = getDefaultSessionDir(),
) {
  if (!sessionGuid) return null;
  const sessions = await scanSessions(sessionDir);
  return (
    sessions.find((session) => session.sessionGuid === sessionGuid)
      ?.sessionFile || null
  );
}

export async function readSessionSnapshot(sessionFile, options = {}) {
  const resolvedFile =
    typeof sessionFile === "string" && sessionFile.trim() ? sessionFile : null;
  if (!resolvedFile) return null;

  let header = null;
  let sessionName = null;
  let model = null;
  const history = [];
  const maxMessages = Math.max(
    1,
    Number.parseInt(String(options.maxMessages || DEFAULT_HISTORY_LIMIT), 10) ||
      DEFAULT_HISTORY_LIMIT,
  );

  const stream = createReadStream(resolvedFile, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (!header && entry.type === "session") {
        header = entry;
        continue;
      }

      if (
        entry.type === "session_info" &&
        typeof entry.name === "string" &&
        entry.name.trim()
      ) {
        sessionName = entry.name.trim();
        continue;
      }

      if (
        entry.type === "model_change" &&
        typeof entry.modelId === "string" &&
        entry.modelId.trim()
      ) {
        model = entry.modelId.trim();
        continue;
      }

      if (entry.type === "message") {
        const message = sanitizeMessage(entry.message, entry.timestamp);
        if (message) history.push(message);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!header?.id) return null;

  const info = await stat(resolvedFile);
  return {
    sessionGuid: header.id,
    sessionFile: resolvedFile,
    cwd: header.cwd || null,
    sessionName,
    model,
    history: history.slice(-maxMessages),
    updatedAt: info.mtimeMs,
  };
}

async function collectJsonlFiles(dir, files) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

async function summarizeSessionFile(sessionFile) {
  let header = null;
  let sessionName = null;
  let firstUserText = null;

  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (!header && entry.type === "session") {
        header = entry;
        continue;
      }

      if (
        !firstUserText &&
        entry.type === "message" &&
        entry.message?.role === "user"
      ) {
        firstUserText = extractPreview(entry.message);
      }

      if (
        entry.type === "session_info" &&
        typeof entry.name === "string" &&
        entry.name.trim()
      ) {
        sessionName = entry.name.trim();
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!header?.id) return null;

  const info = await stat(sessionFile);
  return {
    sessionGuid: header.id,
    sessionFile,
    cwd: header.cwd || null,
    sessionName,
    preview: firstUserText,
    updatedAt: info.mtimeMs,
  };
}

function sanitizeMessage(message, fallbackTimestamp) {
  if (!message || typeof message !== "object") return null;

  if (message.role === "user") {
    const text = extractUserText(message.content);
    if (!text) return null;
    return {
      role: "user",
      timestamp: normalizeTimestamp(message.timestamp || fallbackTimestamp),
      text,
    };
  }

  if (message.role === "assistant") {
    const text = extractAssistantText(message.content);
    const thinkingText = extractAssistantThinkingText(message.content);
    if (!text && !thinkingText && message.stopReason === "toolUse") return null;
    return {
      role: "assistant",
      timestamp: normalizeTimestamp(message.timestamp || fallbackTimestamp),
      text: text || `[${message.stopReason || "done"}]`,
      thinkingText: thinkingText || undefined,
      stopReason: message.stopReason,
    };
  }

  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      timestamp: normalizeTimestamp(message.timestamp || fallbackTimestamp),
      toolCallId: message.toolCallId,
      toolName: message.toolName || "tool",
      text: extractToolResultText(message.content),
      isError: !!message.isError,
    };
  }

  return null;
}

function extractPreview(message) {
  if (typeof message.content === "string") {
    return compactText(message.content);
  }

  if (!Array.isArray(message.content)) return null;

  const text = message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "image") return "[image]";
      return "";
    })
    .join(" ");

  return compactText(text);
}

function extractUserText(content) {
  if (typeof content === "string") return normalizeText(content);
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content.map(extractContentPart).filter(Boolean).join(""),
  );
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content
      .filter((part) => part?.type === "text")
      .map((part) => part.text || "")
      .join(""),
  );
}

function extractAssistantThinkingText(content) {
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content
      .filter((part) => part?.type === "thinking")
      .map((part) => part.thinking || "")
      .join("\n\n"),
  );
}

function extractToolResultText(content) {
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content.map(extractContentPart).filter(Boolean).join(""),
  );
}

function extractContentPart(part) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "text") return part.text || "";
  if (part.type === "image") return "\n[image]\n";
  return "";
}

function normalizeText(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) return "";
  return truncateText(normalized);
}

function truncateText(text) {
  return text.length > DEFAULT_MESSAGE_LIMIT
    ? `${text.slice(0, DEFAULT_MESSAGE_LIMIT - 1)}…`
    : text;
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function compactText(text) {
  const trimmed = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return null;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}
