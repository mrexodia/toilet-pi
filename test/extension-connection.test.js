import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { createRunnerSocketFactory } from "../runner-socket.js";

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for extension connection");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t, { timeoutMs = 200 } = {}) {
  const state = { dnsError: null, pauseDns: false, stallUpgrade: false, lookups: 0, clients: [], connections: [], messages: [], logs: [], injected: [] };
  const server = createServer();
  const hub = new WebSocketServer({ noServer: true });
  const rawSockets = new Set();
  server.on("connection", (socket) => {
    rawSockets.add(socket);
    socket.on("close", () => rawSockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    if (state.stallUpgrade) return;
    hub.handleUpgrade(request, socket, head, (ws) => {
      const id = state.connections.length;
      state.connections.push(ws);
      ws.on("message", (data) => state.messages.push({ connectionId: id, ...JSON.parse(String(data)) }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const savedUrl = process.env.TOILET_PI_SERVER_URL;
  process.env.TOILET_PI_SERVER_URL = `ws://hub.invalid:${server.address().port}/ws?token=extension-secret`;
  const savedLog = console.log;
  console.log = (...args) => state.logs.push(args.join(" "));

  // Inject only the transport dependencies; exercise the actual extension, shared socket factory and real sockets.
  const key = `toilet-pi-connection-test-${randomUUID()}`;
  globalThis[Symbol.for(key)] = (options) => {
    const create = createRunnerSocketFactory({
      ...options,
      connectTimeoutMs: timeoutMs,
      lookup(_hostname, options, callback) {
        state.lookups++;
        if (state.pauseDns) return;
        queueMicrotask(() => callback(state.dnsError,
          options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", options.all ? undefined : 4));
      },
    });
    return (url) => {
      const ws = create(url);
      state.clients.push(ws);
      return ws;
    };
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "./runner-socket.js" && context.parentURL?.includes("/toilet-pi.ts")) {
      return { url: `data:text/javascript,${encodeURIComponent(`export const createRunnerSocketFactory = globalThis[Symbol.for(${JSON.stringify(key)})];`)}`, shortCircuit: true };
    }
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: "data:text/javascript,export const VERSION = '1.3.0'", shortCircuit: true };
    }
    return next(specifier, context);
  } });
  const handlers = new Map();
  const context = {
    model: { provider: "fake", id: "small", contextWindow: 1000 }, hasUI: false,
    isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "stable-session", getSessionFile: () => null,
      getSessionName: () => null, getCwd: () => "/fake", getBranch: () => [],
    },
  };
  const stop = async () => handlers.get("session_shutdown")?.({}, context);
  t.after(async () => {
    try {
      await stop();
      for (const socket of state.clients) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      for (const socket of hub.clients) socket.terminate();
      for (const socket of rawSockets) socket.destroy();
      await new Promise((resolve) => hub.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    } finally {
      hooks.deregister();
      delete globalThis[Symbol.for(key)];
      console.log = savedLog;
      if (savedUrl === undefined) delete process.env.TOILET_PI_SERVER_URL;
      else process.env.TOILET_PI_SERVER_URL = savedUrl;
    }
  });
  const { default: register } = await import(`../toilet-pi.ts?connection-test=${key}`);
  register({
    on: (name, handler) => handlers.set(name, handler), registerCommand() {},
    getThinkingLevel: () => "off", sendUserMessage: (...args) => state.injected.push(args),
  });
  assert.equal(state.clients.length, 0, "extension registration must not open sockets");
  return { state, start: () => handlers.get("session_start")({}, context), stop };
}

test("extension reconnects through transient DNS failure, restores its identity, and does not replay inputs", async (t) => {
  const { state, start } = await fixture(t);
  await start();
  await until(() => state.messages.some((m) => m.type === "hello"));
  state.connections[0].send(JSON.stringify({ type: "control_command", operation: "send", sessionGuid: "stable-session", inputId: "one-input", text: "do this once", mode: "prompt" }));
  await until(() => state.injected.length === 1);
  const pong = once(state.clients[0], "pong");
  state.clients[0].ping();
  await pong;
  state.dnsError = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
  state.connections[0].terminate();
  await until(() => state.messages.some((m) => m.type === "hello" && m.connectionId === 1));
  assert.equal(state.lookups, 2);
  assert.equal(state.injected.length, 1);
  assert.ok(state.messages.filter((m) => m.type === "hello").every((m) => m.sessionGuid === "stable-session"));
  assert.ok(state.logs.some((line) => /temporary DNS failure.*recently connected address/.test(line)));
  assert.ok(state.logs.some((line) => /disconnected \(1006\); connected for \d+ms; last pong \d+ms ago/.test(line)));
  assert.ok(state.logs.some((line) => /reconnecting in \d+ms/.test(line)));
  assert.ok(state.logs.every((line) => !line.includes("extension-secret")));
});

for (const stage of ["DNS", "HTTP upgrade"]) {
  test(`extension reconnects after its ${stage} deadline`, async (t) => {
    const { state, start } = await fixture(t);
    if (stage === "DNS") state.pauseDns = true;
    else state.stallUpgrade = true;
    await start();
    await until(() => state.logs.some((line) => line.includes("connection attempt timed out after 200ms")));
    state.pauseDns = false;
    state.stallUpgrade = false;
    await until(() => state.messages.some((m) => m.type === "hello"));
    assert.equal(state.clients.length, 2);
    assert.equal(state.clients[0].readyState, WebSocket.CLOSED);
    assert.equal(state.clients[1].readyState, WebSocket.OPEN);
  });
}

test("extension shutdown during a pending handshake clears the deadline and never reconnects", async (t) => {
  const timeouts = new Set();
  const cleared = new Set();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    const handle = set(callback, ms, ...args);
    if (ms === 15000) timeouts.add(handle);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => { cleared.add(handle); return clear(handle); });
  const { state, start, stop } = await fixture(t, { timeoutMs: 15000 });
  state.pauseDns = true;
  await start();
  await until(() => state.clients.length === 1);
  assert.equal(state.clients[0].readyState, WebSocket.CONNECTING);
  await stop();
  await until(() => state.clients[0].readyState === WebSocket.CLOSED);
  assert.equal(timeouts.size, 1);
  assert.ok([...timeouts].every((handle) => cleared.has(handle)), "close must retain the factory's cleanup listener");
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(state.clients.length, 1);
  assert.ok(!state.logs.some((line) => line.includes("reconnecting")));
});

for (const [code, reason] of [[1000, "replaced"], [1000, "released"], [1008, "Unauthorized"]]) {
  test(`extension still stops reconnecting on ${code} ${reason}`, async (t) => {
    const { state, start } = await fixture(t);
    await start();
    await until(() => state.messages.some((m) => m.type === "hello"));
    state.connections[0].close(code, reason);
    await until(() => state.clients[0].readyState === WebSocket.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 1400));
    assert.equal(state.clients.length, 1);
    assert.ok(!state.logs.some((line) => /reconnecting in/.test(line)));
  });
}
