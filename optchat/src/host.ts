/**
 * The host: pi's model runtime, logins and settings, a durable Harness over SQLite in the agent's home directory,
 * pi-durable's coding tools, and the optchat memory on the root conversation.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	type HarnessSettings,
	type ModelRef,
	wrapTool,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";
import { type AgentConfig, readConfig, updateConfig } from "./config.ts";
import { Home, type Reload, selfExtension } from "./home.ts";
import { type ModelChoice, Optchat } from "./optchat/index.ts";
import { agentsExtension } from "./orchestrate.ts";

export type AgentOptions = {
	/** The agent's working directory; its memory lives in `.optchat/` under it, its settings in `optchat.json`. */
	readonly home: string;
	/** The session's name on the hub. */
	readonly name?: string;
	/** `provider/modelId` for the turns; pi's default model when absent. */
	readonly model?: string;
	/** `provider/modelId` for the compactions; the turns' model when absent. */
	readonly compactor?: string;
	readonly thinking?: string;
	readonly compactorThinking?: string;
	readonly context?: Context;
	readonly onReport?: (error: unknown) => void;
	/** Only read: no indexing, no compactions, no task scheduling. For status and view beside a running agent. */
	readonly readonly?: boolean;
};

export type Agent = {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly optchat: Optchat;
	readonly modelRuntime: ModelRuntime;
	readonly settings: SettingsManager;
	readonly home: string;
	/** The settings in effect: the home's `optchat.json` under the run's flags. */
	readonly config: AgentConfig;
	/** The session's name on the hub; without one, the hub shows the first message. */
	readonly name: string | undefined;
	/** Change and save the home's settings, for example after the hub switches the model. */
	saveConfig(patch: AgentConfig): Promise<AgentConfig>;
	/** Load the home's .env, skills and extensions again, in place. */
	reload(): Promise<Reload>;
	close(): Promise<void>;
};

const LOCK_STALE_MS = 60_000;
const LOCK_BEAT_MS = 15_000;

/**
 * One process owns a chat: an exclusive lock file in the home, refreshed while the process lives. A lock whose
 * process is gone, or that was not refreshed for a minute, is taken over.
 */
export async function takeLock(home: string): Promise<() => Promise<void>> {
	const file = join(home, ".optchat", "lock");
	const mine = JSON.stringify({ pid: process.pid, at: Date.now() });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await writeFile(file, mine, { flag: "wx" });
			break;
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST" || attempt === 1) throw error;
			let held: { pid?: number; at?: number } = {};
			try {
				held = JSON.parse(await readFile(file, "utf8")) as { pid?: number; at?: number };
			} catch {
				// unreadable: stale
			}
			let alive = false;
			if (typeof held.pid === "number" && held.pid !== process.pid) {
				try {
					process.kill(held.pid, 0);
					alive = true;
				} catch {
					alive = false;
				}
			}
			const fresh = typeof held.at === "number" && Date.now() - held.at < LOCK_STALE_MS;
			if (alive && fresh) {
				throw new Error(`another agent owns ${home} (process ${held.pid}); stop it first, or use another home`);
			}
			await unlink(file).catch(() => {});
		}
	}
	const beat = setInterval(() => {
		void writeFile(file, JSON.stringify({ pid: process.pid, at: Date.now() })).catch(() => {});
	}, LOCK_BEAT_MS);
	beat.unref();
	return async () => {
		clearInterval(beat);
		await unlink(file).catch(() => {});
	};
}

/** The coding tools with bash keeping its whole output, so the clip hook sees the head and the tail. */
const OutputLimits = defineExtension({
	name: "optchat-limits",
	wraps: [
		wrapTool(createBashTool(), (bash) => ({
			...bash,
			description:
				"Execute a bash command in the current working directory. Returns combined stdout and stderr, clipped to its " +
				"head and tail, 30,000 characters in all. Optionally provide a timeout in seconds.",
			outputLimits: { maxBytes: 8 * 1024 * 1024, maxLines: 1_000_000, retain: "head" },
		})),
	],
});

export function parseModel(spec: string | undefined): ModelRef | undefined {
	if (spec === undefined || spec === "") return undefined;
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`a model is provider/modelId, not ${spec}`);
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

