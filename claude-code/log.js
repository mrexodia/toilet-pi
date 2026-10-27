import { appendFileSync } from "node:fs";

const LOG_FILE = process.env.TOILET_PI_CLAUDE_LOG;

/** stderr (Claude Code's debug log keeps little of it), plus TOILET_PI_CLAUDE_LOG when set. */
export function log(text) {
	const line = `[toilet-pi] ${new Date().toISOString()} ${text}\n`;
	process.stderr.write(line);
	if (LOG_FILE) {
		try {
			appendFileSync(LOG_FILE, line);
		} catch {
			// logging must never break the bridge
		}
	}
}

export const logToFile = LOG_FILE !== undefined && LOG_FILE !== "";
