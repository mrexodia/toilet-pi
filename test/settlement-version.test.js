import assert from "node:assert/strict";
import { test } from "node:test";
import { supportsSettlementVersion } from "../settlement-version.js";

test("certifies known Pi settlement event generations but not unknown future majors", () => {
  for (const version of ["0.85.1", "0.86.0", "1.1.0", "1.3.0"]) assert.equal(supportsSettlementVersion(version), true, version);
  for (const version of ["0.85.0", "0.84.9", "1.0.0", "2.0.0", "unknown", undefined]) assert.equal(supportsSettlementVersion(version), false, String(version));
});
