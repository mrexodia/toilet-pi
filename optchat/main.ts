#!/usr/bin/env node
/**
 * toilet-pi agent: a long-running agent with a memory that never ends, on pi-durable.
 *
 *   node main.ts [options]                  chat: each line you type is a turn
 *   node main.ts [options] say "..."        one turn, then exit
 *   node main.ts [options] note "..."       log a memory from before the chat
 *   node main.ts [options] compact          build every pending node, then exit
 *   node main.ts [options] status           counts, sizes and usage
 *   node main.ts [options] view             the view as the model sees it
 *   node main.ts [options] zoom ID [N [AT]] open a line of the view
 *   node main.ts [options] page [FILE]      write the whole memory as one HTML page (default: .optchat/memory.html)
 *   node main.ts [options] serve            run as a session on the Toilet-Pi hub, until stopped
 *   node main.ts [options] setup            choose the name, the models and the hub, saved in the home's optchat.json
 *
 * Options, and the environment variables behind them:
 *   --home DIR         OPTCHAT_HOME         the agent's working directory (default: ~/.optchat-agent)
 *   --model P/M        OPTCHAT_MODEL        the turns' model, as provider/modelId (default: pi's default model)
 *   --compactor P/M    OPTCHAT_COMPACTOR    the compactions' model (default: the turns' model)
 *   --thinking LEVEL   OPTCHAT_THINKING     the turns' thinking level (default: pi's default)
 *   --compactor-thinking LEVEL              the compactions' thinking level
 *   --name NAME        OPTCHAT_NAME         the session's name on the hub (default: none; the hub shows the first message)
 *
 * Models and logins are pi's: run `pi` and `/login` for a subscription, or add a provider to pi's models.json.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentEvent, type EntryRecord, watchEvents } from "@earendil-works/pi-durable";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAuthStore, promptLogin } from "../cli/auth.js";
import { authenticateAdmin } from "../cli/client.js";
import { parseToiletPiInput, readToiletPiConfig, redactUrlTokens, toBrowserBaseUrl, writeToiletPiConfig } from "../toilet-pi-config.js";
import { readConfig, writeConfig } from "./src/config.ts";
import { type Agent, openAgent, parseModel } from "./src/host.ts";
import { renderPage } from "./src/page.ts";
import { StreamedMessage } from "./src/stream.ts";
import { Runner } from "./src/runner.ts";
import type { ChatState } from "./src/optchat/index.ts";
import { contentText } from "./src/optchat/memory.ts";

const context = BACKGROUND_CONTEXT;
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

function usage(): string {
	return `toilet-pi agent

  node main.ts [options]                  chat: each line you type is a turn
  node main.ts [options] say "..."        one turn, then exit
  node main.ts [options] note "..."       log a memory from before the chat
  node main.ts [options] compact          build every pending node, then exit
  node main.ts [options] status           counts, sizes and usage
  node main.ts [options] view             the view as the model sees it
  node main.ts [options] zoom ID [N [AT]] open a line of the view
  node main.ts [options] page [FILE]      write the whole memory as one HTML page (default: .optchat/memory.html)
  node main.ts [options] serve            run as a session on the Toilet-Pi hub, until stopped
  node main.ts [options] setup            choose the name, the models and the hub; saved in the home's optchat.json

Options (environment variable); each overrides the home's optchat.json for one run:
  --home DIR               (OPTCHAT_HOME)       the agent's working directory; default ~/.optchat-agent
  --model provider/id      (OPTCHAT_MODEL)      the turns' model; default: pi's default model
  --compactor provider/id  (OPTCHAT_COMPACTOR)  the compactions' model; default: the turns' model
  --thinking LEVEL         (OPTCHAT_THINKING)   the turns' thinking level
  --compactor-thinking LEVEL                    the compactions' thinking level
  --name NAME              (OPTCHAT_NAME)       the session's name on the hub; default none: the hub shows the first message

The hub is the one \`/toilet-pi setup\` saved in pi (or TOILET_PI_SERVER_URL); the agent's own tools for other
sessions use the CLI's saved login (\`toilet-pi login\`) or TOILET_PI_ORCHESTRATOR_TOKEN with TOILET_PI_CLI_SERVER.
Models and logins are pi's: run \`pi\`, then \`/login\`, or add a provider to ~/.pi/agent/models.json.`;
}

type Options = { home: string; model?: string; compactor?: string; thinking?: string; compactorThinking?: string; name?: string };

function parseArgs(argv: string[]): { options: Options; rest: string[] } {
	const options: Options = {
		home: process.env.OPTCHAT_HOME || join(homedir(), ".optchat-agent"),
		...(process.env.OPTCHAT_MODEL ? { model: process.env.OPTCHAT_MODEL } : {}),
		...(process.env.OPTCHAT_COMPACTOR ? { compactor: process.env.OPTCHAT_COMPACTOR } : {}),
		...(process.env.OPTCHAT_THINKING ? { thinking: process.env.OPTCHAT_THINKING } : {}),
		...(process.env.OPTCHAT_NAME ? { name: process.env.OPTCHAT_NAME } : {}),
	};
	const rest: string[] = [];
	const names: Record<string, keyof Options> = {
		"--home": "home",
		"--model": "model",
		"--compactor": "compactor",
		"--thinking": "thinking",
		"--compactor-thinking": "compactorThinking",
		"--name": "name",
	};
	for (let k = 0; k < argv.length; k++) {
		const arg = argv[k]!;
		if (arg === "-h" || arg === "--help") {
			console.log(usage());
			process.exit(0);
		}
		const name = names[arg];
		if (name !== undefined) {
			const value = argv[++k];
			if (value === undefined) throw new Error(`missing value for ${arg}`);
			options[name] = value;
		} else rest.push(arg);
	}
	return { options, rest };
}

/** Streams a turn to the terminal: thoughts dimmed (shown, never logged), text plain, tools in one line each. */
class Printer {
	#mode: "text" | "mind" | undefined;
	readonly tty = process.stdout.isTTY === true;
	/** Whether any answer text was streamed. */
	printed = false;

