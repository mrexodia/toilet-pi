import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const TOILET_PI_RUNTIMES = Object.freeze({
  PI: "pi",
  OMP: "omp",
});

const ENV_RUNTIME = "TOILET_PI_RUNTIME";
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const ENV_SESSION_DIR = "TOILET_PI_SESSION_DIR";
const ENV_COMMAND = "TOILET_PI_PI_COMMAND";

const RUNTIME_DEFAULTS = Object.freeze({
  [TOILET_PI_RUNTIMES.PI]: {
    configDirName: ".pi",
    command: "pi",
  },
  [TOILET_PI_RUNTIMES.OMP]: {
    configDirName: ".omp",
    command: "omp",
  },
});

export function expandHomeDir(input, homeDir = homedir()) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

export function normalizeRuntime(input) {
  const value = String(input || "").trim().toLowerCase();
  if (value === TOILET_PI_RUNTIMES.PI || value === TOILET_PI_RUNTIMES.OMP) {
    return value;
  }
  return null;
}

export function getRuntimeDefaults(runtime, options = {}) {
  const normalizedRuntime = normalizeRuntime(runtime);
  if (!normalizedRuntime) {
    throw new Error(`Unsupported Toilet-Pi runtime: ${runtime}`);
  }

  const homeDir = options.homeDir || homedir();
  const defaults = RUNTIME_DEFAULTS[normalizedRuntime];
  const agentDir = path.join(homeDir, defaults.configDirName, "agent");
  return {
    runtime: normalizedRuntime,
    agentDir,
    sessionDir: path.join(agentDir, "sessions"),
    command: defaults.command,
  };
}

export function resolveRuntimeFlavor(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || homedir();
  const hostAgentDir = normalizeOptionalPath(options.hostAgentDir);
  const defaultsByRuntime = {
    [TOILET_PI_RUNTIMES.PI]: getRuntimeDefaults(TOILET_PI_RUNTIMES.PI, { homeDir }),
    [TOILET_PI_RUNTIMES.OMP]: getRuntimeDefaults(TOILET_PI_RUNTIMES.OMP, { homeDir }),
  };

  const explicitRuntime = normalizeRuntime(env[ENV_RUNTIME]);
  if (explicitRuntime) return explicitRuntime;

  const explicitHint =
    inferRuntimeFromPath(env[ENV_AGENT_DIR], defaultsByRuntime) ||
    inferRuntimeFromPath(env[ENV_SESSION_DIR], defaultsByRuntime) ||
    inferRuntimeFromCommand(env[ENV_COMMAND]);
  if (explicitHint) return explicitHint;

  const hostRuntime = inferRuntimeFromPath(hostAgentDir, defaultsByRuntime);
  if (hostRuntime) return hostRuntime;

  const dirExists = options.dirExists || defaultDirExists;
  const existingAgentDirs = Object.values(TOILET_PI_RUNTIMES).filter((runtime) =>
    safeBoolean(() => dirExists(defaultsByRuntime[runtime].agentDir)),
  );
  if (existingAgentDirs.length === 1) return existingAgentDirs[0];

  const commandExists = options.commandExists || defaultCommandExists;
  const availableCommands = Object.values(TOILET_PI_RUNTIMES).filter((runtime) =>
    safeBoolean(() => commandExists(defaultsByRuntime[runtime].command)),
  );
  if (availableCommands.length === 1) return availableCommands[0];

  return TOILET_PI_RUNTIMES.PI;
}

export function resolveRuntimeTarget(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || homedir();
  const runtime = resolveRuntimeFlavor({ ...options, env, homeDir });
  const defaults = getRuntimeDefaults(runtime, { homeDir });
  const agentDir =
    expandHomeDir(env[ENV_AGENT_DIR], homeDir) ||
    normalizeOptionalPath(options.hostAgentDir) ||
    defaults.agentDir;
  const sessionDir = expandHomeDir(env[ENV_SESSION_DIR], homeDir) || path.join(agentDir, "sessions");
  const command = String(env[ENV_COMMAND] || "").trim() || defaults.command;

  return {
    runtime,
    agentDir,
    sessionDir,
    command,
  };
}

function normalizeOptionalPath(input) {
  const value = String(input || "").trim();
  return value || null;
}

function normalizeFsPath(input) {
  const value = normalizeOptionalPath(input);
  if (!value) return null;
  return path.normalize(value).replace(/\\+/g, "/").toLowerCase();
}

function inferRuntimeFromPath(input, defaultsByRuntime) {
  const normalizedPath = normalizeFsPath(input);
  if (!normalizedPath) return null;

  for (const runtime of Object.values(TOILET_PI_RUNTIMES)) {
    const defaults = defaultsByRuntime[runtime];
    if (
      normalizedPath === normalizeFsPath(defaults.agentDir) ||
      normalizedPath === normalizeFsPath(defaults.sessionDir)
    ) {
      return runtime;
    }
  }

  if (normalizedPath.endsWith("/.omp/agent") || normalizedPath.endsWith("/.omp/agent/sessions")) {
    return TOILET_PI_RUNTIMES.OMP;
  }
  if (normalizedPath.endsWith("/.pi/agent") || normalizedPath.endsWith("/.pi/agent/sessions")) {
    return TOILET_PI_RUNTIMES.PI;
  }
  return null;
}

function inferRuntimeFromCommand(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  const baseName = path.basename(value).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/i, "");
  if (baseName === TOILET_PI_RUNTIMES.PI) return TOILET_PI_RUNTIMES.PI;
  if (baseName === TOILET_PI_RUNTIMES.OMP) return TOILET_PI_RUNTIMES.OMP;
  return null;
}

function defaultDirExists(dirPath) {
  return existsSync(dirPath);
}

function defaultCommandExists(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

function safeBoolean(check) {
  try {
    return !!check();
  } catch {
    return false;
  }
}
