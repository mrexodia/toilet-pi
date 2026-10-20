import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBackgroundLauncher } from "../background-launcher.js";
import { backgroundWorkerCommand, detectRunnerRuntime } from "../runner-runtime.js";

function fixture(cwd, behavior = "started", timeoutMs = 100, options = {}) {
  const spawned = [];
  const launcher = createBackgroundLauncher({ hostId: "machine", getConnectUrl: () => "ws://isolated/ws?token=secret",
    extensionPath: "/installed/toilet-pi.ts", env: { TOILET_PI_DEFAULT_RUNTIME: "omp", TOILET_PI_PI_COMMAND: "custom-pi",
      PI_CODING_AGENT_DIR: path.join(cwd, "agent"), ...options.env }, timeoutMs,
    runtime: options.runtime ?? "pi", getDefaultRuntime: options.getDefaultRuntime,
    spawnWorker(command, args, options) {
      const worker = new EventEmitter();
      Object.assign(worker, { connected: true, disconnect() { this.connected = false; }, unref() {}, kill() { this.killed = true; },
        send(config, callback) {
          worker.config = config;
          callback?.();
          if (behavior === "timeout") return;
          setImmediate(() => behavior === "spawn-error" ? worker.emit("error", new Error("secret error")) :
            worker.emit("message", behavior === "error" ? { status: "error" } : { status: "started", pid: 42 }));
        } });
      spawned.push({ command, args, options, worker });
      return worker;
    } });
  return { launcher, spawned };
}

