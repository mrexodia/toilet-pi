/**
 * Steering other agents through the Toilet-Pi hub: tools to list sessions, send them work, read their history,
 * abort them and start new ones, and a durable reporter task that waits for an input to settle and posts the answer
 * back into the chat as a message starting "[Name] report". The agent never waits or polls itself.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTask, defineTool, type Extension, LiveDoc } from "@earendil-works/pi-durable";
import { createAuthStore, resolveCredentials } from "../../cli/auth.js";
import { type HubHost, type HubSession, ToiletPiClient } from "../../cli/client.js";
import { ChatDoc } from "./optchat/docs.ts";
import { stateLine } from "./optchat/extension.ts";
import { first, headOf } from "./optchat/memory.ts";
import type { Part } from "./optchat/tree.ts";

const WAIT_MS = 60_000;

/** A connected hub client with the CLI's saved login or the environment's token. */
export async function hubClient(timeoutMs = 20_000): Promise<ToiletPiClient> {
	const store = createAuthStore(process.env.TOILET_PI_AUTH_FILE || undefined);
	const credentials = await resolveCredentials(
		{
			...(process.env.TOILET_PI_CLI_SERVER ? { serverUrl: process.env.TOILET_PI_CLI_SERVER } : {}),
			...(process.env.TOILET_PI_ADMIN_TOKEN ? { token: process.env.TOILET_PI_ADMIN_TOKEN } : {}),
			...(process.env.TOILET_PI_ORCHESTRATOR_TOKEN ? { orchestratorToken: process.env.TOILET_PI_ORCHESTRATOR_TOKEN } : {}),
		},
		store,
	);
	return new ToiletPiClient({ ...credentials, timeoutMs }).connect();
}

async function selfGuid(home: string): Promise<string | undefined> {
	try {
		return (JSON.parse(await readFile(join(home, ".optchat", "runner.json"), "utf8")) as { sessionGuid?: string }).sessionGuid;
	} catch {
		return undefined;
	}
}

type Found = { session: HubSession; host: HubHost };

function sessions(hosts: readonly HubHost[]): Found[] {
	return hosts.flatMap((host) => host.sessions.map((session) => ({ session, host })));
}

/** A session by id prefix, or by name or directory. */
function resolve(hosts: readonly HubHost[], reference: string): Found {
	const all = sessions(hosts);
	const byId = all.filter(({ session }) => session.sessionGuid.startsWith(reference));
	if (byId.length === 1) return byId[0]!;
	if (byId.length > 1) throw new Error(`${reference} matches ${byId.length} sessions; use a longer id`);
	const byName = all.filter(({ session }) => session.sessionName === reference || session.cwd === reference);
	if (byName.length === 1) return byName[0]!;
	if (byName.length > 1) throw new Error(`${reference} names ${byName.length} sessions; use an id`);
	throw new Error(`no session ${reference}; list them with agents()`);
}

function state(session: HubSession): string {
	if (session.owner === null && session.runnerStatus !== "running") return "inactive";
	return session.busy ? "busy" : "idle";
}

function label(found: Found): string {
	return found.session.sessionName || found.session.cwd || found.session.sessionGuid.slice(0, 8);
}

