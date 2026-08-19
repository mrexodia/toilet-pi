import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import {
  parseToiletPiCommand,
  redactUrlTokens,
  TOILET_PI_COMMAND_USAGE,
} from "../toilet-pi-config.js";

const { default: registerExtension } = await import(
  `../toilet-pi.ts?command-test=${Date.now()}`
);

test("parses nested toilet-pi subcommands", () => {
  assert.deepEqual(parseToiletPiCommand(""), { action: "help" });
  assert.deepEqual(parseToiletPiCommand("help"), { action: "help" });
  assert.deepEqual(parseToiletPiCommand("status"), { action: "status" });
  assert.deepEqual(parseToiletPiCommand("setup"), {
    action: "setup",
    connectUrl: null,
  });
  assert.deepEqual(
    parseToiletPiCommand("setup wss://example.test/ws?token=machine-token"),
    {
      action: "setup",
      connectUrl: "wss://example.test/ws?token=machine-token",
    },
  );
  assert.throws(() => parseToiletPiCommand("status extra"), {
    message: TOILET_PI_COMMAND_USAGE,
  });
  assert.throws(() => parseToiletPiCommand("wss://example.test/ws?token=old"), {
    message: TOILET_PI_COMMAND_USAGE,
  });
});

test("redacts tokens from WebSocket error URLs", () => {
  assert.equal(
    redactUrlTokens(
      "WebSocket connection to 'wss://example.test/ws?token=secret%2Fvalue&role=pi' failed: Failed to connect",
    ),
    "WebSocket connection to 'wss://example.test/ws?token=[REDACTED]&role=pi' failed: Failed to connect",
  );
});

test("redacts token-bearing WebSocket errors before logging", async () => {
  const token = "machine-secret";
  const previousUrl = process.env.TOILET_PI_SERVER_URL;
  const originalEmit = WebSocket.prototype.emit;
  const originalConsoleLog = console.log;
  const handlers = new Map();
  const logs = [];
  let resolveError;
  let errorTimeout;
  const errorEmitted = new Promise((resolve) => {
    resolveError = resolve;
  });

  process.env.TOILET_PI_SERVER_URL = `ws://127.0.0.1:1/ws?token=${token}`;
  WebSocket.prototype.emit = function (eventName, ...args) {
    if (eventName === "error") {
      args = [
        new Error(
          `WebSocket connection to '${this.url}' failed: Failed to connect`,
        ),
      ];
    }
    const emitted = originalEmit.call(this, eventName, ...args);
    if (eventName === "error") resolveError();
    return emitted;
  };
  console.log = (...args) => logs.push(args.join(" "));

  const pi = {
    on(name, handler) {
      const entries = handlers.get(name) || [];
      entries.push(handler);
      handlers.set(name, entries);
    },
    registerCommand() {},
    sendUserMessage() {},
  };
  const context = {
    hasUI: false,
    model: null,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    sessionManager: {
      getSessionId: () => "redaction-test",
      getSessionFile: () => null,
      getSessionName: () => null,
      getCwd: () => process.cwd(),
      getBranch: () => [],
    },
  };

  try {
    registerExtension(pi);
    await handlers.get("session_start")[0]({}, context);
    await Promise.race([
      errorEmitted,
      new Promise((_, reject) => {
        errorTimeout = setTimeout(
          () => reject(new Error("Timed out waiting for WebSocket error")),
          2000,
        );
      }),
    ]);

    const output = logs.join("\n");
    assert.match(output, /WebSocket error: .*\?token=\[REDACTED\]/);
    assert.doesNotMatch(output, new RegExp(token));
  } finally {
    clearTimeout(errorTimeout);
    const shutdown = handlers.get("session_shutdown")?.[0];
    if (shutdown) await shutdown({}, context);
    WebSocket.prototype.emit = originalEmit;
    console.log = originalConsoleLog;
    if (previousUrl === undefined) delete process.env.TOILET_PI_SERVER_URL;
    else process.env.TOILET_PI_SERVER_URL = previousUrl;
  }
});

test("registers status under toilet-pi without a ws alias", async () => {
  const commands = new Map();
  const notifications = [];
  registerExtension({
    on() {},
    registerCommand(name, options) {
      commands.set(name, options);
    },
  });

  assert.deepEqual([...commands.keys()], ["toilet-pi"]);
  const command = commands.get("toilet-pi");
  const context = {
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  await command.handler("", context);
  await command.handler("status", context);

  assert.deepEqual(notifications, [
    { message: TOILET_PI_COMMAND_USAGE, level: "info" },
    {
      message: "toilet-pi is not configured yet. Run /toilet-pi setup.",
      level: "info",
    },
  ]);
});
