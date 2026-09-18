import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";

test("extension routes configuration queries and broadcasts local selections on an isolated socket", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const previousUrl = process.env.TOILET_PI_SERVER_URL;
  process.env.TOILET_PI_SERVER_URL = `ws://127.0.0.1:${server.address().port}/ws?token=isolated-test`;
  const handlers = new Map();
  let level = "off", idle = true;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {}, getThinkingLevel: () => level,
    setModel() { throw new Error("Busy configuration must never call this"); },
    setThinkingLevel() { throw new Error("Busy configuration must never call this"); },
  };
  const ctx = {
    model: { provider: "fake", id: "small", contextWindow: 1000 }, hasUI: false,
    isIdle: () => idle, hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "isolated-session", getSessionFile: () => null,
      getSessionName: () => null, getCwd: () => "/fake", getBranch: () => [],
    },
  };
  const messages = [];
  let socket;
  server.on("connection", connected => {
    socket = connected;
    socket.on("message", data => messages.push(JSON.parse(String(data))));
  });
  const waitFor = async predicate => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const match = messages.find(predicate);
      if (match) return match;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for isolated extension response");
  };
  try {
    const { default: register } = await import(`../toilet-pi.ts?models-test=${Date.now()}`);
    register(pi);
    await handlers.get("session_start")({}, ctx);
    const hello = await waitFor(message => message.type === "hello");
    assert.deepEqual(hello.configuration, { provider: "fake", modelId: "small", thinkingLevel: "off" });
    assert(hello.capabilities.includes("model_control_v1"));
    socket.send(JSON.stringify({ type: "session_request", requestId: "read", sessionGuid: "isolated-session", operation: "get_config" }));
    const read = await waitFor(message => message.requestId === "read");
    assert.equal(read.success, true);
    assert.deepEqual(read.data.configuration, hello.configuration);
    level = "high";
    await handlers.get("thinking_level_select")({ level }, ctx);
    await waitFor(message => message.event?.type === "configuration" && message.event.configuration.thinkingLevel === "high");
    idle = false;
    socket.send(JSON.stringify({ type: "session_request", requestId: "busy", sessionGuid: "isolated-session", operation: "configure", thinkingLevel: "high" }));
    assert.equal((await waitFor(message => message.requestId === "busy")).error.code, "busy");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    if (previousUrl === undefined) delete process.env.TOILET_PI_SERVER_URL;
    else process.env.TOILET_PI_SERVER_URL = previousUrl;
  }
});
