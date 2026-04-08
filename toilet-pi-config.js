import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG_DIR_NAME = ".pi";
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const TOILET_PI_CONFIG_FILE = "toilet-pi.json";
const TOILET_PI_SERVER_STATE_FILE = "toilet-pi-server.json";

export function getAgentDir() {
  const envDir = process.env[ENV_AGENT_DIR];
  if (envDir) {
    if (envDir === "~") return homedir();
    if (envDir.startsWith("~/")) return path.join(homedir(), envDir.slice(2));
    return envDir;
  }
  return path.join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function getToiletPiConfigPath() {
  return path.join(getAgentDir(), TOILET_PI_CONFIG_FILE);
}

export function getToiletPiServerStatePath() {
  return path.join(getAgentDir(), TOILET_PI_SERVER_STATE_FILE);
}

export async function readToiletPiConfig() {
  try {
    const raw = await readFile(getToiletPiConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

export async function writeToiletPiConfig(config) {
  const normalized = normalizeConfig(config);
  await mkdir(getAgentDir(), { recursive: true });
  await writeFile(getToiletPiConfigPath(), `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return normalized;
}

export async function readToiletPiServerState() {
  try {
    const raw = await readFile(getToiletPiServerStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token !== "string" || !parsed.token.trim()) return null;
    return { token: parsed.token.trim() };
  } catch {
    return null;
  }
}

export async function ensureToiletPiServerToken() {
  const existing = await readToiletPiServerState();
  if (existing?.token) return existing.token;

  const token = randomBytes(32).toString("base64url");
  await mkdir(getAgentDir(), { recursive: true });
  await writeFile(
    getToiletPiServerStatePath(),
    `${JSON.stringify({ token }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return token;
}

export function parseToiletPiInput(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("Missing Toilet-Pi URL");

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Invalid Toilet-Pi URL");
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const token = hashParams.get("token") || url.searchParams.get("token");
    if (!token) throw new Error("Missing token in Toilet-Pi URL");

    const wsUrl = new URL(url.toString());
    wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/ws";
    wsUrl.search = "";
    wsUrl.hash = "";
    return normalizeConfig({
      serverUrl: wsUrl.toString(),
      token,
    });
  }

  if (url.protocol === "ws:" || url.protocol === "wss:") {
    const token = url.searchParams.get("token");
    if (!token) throw new Error("Missing token in Toilet-Pi URL");

    url.pathname = url.pathname && url.pathname !== "/" ? url.pathname : "/ws";
    url.search = "";
    url.hash = "";
    return normalizeConfig({
      serverUrl: url.toString(),
      token,
    });
  }

  throw new Error("Toilet-Pi URL must start with http://, https://, ws://, or wss://");
}

export function normalizeConfig(config) {
  const serverUrl = String(config?.serverUrl || "").trim();
  const token = String(config?.token || "").trim();
  if (!serverUrl || !token) throw new Error("Invalid Toilet-Pi config");

  const url = new URL(serverUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Toilet-Pi serverUrl must use ws:// or wss://");
  }
  url.pathname = url.pathname && url.pathname !== "/" ? url.pathname : "/ws";
  url.search = "";
  url.hash = "";

  return {
    serverUrl: url.toString(),
    token,
  };
}

export function buildConnectUrl(config) {
  const normalized = normalizeConfig(config);
  const url = new URL(normalized.serverUrl);
  url.searchParams.set("token", normalized.token);
  return url.toString();
}

export function buildAdminUrl(configOrServerUrl, token) {
  const baseUrl =
    typeof configOrServerUrl === "string"
      ? toBrowserBaseUrl(configOrServerUrl)
      : toBrowserBaseUrl(normalizeConfig(configOrServerUrl).serverUrl);
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = new URLSearchParams({ token: token || configOrServerUrl?.token || "" }).toString();
  return url.toString();
}

export function toBrowserBaseUrl(serverUrl) {
  const url = new URL(serverUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.pathname === "/ws") {
    url.pathname = "/";
  } else if (url.pathname.endsWith("/ws")) {
    url.pathname = url.pathname.slice(0, -3) || "/";
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function hasMatchingToken(expectedToken, candidateToken) {
  const expected = Buffer.from(String(expectedToken || ""));
  const candidate = Buffer.from(String(candidateToken || ""));
  if (expected.length === 0 || expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}