function harnessSettings(settings: SettingsManager): HarnessSettings {
	return {
		compaction: { enabled: false, backgroundTokens: 0 },
		get stream() {
			const provider = settings.getProviderRetrySettings();
			const idle = settings.getHttpIdleTimeoutMs();
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get retry() {
			return settings.getRetrySettings();
		},
		steeringMode: "all",
		followUpMode: "all",
	};
}

/** The instructions that follow the system prompt: `instructions.md` in the home directory, if present. */
export async function readInstructions(home: string): Promise<string | undefined> {
	try {
		const text = (await readFile(join(home, "instructions.md"), "utf8")).trim();
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
}

export async function openAgent(options: AgentOptions): Promise<Agent> {
	const home = resolve(options.home);
	const context = options.context ?? BACKGROUND_CONTEXT;
	const report = options.onReport ?? ((error: unknown) => console.error(error));
	await mkdir(join(home, ".optchat"), { recursive: true });
	const registry = createRegistry();
	const additions = new Home(home, registry, report);
	await additions.loadEnv();
	const saved = await readConfig(home);
	const config: AgentConfig = {
		...saved,
		...(options.name === undefined ? {} : { name: options.name }),
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.thinking === undefined ? {} : { thinking: options.thinking }),
		...(options.compactor === undefined ? {} : { compactor: options.compactor }),
		...(options.compactorThinking === undefined ? {} : { compactorThinking: options.compactorThinking }),
	};
	const modelRuntime = await ModelRuntime.create();
	const settings = SettingsManager.create(home);
	registry.install(CodingTools);
	registry.install(OutputLimits);
	Optchat.install(registry, { home });
	registry.install(agentsExtension({ home }));
	// The home's own additions come last: the skills section, then the extensions. They reload in place.
	registry.install(selfExtension(additions));
	await additions.reload();
	const env = new NodeExecutionEnv({ cwd: home });
	const release = options.readonly ? async () => {} : await takeLock(home);
	const storage = await openNodeSqliteStorage(join(home, ".optchat", "agent.sqlite")).catch(async (error) => {
		await release();
		throw error;
	});
	const harness = await Harness.open(
		storage,
		{ models: modelRuntime, registry, settings: harnessSettings(settings), env: () => env, onReport: report },
		context,
	);
	try {
		const chosen = parseModel(config.model) ?? {
			provider: settings.getDefaultProvider() ?? "",
			modelId: settings.getDefaultModel() ?? "",
		};
		if (chosen.provider === "" || chosen.modelId === "") throw new Error("no model: pass --model provider/modelId or set pi's default");
		if (modelRuntime.getModel(chosen.provider, chosen.modelId) === undefined) {
			throw new Error(`model ${chosen.provider}/${chosen.modelId} is not available; log in with pi, or pick another with --model`);
		}
		const thinking = (config.thinking ?? settings.getDefaultThinkingLevel() ?? "medium") as ModelThinkingLevel;
		const root = await harness.root(context, { agent: { cwd: home, model: chosen, thinkingLevel: thinking } });
		const agent = await root.agent(context);
		const instructions = await readInstructions(home);
		const change = {
			...(config.model !== undefined && (agent.model?.provider !== chosen.provider || agent.model.modelId !== chosen.modelId)
				? { model: chosen }
				: {}),
			...(config.thinking !== undefined && agent.thinkingLevel !== thinking ? { thinkingLevel: thinking } : {}),
			...(agent.instructions !== instructions ? { instructions: instructions ?? null } : {}),
			...(agent.cwd !== home ? { cwd: home } : {}),
		};
		if (Object.keys(change).length > 0) await root.configure(change, context);
		// instructions.md is re-read before each turn, so an edit takes effect without a restart.
		const refreshInstructions = async (): Promise<void> => {
			const text = await readInstructions(home);
			const current = await root.agent(context);
			if (current.instructions !== text) await root.configure({ instructions: text ?? null }, context);
		};
		const optchat = new Optchat(harness, root, { home, context, onReport: report, beforeTurn: refreshInstructions });
		const compactor = parseModel(config.compactor);
		const compactorChoice: ModelChoice | undefined =
			compactor === undefined
				? config.compactorThinking === undefined
					? undefined
					: { ...chosen, thinkingLevel: config.compactorThinking }
				: { ...compactor, ...(config.compactorThinking === undefined ? {} : { thinkingLevel: config.compactorThinking }) };
		if (!options.readonly) {
			await optchat.configure(compactorChoice);
			harness.resume();
			await optchat.start();
			additions.watch((result) => {
				for (const error of result.errors) report(new Error(error));
			});
		}
		return {
			harness,
			root,
			optchat,
			modelRuntime,
			settings,
			home,
			config,
			name: config.name,
			saveConfig: (patch) => updateConfig(home, patch),
			reload: () => additions.reload(),
			close: async () => {
				additions.stop();
				await optchat.stop();
				await harness.close(context);
				await env.cleanup(context);
				await release();
			},
		};
	} catch (error) {
		await harness.close(context).catch(() => {});
		await release();
		throw error;
	}
}
