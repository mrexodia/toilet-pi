import assert from "node:assert/strict";
import { test } from "node:test";
import { timestampLog } from "../src/log.ts";

test("log timestamps use local time with zero-padded fields and milliseconds", () => {
	assert.equal(
		timestampLog("toilet-pi: disconnected (1006)", new Date(2026, 0, 2, 3, 4, 5, 6)),
		"[2026-01-02 03:04:05.006] toilet-pi: disconnected (1006)",
	);
	assert.equal(
		timestampLog("toilet-pi: connected", new Date(2026, 10, 23, 14, 45, 56, 789)),
		"[2026-11-23 14:45:56.789] toilet-pi: connected",
	);
});

test("each line in a multiline diagnostic gets the same timestamp", () => {
	assert.equal(
		timestampLog("socket error\r\ndetails\nmore", new Date(2026, 0, 2, 3, 4, 5, 0)),
		"[2026-01-02 03:04:05.000] socket error\n[2026-01-02 03:04:05.000] details\n[2026-01-02 03:04:05.000] more",
	);
});
