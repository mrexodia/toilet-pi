import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { createRunnerSocketFactory } from "../runner-socket.js";

const dnsError = (code) => Object.assign(new Error(`getaddrinfo ${code}`), { code });

async function fixture(t) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let now = 0;
  let error = null;
  let lookups = 0;
  const logs = [];
  const clients = new Set();
  const lookup = (_host, options, callback) => {
    lookups++;
    queueMicrotask(() => callback(error, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", options.all ? undefined : 4));
  };
  const factory = createRunnerSocketFactory({ log: (text) => logs.push(text), lookup, now: () => now });
  const connect = (host = "hub.invalid") => {
    const ws = factory(`ws://${host}:${server.address().port}/ws?token=secret`);
    ws.on("error", () => {});
    clients.add(ws);
    return ws;
  };
  t.after(async () => {
    for (const ws of clients) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { connect, logs, server, setTime: (value) => { now = value; }, setError: (value) => { error = value; }, lookups: () => lookups };
}

async function fails(ws, code) {
  const closed = new Promise((resolve) => ws.once("close", () => resolve()));
  const [error] = await once(ws, "error");
  assert.equal(error.code, code);
  await closed;
}

test("temporary DNS failure reuses a live peer, preserves the Host header, and still tries DNS first", async (t) => {
  const f = await fixture(t);
  const first = f.connect();
  await once(first, "open");
  // A long-lived connection can refresh its peer via pong, rather than expiring after its initial lookup.
  f.setTime(12 * 60 * 60_000);
  const pong = once(first, "pong");
  first.ping();
  await pong;
  first.terminate();
  await once(first, "close");
  f.setError(dnsError("EAI_AGAIN"));
  const accepted = once(f.server, "connection");
  const second = f.connect();
  await once(second, "open");
  const [, request] = await accepted;
  assert.match(request.headers.host, /^hub\.invalid:/);
  assert.equal(f.lookups(), 2);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /temporary DNS failure.*recently connected address/);
  assert.ok(f.logs.every((line) => !line.includes("secret")));
  f.setError(null);
  await once(f.connect(), "open");
  assert.equal(f.lookups(), 3);
  assert.equal(f.logs.length, 1, "successful DNS must bypass fallback");
});

test("no address is invented on a cold-start DNS failure", async (t) => {
  const f = await fixture(t);
  f.setError(dnsError("EAI_AGAIN"));
  await fails(f.connect(), "EAI_AGAIN");
  assert.deepEqual(f.logs, []);
});

test("fallback expires five minutes after the last live connection and failures do not renew it", async (t) => {
  const f = await fixture(t);
  const first = f.connect();
  await once(first, "open");
  first.terminate();
  await once(first, "close");
  f.setTime(5 * 60_000);
  f.setError(dnsError("EAI_AGAIN"));
  await fails(f.connect(), "EAI_AGAIN");
  f.setTime(6 * 60_000);
  await fails(f.connect(), "EAI_AGAIN");
  assert.deepEqual(f.logs, []);
});

test("fallback never crosses hostnames or masks a permanent DNS error", async (t) => {
  const f = await fixture(t);
  await once(f.connect(), "open");
  f.setError(dnsError("EAI_AGAIN"));
  await fails(f.connect("another.invalid"), "EAI_AGAIN");
  f.setError(dnsError("ENOTFOUND"));
  await fails(f.connect(), "ENOTFOUND");
  f.setError(dnsError("EAI_AGAIN"));
  await fails(f.connect(), "EAI_AGAIN");
  assert.deepEqual(f.logs, []);
});

for (const stage of ["DNS", "TLS", "HTTP upgrade"]) {
  test(`absolute connection deadline terminates a stalled ${stage}`, async (t) => {
    const sockets = new Set();
    const server = createServer((socket) => { sockets.add(socket); socket.on("data", () => {}); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    });
    const logs = [];
    const factory = createRunnerSocketFactory({
      log: (text) => logs.push(text), connectTimeoutMs: 100,
      ...(stage === "DNS" ? { lookup: () => {} } : {}),
    });
    const ws = factory(`${stage === "TLS" ? "wss" : "ws"}://${stage === "DNS" ? "hub.invalid" : "127.0.0.1"}:${server.address().port}`);
    ws.on("error", () => {});
    await new Promise((resolve) => ws.once("close", () => resolve()));
    assert.equal(ws.readyState, WebSocket.CLOSED);
    assert.deepEqual(logs, ["connection attempt timed out after 100ms; reconnecting"]);
  });
}

test("opening or canceling a connection clears its deadline", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  const logs = [];
  const factory = createRunnerSocketFactory({ log: (text) => logs.push(text), connectTimeoutMs: 100 });
  const ws = factory(`ws://127.0.0.1:${server.address().port}`);
  ws.on("error", () => {});
  t.after(() => ws.terminate());
  await once(ws, "open");
  const pending = createRunnerSocketFactory({ log: (text) => logs.push(text), connectTimeoutMs: 100, lookup: () => {} })("ws://hub.invalid");
  pending.on("error", () => {});
  const closed = new Promise((resolve) => pending.once("close", () => resolve()));
  pending.close();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.deepEqual(logs, []);
});
