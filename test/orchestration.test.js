import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInputTracker } from "../input-tracker.js";
import { buildHistoryPage, selectPersistedBranch } from "../history-page.js";
import { readSessionHistory, readSessionSnapshot } from "../session-scanner.js";
import { runCli } from "../cli/main.js";

function trackerFixture() {
  let idle = true, queued = false, configuring = false;
  const messages = [], events = [];
  const tracker = createInputTracker({ pi: { sendUserMessage: (text, options) => messages.push({ text, options }) },
    getContext: () => ({ isIdle: () => idle, hasPendingMessages: () => queued, sessionManager: { getSessionId: () => "session" } }),
    configuring: () => configuring, emit: e => events.push(e.input) });
  const dispatch = (inputId, mode = "prompt") => tracker.dispatch({ inputId, sessionGuid: "session", mode, text: "/literal" });
  return { tracker, dispatch, messages, events, state: (i, q = false, c = false) => { idle = i; queued = q; configuring = c; } };
}

test("tracked inputs use markers, explicit modes, and settlement rather than FIFO or idle inference", () => {
  const f = trackerFixture();
  f.dispatch("one"); f.state(false); f.dispatch("two", "followUp");
  assert.equal(f.messages[0].options.expandPromptTemplates, false);
  assert.equal(f.messages[1].options.deliverAs, "followUp");
  f.tracker.messageStart({ role: "user", content: "unrelated local input" });
  assert.equal(f.events.length, 2);
  f.tracker.messageStart({ role: "user", content: f.messages[1].text });
  f.tracker.messageEnd({ role: "assistant", stopReason: "error" });
  f.tracker.settled(); // not idle: retries can still be pending
  assert.equal(f.events.at(-1).state, "running");
  f.tracker.messageStart({ role: "user", content: f.messages[0].text });
  f.tracker.messageEnd({ role: "assistant", stopReason: "stop" });
  f.state(true); f.tracker.settled();
  assert.deepEqual(f.events.slice(-2).map(e => [e.inputId, e.state]), [["two", "settled"], ["one", "settled"]]);
  assert.equal(f.tracker.pending(), false);
});

test("busy/configuring input is rejected; provider failures, aborts, swallowed prompts are distinct", () => {
  for (const [reason, expected] of [["error", "failed"], ["aborted", "aborted"], [undefined, "unknown"]]) {
    const f = trackerFixture(); f.dispatch("one");
    f.tracker.messageStart({ role: "user", content: f.messages[0].text });
    f.tracker.messageEnd({ role: "assistant", stopReason: reason }); f.tracker.settled();
    assert.equal(f.events.at(-1).state, expected);
  }
  const f = trackerFixture();
  f.state(false); f.dispatch("busy"); assert.equal(f.messages.length, 0);
  f.state(true, false, true); f.dispatch("config"); assert.equal(f.messages.length, 0);
  f.state(true); f.dispatch("swallowed"); f.tracker.settled();
  assert.equal(f.events.at(-1).state, "unknown");
});

test("branch navigation invalidates unfinished tracked work rather than settling a different branch", () => {
  const f = trackerFixture(); f.dispatch("one");
  f.tracker.messageStart({ role: "user", content: f.messages[0].text });
  f.tracker.invalidate();
  assert.equal(f.events.at(-1).state, "unknown");
  f.tracker.messageEnd({ role: "assistant", stopReason: "stop" }); f.tracker.settled();
  assert.equal(f.events.at(-1).state, "unknown");
});

test("older runtime rejecting optional events can still load the shared extension", async () => {
  const registered = [];
  const { default: register } = await import("../toilet-pi.ts");
  assert.doesNotThrow(() => register({ on(name) {
    if (["agent_settled", "thinking_level_select", "session_tree"].includes(name)) throw new Error("Unsupported event");
    registered.push(name);
  }, registerCommand() {} }));
  assert(registered.includes("session_start"));
  assert(registered.includes("input"));
});

const message = (id, parentId, content) => ({ type: "message", id, parentId, message: { role: "user", content } });
test("history walks only the persisted branch, paginates, and never duplicates retained compaction tail", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "toilet-history-"));
  const file = path.join(dir, "session.jsonl");
  try {
    const entries = [message("a", null, "root"), message("b", "a", "abandoned"), message("c", "a", "chosen"),
      { type: "compaction", id: "d", parentId: "c", summary: "summary", retainedTail: [{ role: "user", content: "chosen" }] },
      message("e", "d", "latest")];
    await writeFile(file, [{ type: "session", version: 3, id: "session", cwd: dir }, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
    const page = await readSessionHistory(file, { last: 2 });
    assert.deepEqual(page.messages.map(m => m.entryId), ["d", "e"]);
    assert.equal(page.complete, false);
    assert.equal(page.leafId, "e");
    const next = await readSessionHistory(file, { since: "a", last: 1 });
    assert.deepEqual(next.messages.map(m => m.entryId), ["c"]);
    assert.equal(next.hasMore, true);
    const all = await readSessionHistory(file);
    assert.equal(all.complete, true);
    assert.equal(all.messages.filter(m => m.text === "chosen").length, 1);
    assert(!all.messages.some(m => m.text === "abandoned"));
    await assert.rejects(readSessionHistory(file, { since: "b" }), /Cursor/);
    await assert.rejects(readSessionHistory(file, { sessionGuid: "wrong" }), /identity/);
    const mirror = await readSessionSnapshot(file);
    assert.deepEqual(mirror.history.map(m => m.entryId), ["a", "c", "e"]);
    await writeFile(file, [{ type: "session", version: 3, id: "session" }, ...entries].map(e => JSON.stringify(e)).join("\n") + '\n{"type":');
    const partial = await readSessionHistory(file);
    assert.equal(partial.complete, false); assert.equal(partial.truncated, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("history rejects missing cursors and marks corrupt parent chains and long Unicode text", () => {
  const corrupt = selectPersistedBranch([message("a", "b", "cycle"), message("b", "a", "cycle")]);
  assert.equal(corrupt.complete, false);
  const missing = selectPersistedBranch([message("a", "missing", "orphan")]);
  assert.equal(missing.complete, false);
  const page = buildHistoryPage([message("a", null, "😀".repeat(30000))]);
  assert.equal(page.truncated, true); assert.equal(page.complete, false);
  assert(Buffer.byteLength(page.messages[0].text) < 52000);
});

test("CLI validates dispatch flags before connecting and renders input IDs before transmission", async () => {
  const requests = []; let output = "", errors = "", connected = 0;
  const client = { overview: { hosts: [{ hostId: "host", sessions: [{ sessionGuid: "session" }] }] },
    connect: async () => { connected++; }, close() {}, control: async (op, fields) => {
      requests.push({ op, fields }); assert(output.includes(fields.inputId));
      return { input: { inputId: fields.inputId, state: "accepted" } };
    } };
  const options = { env: {}, authStore: { read: async () => ({ serverUrl: "https://isolated.test/", cookie: "toilet-pi-admin=fake-session" }) }, createClient: () => client, out: s => { output += s; }, err: s => { errors += s; }, readStdin: async () => "task\nfrom stdin" };
  assert.equal(await runCli(["send", "session", "--steer", "--follow-up", "hi"], options), 2);
  assert.equal(connected, 0);
  assert.equal(await runCli(["send", "session", "--stdin", "--follow-up"], options), 0);
  assert.equal(requests[0].fields.mode, "followUp");
  assert.equal(requests[0].fields.text, "task\nfrom stdin");
});
