#!/usr/bin/env node
/**
 * The one hook command for every Claude Code event Toilet-Pi uses. It hands the hook's JSON to this session's
 * bridge and prints whatever the bridge answers (only PreToolUse/PostToolUse ever answer, to stop a run that was
 * aborted remotely). It always fails open: no bridge, a slow bridge or any error means "carry on as if not here".
 */

import { appendFileSync } from "node:fs";
import { connect } from "node:net";
import { bridgeCandidates } from "./ipc.js";

const REPLY_TIMEOUT_MS = 3000;

function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", () => resolve(data));
	});
}

/**
 * Hand the hook to the bridge at `path`. Resolves `{ connected: false }` when nothing listens there (so the next
 * candidate can be tried), else `{ connected: true, reply }`, with a null reply on a bad or slow answer.
 */
function ask(path, payload) {
	return new Promise((resolve) => {
		const socket = connect(path);
		let connected = false;
		let buffer = "";
		const done = (reply) => {
			clearTimeout(timer);
			socket.destroy();
			resolve({ connected, reply });
		};
		const timer = setTimeout(() => done(null), REPLY_TIMEOUT_MS);
		socket.on("connect", () => {
			connected = true;
			socket.write(`${JSON.stringify(payload)}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				done(JSON.parse(buffer.slice(0, newline)));
			} catch {
				done(null);
			}
		});
		socket.on("error", () => done(null));
	});
}

async function main() {
	if (process.env.TOILET_PI_CLAUDE === "0") return;
	const raw = await readStdin();
	let input;
	try {
		input = JSON.parse(raw);
	} catch {
		return;
	}
	// At startup the bridge may still be binding its endpoint: SessionStart waits for it briefly.
	const deadline = Date.now() + (input.hook_event_name === "SessionStart" ? 5000 : 0);
	for (;;) {
		for (const path of bridgeCandidates(process.env, process.ppid, input.session_id)) {
			const { connected, reply } = await ask(path, input);
			if (!connected) continue;
			if (reply?.output) process.stdout.write(`${JSON.stringify(reply.output)}\n`);
			return;
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	// Nothing answered: say so in the bridge's log, if there is one, so a broken lookup is visible.
	if (process.env.TOILET_PI_CLAUDE_LOG) {
		const tried = bridgeCandidates(process.env, process.ppid, input.session_id).join(", ");
		try {
			appendFileSync(process.env.TOILET_PI_CLAUDE_LOG, `[toilet-pi hook] ${new Date().toISOString()} ${input.hook_event_name}: no bridge answered (CLAUDE_PID=${process.env.CLAUDE_PID ?? "-"}, ppid=${process.ppid}, session=${input.session_id ?? "-"}; tried ${tried})\n`);
		} catch {
			// logging must never break the hook
		}
	}
}

main().catch(() => {}).finally(() => process.exit(0));
