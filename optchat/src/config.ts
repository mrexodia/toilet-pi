/** The agent's own settings, kept in `optchat.json` in its home directory. Flags and environment override them for one run. */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AgentConfig = {
	/** The session's name on the hub. */
	name?: string;
	/** The turns' model, as provider/modelId. */
	model?: string;
	thinking?: string;
	/** The compactions' model, as provider/modelId; the turns' model when absent. */
	compactor?: string;
	compactorThinking?: string;
};

export const CONFIG_FILE = "optchat.json";

export function configPath(home: string): string {
	return join(home, CONFIG_FILE);
}

export async function readConfig(home: string): Promise<AgentConfig> {
	try {
		const parsed = JSON.parse(await readFile(configPath(home), "utf8")) as Record<string, unknown>;
		const config: AgentConfig = {};
		for (const key of ["name", "model", "thinking", "compactor", "compactorThinking"] as const) {
			const value = parsed[key];
			if (typeof value === "string" && value.trim() !== "") config[key] = value.trim();
		}
		return config;
	} catch {
		return {};
	}
}

export async function writeConfig(home: string, config: AgentConfig): Promise<void> {
	const clean = Object.fromEntries(Object.entries(config).filter(([, value]) => typeof value === "string" && value !== ""));
	await writeFile(configPath(home), `${JSON.stringify(clean, null, 2)}\n`, "utf8");
}

/** The saved config with a patch applied and written back. */
export async function updateConfig(home: string, patch: AgentConfig): Promise<AgentConfig> {
	const next = { ...(await readConfig(home)), ...patch };
	await writeConfig(home, next);
	return next;
}
