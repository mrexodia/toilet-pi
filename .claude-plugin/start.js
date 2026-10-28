#!/usr/bin/env node
/**
 * Entry point of the plugin's `toilet-pi` MCP server (see .claude-plugin/plugin.json).
 *
 * The MCP handshake is answered first, so Claude Code never waits on the network. Then the bridge's one runtime
 * dependency (`ws`) is found in the checkout (Claude Code usually installs the repository's dependencies with the
 * plugin, and a development checkout has run `npm install`), or else installed once into ${CLAUDE_PLUGIN_DATA},
 * which survives plugin updates, with module resolution falling back to it. Then the bridge starts.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { log } from "./log.js";
import { StdioMcp } from "./mcp.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["ws"];
const LOCK_STALE_MS = 5 * 60_000;

function resolvableFrom(directory, name) {
	try {
		createRequire(join(directory, "package.json")).resolve(name);
		return true;
	} catch {
		return false;
	}
}

/** The versions this checkout asks for, from its own package.json. */
function wanted() {
	const { dependencies = {} } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	return Object.fromEntries(PACKAGES.map((name) => [name, dependencies[name] ?? "*"]));
}

function npm(args, cwd) {
	return new Promise((resolvePromise, reject) => {
		// npm is a .cmd script on Windows, which Node only runs through a shell.
		const windows = process.platform === "win32";
		execFile(windows ? "npm.cmd" : "npm", args, { cwd, shell: windows, timeout: 120_000, env: { ...process.env, npm_config_update_notifier: "false" } }, (error, _stdout, stderr) =>
			error ? reject(new Error(`npm ${args[0]} failed: ${String(stderr || error.message).trim().split("\n").slice(-3).join(" ")}`)) : resolvePromise());
	});
}

/** Install the dependencies into `data` unless the installed set already matches; one session at a time. */
async function installInto(data) {
	const want = JSON.stringify(wanted());
	const marker = join(data, "installed.json");
	const current = () => {
		try {
			return readFileSync(marker, "utf8") === want && PACKAGES.every((name) => resolvableFrom(data, name));
		} catch {
			return false;
		}
	};
	if (current()) return;
	mkdirSync(data, { recursive: true });
	const lock = join(data, "install.lock");
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch {
			// Another session is installing: wait for it, or take over a lock it abandoned.
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
			} catch {
				// gone already
			}
			await new Promise((r) => setTimeout(r, 500));
			if (current()) return;
		}
	}
	try {
		if (current()) return;
		log(`installing ${PACKAGES.join(", ")} into ${data}`);
		writeFileSync(join(data, "package.json"), `${JSON.stringify({ private: true, dependencies: JSON.parse(want) }, null, 2)}\n`);
		await npm(["install", "--omit=dev", "--no-audit", "--no-fund"], data);
		writeFileSync(marker, want);
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/** Resolve bare package imports from ${CLAUDE_PLUGIN_DATA} when the checkout itself has no node_modules. */
function fallBackTo(data) {
	const parentURL = pathToFileURL(join(data, "package.json")).href;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			try {
				return nextResolve(specifier, context);
			} catch (error) {
				if (!PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) throw error;
				return nextResolve(specifier, { ...context, parentURL });
			}
		},
	});
}

async function main() {
	const mcp = new StdioMcp();
	if (process.env.TOILET_PI_CLAUDE === "0") return;
	if (!PACKAGES.every((name) => resolvableFrom(ROOT, name))) {
		const data = process.env.CLAUDE_PLUGIN_DATA;
		if (!data) throw new Error(`missing ${PACKAGES.join(", ")}: run npm install in ${ROOT}`);
		await installInto(data);
		fallBackTo(data);
	}
	const { Bridge } = await import("./bridge.js");
	const bridge = new Bridge({ mcp });
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void bridge.stop());
	await bridge.start();
}

main().catch((error) => {
	// Stay up as an inert MCP server: a failed server would only add noise to Claude Code's /mcp list.
	log(`not started: ${error instanceof Error ? error.message : String(error)}`);
});
