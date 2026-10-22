import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ToiletPiClient } from "../../cli/client.js";
import { parseChildRuntime, readConfig, updateConfig, writeConfig } from "../src/config.ts";
import { agentsExtension } from "../src/orchestrate.ts";

const main = fileURLToPath(new URL("../main.ts", import.meta.url));

test("old homes default to Pi, and childRuntime round-trips without changing model settings", async () => {
	const home = await mkdtemp(join(tmpdir(), "optchat-config-"));
	try {
		await writeConfig(home, { model: "fake/model", name: "agent" });
		assert.equal(parseChildRuntime((await readConfig(home)).childRuntime), "pi");
		await updateConfig(home, { childRuntime: "omp" });
		await updateConfig(home, { thinking: "high" });
		assert.deepEqual(await readConfig(home), { model: "fake/model", name: "agent", thinking: "high", childRuntime: "omp" });
		for (const invalid of ["python", "", null, 1]) assert.throws(() => parseChildRuntime(invalid), /childRuntime must be pi or omp/);
		await writeFile(join(home, "optchat.json"), JSON.stringify({ childRuntime: "python" }));
		await assert.rejects(readConfig(home), /childRuntime must be pi or omp/);
	} finally { await rm(home, { recursive: true, force: true }); }
});

test("request log settings survive saves from the hub", async () => {
	const home = await mkdtemp(join(tmpdir(), "optchat-config-"));
	try {
		await writeFile(join(home, "optchat.json"), JSON.stringify({ model: "a/b", recordRequests: false, requestLogMB: 64 }));
		await updateConfig(home, { model: "c/d" });
		assert.deepEqual(await readConfig(home), { model: "c/d", recordRequests: false, requestLogMB: 64 });
		await writeFile(join(home, "optchat.json"), JSON.stringify({ recordRequests: "no", requestLogMB: -1 }));
		assert.deepEqual(await readConfig(home), {});
	} finally { await rm(home, { recursive: true, force: true }); }
});

test("agent_new sends the configured default runtime even to a remote launcher, with a per-call override", async () => {
	const names = ["TOILET_PI_CLI_SERVER", "TOILET_PI_ORCHESTRATOR_TOKEN", "TOILET_PI_ADMIN_TOKEN"] as const;
	const previous = names.map(name => process.env[name]);
	const proto = ToiletPiClient.prototype;
	const original = { connect: proto.connect, control: proto.control, close: proto.close };
	const calls: unknown[] = [];
	try {
		process.env.TOILET_PI_CLI_SERVER = "http://127.0.0.1:1/";
		process.env.TOILET_PI_ORCHESTRATOR_TOKEN = "isolated-test";
		delete process.env.TOILET_PI_ADMIN_TOKEN;
		proto.connect = async function () { this.overview = { hosts: [{ hostId: "remote", hostname: "remote", connected: false, sessions: [] }] }; return this; };
		proto.control = async function (operation, fields) { calls.push([operation, fields]); return { sessionGuid: "child" }; };
		proto.close = () => {};
		for (const childRuntime of [undefined, "omp"] as const) {
			const tool = agentsExtension({ home: "unused", childRuntime }).tools!.find(tool => tool.name === "agent_new")!;
			await tool.execute({ host: "remote", cwd: "/project" }, {} as never, BACKGROUND_CONTEXT);
			assert.deepEqual(calls.at(-1), ["new", { hostId: "remote", cwd: "/project", runtime: childRuntime ?? "pi" }]);
			await tool.execute({ host: "remote", cwd: "/project", runtime: "pi" }, {} as never, BACKGROUND_CONTEXT);
			assert.deepEqual(calls.at(-1), ["new", { hostId: "remote", cwd: "/project", runtime: "pi" }]);
		}
	} finally {
		Object.assign(proto, original);
		names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
	}
});

async function cli(home: string, preload: string, args: string[], answers = "", extraEnv: Record<string, string> = {}) {
	const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, main, "--home", home, ...args], {
		env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
			PI_CODING_AGENT_DIR: join(home, "pi"), TOILET_PI_AUTH_FILE: join(home, "auth.json"), ...extraEnv },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let out = "", err = "";
	child.stdout.on("data", data => { out += data; }); child.stderr.on("data", data => { err += data; });
	child.stdin.end(answers);
	const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
	return { code, out, err };
}

test("setup saves the child runtime with flag/env precedence; invalid overrides leave the home intact", async () => {
	const home = await mkdtemp(join(tmpdir(), "optchat-setup-"));
	try {
		const preload = join(home, "sdk-stub.mjs");
		// No real runtime/provider calls or saved credentials are used by the wizard test.
		const sdk = `export const ModelRuntime = { create: async () => ({ getAvailableSnapshot: () => [], getModel: () => undefined }) };
			export const SettingsManager = { create: () => ({ getDefaultProvider() {}, getDefaultModel() {}, getDefaultThinkingLevel() {} }) };
			export const formatSkillsForPrompt = () => ''; export const loadSkillsFromDir = () => ({ skills: [], diagnostics: [] });`;
		await writeFile(preload, `import { registerHooks } from 'node:module'; registerHooks({ resolve(s, c, next) {
			return s === '@earendil-works/pi-coding-agent' ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(sdk)}`)}, shortCircuit: true } : next(s, c);
		} });`);
		const setup = await cli(home, preload, ["setup"], "agent\n\n\n\n\nomp\n\n");
		assert.equal(setup.code, 0, setup.err);
		assert.equal((await readConfig(home)).childRuntime, "omp");
		const envOverride = await cli(home, preload, ["setup"], "\n".repeat(7), { OPTCHAT_CHILD_RUNTIME: "pi" });
		assert.equal(envOverride.code, 0, envOverride.err);
		assert.equal((await readConfig(home)).childRuntime, "pi");
		const flagOverride = await cli(home, preload, ["--child-runtime", "omp", "setup"], "\n".repeat(7), { OPTCHAT_CHILD_RUNTIME: "pi" });
		assert.equal(flagOverride.code, 0, flagOverride.err);
		assert.equal((await readConfig(home)).childRuntime, "omp");
		const saved = await readFile(join(home, "optchat.json"), "utf8");
		for (const [args, env] of [[["--child-runtime", "bad", "status"], {}], [["status"], { OPTCHAT_CHILD_RUNTIME: "bad" }]] as const) {
			const result = await cli(home, preload, [...args], "", env);
			assert.notEqual(result.code, 0); assert.match(result.err, /childRuntime must be pi or omp/);
			assert.equal(await readFile(join(home, "optchat.json"), "utf8"), saved);
		}
	} finally { await rm(home, { recursive: true, force: true }); }
});
