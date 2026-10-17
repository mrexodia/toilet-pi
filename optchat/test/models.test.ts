import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { validateModel } from "../src/host.ts";

function runtime(available: boolean, configured: boolean): Pick<ModelRuntime, "getModel" | "getProviderAuthStatus"> {
	return {
		getModel: () => available ? {} as ReturnType<ModelRuntime["getModel"]> : undefined,
		getProviderAuthStatus: () => ({ configured }),
	};
}

for (const role of ["model", "compactor"] as const) {
	test(`an unconfigured ${role} gives an actionable error even when present in the catalog`, () => {
		assert.throws(
			() => validateModel(runtime(true, false), { provider: "openai-codex", modelId: "test" }, role, "home"),
			(error: Error) => {
				assert.ok(error.message.includes(`${role} openai-codex/test`));
				assert.ok(error.message.includes("provider openai-codex is not configured"));
				assert.ok(error.message.includes(join("home", "optchat.json")));
				assert.ok(error.message.includes(`--${role}`));
				return true;
			},
		);
	});
}

test("a missing model is distinguished from an unconfigured provider", () => {
	assert.throws(
		() => validateModel(runtime(false, true), { provider: "openai", modelId: "missing" }, "compactor", "home"),
		/compactor openai\/missing is not available/,
	);
});

test("a configured model passes without making a model request", () => {
	assert.doesNotThrow(() => validateModel(runtime(true, true), { provider: "openai", modelId: "test" }, "model", "home"));
});