	write(text: string): void {
		process.stdout.write(text);
	}

	delta(kind: "text" | "mind", text: string): void {
		if (kind !== this.#mode) {
			this.close();
			this.#mode = kind;
			if (kind === "mind" && this.tty) this.write(DIM);
		}
		if (kind === "text") this.printed = true;
		this.write(text);
	}

	close(): void {
		if (this.#mode === undefined) return;
		if (this.#mode === "mind" && this.tty) this.write(OFF);
		this.write("\n");
		this.#mode = undefined;
	}

	line(text: string): void {
		this.close();
		this.write(`${text}\n`);
	}

	dim(text: string): void {
		this.line(this.tty ? `${DIM}${text}${OFF}` : text);
	}
}

function resultHead(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0];
	if (message === undefined || message.role !== "toolResult") return "";
	const text = contentText(message.content);
	const head = text.trim().split("\n")[0]!.slice(0, 200);
	return head + (text.length > head.length ? `… (${text.length} characters)` : "");
}

function statusLine(chat: ChatState, bytes: number): string {
	const pending = chat.ready.reduce((n, q) => n + q.length, 0) + Object.keys(chat.busy).length;
	const parts = [`${chat.count} messages`, `view ${chat.view.parts.length} lines, ${(bytes / 1000).toFixed(1)} KB`];
	if (pending > 0) parts.push(`${pending} nodes pending`);
	if (chat.usage.calls > 0) parts.push(`compactions ${chat.usage.calls} calls, $${chat.usage.cost.toFixed(4)}`);
	return `· ${parts.join(" · ")}`;
}

function viewBytes(chat: ChatState): number {
	let n = 0;
	for (const p of chat.view.parts) n += chat.sizes[`${p[0]}/${p[1]}`] ?? 0;
	return n;
}

/** Print the conversation's events as they happen; returns a stop function. */
async function follow(agent: Agent, out: Printer, onRunEnd: () => void): Promise<() => Promise<unknown>> {
	const stream = await watchEvents(agent.harness, agent.root.id, context);
	const partial = new StreamedMessage();
	stream.start(async (events: readonly AgentEvent[]) => {
		for (const event of events) {
			switch (event.type) {
				case "message_start":
					if (event.message.role === "assistant") {
						const added = partial.start(event.message);
						if (added.thinking !== "") out.delta("mind", added.thinking);
						if (added.text !== "") out.delta("text", added.text);
					}
					break;
				case "message_update": {
					const added = partial.apply(event.changes);
					if (added.thinking !== "") out.delta("mind", added.thinking);
					if (added.text !== "") out.delta("text", added.text);
					break;
				}
				case "message_end":
					if (event.entry.model?.[0]?.role === "assistant") out.close();
					break;
				case "tool_execution_start":
					out.line(`» ${event.toolName} ${JSON.stringify(event.args).slice(0, 300)}`);
					break;
				case "tool_execution_end":
					out.line(`  ← ${resultHead(event.entry)}`);
					break;
				case "auto_retry_start":
					out.dim(`(retrying: ${event.errorMessage})`);
					break;
				case "task_failed":
					out.dim(`(task ${event.kind} failed: ${event.message})`);
					break;
				case "run_end":
					out.close();
					onRunEnd();
					break;
				default:
					break;
			}
		}
	});
	return () => stream.stop();
}

async function chat(agent: Agent, once: string | undefined): Promise<void> {
	const out = new Printer();
	let prompt = async (): Promise<void> => {};
	const stop = await follow(agent, out, () => void prompt());
	const say = async (text: string): Promise<void> => {
		if (await agent.optchat.busy()) {
			await agent.optchat.steer(text);
			out.dim("(sent to the running turn)");
			return;
		}
		await agent.optchat.turn(text, {
			onWait: (state) => out.dim(`(summarizing: ${state.ready.reduce((n, q) => n + q.length, 0) + Object.keys(state.busy).length} nodes to build)`),
		});
	};
	if (once !== undefined) {
		const submission = await agent.optchat.turn(once, { onWait: () => out.dim("(summarizing first)") });
		const settled = await submission.wait(context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		out.close();
		if (settled.status === "unanswered") out.line(`No reply: ${settled.reason}`);
		else if (settled.type === "input" && !out.printed) {
			const answer = await agent.root.commit((tx) => tx.entry(settled.answer), context);
			const message = answer?.model?.[0];
			if (message?.role === "assistant") out.line(message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
		}
		await agent.optchat.idle();
		out.dim(statusLine(await agent.optchat.state(), viewBytes(await agent.optchat.state())));
		await stop();
		return;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
	prompt = async () => {
		const state = await agent.optchat.state();
		out.dim(statusLine(state, viewBytes(state)));
		rl.setPrompt("> ");
		rl.prompt();
	};
	await prompt();
	await new Promise<void>((resolve) => {
		rl.on("line", (line) => {
			const text = line.trim();
			if (text === "" ) return rl.prompt();
			if (text === "exit" || text === "quit" || text === "/exit") return resolve();
			if (text === "/status") return void prompt();
			if (text === "/reload") {
				return void agent
					.reload()
					.then((r) => {
						const list = r.extensions.map((e) => `${e.name} [${e.tools.join(", ")}]`).join("; ") || "none";
						out.line(`extensions: ${list}${r.errors.length ? `\nerrors:\n  ${r.errors.join("\n  ")}` : ""}`);
					})
					.then(prompt);
			}
			if (text === "/view") return void agent.optchat.render().then((view) => out.line(view)).then(prompt);
			if (text.startsWith("/zoom ")) {
				const [id, n, at] = text.slice(6).trim().split(/\s+/).map(Number);
				return void agent.optchat.zoom(id ?? 0, n ?? 1, at ?? 0).then((got) => out.line(got)).then(prompt);
			}
			if (text.startsWith("/note ")) return void agent.optchat.note(text.slice(6)).then(prompt);
			void say(text).catch((error) => out.line(`No reply: ${error instanceof Error ? error.message : String(error)}`));
		});
		rl.on("close", () => resolve());
	});
	rl.close();
	await stop();
}

const INSTRUCTIONS = `# Instructions

These follow the system prompt in every call. Say who you are, how your files are organized, and how you want
work done. For example:

- I am ... My projects live in ...
- Prefer short answers. Ask before destructive commands.
`;

/** An interactive setup: the name, the models and their thinking levels, the hub, saved in optchat.json. */
async function setup(options: Options): Promise<number> {
	const home = resolve(options.home);
	await mkdir(join(home, ".optchat"), { recursive: true });
	const current = await readConfig(home);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// Piped answers (a script, or a test) come all at once and close the input, so they are read up front.
	const piped = process.stdin.isTTY ? undefined : (await new Promise<string>((resolve) => {
		let data = "";
		rl.on("line", (line) => (data += `${line}\n`));
		rl.once("close", () => resolve(data));
	})).split("\n");
	const ask = (question: string, fallback?: string): Promise<string> => {
		const prompt = fallback ? `${question} [${fallback}]: ` : `${question}: `;
		if (piped !== undefined) {
			const answer = (piped.shift() ?? "").trim();
			console.log(`${prompt}${answer}`);
			return Promise.resolve(answer || fallback || "");
		}
		return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim() || fallback || "")));
	};
	try {
		console.log(`Setting up the agent in ${home}\n`);
		const asked = await ask("Session name on the hub (empty or 'none': the hub shows the first message)", current.name ?? options.name);
		const name = asked.toLowerCase() === "none" ? "" : asked;
		const runtime = await ModelRuntime.create();
		const settings = SettingsManager.create(home);
		const models = runtime.getAvailableSnapshot();
		if (models.length === 0) console.log("No models are available: run pi and /login, or add a provider to pi's models.json.");
		else {
			console.log("\nAvailable models (pi's logins and models.json):");
			models.forEach((model, k) => console.log(`  ${String(k + 1).padStart(2)}. ${model.provider}/${model.id}`));
			console.log();
		}
		const pick = async (question: string, fallback: string | undefined): Promise<string> => {
			const answer = await ask(question, fallback);
			const n = Number(answer);
			if (Number.isInteger(n) && n >= 1 && n <= models.length) return `${models[n - 1]!.provider}/${models[n - 1]!.id}`;
			const ref = parseModel(answer);
			if (ref !== undefined && runtime.getModel(ref.provider, ref.modelId) === undefined) console.log(`  (warning: ${answer} is not available right now)`);
			return answer;
		};
		const levelsOf = (spec: string): string[] => {
			const ref = parseModel(spec);
			const model = ref === undefined ? undefined : runtime.getModel(ref.provider, ref.modelId);
			return model === undefined ? ["off", "minimal", "low", "medium", "high", "xhigh"] : [...getSupportedThinkingLevels(model)];
		};
		const piDefault = settings.getDefaultProvider() && settings.getDefaultModel() ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}` : undefined;
		const model = await pick("Turns' model (a number, or provider/id)", current.model ?? options.model ?? piDefault);
		const thinking = await ask(`Turns' thinking level (${levelsOf(model).join(", ")})`, current.thinking ?? options.thinking ?? settings.getDefaultThinkingLevel() ?? "medium");
		const compactor = await pick("Compactions' model: a fast, cheap one (a number, or provider/id)", current.compactor ?? options.compactor ?? model);
		const compactorThinking = await ask(`Compactions' thinking level (${levelsOf(compactor).join(", ")})`, current.compactorThinking ?? options.compactorThinking ?? "medium");
		await writeConfig(home, { name, model, thinking, compactor, compactorThinking });
		console.log(`\nSaved ${join(home, "optchat.json")}`);

		const hub = await readToiletPiConfig();
		const keep = hub ? "keep the saved one" : "";
		const url = await ask(
			hub ? `Toilet-Pi machine connect URL (saved: ${redactUrlTokens(hub.serverUrl)})` : "Toilet-Pi machine connect URL, from the web UI's Installation page (empty: skip)",
			keep,
		);
		if (url !== "" && url !== keep) {
			await writeToiletPiConfig(parseToiletPiInput(url));
			console.log("Saved the machine connect URL for pi and the agent.");
		}
		const store = createAuthStore();
		let login: Awaited<ReturnType<typeof store.read>> = null;
		let unusable = "";
		try {
			login = await store.read();
		} catch (error) {
			unusable = error instanceof Error ? error.message : String(error);
		}
		let wantsLogin = false;
		let serverUrl = "";
		if (login !== null) console.log(`Hub login for the agent's own tools: saved for ${login.serverUrl} (${store.path})`);
		else if (unusable !== "") console.log(`Hub login for the agent's own tools: ${store.path} exists but cannot be used: ${unusable}`);
		else console.log(`Hub login for the agent's own tools: none saved (${store.path})`);
		const question = login !== null ? "Log in again? (y/N)" : "Log in now for the agent's own hub tools (agents, agent_send, ...)? (y/N)";
		if (process.stdin.isTTY && (await ask(question, "n")).toLowerCase().startsWith("y")) {
			const saved = await readToiletPiConfig();
			serverUrl = await ask("Hub URL, http or https", saved ? toBrowserBaseUrl(saved.serverUrl) : undefined);
			wantsLogin = serverUrl !== "";
		} else if (login === null) console.log("You can log in later with `node cli/toilet-pi.js login`.");
		if (!existsSync(join(home, "instructions.md"))) {
			await writeFile(join(home, "instructions.md"), INSTRUCTIONS, "utf8");
			console.log(`Wrote a starter ${join(home, "instructions.md")}: edit it to say who you are and how you work.`);
		}
		rl.close();
		if (wantsLogin) {
			const token = await promptLogin("Admin token (hidden): ", { secret: true });
			const record = await authenticateAdmin({ serverUrl, token });
			await store.write(record);
			console.log(`Logged in to ${record.serverUrl}; saved ${store.path}`);
			process.stdin.pause();
		}
		console.log(`\nDone. Start it with:\n  npm run optchat -- --home "${home}" serve`);
		return 0;
	} finally {
		rl.close();
	}
}

