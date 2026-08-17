import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const packageRoot = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("package.json", packageRoot), "utf8"),
);

test("OMP and pi load the same extension entrypoint", async () => {
  assert.deepEqual(manifest.omp?.extensions, ["./toilet-pi.ts"]);
  assert.deepEqual(manifest.omp.extensions, manifest.pi?.extensions);
  assert.equal(
    manifest.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional,
    true,
  );
  await access(new URL(manifest.omp.extensions[0], packageRoot));
});
