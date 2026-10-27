/**
 * How a hook finds its session's bridge. Claude Code spawns the bridge (an MCP server) and every hook command as
 * its own descendants, so the bridge listens on a socket named after its parent's pid (the `claude` process), and a
 * hook walks up its own ancestors until it finds one. No session ids need to be known in advance, and two Claude
 * sessions in the same folder never cross.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function runDir() {
	return process.env.TOILET_PI_CLAUDE_RUN_DIR || join(homedir(), ".claude", "toilet-pi", "run");
}

export function socketPath(claudePid) {
	return join(runDir(), `${claudePid}.sock`);
}

/** The parent of `pid`, or null. Linux reads /proc; macOS and the BSDs ask `ps`. */
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
	try {
		const parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim());
		return Number.isInteger(parent) && parent > 1 ? parent : null;
	} catch {
		return null;
	}
}

/** The bridge socket of the nearest ancestor that has one. */
export function findBridgeSocket(startPid = process.ppid, maxDepth = 8) {
	let pid = startPid;
	for (let depth = 0; pid && depth < maxDepth; depth++) {
		const path = socketPath(pid);
		if (existsSync(path)) return path;
		pid = parentOf(pid);
	}
	return null;
}

/** The command line of `pid` as argv, or null when it can't be read. */
export function commandLine(pid) {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
	} catch {
		// no procfs
	}
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
