#!/usr/bin/env node
/**
 * The one hook command for every Claude Code event Toilet-Pi uses. It hands the hook's JSON to this session's
 * bridge and prints whatever the bridge answers (only PreToolUse/PostToolUse ever answer, to stop a run that was
 * aborted remotely). It always fails open: no bridge, a slow bridge or any error means "carry on as if not here".
 */

import { connect } from "node:net";
import { findBridgeSocket } from "./ipc.js";

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

function ask(path, payload) {
	return new Promise((resolve) => {
		const socket = connect(path);
		let buffer = "";
		const done = (value) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => done(null), REPLY_TIMEOUT_MS);
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
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
	// At startup the bridge may still be binding its socket: SessionStart waits for it briefly.
	const deadline = Date.now() + (input.hook_event_name === "SessionStart" ? 5000 : 0);
	let path = findBridgeSocket();
	while (path === null && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 200));
		path = findBridgeSocket();
	}
	if (path === null) return;
	const reply = await ask(path, input);
	if (reply?.output) process.stdout.write(`${JSON.stringify(reply.output)}\n`);
}

main().catch(() => {}).finally(() => process.exit(0));
