import { createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

export function getDefaultSessionDir() {
	return process.env.TOILET_PI_SESSION_DIR || path.join(homedir(), ".pi", "agent", "sessions");
}

export async function scanSessions(sessionDir = getDefaultSessionDir()) {
	try {
		await access(sessionDir);
	} catch {
		return [];
	}

	const files = [];
	await collectJsonlFiles(sessionDir, files);

	const sessions = [];
	for (const file of files) {
		const summary = await summarizeSessionFile(file);
		if (summary) sessions.push(summary);
	}

	sessions.sort((a, b) => b.updatedAt - a.updatedAt);
	return sessions;
}

async function collectJsonlFiles(dir, files) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectJsonlFiles(fullPath, files);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(fullPath);
		}
	}
}

async function summarizeSessionFile(sessionFile) {
	let header = null;
	let sessionName = null;
	let firstUserText = null;

	const stream = createReadStream(sessionFile, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of rl) {
			if (!line.trim()) continue;

			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (!header && entry.type === "session") {
				header = entry;
				continue;
			}

			if (!firstUserText && entry.type === "message" && entry.message?.role === "user") {
				firstUserText = extractPreview(entry.message);
			}

			if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
				sessionName = entry.name.trim();
			}
		}
	} finally {
		rl.close();
		stream.destroy();
	}

	if (!header?.id) return null;

	const info = await stat(sessionFile);
	return {
		sessionGuid: header.id,
		sessionFile,
		cwd: header.cwd || null,
		sessionName,
		preview: firstUserText,
		updatedAt: info.mtimeMs,
	};
}

function extractPreview(message) {
	if (typeof message.content === "string") {
		return compactText(message.content);
	}

	if (!Array.isArray(message.content)) return null;

	const text = message.content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (part.type === "text") return part.text || "";
			if (part.type === "image") return "[image]";
			return "";
		})
		.join(" ");

	return compactText(text);
}

function compactText(text) {
	const trimmed = String(text || "").replace(/\s+/g, " ").trim();
	if (!trimmed) return null;
	return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}
