import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

function waitFor(check, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const result = check();
      if (result) return resolve(result);
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for websocket message"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("mirrors the provider error message instead of a generic error placeholder", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  const previousUrl = process.env.TOILET_PI_SERVER_URL;
  process.env.TOILET_PI_SERVER_URL = `ws://127.0.0.1:${address.port}/ws?token=test-token`;

  const received = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => received.push(JSON.parse(String(data))));
  });

  const handlers = new Map();
  const pi = {
    on(name, handler) {
      const entries = handlers.get(name) || [];
      entries.push(handler);
      handlers.set(name, entries);
    },
    registerCommand() {},
  };
  const context = {
    hasUI: false,
    model: null,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "error-session",
      getSessionFile: () => null,
      getSessionName: () => null,
      getCwd: () => process.cwd(),
      getBranch: () => [],
    },
  };

  try {
    const { default: registerExtension } = await import(
      `../toilet-pi.ts?assistant-error-test=${Date.now()}`
    );
    registerExtension(pi);
    await handlers.get("session_start")[0]({}, context);
    await waitFor(() => received.find((message) => message.type === "hello"));

    await handlers.get("message_end")[0]({
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Retry failed after 3 attempts: fetch failed",
        timestamp: 123,
      },
    });

    const event = await waitFor(() => received.find(
      (message) => message.type === "session_event" && message.event?.type === "message",
    ));
    assert.equal(event.event.message.stopReason, "error");
    assert.equal(event.event.message.text, "Error: Retry failed after 3 attempts: fetch failed");
  } finally {
    const shutdown = handlers.get("session_shutdown")?.[0];
    if (shutdown) await shutdown({}, context);
    if (previousUrl === undefined) delete process.env.TOILET_PI_SERVER_URL;
    else process.env.TOILET_PI_SERVER_URL = previousUrl;
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