async function main(): Promise<number> {
	const { options, rest } = parseArgs(process.argv.slice(2));
	const command = rest[0] ?? "chat";
	if (command === "setup") return setup(options);
	const readonly = command === "status" || command === "view" || command === "zoom" || command === "page";
	const agent = await openAgent({ ...options, readonly, onReport: (error) => console.error(`${DIM}(${error instanceof Error ? error.message : String(error)})${OFF}`) });
	try {
		switch (command) {
			case "chat":
				await chat(agent, undefined);
				break;
			case "say":
				await chat(agent, rest.slice(1).join(" "));
				break;
			case "note": {
				const text = rest.slice(1).join(" ");
				if (text.trim() === "") throw new Error("note needs a text");
				await (await agent.optchat.note(text)).wait(context);
				await agent.optchat.idle();
				console.log("note logged");
				break;
			}
			case "compact":
				await agent.optchat.idle({ onWait: (state) => console.log(`${state.ready.reduce((n, q) => n + q.length, 0) + Object.keys(state.busy).length} nodes to build`) });
				console.log("every node is built");
				break;
			case "status": {
				const state = await agent.optchat.state();
				console.log(`messages: ${state.count} (${state.count - (state.ready[0]?.[0] ?? state.count)} not summarized yet)`);
				console.log(`view: ${state.view.parts.length} lines, ${viewBytes(state)} bytes${state.view.batch ? ", merging at each message" : ""}`);
				console.log(`compactions' view: ${state.seen.parts.length} lines`);
				console.log(`nodes ready to build: ${state.ready.reduce((n, q) => n + q.length, 0)}, building: ${Object.keys(state.busy).length}`);
				console.log(`compactions: ${state.usage.calls} calls, ${state.usage.input} in, ${state.usage.output} out, $${state.usage.cost.toFixed(4)}`);
				const agentState = await agent.root.agent(context);
				console.log(`model: ${agentState.model?.provider}/${agentState.model?.modelId} (${agentState.thinkingLevel}); compactor: ${state.compactor ? `${state.compactor.provider}/${state.compactor.modelId}` : "the same"}`);
				console.log(`home: ${agent.home}`);
				break;
			}
			case "serve": {
				const out = new Printer();
				const stop = await follow(agent, out, () => {});
				const runner = new Runner({ agent, log: (text) => out.dim(text) });
				await runner.start();
				await new Promise<void>((resolve) => {
					process.once("SIGINT", () => resolve());
					process.once("SIGTERM", () => resolve());
				});
				out.dim("stopping");
				await runner.stop();
				await stop();
				break;
			}
			case "view":
				process.stdout.write(await agent.optchat.render());
				break;
			case "page": {
				const file = rest[1] ?? join(agent.home, ".optchat", "memory.html");
				await writeFile(file, await renderPage(agent.optchat), "utf8");
				console.log(file);
				break;
			}
			case "zoom": {
				const [id, n, at] = rest.slice(1).map(Number);
				if (id === undefined || Number.isNaN(id)) throw new Error("zoom ID [N [AT]]");
				console.log(await agent.optchat.zoom(id, n ?? 1, at ?? 0));
				break;
			}
			default:
				console.error(`no command ${command}\n\n${usage()}`);
				return 2;
		}
		return 0;
	} finally {
		await agent.close();
	}
}

main().then(
	(code) => {
		process.exitCode = code;
		// Let the handles close on their own; force the exit only if something keeps the loop alive.
		setTimeout(() => process.exit(code), 3000).unref();
	},
	(error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		setTimeout(() => process.exit(1), 3000).unref();
	},
);
