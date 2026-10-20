// One process per headless Pi/OMP, not a host supervisor. Holding RPC stdin open lets the agent outlive its
// launching session, /reload and SSH terminal. The shared extension owns hub connectivity/shutdown; no scans.
import { spawnRuntimeCommand } from "./runtime-process.js";

let child;
let stopping = false;
const configurationTimeout = setTimeout(() => process.exit(1), 10_000);
function reply(message) {
  if (process.connected) process.send(message, () => {});
}
function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(configurationTimeout);
  if (!child) { process.exitCode = 1; return; }
  child.stdin?.end();
  const force = setTimeout(() => child.kill(), 5000);
  force.unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.once("message", config => {
  clearTimeout(configurationTimeout);
  if (typeof config?.command !== "string" || !Array.isArray(config.args) || !config.args.every(a => typeof a === "string")) {
    reply({ status: "error" }); process.exitCode = 1;
    if (process.connected) process.disconnect();
    return;
  }
  try {
    child = spawnRuntimeCommand(config.command, config.args, { cwd: process.cwd(), env: process.env,
      windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.on("error", () => {});
    child.once("spawn", () => reply({ status: "started", pid: child.pid }));
    child.once("error", () => {
      reply({ status: "error" }); process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
    child.once("exit", code => {
      child.stdin.destroy();
      process.exitCode = code ?? 1;
      if (process.connected) process.disconnect();
    });
  } catch {
    reply({ status: "error" }); process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
});
