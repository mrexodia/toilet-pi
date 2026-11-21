import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ControlError, ToiletPiClient } from "../../cli/client.js";
import { Reporter } from "../src/orchestrate.ts";

const definition = Reporter.definition;
type WaitTask = Parameters<typeof definition.phases.wait>[0];
type Runtime = Parameters<typeof definition.phases.wait>[1];
type NextState = Exclude<Awaited<ReturnType<Parameters<Runtime["commit"]>[0]>>, undefined>;

/** Exercise the real phase handlers, without credentials, networking, clocks, or model calls. */
function fixture(t: TestContext, response: Record<string, unknown> | Error, attempt = 1, restored?: NextState) {
	const names = ["TOILET_PI_CLI_SERVER", "TOILET_PI_ORCHESTRATOR_TOKEN", "TOILET_PI_ADMIN_TOKEN"] as const;
	const previous = names.map(name => process.env[name]);
	t.after(() => names.forEach((name, i) => {
		if (previous[i] === undefined) delete process.env[name];
		else process.env[name] = previous[i];
	}));
	process.env.TOILET_PI_CLI_SERVER = "http://127.0.0.1:1/";
	process.env.TOILET_PI_ORCHESTRATOR_TOKEN = "isolated-test";
	delete process.env.TOILET_PI_ADMIN_TOKEN;
	const calls: { operation: string; fields: Record<string, unknown> | undefined }[] = [];
	let closed = 0;
	t.mock.method(ToiletPiClient.prototype, "connect", async function (this: ToiletPiClient) { return this; });
	t.mock.method(ToiletPiClient.prototype, "control", async (operation: string, fields?: Record<string, unknown>) => {
		calls.push({ operation, fields });
		if (operation === "history") return { history: { messages: [{ role: "assistant", text: "Finished the task" }] } };
		assert.equal(operation, "get_input", "a reporter must never resend the original work");
		if (response instanceof Error) throw response;
		return response;
	});
	t.mock.method(ToiletPiClient.prototype, "close", () => { closed++; });

	const task: WaitTask = {
		id: 73 as WaitTask["id"], conversationId: 1 as WaitTask["conversationId"],
		kind: definition.name, version: 1, background: true, abortRequested: false,
		input: { sessionGuid: "spark-session", inputId: "old-input", name: "spark-control", task: "unused" },
		state: { status: "running", checkpoint: { phase: "wait", attempt } },
	};
	let state: NextState = restored ?? task.state;
	const errors: unknown[] = [];
	const sleeps: number[] = [];
	const submissions: { type: string; content: string; whenBusy: string; requestId: string }[] = [];
	const runtime = {
		conversationId: task.conversationId,
		commit: async (change: Parameters<Runtime["commit"]>[0]) => {
			const next = await change({} as never, { ...task, state } as never);
			if (next !== undefined) state = structuredClone(next);
		},
		report: (error: unknown) => { errors.push(error); },
		now: () => 1000,
		sleep: async (until: number) => { sleeps.push(until); },
		// A busy main conversation receives the report as steering, with no memory-view preparation.
		snapshot: async () => ({ run: 99 }),
		conversation: async () => ({ submit: async (submission: typeof submissions[number]) => { submissions.push(submission); } }),
	} as unknown as Runtime;
	return {
		calls, errors, sleeps, submissions,
		get state() { return state; },
		get closed() { return closed; },
		async step() {
			assert.equal(state.status, "running");
			if (state.status !== "running") throw new Error("cannot schedule a terminal task");
			await definition.phases[state.checkpoint.phase]({ ...task, state } as never, runtime, BACKGROUND_CONTEXT);
		},
	};
}

for (const attempt of [1, 10523]) {
	test(`unknown_input ends polling and posts one outcome-unknown report (attempt ${attempt})`, async t => {
		// Deliberately not the hub's current wording: classification must use the code, not the message.
		const f = fixture(t, new ControlError("unknown_input", "Tracking record no longer exists"), attempt);
		await f.step();
		assert.equal(f.state.status, "running");
		assert.equal(f.state.checkpoint?.phase, "report");
		assert.deepEqual(f.errors, []);
		assert.deepEqual(f.sleeps, []);
		assert.equal(f.closed, 1);
		await f.step();
		assert.deepEqual(f.state, { status: "terminal", outcome: { status: "completed", result: null } });
		assert.deepEqual(f.calls, [{ operation: "get_input", fields: { sessionGuid: "spark-session", inputId: "old-input" } }]);
		assert.equal(f.submissions.length, 1);
		assert.match(f.submissions[0]!.content, /^\[spark-control\] report:.*old-input.*unknown/);
		assert.match(f.submissions[0]!.content, /may already have executed/);
		assert.match(f.submissions[0]!.content, /Do not automatically resend/);
		assert.equal(f.submissions[0]!.requestId, "report:73", "retain the durable submission deduplication key");
	});
}

test("a returned unknown status uses the same terminal reporting path", async t => {
	const f = fixture(t, { input: { state: "unknown" } });
	await f.step();
	await f.step();
	assert.equal(f.state.status, "terminal");
	assert.equal(f.calls.length, 1);
	assert.equal(f.submissions.length, 1);
	assert.match(f.submissions[0]!.content, /outcome.*unknown/);
	assert.deepEqual(f.errors, []);
	assert.deepEqual(f.sleeps, []);
});

for (const error of [new Error("Request timed out"), new Error("Disconnected"),
	new ControlError("overloaded", "unknown_input is not this error's code"), new Error("unknown_input: not a structured hub error")]) {
	test(`other failures still retry without resending: ${error.message}`, async t => {
		const f = fixture(t, error, 10523);
		await f.step();
		assert.deepEqual(f.state, { status: "running", checkpoint: { phase: "wait", attempt: 10524 } });
		assert.deepEqual(f.sleeps, [61000]);
		assert.equal(f.errors.length, 1);
		assert.match(String(f.errors[0]), /attempt 10523/);
		assert.equal(f.closed, 1);
		assert.equal(f.calls.length, 1);
		assert.deepEqual(f.submissions, []);
	});
}

test("settled inputs still report their answer", async t => {
	const f = fixture(t, { input: { state: "settled" } });
	await f.step();
	await f.step();
	assert.equal(f.state.status, "terminal");
	assert.deepEqual(f.calls.map(c => c.operation), ["get_input", "history"]);
	assert.equal(f.submissions[0]!.content, "[spark-control] report (input old-input settled): Finished the task");
});

test("a restored report checkpoint completes without reconnecting or polling", async t => {
	const f = fixture(t, new Error("must not poll"), 10523,
		JSON.parse(JSON.stringify({ status: "running", checkpoint: { phase: "report", text: "[spark-control] report: outcome unknown" } })));
	await f.step();
	assert.equal(f.state.status, "terminal");
	assert.equal(f.submissions.length, 1);
	assert.equal(f.submissions[0]!.requestId, "report:73");
	assert.deepEqual(f.calls, []);
	assert.equal(f.closed, 0);
	assert.deepEqual(f.errors, []);
	assert.deepEqual(f.sleeps, []);
});