test("launches Pi, not the supervisor default runtime, without putting credentials in arguments", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "toilet-launch-"));
  try {
    const f = fixture(cwd);
    const message = { requestId: "one", createNew: true, cwd };
    const [a, b] = await Promise.all([f.launcher.start(message), f.launcher.start(message)]);
    assert.deepEqual(a, { pid: 42 }); assert.deepEqual(b, a);
    assert.equal(f.spawned.length, 1);
    const { options, worker, args } = f.spawned[0];
    assert.equal(options.detached, true);
    assert.equal(options.cwd, cwd);
    assert.equal(options.env.TOILET_PI_SERVER_URL, "ws://isolated/ws?token=secret");
    assert.equal(options.env.TOILET_PI_HOST_ID, "machine");
    assert.equal(options.env.TOILET_PI_ROLE, "background");
    assert.equal(options.env.TOILET_PI_LAUNCH_REQUEST_ID, "one");
    assert.equal(worker.config.command, "custom-pi");
    assert.deepEqual(worker.config.args.slice(0, 4), ["--mode", "rpc", "-e", "/installed/toilet-pi.ts"]);
    assert.equal(worker.config.args.at(-1), path.join(cwd, "agent", "sessions"));
    assert(!JSON.stringify([args, worker.config]).includes("secret"));
    assert.equal(worker.connected, false);
    await assert.rejects(f.launcher.start({ ...message, cwd: path.dirname(cwd) }), /different work/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("OMP parents launch OMP children with OMP's own agent and session directories", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "toilet-omp-"));
  try {
    const agentDir = path.join(cwd, "omp-agent"), sessions = path.join(cwd, "omp-sessions");
    const f = fixture(cwd, "started", 100, { runtime: "omp", env: { PI_CODING_AGENT_DIR: agentDir,
      TOILET_PI_OMP_COMMAND: "custom-omp", TOILET_PI_OMP_SESSION_DIR: sessions } });
    await f.launcher.start({ requestId: "omp-child", createNew: true, cwd });
    const { worker, options } = f.spawned[0];
    assert.equal(worker.config.command, "custom-omp");
    assert.equal(worker.config.args.at(-1), sessions);
    assert.equal(options.env.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(options.env.OMP_CODING_AGENT_DIR, agentDir);
    assert.equal(options.env.TOILET_PI_RUNNER_RUNTIME, "omp");
    assert.equal(options.env.TOILET_PI_SESSION_DIR, undefined, "OMP storage must not poison Pi's session-dir override");
    assert.notEqual(options.env.TOILET_PI_PI_AGENT_DIR, agentDir);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a configured default and an explicit runtime override preserve separate runtime config", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "toilet-runtime-"));
  try {
    const f = fixture(cwd, "started", 100, { getDefaultRuntime: () => "omp", env: { TOILET_PI_OMP_COMMAND: "my-omp" } });
    await f.launcher.start({ requestId: "default", createNew: true, cwd });
    assert.equal(f.spawned[0].worker.config.command, "my-omp");
    assert.equal(f.spawned[0].options.env.PI_CODING_AGENT_DIR, undefined, "Pi agent-dir override must not be passed to OMP");
    assert.equal(f.spawned[0].options.env.TOILET_PI_PI_AGENT_DIR, path.join(cwd, "agent"));
    await f.launcher.start({ requestId: "explicit", createNew: true, cwd, runtime: "pi" });
    assert.equal(f.spawned[1].worker.config.command, "custom-pi");
    await assert.rejects(f.launcher.start({ requestId: "explicit", createNew: true, cwd, runtime: "omp" }), /different work/);
    await assert.rejects(f.launcher.start({ requestId: "invalid", createNew: true, cwd, runtime: "python" }), /runtime must be/);
    // An OMP child can subsequently launch Pi without using OMP's PI_CODING_AGENT_DIR as Pi's config.
    const g = fixture(cwd, "started", 100, { runtime: "omp", env: { ...f.spawned[0].options.env,
      PI_CODING_AGENT_DIR: path.join(cwd, "omp-agent") } });
    await g.launcher.start({ requestId: "pi-grandchild", createNew: true, cwd, runtime: "pi" });
    assert.equal(g.spawned[0].options.env.PI_CODING_AGENT_DIR, path.join(cwd, "agent"));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("detects the actual runner package or bundled executable, not DEFAULT_RUNTIME or an installed sibling SDK", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "toilet-identify-"));
  try {
    const entry = path.join(cwd, "cli.js");
    for (const [name, expected] of [["@oh-my-pi/pi-coding-agent", "omp"], ["@earendil-works/pi-coding-agent", "pi"], ["@mariozechner/pi-coding-agent", "pi"]]) {
      await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name }));
      assert.equal(detectRunnerRuntime({ argv: ["node", entry], execPath: "node", env: { TOILET_PI_DEFAULT_RUNTIME: "omp", TOILET_PI_RUNNER_RUNTIME: "pi" } }), expected);
    }
    assert.equal(detectRunnerRuntime({ argv: ["omp"], execPath: "omp.exe", env: {} }), "omp");
    assert.equal(detectRunnerRuntime({ argv: ["omp", entry], execPath: "omp.exe", env: {} }), "omp", "bundled executable identity wins over an argument in a sibling package");
    assert.equal(backgroundWorkerCommand({ execPath: "omp.exe", versions: { bun: "1.3.0" } }), "node");
    assert.equal(backgroundWorkerCommand({ execPath: "C:/node/node.exe", versions: { node: "24.0.0" } }), "C:/node/node.exe");
    assert.equal(detectRunnerRuntime({ argv: ["pi"], execPath: "pi", env: { TOILET_PI_RUNNER_RUNTIME: "omp" } }), "pi");
    assert.equal(detectRunnerRuntime({ argv: ["custom"], execPath: "custom", env: { TOILET_PI_RUNNER_RUNTIME: "omp" } }), "omp");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("rejects missing/relative/non-directory paths and resumes without starting a process", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "toilet-launch-"));
  const file = path.join(cwd, "file"); await writeFile(file, "data");
  try {
    const f = fixture(cwd);
    for (const [i, value] of [undefined, "relative", path.join(cwd, "absent"), file, "x\0y"].entries()) {
      await assert.rejects(f.launcher.start({ requestId: String(i), cwd: value, createNew: true }));
    }
    await assert.rejects(f.launcher.start({ requestId: "resume", cwd, createNew: false }), /requires a supervisor/);
    assert.equal(f.spawned.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("startup errors and timeouts are bounded, redacted and never automatically replayed", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "toilet-launch-"));
  try {
    for (const behavior of ["error", "spawn-error", "timeout"]) {
      const f = fixture(cwd, behavior, 20), message = { requestId: "same", createNew: true, cwd };
      for (let i = 0; i < 2; i++) await assert.rejects(f.launcher.start(message), error => !error.message.includes("secret"));
      assert.equal(f.spawned.length, 1);
      if (behavior === "timeout") assert.equal(f.spawned[0].worker.killed, true);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("bounds concurrent startup work without evicting deduplication entries", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "toilet-launch-"));
  try {
    const f = fixture(cwd, "timeout", 50);
    const launches = Array.from({ length: 8 }, (_, i) => f.launcher.start({ requestId: String(i), createNew: true, cwd }).catch(() => {}));
    await assert.rejects(f.launcher.start({ requestId: "nine", createNew: true, cwd }), /Too many launches/);
    await Promise.all(launches);
    assert.equal(f.spawned.length, 8);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a full ledger fails closed instead of evicting potentially executed launches", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "toilet-launch-"));
  try {
    const f = fixture(cwd);
    const absent = path.join(cwd, "absent");
    for (let i = 0; i < 256; i++) await assert.rejects(f.launcher.start({ requestId: String(i), createNew: true, cwd: absent }), /directory/);
    await assert.rejects(f.launcher.start({ requestId: "overflow", createNew: true, cwd }), /ledger is full/);
    await assert.rejects(f.launcher.start({ requestId: "0", createNew: true, cwd: absent }), /directory/);
    assert.equal(f.spawned.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!await check()) { assert(Date.now() < end, "timed out waiting for detached test process"); await new Promise(r => setTimeout(r, 20)); }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("a real detached RPC stdin keeper survives the launching process exiting", { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "toilet-detached-"));
  let childPid, workerPid;
  try {
    const fake = path.join(cwd, "fake.mjs"), parent = path.join(cwd, "parent.mjs");
    await writeFile(fake, `import { writeFileSync } from 'node:fs';
      writeFileSync('ready.json', JSON.stringify({ cwd: process.cwd(), role: process.env.TOILET_PI_ROLE, request: process.env.TOILET_PI_LAUNCH_REQUEST_ID }));
      process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`);
    const moduleUrl = new URL("../background-launcher.js", import.meta.url).href;
    await writeFile(parent, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
      import { createBackgroundLauncher } from ${JSON.stringify(moduleUrl)};
      let workerPid;
      const launcher = createBackgroundLauncher({ hostId: 'test', extensionPath: 'unused',
        getConnectUrl: () => 'ws://isolated/ws?token=test', spawnWorker(...args) {
          const worker = spawn(...args); workerPid = worker.pid;
          const send = worker.send.bind(worker); worker.send = (_config, cb) => send({ command: process.execPath, args: [${JSON.stringify(fake)}] }, cb);
          return worker;
        } });
      const result = await launcher.start({ requestId: 'survive-parent', createNew: true, cwd: process.cwd() });
      writeFileSync('result.json', JSON.stringify({ ...result, workerPid }));`);
    const parentProcess = spawn(process.execPath, [parent], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; parentProcess.stderr.on("data", data => { stderr += data; });
    const code = await new Promise((resolve, reject) => { parentProcess.once("error", reject); parentProcess.once("exit", resolve); });
    assert.equal(code, 0, stderr);
    ({ pid: childPid, workerPid } = JSON.parse(await readFile(path.join(cwd, "result.json"), "utf8")));
    await until(async () => { try { await readFile(path.join(cwd, "ready.json")); return true; } catch { return false; } });
    assert(alive(childPid)); assert(alive(workerPid));
    assert.deepEqual(JSON.parse(await readFile(path.join(cwd, "ready.json"), "utf8")), { cwd, role: "background", request: "survive-parent" });
    process.kill(childPid); await until(() => !alive(workerPid));
  } finally {
    if (childPid && alive(childPid)) process.kill(childPid);
    if (workerPid && alive(workerPid)) process.kill(workerPid);
    await rm(cwd, { recursive: true, force: true });
  }
});
