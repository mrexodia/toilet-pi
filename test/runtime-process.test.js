import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnRuntimeCommand } from "../runtime-process.js";

function collectChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test(
  "launches pi and omp through npm-style Windows .cmd shims",
  { skip: process.platform !== "win32", timeout: 10_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "toilet-pi-cmd-shims-"));
    try {
      const targetPath = path.join(root, "shim-target.js");
      await writeFile(
        targetPath,
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      );

      for (const runtime of ["pi", "omp"]) {
        await writeFile(
          path.join(root, `${runtime}.cmd`),
          `@ECHO off\r\n"${process.execPath}" "%~dp0\\shim-target.js" %*\r\n`,
        );
      }

      const pathKey =
        Object.keys(process.env).find((key) => key.toLowerCase() === "path") ||
        "PATH";
      const env = {
        ...process.env,
        [pathKey]: `${root}${path.delimiter}${process.env[pathKey] || ""}`,
      };
      const expectedArgs = ["--label", "hello world", "amp&ersand"];

      for (const runtime of ["pi", "omp"]) {
        const result = await collectChild(
          spawnRuntimeCommand(runtime, expectedArgs, {
            env,
            windowsHide: true,
          }),
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
        assert.deepEqual(JSON.parse(result.stdout), expectedArgs);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
