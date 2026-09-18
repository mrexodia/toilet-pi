import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat, chmod, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createAuthStore, resolveCredentials, promptLogin } from "../cli/auth.js";
import { authenticateAdmin, ToiletPiClient } from "../cli/client.js";
import { runCli } from "../cli/main.js";

const record = { serverUrl: "https://isolated.example/", cookie: "toilet-pi-admin=test.session.cookie", expiresAt: Date.now() + 3600000 };
async function temporary(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "toilet-cli-auth-"));
  try { await fn(createAuthStore(path.join(dir, "agent", "toilet-pi-auth.json")), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("auth storage is atomic, private, projected, and removable without contacting a server", async () => temporary(async (store, dir) => {
  assert.equal(await store.read(), null);
  await store.write({ ...record, token: "do-not-store-admin-secret" });
  const raw = await readFile(store.path, "utf8");
  assert(!raw.includes("do-not-store-admin-secret"));
  assert.deepEqual(await store.read(), { version: 1, ...record });
  if (process.platform !== "win32") assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.join(dir, "agent")), ["toilet-pi-auth.json"]);
  await store.write({ ...record, cookie: "toilet-pi-admin=replacement" });
  assert.equal((await store.read()).cookie, "toilet-pi-admin=replacement");
  await assert.rejects(store.clear("https://other.example"), /different server/);
  assert.equal(await store.clear(), true);
  assert.equal(await store.clear(), false);
}));

test("malformed, symlinked and permissive auth files fail closed without leaking their contents", async () => temporary(async (store, dir) => {
  await store.write(record);
  await writeFile(store.path, '{"token":"private-value",broken');
  await assert.rejects(store.read(), error => !error.message.includes("private-value") && /Cannot read/.test(error.message));
  await store.write(record); // login repairs malformed data without reading it
  if (process.platform !== "win32") {
    await chmod(store.path, 0o644);
    await assert.rejects(store.read(), /owner-only/);
    await store.clear();
    const target = path.join(dir, "target");
    await writeFile(target, "unchanged");
    await symlink(target, store.path);
    await assert.rejects(store.read(), /symlink/);
    await assert.rejects(store.write(record), /Could not save/);
    assert.equal(await readFile(target, "utf8"), "unchanged");
  }
}));

test("credential resolution binds saved cookies to the full server base URL and respects explicit overrides", async () => {
  let reads = 0;
  const store = { read: async () => { reads++; return record; } };
  assert.deepEqual(await resolveCredentials({}, store), { serverUrl: record.serverUrl, sessionCookie: record.cookie });
  await assert.rejects(resolveCredentials({ serverUrl: "https://other.example" }, store), /different server/);
  await assert.rejects(resolveCredentials({ serverUrl: "https://isolated.example/other" }, store), /different server/);
  await assert.rejects(resolveCredentials({}, { read: async () => ({ ...record, expiresAt: 1 }) }), /expired/);
  await assert.rejects(resolveCredentials({}, { read: async () => null }), /Not logged in/);
  const before = reads;
  assert.deepEqual(await resolveCredentials({ serverUrl: "https://override.example", orchestratorToken: "scoped" }, store), {
    serverUrl: "https://override.example", orchestratorToken: "scoped", token: undefined,
  });
  assert.equal(reads, before);
  assert.throws(() => new ToiletPiClient({ serverUrl: record.serverUrl, sessionCookie: record.cookie, token: "admin" }), /exactly one/);
  assert.throws(() => new ToiletPiClient({ serverUrl: record.serverUrl, sessionCookie: "toilet-pi-admin=x; injected=y" }), /Invalid saved/);
});

test("login uses hidden prompting, saves only after authentication, and logout is local", async () => temporary(async store => {
  let stdout = "", stderr = "", calls = 0;
  const options = { env: {}, authStore: store, out: s => { stdout += s; }, err: s => { stderr += s; },
    prompt: async (label, settings) => { assert.equal(settings.secret, true); return "entered-secret"; },
    authenticate: async args => { calls++; assert.equal(args.token, "entered-secret"); return record; },
    createClient: () => { throw new Error("Login/logout must not connect a WebSocket"); },
  };
  assert.equal(await runCli(["login", "--server", record.serverUrl], options), 0);
  assert.equal(calls, 1);
  assert(!stdout.includes("entered-secret")); assert(!stdout.includes(record.cookie));
  const before = await readFile(store.path, "utf8");
  options.authenticate = async () => { throw new Error("Rejected entered-secret"); };
  assert.equal(await runCli(["login", record.serverUrl], options), 1);
  assert.equal(await readFile(store.path, "utf8"), before);
  assert(!stderr.includes("entered-secret"));
  assert.equal(await runCli(["logout"], options), 0);
  assert.equal(await store.read(), null);
  assert.equal(calls, 1);
}));

test("ordinary commands use saved login, redact cookie values, and help touches no auth file", async () => {
  let connected = 0, stderr = "", reads = 0;
  const options = { env: {}, authStore: { read: async () => { reads++; return record; } }, out() {}, err: s => { stderr += s; },
    createClient: args => { assert.equal(args.sessionCookie, record.cookie); return {
      connect: async () => { connected++; throw new Error("reflected test.session.cookie"); }, close() {},
    }; },
  };
  assert.equal(await runCli(["--help"], options), 0); assert.equal(reads, 0);
  assert.equal(await runCli(["hosts"], options), 1); assert.equal(connected, 1);
  assert(!stderr.includes("test.session.cookie"));
  assert.equal(await runCli(["hosts", "--server", "https://other.example"], options), 1);
  assert.equal(connected, 1);
});

test("hidden token entry never echoes input and restores terminal state on success/cancel", async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    let output = "";
    const outputStream = { isTTY: true, write: s => { output += s; } };
    const promise = promptLogin("Token: ", { secret: true, input, output: outputStream });
    input.write(cancel ? "private\u0003" : "privatx\u007fe\r");
    if (cancel) await assert.rejects(promise, /cancelled/);
    else assert.equal(await promise, "private");
    assert.equal(output, "Token: \n");
    assert.equal(input.isRaw, false); assert.equal(input.isPaused(), true);
    assert.equal(input.listenerCount("data"), 0); input.destroy();
  }
  await assert.rejects(promptLogin("Token: ", { secret: true, input: { isTTY: false }, output: { isTTY: false } }), /interactive/);
});

test("HTTP login rejects redirect and missing/expired cookie; extracts only the named cookie and expiry", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url.href, "https://isolated.example/auth/login");
      assert.equal(options.redirect, "error");
      assert.equal(JSON.parse(options.body).token, "private");
      return new Response("ok", { headers: { "Set-Cookie": "toilet-pi-admin=signed-cookie; Max-Age=60; HttpOnly; Path=/" } });
    };
    const login = await authenticateAdmin({ serverUrl: record.serverUrl, token: "private" });
    assert.equal(login.cookie, "toilet-pi-admin=signed-cookie");
    assert(login.expiresAt > Date.now());
    for (const response of [new Response("private", { status: 302 }), new Response("private"),
      new Response("private", { headers: { "Set-Cookie": "toilet-pi-admin=x; Max-Age=0" } })]) {
      globalThis.fetch = async () => response;
      await assert.rejects(authenticateAdmin({ serverUrl: record.serverUrl, token: "private" }), e => !e.message.includes("private"));
    }
  } finally { globalThis.fetch = previous; }
});