function reply(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

type ReporterInput = { sessionGuid: string; name: string; inputId: string; task: string };
type ReporterState = { phase: "wait"; attempt: number } | { phase: "report"; text: string };

/** Waits for one input on another session to settle, then posts its answer into the chat. */
export const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "agents.reporter",
	version: 1,
	initial: () => ({ phase: "wait", attempt: 1 }),
	phases: {
		wait: async (task, runtime, context) => {
			const { sessionGuid, name, inputId } = task.input;
			let text: string | undefined;
			let client: ToiletPiClient | undefined;
			try {
				client = await hubClient(WAIT_MS);
				const input = await client.waitInput(sessionGuid, inputId);
				if (input.state === "unknown") {
					text = `[${name}] report: the outcome of input ${inputId} is unknown (the session disconnected or the hub lost track of it); read its history to see what happened.`;
				} else {
					let answer = "(no answer text)";
					try {
						const { history } = (await client.control("history", { sessionGuid, last: 12 })) as {
							history: { messages: { role: string; text: string }[] };
						};
						const last = [...history.messages].reverse().find((m) => m.role === "assistant" && m.text.trim() !== "");
						if (last !== undefined) answer = last.text;
					} catch (error) {
						answer = `(its history could not be read: ${error instanceof Error ? error.message : String(error)})`;
					}
					text = `[${name}] report (input ${inputId} ${input.state}): ${answer}`;
				}
			} catch (error) {
				// A timeout or a disconnect: try again from a new checkpoint, with a little patience.
				const attempt = task.state.checkpoint.attempt;
				runtime.report(new Error(`reporter for ${name}: ${error instanceof Error ? error.message : String(error)} (attempt ${attempt})`));
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait", attempt: attempt + 1 } }), context);
				await runtime.sleep(runtime.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)), context);
				return;
			} finally {
				client?.close();
			}
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", text: text! } }), context);
		},
		report: async (task, runtime, context) => {
			const text = task.state.checkpoint.text;
			const main = (await runtime.conversation(runtime.conversationId, context))!;
			const busy = (await runtime.snapshot(LiveDoc, runtime.conversationId, context))?.run !== undefined;
			if (!busy) {
				// Like a typed turn: wait a little for the tree, then freeze the view for the run.
				for (let k = 0; k < 30; k++) {
					const chat = await runtime.snapshot(ChatDoc, runtime.conversationId, context);
					if (chat === undefined || first(chat) >= chat.count) break;
					await runtime.sleep(runtime.now() + 1000, context);
				}
				await runtime.commit(async (tx) => {
					const chat = await tx.doc(ChatDoc, runtime.conversationId);
					chat.turn = { first: chat.count, parts: chat.view.parts.map((p) => [...p] as Part), head: headOf(text), state: stateLine(task.input.task) };
					return undefined;
				}, context);
			}
			await main.submit({ type: "input", content: text, whenBusy: "steer", requestId: `report:${task.id}` }, context);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export function agentsExtension(options: { readonly home: string }): Extension {
	return defineExtension({
		name: "agents",
		tasks: [Reporter],
		tools: [
			defineTool({
				name: "agents",
				description:
					"List the other agents (pi sessions) on the Toilet-Pi hub: id, host, state and name or directory. " +
					"Inactive sessions can be resumed with agent_resume.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async (_args, _api, _context) => {
					const self = await selfGuid(options.home);
					const client = await hubClient();
					try {
						const rows = sessions(client.overview?.hosts ?? [])
							.filter(({ session }) => session.sessionGuid !== self)
							.map(({ session, host }) => `${session.sessionGuid}  ${host.hostname}${host.connected ? "" : " (no supervisor)"}  ${state(session)}  ${session.sessionName || session.cwd || ""}`);
						return reply(rows.length === 0 ? "No other sessions." : rows.join("\n"));
					} finally {
						client.close();
					}
				},
			}),
			defineTool({
				name: "agent_send",
				description:
					"Send a task or message to another agent on the hub, by session id prefix, name or directory. Returns at " +
					"once; the agent's answer reaches you later as a message starting \"[name] report\". mode: prompt (the " +
					"session must be idle), steer (joins its current work) or followUp (after its current work).",
				parameters: Type.Object({
					session: Type.String(),
					text: Type.String(),
					mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")])),
				}),
				replay: "unsafe",
				execute: async (args, api, context) => {
					const inputId = randomUUID();
					const client = await hubClient();
					let found: Found;
					try {
						found = resolve(client.overview?.hosts ?? [], args.session);
						if (state(found.session) === "inactive") return reply(`${label(found)} is inactive: resume it first with agent_resume.`);
						await client.control("send", {
							sessionGuid: found.session.sessionGuid,
							inputId,
							text: args.text,
							mode: args.mode ?? "prompt",
							requireSettled: true,
						});
					} catch (error) {
						return reply(`Not sent: ${error instanceof Error ? error.message : String(error)}`);
					} finally {
						client.close();
					}
					const name = label(found);
					await api.createTask(
						Reporter,
						{ sessionGuid: found.session.sessionGuid, name, inputId, task: options.home },
						{ ownership: { kind: "conversation" }, background: true },
						context,
					);
					return reply(`Sent input ${inputId} to ${name} (${found.session.sessionGuid}). Its report will arrive as a message starting "[${name}] report". Go on with other work or end your turn.`);
				},
			}),
			defineTool({
				name: "agent_history",
				description: "The recent transcript of another agent on the hub: the last N messages (default 20).",
				parameters: Type.Object({ session: Type.String(), last: Type.Optional(Type.Number()) }),
				replay: "safe",
				execute: async (args) => {
					const client = await hubClient();
					try {
						const found = resolve(client.overview?.hosts ?? [], args.session);
						const { history } = (await client.control("history", {
							sessionGuid: found.session.sessionGuid,
							last: Math.max(1, Math.min(200, Math.floor(args.last ?? 20))),
						})) as { history: { messages: { role: string; text: string; toolName?: string }[]; hasMore: boolean } };
						const rows = history.messages.map((m) => `${m.role === "toolResult" ? `tool ${m.toolName ?? ""}` : m.role}: ${m.text.replace(/\s+/g, " ").slice(0, 2000)}`);
						return reply(`${label(found)} (${found.session.sessionGuid}), ${state(found.session)}${history.hasMore ? ", earlier messages omitted" : ""}:\n${rows.join("\n") || "(empty)"}`);
					} catch (error) {
						return reply(error instanceof Error ? error.message : String(error));
					} finally {
						client.close();
					}
				},
			}),
			defineTool({
				name: "agent_abort",
				description: "Interrupt another agent's current work on the hub. Its queued inputs are not cleared.",
				parameters: Type.Object({ session: Type.String() }),
				replay: "unsafe",
				execute: async (args) => {
					const client = await hubClient();
					try {
						const found = resolve(client.overview?.hosts ?? [], args.session);
						const data = await client.control("abort", { sessionGuid: found.session.sessionGuid });
						return reply(`${label(found)}: abort ${String(data.status ?? "requested")}.`);
					} catch (error) {
						return reply(error instanceof Error ? error.message : String(error));
					} finally {
						client.close();
					}
				},
			}),
			defineTool({
				name: "agent_resume",
				description: "Start an inactive session on the hub again in the background, so it can take input.",
				parameters: Type.Object({ session: Type.String() }),
				replay: "unsafe",
				execute: async (args) => {
					const client = await hubClient(90_000);
					try {
						const found = resolve(client.overview?.hosts ?? [], args.session);
						const data = await client.control("resume", { sessionGuid: found.session.sessionGuid }, 90_000);
						return reply(`${label(found)}: ${String(data.status ?? "running")}.`);
					} catch (error) {
						return reply(error instanceof Error ? error.message : String(error));
					} finally {
						client.close();
					}
				},
			}),
			defineTool({
				name: "agent_new",
				description: "Start a new pi session in a directory on a host of the hub (the directory must exist there). Returns its id.",
				parameters: Type.Object({ host: Type.String(), cwd: Type.String() }),
				replay: "unsafe",
				execute: async (args) => {
					const client = await hubClient(90_000);
					try {
						const hosts = client.overview?.hosts ?? [];
						const host = hosts.find((h) => h.hostId === args.host || h.hostname === args.host || h.hostId.startsWith(args.host));
						if (host === undefined) return reply(`no host ${args.host}; hosts: ${hosts.map((h) => `${h.hostId} (${h.hostname})`).join(", ") || "none"}`);
						const data = await client.control("new", { hostId: host.hostId, cwd: args.cwd }, 90_000);
						return reply(`Started session ${String(data.sessionGuid)} on ${host.hostname} in ${args.cwd}. Send it work with agent_send.`);
					} catch (error) {
						return reply(error instanceof Error ? error.message : String(error));
					} finally {
						client.close();
					}
				},
			}),
		],
	});
}
