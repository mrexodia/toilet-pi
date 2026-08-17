import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readToiletPiConfig,
  writeToiletPiConfig,
} from "../toilet-pi-config.js";
import {
  buildRunnerInvocation,
  resolveSupervisorRuntimeConfig,
  scanSupervisorSessions,
  selectSupervisorTarget,
  SUPERVISOR_RUNTIMES,
} from "../supervisor-runtime.js";

function sessionRecord(id, timestamp) {
  return `${JSON.stringify({
    type: "session",
    id,
    cwd: `/projects/${id}`,
    timestamp,
  })}\n`;
}

async function writeSession(sessionDir, name, id, timestamp) {
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${name}.jsonl`);
  await writeFile(sessionFile, sessionRecord(id, timestamp));
  return sessionFile;
}

test("resolves independent pi and OMP runtime targets", () => {
  const homeDir = path.join(tmpdir(), "toilet-pi-runtime-home");
  const config = resolveSupervisorRuntimeConfig({
    env: {
      PI_CODING_AGENT_DIR: "~/custom-pi",
      OMP_CODING_AGENT_DIR: "~/custom-omp",
      TOILET_PI_PI_COMMAND: "custom-pi",
      TOILET_PI_OMP_COMMAND: "custom-omp",
      TOILET_PI_DEFAULT_RUNTIME: "omp",
    },
    homeDir,
    platform: "win32",
  });

  assert.equal(config.defaultRuntime, SUPERVISOR_RUNTIMES.OMP);
  assert.deepEqual(config.targets, [
    {
      runtime: SUPERVISOR_RUNTIMES.PI,
      command: "custom-pi",
      agentDir: path.join(homeDir, "custom-pi"),
      agentDirOverride: true,
      sessionDir: path.join(homeDir, "custom-pi", "sessions"),
    },
    {
      runtime: SUPERVISOR_RUNTIMES.OMP,
      command: "custom-omp",
      agentDir: path.join(homeDir, "custom-omp"),
      agentDirOverride: true,
      sessionDir: path.join(homeDir, "custom-omp", "sessions"),
    },
  ]);
});

test("uses OMP's XDG data directory when it is active", () => {
  const homeDir = path.join(tmpdir(), "toilet-pi-xdg-home");
  const xdgDataHome = path.join(homeDir, "xdg-data");
  const xdgOmpRoot = path.join(xdgDataHome, "omp");
  const config = resolveSupervisorRuntimeConfig({
    env: { XDG_DATA_HOME: xdgDataHome },
    homeDir,
    platform: "linux",
    directoryExists: (candidate) => candidate === xdgOmpRoot,
  });

  const ompTarget = config.targets.find(
    (target) => target.runtime === SUPERVISOR_RUNTIMES.OMP,
  );
  assert.equal(ompTarget.sessionDir, path.join(xdgOmpRoot, "sessions"));
});

test("scans both runtimes and keeps the newest duplicate session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "toilet-pi-runtimes-"));
  try {
    const piSessionDir = path.join(root, "pi-sessions");
    const ompSessionDir = path.join(root, "omp-sessions");
    await writeSession(piSessionDir, "pi", "pi-only", 1);
    await writeSession(ompSessionDir, "omp", "omp-only", 2);
    await writeSession(piSessionDir, "shared", "shared", 3);
    const newestSharedFile = await writeSession(
      ompSessionDir,
      "shared",
      "shared",
      4,
    );

    const sessions = await scanSupervisorSessions({
      defaultRuntime: SUPERVISOR_RUNTIMES.PI,
      targets: [
        {
          runtime: SUPERVISOR_RUNTIMES.PI,
          sessionDir: piSessionDir,
        },
        {
          runtime: SUPERVISOR_RUNTIMES.OMP,
          sessionDir: ompSessionDir,
        },
      ],
    });

    assert.deepEqual(
      sessions.map((session) => [session.sessionGuid, session.runtime]),
      [
        ["shared", SUPERVISOR_RUNTIMES.OMP],
        ["omp-only", SUPERVISOR_RUNTIMES.OMP],
        ["pi-only", SUPERVISOR_RUNTIMES.PI],
      ],
    );
    assert.equal(sessions[0].sessionFile, newestSharedFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selects and builds the matching runtime invocation", () => {
  const homeDir = path.join(tmpdir(), "toilet-pi-launch-home");
  const config = resolveSupervisorRuntimeConfig({
    env: {},
    homeDir,
    platform: "win32",
  });
  const ompTarget = config.targets.find(
    (target) => target.runtime === SUPERVISOR_RUNTIMES.OMP,
  );
  const ompSessionFile = path.join(ompTarget.sessionDir, "project", "session.jsonl");
  const selected = selectSupervisorTarget(
    { sessionGuid: "omp-session", sessionFile: ompSessionFile },
    config,
  );
  const invocation = buildRunnerInvocation({
    target: selected,
    extensionPath: "C:/toilet-pi/toilet-pi.ts",
    sessionRef: ompSessionFile,
  });

  assert.equal(selected.runtime, SUPERVISOR_RUNTIMES.OMP);
  assert.equal(invocation.command, "omp");
  assert.deepEqual(invocation.args, [
    "--mode",
    "rpc",
    "-e",
    "C:/toilet-pi/toilet-pi.ts",
    "--session",
    ompSessionFile,
    "--session-dir",
    ompTarget.sessionDir,
  ]);
  assert.equal(invocation.clearInheritedAgentDir, true);
  assert.equal(invocation.agentDirOverride, null);
});

test("uses the configured default runtime for new sessions", () => {
  const config = resolveSupervisorRuntimeConfig({
    env: {
      TOILET_PI_DEFAULT_RUNTIME: "omp",
      OMP_CODING_AGENT_DIR: "C:/omp-agent",
    },
    platform: "win32",
  });
  const selected = selectSupervisorTarget({ createNew: true }, config);
  const invocation = buildRunnerInvocation({
    target: selected,
    extensionPath: "C:/toilet-pi/toilet-pi.ts",
    createNew: true,
  });

  assert.equal(selected.runtime, SUPERVISOR_RUNTIMES.OMP);
  assert.equal(invocation.command, "omp");
  assert.equal(invocation.agentDirOverride, "C:/omp-agent");
  assert.equal(invocation.clearInheritedAgentDir, false);
  assert.equal(invocation.args.includes("--session"), false);
});

test("reads machine configuration from an OMP agent directory", async () => {
  const ompAgentDir = await mkdtemp(path.join(tmpdir(), "toilet-pi-omp-agent-"));
  try {
    const expected = {
      serverUrl: "ws://127.0.0.1:3457/ws",
      token: "omp-token",
    };
    await writeToiletPiConfig(expected, ompAgentDir);
    assert.deepEqual(await readToiletPiConfig(ompAgentDir), expected);
  } finally {
    await rm(ompAgentDir, { recursive: true, force: true });
  }
});
