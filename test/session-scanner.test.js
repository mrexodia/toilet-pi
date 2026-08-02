import assert from "node:assert/strict";
import { mkdtemp, appendFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readSessionSnapshot,
  scanSessions,
} from "../session-scanner.js";

function encodeEntries(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function createFixture() {
  const sessionDir = await mkdtemp(path.join(tmpdir(), "toilet-pi-scanner-"));
  const sessionFile = path.join(sessionDir, "session.jsonl");
  await writeFile(
    sessionFile,
    encodeEntries([
      { type: "session", id: "session-1", cwd: "/tmp/project" },
      {
        type: "message",
        timestamp: 1,
        message: { role: "user", content: "initial prompt", timestamp: 1 },
      },
      { type: "session_info", name: "Initial name", timestamp: 2 },
    ]),
  );
  return { sessionDir, sessionFile };
}

test("scanSessions reuses immutable cached summaries and reparses changed files", async () => {
  const fixture = await createFixture();
  try {
    const first = await scanSessions(fixture.sessionDir);
    assert.equal(first.length, 1);
    assert.equal(first[0].sessionName, "Initial name");

    first[0].sessionName = "Mutated by caller";
    const unchanged = await scanSessions(fixture.sessionDir);
    assert.equal(unchanged[0].sessionName, "Initial name");

    await appendFile(
      fixture.sessionFile,
      encodeEntries([
        { type: "session_info", name: "Updated name", timestamp: 3 },
      ]),
    );
    const changed = await scanSessions(fixture.sessionDir);
    assert.equal(changed[0].sessionName, "Updated name");
    assert.equal(changed[0].updatedAt, 3);

    await unlink(fixture.sessionFile);
    assert.deepEqual(await scanSessions(fixture.sessionDir), []);
  } finally {
    await rm(fixture.sessionDir, { recursive: true, force: true });
  }
});

test("readSessionSnapshot reads current history on demand", async () => {
  const fixture = await createFixture();
  try {
    const first = await readSessionSnapshot(fixture.sessionFile);
    assert.equal(first.history.length, 1);
    first.history[0].text = "Mutated by caller";

    const unchanged = await readSessionSnapshot(fixture.sessionFile);
    assert.equal(unchanged.history[0].text, "initial prompt");

    await appendFile(
      fixture.sessionFile,
      encodeEntries([
        {
          type: "message",
          timestamp: 4,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "new response" }],
            stopReason: "stop",
            timestamp: 4,
          },
        },
      ]),
    );
    const changed = await readSessionSnapshot(fixture.sessionFile);
    assert.equal(changed.history.length, 2);
    assert.equal(changed.history[1].text, "new response");
    assert.equal(changed.updatedAt, 4);
  } finally {
    await rm(fixture.sessionDir, { recursive: true, force: true });
  }
});
