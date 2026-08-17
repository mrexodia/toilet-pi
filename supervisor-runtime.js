import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { scanSessions } from "./session-scanner.js";

export const SUPERVISOR_RUNTIMES = Object.freeze({
  PI: "pi",
  OMP: "omp",
});

export function resolveSupervisorRuntimeConfig(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || homedir();
  const platform = options.platform || process.platform;
  const directoryExists = options.directoryExists || existsSync;

  const piAgentOverride = expandDirectory(env.PI_CODING_AGENT_DIR, homeDir);
  const ompAgentOverride = expandDirectory(env.OMP_CODING_AGENT_DIR, homeDir);
  const piAgentDir = piAgentOverride || path.join(homeDir, ".pi", "agent");
  const ompAgentDir = ompAgentOverride || path.join(homeDir, ".omp", "agent");

  const piSessionDir =
    expandDirectory(env.TOILET_PI_SESSION_DIR, homeDir) ||
    path.join(piAgentDir, "sessions");
  const ompSessionDir =
    expandDirectory(env.TOILET_PI_OMP_SESSION_DIR, homeDir) ||
    resolveDefaultOmpSessionDir({
      env,
      homeDir,
      platform,
      directoryExists,
      ompAgentDir,
      hasAgentOverride: !!ompAgentOverride,
    });

  return {
    defaultRuntime:
      normalizeRuntime(env.TOILET_PI_DEFAULT_RUNTIME) ||
      SUPERVISOR_RUNTIMES.PI,
    targets: [
      {
        runtime: SUPERVISOR_RUNTIMES.PI,
        command: String(env.TOILET_PI_PI_COMMAND || "pi").trim() || "pi",
        agentDir: piAgentDir,
        agentDirOverride: !!piAgentOverride,
        sessionDir: piSessionDir,
      },
      {
        runtime: SUPERVISOR_RUNTIMES.OMP,
        command: String(env.TOILET_PI_OMP_COMMAND || "omp").trim() || "omp",
        agentDir: ompAgentDir,
        agentDirOverride: !!ompAgentOverride,
        sessionDir: ompSessionDir,
      },
    ],
  };
}

export async function scanSupervisorSessions(runtimeConfig) {
  const results = await Promise.all(
    runtimeConfig.targets.map(async (target) => {
      const sessions = await scanSessions(target.sessionDir);
      return sessions.map((session) => ({ ...session, runtime: target.runtime }));
    }),
  );

  const sessionsByGuid = new Map();
  const defaultRuntime = runtimeConfig.defaultRuntime;
  for (const session of results.flat()) {
    const existing = sessionsByGuid.get(session.sessionGuid);
    if (
      !existing ||
      session.updatedAt > existing.updatedAt ||
      (session.updatedAt === existing.updatedAt &&
        session.runtime === defaultRuntime &&
        existing.runtime !== defaultRuntime)
    ) {
      sessionsByGuid.set(session.sessionGuid, session);
    }
  }

  return Array.from(sessionsByGuid.values()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export function selectSupervisorTarget(
  message,
  runtimeConfig,
  knownSessions = new Map(),
) {
  const explicitRuntime = normalizeRuntime(message?.runtime);
  if (explicitRuntime) {
    const explicitTarget = findTarget(runtimeConfig, explicitRuntime);
    if (explicitTarget) return explicitTarget;
  }

  if (typeof message?.sessionFile === "string" && message.sessionFile.trim()) {
    const fileTarget = runtimeConfig.targets.find((target) =>
      isPathInside(target.sessionDir, message.sessionFile),
    );
    if (fileTarget) return fileTarget;
  }

  if (typeof message?.sessionGuid === "string") {
    const knownRuntime = knownSessions.get(message.sessionGuid)?.runtime;
    const knownTarget = findTarget(runtimeConfig, knownRuntime);
    if (knownTarget) return knownTarget;
  }

  return (
    findTarget(runtimeConfig, runtimeConfig.defaultRuntime) ||
    runtimeConfig.targets[0]
  );
}

export function buildRunnerInvocation({
  target,
  extensionPath,
  sessionRef = null,
  createNew = false,
}) {
  const args = ["--mode", "rpc", "-e", extensionPath];
  if (!createNew && sessionRef) args.push("--session", sessionRef);
  args.push("--session-dir", target.sessionDir);

  return {
    command: target.command,
    args,
    agentDirOverride: target.agentDirOverride ? target.agentDir : null,
    clearInheritedAgentDir:
      target.runtime === SUPERVISOR_RUNTIMES.OMP &&
      !target.agentDirOverride,
  };
}

export function getConfigAgentDirs(runtimeConfig) {
  return [...runtimeConfig.targets]
    .sort((a, b) => {
      if (a.runtime === runtimeConfig.defaultRuntime) return -1;
      if (b.runtime === runtimeConfig.defaultRuntime) return 1;
      return 0;
    })
    .map((target) => target.agentDir)
    .filter((agentDir, index, all) => all.indexOf(agentDir) === index);
}

function resolveDefaultOmpSessionDir({
  env,
  homeDir,
  platform,
  directoryExists,
  ompAgentDir,
  hasAgentOverride,
}) {
  if (!hasAgentOverride && (platform === "linux" || platform === "darwin")) {
    const xdgDataHome = expandDirectory(env.XDG_DATA_HOME, homeDir);
    if (xdgDataHome) {
      const xdgOmpRoot = path.join(xdgDataHome, "omp");
      try {
        if (directoryExists(xdgOmpRoot)) {
          return path.join(xdgOmpRoot, "sessions");
        }
      } catch {
        // Fall back to the conventional OMP agent directory.
      }
    }
  }
  return path.join(ompAgentDir, "sessions");
}

function expandDirectory(input, homeDir = homedir()) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function normalizeRuntime(input) {
  const runtime = String(input || "").trim().toLowerCase();
  return runtime === SUPERVISOR_RUNTIMES.PI ||
    runtime === SUPERVISOR_RUNTIMES.OMP
    ? runtime
    : null;
}

function findTarget(runtimeConfig, runtime) {
  return runtimeConfig.targets.find((target) => target.runtime === runtime);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
