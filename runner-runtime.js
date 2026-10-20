import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const packages = new Map([
  ["@earendil-works/pi-coding-agent", "pi"],
  ["@mariozechner/pi-coding-agent", "pi"],
  ["@oh-my-pi/pi-coding-agent", "omp"],
]);

/** Identify the actual executable, not an installed sibling SDK or the supervisor's default runtime. */
export function detectRunnerRuntime({ argv = process.argv, execPath = process.execPath, env = process.env } = {}) {
  const executable = path.basename(execPath).toLowerCase().replace(/\.exe$/, "");
  if (executable === "pi" || executable === "omp") return executable;
  for (const entry of [argv[1], execPath]) {
    if (!entry) continue;
    let resolved = entry;
    try { resolved = realpathSync(entry); } catch { /* Bundled executable or a test invocation. */ }
    let directory = path.dirname(resolved);
    for (;;) {
      try {
        const runtime = packages.get(JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).name);
        if (runtime) return runtime;
      } catch { /* Not a known package root. */ }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const name = path.basename(resolved).toLowerCase().replace(/\.(exe|cmd|js|mjs|cjs|ts)$/, "");
    if (name === "pi" || name === "omp") return name;
  }
  // Children launched through custom wrappers carry an explicit identity. Never use DEFAULT_RUNTIME here:
  // that is a supervisor policy, not evidence of which runtime loaded this extension.
  return env.TOILET_PI_RUNNER_RUNTIME === "omp" ? "omp" : "pi";
}

/** A bundled Bun/OMP executable cannot be used as `node background-worker.js`. Node is a package requirement. */
export function backgroundWorkerCommand({ execPath = process.execPath, versions = process.versions } = {}) {
  return versions.bun ? "node" : execPath;
}

/** OMP also calls its agent-dir variable PI_CODING_AGENT_DIR; keep the two runtimes' configs separate. */
export function launcherEnvironment(runtime, env) {
  if (runtime !== "omp") return { ...env };
  const result = { ...env };
  if (!result.OMP_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR) result.OMP_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
  delete result.PI_CODING_AGENT_DIR;
  if (env.TOILET_PI_PI_AGENT_DIR) result.PI_CODING_AGENT_DIR = env.TOILET_PI_PI_AGENT_DIR;
  return result;
}
