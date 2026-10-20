import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSupervisorRuntimeConfig, buildRunnerInvocation } from "./supervisor-runtime.js";
import { backgroundWorkerCommand, detectRunnerRuntime, launcherEnvironment } from "./runner-runtime.js";

const workerPath = fileURLToPath(new URL("./background-worker.js", import.meta.url));

/** No scanning or supervisor connection: each launched RPC process gets a small independent stdin keeper. */
export function createBackgroundLauncher({ getConnectUrl, hostId, extensionPath, env = process.env,
  runtime = detectRunnerRuntime({ env }), getDefaultRuntime = () => runtime,
  spawnWorker = spawn, timeoutMs = 10_000 } = {}) {
  const requests = new Map();
  let launching = 0;
  return {
    async start(message) {
      const id = message?.requestId;
      if (typeof id !== "string" || !id || id.length > 256) throw new Error("A bounded launch request ID is required");
      if (requests.has(id)) {
        const known = requests.get(id);
        if (known.cwd !== message.cwd || known.runtime !== message.runtime || message.createNew !== true) throw new Error("Launch request ID was used for different work");
        return known.result;
      }
      if (message.createNew !== true) throw new Error("This runner can create sessions; inactive resume requires a supervisor");
      const childRuntime = message.runtime ?? getDefaultRuntime();
      if (!["pi", "omp"].includes(childRuntime)) throw new Error("Launch runtime must be pi or omp");
      if (launching >= 8) throw new Error("Too many launches in progress");
      const cwd = message.cwd;
      if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.length > 4096 || cwd.includes("\0")) {
        throw new Error("cwd must be an absolute path to an existing directory on this machine");
      }
      const connectUrl = getConnectUrl?.();
      if (!connectUrl) throw new Error("Configure the Toilet-Pi connection before launching");
      if (requests.size >= 256) throw new Error("Launch ledger is full; reload the launcher before starting more sessions");
      launching++;
      // Remember before the first await: duplicate delivery must never launch another process.
      const result = (async () => {
        const directory = await stat(cwd).catch(() => null);
        if (!directory?.isDirectory()) throw new Error("Launch directory does not exist or is not accessible");
        const configEnv = launcherEnvironment(runtime, env);
        const config = resolveSupervisorRuntimeConfig({ env: configEnv });
        const target = config.targets.find(t => t.runtime === childRuntime);
        const invocation = buildRunnerInvocation({ target, extensionPath, createNew: true });
        // Preserve the selected Pi config and session storage, not the launcher's active session identity.
        const childEnv = { ...configEnv, TOILET_PI_SERVER_URL: connectUrl, TOILET_PI_HOST_ID: hostId,
          TOILET_PI_ROLE: "background", TOILET_PI_LAUNCH_REQUEST_ID: id, TOILET_PI_RUNNER_RUNTIME: childRuntime,
          TOILET_PI_PI_AGENT_DIR: config.targets.find(t => t.runtime === "pi").agentDir,
          [childRuntime === "omp" ? "TOILET_PI_OMP_SESSION_DIR" : "TOILET_PI_SESSION_DIR"]: target.sessionDir };
        if (invocation.clearInheritedAgentDir) delete childEnv.PI_CODING_AGENT_DIR;
        else if (invocation.agentDirOverride) childEnv.PI_CODING_AGENT_DIR = invocation.agentDirOverride;
        return new Promise((resolve, reject) => {
          const worker = spawnWorker(backgroundWorkerCommand(), [workerPath], {
            cwd, env: childEnv, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
          });
          let finished = false;
          const finish = (error, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (worker.connected) worker.disconnect();
            worker.unref();
            if (error) reject(error); else resolve(value);
          };
          const timer = setTimeout(() => {
            worker.kill(); // Outcome can be unknown; never automatically replay a launch.
            finish(new Error("Launcher startup timed out; inspect the hub before retrying"));
          }, timeoutMs);
          worker.on("error", () => finish(new Error("Could not start the background launcher")));
          worker.on("exit", () => finish(new Error("Background launcher exited before startup")));
          worker.on("message", reply => {
            if (reply?.status === "started") finish(null, { pid: reply.pid });
            else if (reply?.status === "error") finish(new Error("Could not start the agent; check the selected runtime's installation and configuration on the target machine"));
          });
          // Credentials travel in the child's environment, never command-line arguments or a launch result.
          worker.send({ command: invocation.command, args: invocation.args }, error => {
            if (error) finish(new Error("Could not configure the background launcher"));
          });
        });
      })().finally(() => { launching--; });
      requests.set(id, { cwd, runtime: message.runtime, result });
      return result;
    },
  };
}
