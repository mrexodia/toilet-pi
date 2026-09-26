import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

test("OMP session lifecycle events never change identity on an existing connection", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const previousUrl = process.env.TOILET_PI_SERVER_URL;
  process.env.TOILET_PI_SERVER_URL = `ws://127.0.0.1:${server.address().port}/ws?token=resume-test`;

  const handlers = new Map();
  const pi = {
    on(name, handler) {
      const registered = handlers.get(name) || [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerCommand() {},
    getThinkingLevel: () => "off",
  };
  let sessionGuid = "original-session";
  let sessionName = null;
  let branch = [];
  const context = {
    model: { provider: "fake", id: "model", contextWindow: 1000 },
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => sessionGuid,
      getSessionFile: () => null,
      getSessionName: () => sessionName,
      getCwd: () => "/fake",
      getBranch: () => branch,
    },
  };

  const hellos = [];
  const messages = [];
  let rejectedIdentityChanges = 0;
  let nextConnectionId = 0;
  server.on("connection", (socket) => {
    const connectionId = ++nextConnectionId;
    let identity = null;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      messages.push({ connectionId, ...message });
      if (message.type !== "hello") return;
      hellos.push({ connectionId, ...message });
      if (identity && identity !== message.sessionGuid) {
        rejectedIdentityChanges += 1;
        socket.close(1008, "Identity changed");
        return;
      }
      identity = message.sessionGuid;
    });
  });

  try {
    const { default: register } = await import(`../toilet-pi.ts?resume-lifecycle=${Date.now()}`);
    register(pi);
    const sessionStart = handlers.get("session_start")[0];
    await sessionStart({}, context);
    const originalHello = await waitFor(
      () => hellos.find((message) => message.sessionGuid === "original-session"),
      "Timed out waiting for the original session hello",
    );

    const helloCountBeforeReload = hellos.length;
    for (const sessionSwitch of handlers.get("session_switch") || []) {
      await sessionSwitch({ reason: "resume", previousSessionFile: "/fake/original.jsonl" }, context);
    }
    const reloadHello = await waitFor(
      () => hellos.length > helloCountBeforeReload && hellos.at(-1),
      "Timed out waiting for the reloaded session snapshot",
    );
    assert.equal(reloadHello.connectionId, originalHello.connectionId);

    sessionName = "renamed session";
    for (const sessionInfoChanged of handlers.get("session_info_changed") || []) {
      await sessionInfoChanged({ name: sessionName }, context);
    }
    await waitFor(
      () => messages.find((message) => message.event?.type === "session_name" && message.event.sessionName === sessionName),
      "Timed out waiting for the renamed session event",
    );

    branch = [{ type: "message", message: { role: "user", content: "compacted branch" } }];
    for (const sessionCompact of handlers.get("session_compact") || []) await sessionCompact({}, context);
    const compactHello = await waitFor(
      () => hellos.findLast((message) => message.history?.[0]?.text === "compacted branch"),
      "Timed out waiting for the compacted session snapshot",
    );
    assert.equal(compactHello.connectionId, originalHello.connectionId);

    const helloCountBeforeTree = hellos.length;
    for (const sessionTree of handlers.get("session_tree") || []) await sessionTree({}, context);
    const treeHello = await waitFor(
      () => hellos.length > helloCountBeforeTree && hellos.at(-1),
      "Timed out waiting for the tree navigation snapshot",
    );
    assert.equal(treeHello.connectionId, originalHello.connectionId);

    sessionGuid = "resumed-session";
    for (const sessionSwitch of handlers.get("session_switch") || []) {
      await sessionSwitch({ reason: "resume", previousSessionFile: "/fake/original.jsonl" }, context);
    }

    const resumedHello = await waitFor(
      () => hellos.find((message) => message.sessionGuid === "resumed-session"),
      "Timed out waiting for the resumed session hello",
    );
    assert.notEqual(resumedHello.connectionId, originalHello.connectionId);

    sessionGuid = "unexpected-tree-session";
    for (const sessionTree of handlers.get("session_tree") || []) await sessionTree({}, context);
    const unexpectedTreeHello = await waitFor(
      () => hellos.find((message) => message.sessionGuid === "unexpected-tree-session"),
      "Timed out waiting for the defensive tree reconnect",
    );
    assert.notEqual(unexpectedTreeHello.connectionId, resumedHello.connectionId);

    sessionGuid = "branched-session";
    for (const sessionBranch of handlers.get("session_branch") || []) {
      await sessionBranch({ previousSessionFile: "/fake/unexpected-tree.jsonl" }, context);
    }
    const branchedHello = await waitFor(
      () => hellos.find((message) => message.sessionGuid === "branched-session"),
      "Timed out waiting for the OMP branch connection",
    );
    assert.notEqual(branchedHello.connectionId, unexpectedTreeHello.connectionId);

    sessionGuid = "forked-session";
    branch = [];
    for (const sessionSwitch of handlers.get("session_switch") || []) {
      await sessionSwitch({ reason: "fork", previousSessionFile: "/fake/branched.jsonl" }, context);
    }
    const forkedHello = await waitFor(
      () => hellos.find((message) => message.sessionGuid === "forked-session"),
      "Timed out waiting for the OMP fork connection",
    );
    assert.notEqual(forkedHello.connectionId, branchedHello.connectionId);

    sessionGuid = "new-session";
    for (const sessionSwitch of handlers.get("session_switch") || []) {
      await sessionSwitch({ reason: "new", previousSessionFile: "/fake/forked.jsonl" }, context);
    }
    const newHello = await waitFor(
      () => hellos.find((message) => message.sessionGuid === "new-session"),
      "Timed out waiting for the OMP new-session connection",
    );
    assert.notEqual(newHello.connectionId, forkedHello.connectionId);
    assert.equal(rejectedIdentityChanges, 0);
  } finally {
    for (const shutdown of handlers.get("session_shutdown") || []) await shutdown({}, context);
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (previousUrl === undefined) delete process.env.TOILET_PI_SERVER_URL;
    else process.env.TOILET_PI_SERVER_URL = previousUrl;
  }
});
