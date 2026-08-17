import assert from "node:assert/strict";
import test from "node:test";
import {
  parseToiletPiCommand,
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
