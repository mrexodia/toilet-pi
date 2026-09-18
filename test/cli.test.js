import assert from "node:assert/strict";
import test from "node:test";
import { compact, resolveSession, runCli } from "../cli/main.js";
import { parseServerUrl } from "../cli/client.js";

const configuration = { provider: "test", modelId: "model", thinkingLevel: "high" };
function fixture() {
  const requests = [];
  let stdout = "", stderr = "", closed = false, connected = 0;
  const client = {
    overview: { hosts: [{ hostId: "host-123", hostname: "desktop", connected: true, sessions: [
      { sessionGuid: "session-abc", sessionName: "Fix tests", cwd: "/work", busy: false, owner: "interactive" },
    ] }] },
    async connect() { connected++; },
    async request(...args) { requests.push(args); return { configuration, models: [
      { provider: "test", id: "model", name: "Test model", thinkingLevels: ["off", "high"] },
    ] }; },
    async snapshot() { return { ...client.overview.hosts[0].sessions[0], configuration, queuedInputs: [] }; },
    close() { closed = true; },
  };
  return { client, requests, get closed() { return closed; }, get connected() { return connected; },
    get stdout() { return stdout; }, get stderr() { return stderr; },
    run: args => runCli(args, { env: {}, authStore: { read: async () => ({ serverUrl: "https://isolated.test/", cookie: "toilet-pi-admin=fake-session" }) }, createClient: () => client, out: text => { stdout += text; }, err: text => { stderr += text; } }),
  };
}

test("help and invalid arguments never create a connection", async () => {
  for (const args of [["--help"], ["nonsense"], ["thinking", "s", "invalid"], ["model", "s", "bad"], ["hosts", "--thinking", "high"], ["status", ""], ["hosts", "--timeout", "0"]]) {
    const f = fixture();
    assert.equal(await f.run(args), args[0] === "--help" ? 0 : 2);
    assert.equal(f.connected, 0);
  }
});

test("models includes levels and current selection in one session request", async () => {
  const f = fixture();
  assert.equal(await f.run(["models", "session-a"]), 0);
  assert.deepEqual(f.requests, [["session-abc", "get_models"]]);
  assert.equal(f.stdout, "test/model  off high\nCurrent: test/model thinking=high\n");
  assert.equal(f.stderr, "");
  assert.equal(f.closed, true);
});

test("model and thinking are sent as one configure operation, preserving model slashes", async () => {
  const f = fixture();
  assert.equal(await f.run(["model", "session-a", "test/vendor/model", "--thinking", "high"]), 0);
  assert.deepEqual(f.requests, [["session-abc", "configure", { provider: "test", modelId: "vendor/model", thinkingLevel: "high" }]]);
  assert.match(f.stdout, /^Configured session-abc:/);
});

test("host and session listing plus mirrored status use compact text", async () => {
  const f = fixture();
  assert.equal(await f.run(["hosts"]), 0);
  assert.equal(await f.run(["sessions", "--host", "desktop"]), 0);
  assert.equal(await f.run(["status", "session-a"]), 0);
  assert.match(f.stdout, /host-123  desktop  connected/);
  assert.match(f.stdout, /session-abc  desktop  idle  Fix tests/);
  assert.match(f.stdout, /Source: mirrored status/);
});

test("ambiguous and unknown targets are never guessed", async () => {
  const f = fixture();
  f.client.overview.hosts[0].sessions.push({ sessionGuid: "session-abd" });
  assert.throws(() => resolveSession(f.client.overview.hosts, "session-a"), /Ambiguous/);
  assert.equal(resolveSession(f.client.overview.hosts, "session-abc").sessionGuid, "session-abc");
  assert.equal(await f.run(["model", "missing", "test/model"]), 1);
  assert.equal(f.requests.length, 0);
});

test("remote URLs require TLS and never accept embedded tokens", () => {
  for (const url of ["http://remote.test", "https://user:password@remote.test", "https://remote.test/#token=secret", "wss://remote.test/ws"]) {
    assert.throws(() => parseServerUrl(url));
  }
  assert.equal(parseServerUrl("https://remote.test").href, "https://remote.test/");
  assert.equal(parseServerUrl("http://127.0.0.1:1234").origin, "http://127.0.0.1:1234");
  assert.throws(() => parseServerUrl(), /Specify --server/);
});

test("terminal controls and newlines cannot forge compact CLI rows", () => {
  assert.equal(compact("hello\x1b[31m\nworld\x00\x1b[0m"), "hello world");
});

test("credentials are redacted from errors and mutation failures are not retried", async () => {
  const f = fixture();
  let calls = 0, stderr = "";
  f.client.request = async () => { calls++; throw new Error("secret\nfailed"); };
  const code = await runCli(["model", "session-abc", "test/model"], {
    env: { TOILET_PI_ADMIN_TOKEN: "secret" }, createClient: () => f.client,
    out: () => {}, err: text => { stderr += text; },
  });
  assert.equal(code, 1);
  assert.equal(calls, 1);
  assert.equal(stderr, "error: [REDACTED] failed\n");
  assert.equal(f.closed, true);
});
