/** The agent's own settings, kept in `optchat.json` in its home directory. Flags and environment override them for one run. */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ChildRuntime = "pi" | "omp";

export function parseChildRuntime(value: unknown = "pi"): ChildRuntime {
	if (value === "pi" || value === "omp") return value;
	throw new Error("childRuntime must be pi or omp (optchat.json, --child-runtime, or OPTCHAT_CHILD_RUNTIME)");
}

export type AgentConfig = {
	/** The session's name on the hub. */
	name?: string;
	/** The turns' model, as provider/modelId. */
	model?: string;
	thinking?: string;
	/** The compactions' model, as provider/modelId; the turns' model when absent. */
	compactor?: string;
	compactorThinking?: string;
	/** Default runtime for agent_new and children launched by this runner; Pi when absent. */
	childRuntime?: ChildRuntime;
	/** Record every model request in `.optchat/requests.sqlite` for the visualizer; on when absent. */
	recordRequests?: boolean;
	/** The request log's size limit in megabytes; the oldest requests go first. 256 when absent. */
	requestLogMB?: number;
};

export const CONFIG_FILE = "optchat.json";

export function configPath(home: string): string {
	return join(home, CONFIG_FILE);
}

export async function readConfig(home: string): Promise<AgentConfig> {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(await readFile(configPath(home), "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	} catch {
		return {};
	}
	const config: AgentConfig = {};
	for (const key of ["name", "model", "thinking", "compactor", "compactorThinking"] as const) {
		const value = parsed[key];
		if (typeof value === "string" && value.trim() !== "") config[key] = value.trim();
	}
	if (parsed.childRuntime !== undefined) config.childRuntime = parseChildRuntime(parsed.childRuntime);
	if (typeof parsed.recordRequests === "boolean") config.recordRequests = parsed.recordRequests;
	if (typeof parsed.requestLogMB === "number" && Number.isFinite(parsed.requestLogMB) && parsed.requestLogMB > 0) {
		config.requestLogMB = parsed.requestLogMB;
	}
	return config;
}

export async function writeConfig(home: string, config: AgentConfig): Promise<void> {
	if (config.childRuntime !== undefined) parseChildRuntime(config.childRuntime);
	const clean = Object.fromEntries(
		Object.entries(config).filter(
			([, value]) => (typeof value === "string" && value !== "") || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)),
		),
	);
	await writeFile(configPath(home), `${JSON.stringify(clean, null, 2)}\n`, "utf8");
}

/** The saved config with a patch applied and written back. */
export async function updateConfig(home: string, patch: AgentConfig): Promise<AgentConfig> {
	const next = { ...(await readConfig(home)), ...patch };
	await writeConfig(home, next);
	return next;
}
