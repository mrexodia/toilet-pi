/**
 * How a hook finds its session's bridge. Claude Code starts the bridge (an MCP server) and every hook as its own
 * children, so the bridge listens on an endpoint named after its parent's pid (the `claude` process), and a hook
 * looks for the endpoint of the Claude process it belongs to: `CLAUDE_PID`, which Claude Code gives every hook.
 * No session ids need to be known in advance, and two Claude sessions in the same folder never cross.
 *
 * The endpoint is a Unix socket on macOS and Linux and a named pipe on Windows.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WINDOWS = process.platform === "win32";

export function runDir() {
	return process.env.TOILET_PI_CLAUDE_RUN_DIR || join(homedir(), ".claude", "toilet-pi", "run");
}

/** Where the bridge of the Claude Code process `claudePid` listens. */
export function endpoint(claudePid) {
	if (WINDOWS) return `\\\\.\\pipe\\toilet-pi-claude-${claudePid}`;
	return join(runDir(), `${claudePid}.sock`);
}

/** Endpoints are files only on POSIX: there a stale one is removed before listening. */
export const endpointIsFile = !WINDOWS;

/** The parent of `pid`, or null. Linux reads /proc; macOS and the BSDs ask `ps`. Not available on Windows. */
export function parentOf(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name is parenthesized and may itself contain spaces or parentheses.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const parent = Number(fields[1]);
		return Number.isInteger(parent) && parent > 1 ? parent : null;
	} catch {
		// no procfs
	}
	if (WINDOWS) return null;
	try {
		const parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim());
		return Number.isInteger(parent) && parent > 1 ? parent : null;
	} catch {
		return null;
	}
}

/**
 * The endpoints a hook should try, best first: the one for `CLAUDE_PID`, then the one for the hook's own parent
 * (Claude Code itself for an exec-form hook), then, on POSIX, any that exist for its further ancestors, which
 * covers a hook run through a shell by a Claude Code without `CLAUDE_PID`.
 */
export function bridgeCandidates(env = process.env, startPid = process.ppid, maxDepth = 8) {
	const out = [];
	const add = (pid) => {
		const path = endpoint(pid);
		if (!out.includes(path)) out.push(path);
	};
	const claudePid = Number(env.CLAUDE_PID);
	if (Number.isInteger(claudePid) && claudePid > 1) add(claudePid);
	add(startPid);
	if (WINDOWS) return out;
	let pid = parentOf(startPid);
	for (let depth = 1; pid && depth < maxDepth; depth++) {
		if (existsSync(endpoint(pid))) add(pid);
		pid = parentOf(pid);
	}
	return out;
}

/** The command line of `pid` as argv, or null when it can't be read (always on Windows). */
export function commandLine(pid) {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
	} catch {
		// no procfs
	}
	if (WINDOWS) return null;
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim().split(/\s+/);
	} catch {
		return null;
	}
}

/**
 * Whether `pid` is the Claude Code CLI: its executable or script is named `claude` (the native build) or lives in
 * the `@anthropic-ai/claude-code` package (an npm install). Checked before signalling it, so a bridge started any
 * other way (a test harness, a wrapper) never ends a process that isn't Claude Code.
 */
export function isClaudeCode(pid) {
	const argv = commandLine(pid);
	if (argv === null) return false;
	return argv.slice(0, 2).some((arg) => /(^|\/)claude(\.exe)?$/.test(arg) || arg.includes("@anthropic-ai/claude-code"));
}
