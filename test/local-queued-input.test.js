import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

function waitFor(check, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const result = check();
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for websocket message"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("removes a CLI-queued message after pi consumes transformed input", async () => {
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
    sendUserMessage() {},
  };

  let hasPendingMessages = false;
  const context = {
    hasUI: false,
    model: null,
    isIdle: () => !hasPendingMessages,
    hasPendingMessages: () => hasPendingMessages,
    abort() {},
    shutdown() {},
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => null,
      getSessionName: () => null,
      getCwd: () => process.cwd(),
      getBranch: () => [],
    },
  };

  try {
    const { default: registerExtension } = await import(
      `../toilet-pi.ts?queue-test=${Date.now()}`
    );
    registerExtension(pi);

    await handlers.get("session_start")[0]({}, context);
    await waitFor(() => received.find((message) => message.type === "hello"));

    await handlers.get("input")[0](
      {
        source: "interactive",
        text: "/template queued argument",
        streamingBehavior: "followUp",
      },
      context,
    );
    hasPendingMessages = true;

    const addEvent = await waitFor(() =>
      received.find(
        (message) =>
          message.type === "session_event" &&
          message.event?.type === "queued_input_add" &&
          message.event.queuedInput?.inputId?.startsWith("local-"),
      ),
    );
    const inputId = addEvent.event.queuedInput.inputId;

    // Pi removes the entry from its queue before message_start. Template and
    // input transformations mean the final text need not equal the raw input.
    hasPendingMessages = false;
    await handlers.get("message_start")[0]({
      message: {
        role: "user",
        content: [{ type: "text", text: "Expanded queued prompt" }],
      },
    });

    await waitFor(() =>
      received.find(
        (message) =>
          message.type === "session_event" &&
          message.event?.type === "queued_input_remove" &&
          message.event.inputId === inputId,
      ),
    );
  } finally {
    const shutdown = handlers.get("session_shutdown")?.[0];
    if (shutdown) await shutdown({}, context);
    if (previousUrl === undefined) delete process.env.TOILET_PI_SERVER_URL;
    else process.env.TOILET_PI_SERVER_URL = previousUrl;
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
