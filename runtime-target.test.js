import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  TOILET_PI_RUNTIMES,
  expandHomeDir,
  getRuntimeDefaults,
  resolveRuntimeTarget,
} from "./runtime-target.js";

const HOME_DIR = path.join(path.sep, "home", "tester");

test("defaults to pi when runtime is ambiguous", () => {
  const target = resolveRuntimeTarget({
    env: {},
    homeDir: HOME_DIR,
    dirExists: () => true,
    commandExists: () => true,
  });

  assert.deepEqual(target, {
    runtime: TOILET_PI_RUNTIMES.PI,
    agentDir: path.join(HOME_DIR, ".pi", "agent"),
    sessionDir: path.join(HOME_DIR, ".pi", "agent", "sessions"),
    command: "pi",
  });
});

test("selects omp when only omp defaults are available", () => {
  const ompDefaults = getRuntimeDefaults(TOILET_PI_RUNTIMES.OMP, { homeDir: HOME_DIR });
  const target = resolveRuntimeTarget({
    env: {},
    homeDir: HOME_DIR,
    dirExists: (candidate) => candidate === ompDefaults.agentDir,
    commandExists: () => false,
  });

  assert.deepEqual(target, {
    runtime: TOILET_PI_RUNTIMES.OMP,
    agentDir: ompDefaults.agentDir,
    sessionDir: ompDefaults.sessionDir,
    command: "omp",
  });
});

test("respects TOILET_PI_RUNTIME override", () => {
  const target = resolveRuntimeTarget({
    env: { TOILET_PI_RUNTIME: "omp" },
    homeDir: HOME_DIR,
    dirExists: () => false,
    commandExists: () => false,
  });

  assert.equal(target.runtime, TOILET_PI_RUNTIMES.OMP);
  assert.equal(target.command, "omp");
  assert.equal(target.agentDir, path.join(HOME_DIR, ".omp", "agent"));
  assert.equal(target.sessionDir, path.join(HOME_DIR, ".omp", "agent", "sessions"));
});

test("uses explicit env overrides for paths and command", () => {
  const target = resolveRuntimeTarget({
    env: {
      PI_CODING_AGENT_DIR: "~/custom-agent",
      TOILET_PI_SESSION_DIR: "~/custom-sessions",
      TOILET_PI_PI_COMMAND: "/usr/local/bin/omp",
    },
    homeDir: HOME_DIR,
    dirExists: () => false,
    commandExists: () => false,
  });

  assert.deepEqual(target, {
    runtime: TOILET_PI_RUNTIMES.OMP,
    agentDir: path.join(HOME_DIR, "custom-agent"),
    sessionDir: path.join(HOME_DIR, "custom-sessions"),
    command: "/usr/local/bin/omp",
  });
});

test("derives the default session dir from an explicit agent dir", () => {
  const target = resolveRuntimeTarget({
    env: {
      PI_CODING_AGENT_DIR: "~/custom-agent",
    },
    homeDir: HOME_DIR,
    dirExists: () => false,
    commandExists: () => false,
  });

  assert.equal(target.runtime, TOILET_PI_RUNTIMES.PI);
  assert.equal(target.agentDir, path.join(HOME_DIR, "custom-agent"));
  assert.equal(target.sessionDir, path.join(HOME_DIR, "custom-agent", "sessions"));
  assert.equal(target.command, "pi");
});

test("prefers the active host agent dir when provided", () => {
  const target = resolveRuntimeTarget({
    env: {},
    homeDir: HOME_DIR,
    hostAgentDir: path.join(HOME_DIR, ".omp", "agent"),
    dirExists: () => false,
    commandExists: () => false,
  });

  assert.deepEqual(target, {
    runtime: TOILET_PI_RUNTIMES.OMP,
    agentDir: path.join(HOME_DIR, ".omp", "agent"),
    sessionDir: path.join(HOME_DIR, ".omp", "agent", "sessions"),
    command: "omp",
  });
});

test("expands tilde paths", () => {
  assert.equal(expandHomeDir("~", HOME_DIR), HOME_DIR);
  assert.equal(expandHomeDir("~/agent", HOME_DIR), path.join(HOME_DIR, "agent"));
  assert.equal(expandHomeDir("~\\agent", HOME_DIR), path.join(HOME_DIR, "agent"));
});
