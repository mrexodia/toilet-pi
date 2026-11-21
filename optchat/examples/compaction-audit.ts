/** Read-only compaction usage audit. No models, credentials, home extensions or network calls are loaded.
 * Run: node optchat/examples/compaction-audit.ts <optchat-home> [requests-since-ISO-date]
 * Output contains aggregate statistics, not prompts, summaries or tool results.
 */
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { apply, type Op } from "@earendil-works/chord/delta";
import { RequestLog, type StoredRequest } from "../src/requests.ts";
import { DurableReader } from "../src/viz/store.ts";
import { type ChatState } from "../src/optchat/docs.ts";
import { flat, NODE } from "../src/optchat/tree.ts";

const home = process.argv[2];
if (!home) throw new Error("Usage: node optchat/examples/compaction-audit.ts <optchat-home> [requests-since-ISO-date]");
const since = process.argv[3] === undefined ? undefined : Date.parse(process.argv[3]);
if (since !== undefined && !Number.isFinite(since)) throw new Error("Invalid requests-since date; use an ISO date/time with timezone");
const reader = new DurableReader(join(resolve(home), ".optchat", "agent.sqlite"));
const log = RequestLog.openReadOnly(join(resolve(home), ".optchat", "requests.sqlite"));
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
function text(message: any): string {
	return typeof message?.content === "string" ? message.content
		: (message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}
function increment(hist: Record<string, number>, key: string | number, n = 1): void {
	hist[key] = (hist[key] ?? 0) + n;
}
function distribution(values: number[]) {
	const a = values.slice().sort((a, b) => a - b);
	if (!a.length) return { n: 0 };
	return { n: a.length, min: a[0], median: a[Math.floor(a.length / 2)], p90: a[Math.floor(a.length * .9)],
		max: a.at(-1), mean: a.reduce((s, n) => s + n, 0) / a.length };
}
function counter() {
	return { calls: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, reasoningReported: 0, cost: 0 };
}
function count(c: ReturnType<typeof counter>, r: StoredRequest): void {
	c.calls++;
	c.input += r.usage?.input ?? 0;
	c.cached += r.usage?.cacheRead ?? 0;
	c.cacheWrite += r.usage?.cacheWrite ?? 0;
	c.output += r.usage?.output ?? 0;
	c.cost += r.usage?.cost ?? 0;
	const reasoning = (r.response?.usage as any)?.reasoning;
	if (typeof reasoning === "number") { c.reasoning += reasoning; c.reasoningReported++; }
}
function nodeKey(label: string): string | undefined {
	const leaf = /^compress message (\d+)/.exec(label);
	if (leaf) return `0/${leaf[1]}`;
	const merge = /^merge (\d+)\+(\d+) and /.exec(label);
	if (merge) { const n = 2 * Number(merge[2]); return `${Math.log2(n)}/${Number(merge[1]) / n}`; }
	return undefined;
}

try {
	// One coherent durable-store snapshot, including all revision deltas and node metadata.
	const lifetime = reader.read(() => {
		const doc = reader.chatDoc();
		if (doc === undefined) throw new Error("No Optchat conversation");
		const revisions = reader.revisions(doc, 0);
		const seq = revisions.at(-1)?.seq ?? 0;
		const built = reader.nodesBuilt(0, seq);
		const hist: Record<string, number> = {};
		const levels: Record<string, { builds: number; calls: number; atLimit: number }> = {};
		let state: ChatState | undefined;
		let unattributedCalls = 0;
		const nodeSizes: number[] = [];
		for (const list of built.values()) for (const n of list) nodeSizes.push(n.size);
		for (const rev of revisions) {
			const before = state?.usage.calls ?? 0;
			state = rev.kind === "base" ? JSON.parse(rev.content) : apply(state, JSON.parse(rev.content) as Op[]);
			const calls = state!.usage.calls - before;
			if (!calls) continue;
			const nodes = built.get(rev.seq) ?? [];
			// Current Build commits usage and its single node atomically. Do not invent attribution if that changes.
			if (nodes.length !== 1 || calls < 0) { unattributedCalls += calls; continue; }
			increment(hist, calls);
			const level = nodes[0]!.key.split("/")[0]!;
			const row = levels[level] ??= { builds: 0, calls: 0, atLimit: 0 };
			row.builds++; row.calls += calls; row.atLimit += Number(calls >= 5);
		}
		const builds = Object.values(hist).reduce((a, b) => a + b, 0);
		const first = state!.count ? reader.messageRecord(0)?.date : undefined;
		const last = state!.count ? reader.messageRecord(state!.count - 1)?.date : undefined;
		return { seq, indexedMessages: state!.count, messageDates: [first, last].map(t => t === undefined ? null : new Date(t).toISOString()),
			usage: state!.usage, builds, callsPerBuild: state!.usage.calls / builds, histogram: hist, byLevel: levels, unattributedCalls,
			nodes: nodeSizes.length, overTargetNodes: nodeSizes.filter(n => n > NODE).length, nodeSizes: distribution(nodeSizes),
			busy: Object.keys(state!.busy).length, failed: Object.keys(state!.failed ?? {}).length };
	});

	// Capture a request-id cutoff. Earlier completed rows are immutable; omit calls still running.
	const metas = log?.list(0, 1_000_000).filter(r => r.kind === "compaction" && (since === undefined || r.started >= since)) ?? [];
	const requests = metas.filter(r => r.ended !== null).flatMap(m => { const r = log!.get(m.id); return r ? [r] : []; });
	const groups = new Map<string, StoredRequest[]>();
	const reasons: Record<string, ReturnType<typeof counter>> = {};
	const models: Record<string, ReturnType<typeof counter>> = {};
	const settings = new Set<string>();
	const prefixHistory = new Map<string, StoredRequest[]>();
	const cacheTiming: Record<string, ReturnType<typeof counter>> = {};
	const sizes: number[] = [], toolSizes: number[] = [], systemSizes: number[] = [], sourceSizes: number[] = [], viewSizes: number[] = [];
	let flattenWouldFit = 0, toolCalls = 0, errors = 0, efficiencyPromptPresent = 0;
	for (const r of requests) {
		const label = r.label.replace(/ \(retry.*\)$/, "");
		const group = groups.get(label) ?? []; group.push(r); groups.set(label, group);
		const users = r.context.messages.filter(m => m.role === "user");
		const tail = text(users.at(-1));
		const reason = !r.label.includes("(retry") ? "initial" : tail.startsWith("Too long") ? "tooLong" : tail.startsWith("You called a tool") ? "toolCall" : "other";
		count(reasons[reason] ??= counter(), r);
		count(models[`${r.provider}/${r.model}`] ??= counter(), r);
		// Exclude session affinity identifiers from the report.
		settings.add(JSON.stringify(Object.fromEntries(Object.entries(r.settings).filter(([k]) => k !== "sessionId"))));
		const response = text(r.response).trim(); sizes.push(bytes(response));
		flattenWouldFit += Number(bytes(response) > NODE && bytes(flat(response)) <= NODE);
		toolCalls += Number(r.response?.content.some(b => b.type === "toolCall"));
		errors += Number(r.error !== null);
		const payload = r.payload as any;
		toolSizes.push(bytes(JSON.stringify(payload?.tools ?? [])));
		const systems = r.context.messages.filter(m => m.role === "system");
		const system = systems.map(m => text(m) + Object.values((m as any).sections ?? {}).join("\n")).join("\n");
		systemSizes.push(bytes(system));
		efficiencyPromptPresent += Number(system.includes("small, mechanical job"));
		const first = text(users[0]);
		const close = first.indexOf("\n</chat>\n");
		if (close >= 0) {
			// Exact same memory view + system + tools + model/settings. Different tasks are deliberately excluded.
			// End times are not cache-ready times; overlap is an opportunity indicator, not proof of duplicate prefill.
			const normalizedSystems = systems.map(({ timestamp, ...rest }) => rest);
			const prefix = JSON.stringify([r.provider, r.model, r.api, r.settings, normalizedSystems, first.slice(0, close), payload?.tools]);
			const key = createHash("sha256").update(prefix).digest("hex");
			const prior = prefixHistory.get(key) ?? [];
			const overlap = prior.some(p => p.started < r.started && p.ended! > r.started);
			const recent = prior.some(p => p.ended! <= r.started && r.started - p.ended! < 300_000);
			const timing = overlap ? "overlappingExactPrefix" : recent ? "completedExactPrefixWithin5min" : "noRecentExactPrefix";
			count(cacheTiming[`${reason === "initial" ? "initial" : "retry"}/${timing}`] ??= counter(), r);
			prior.push(r); prefixHistory.set(key, prior);
			viewSizes.push(bytes(first.slice(0, close)));
			const start = first.indexOf("\n<input>\n", close), end = first.lastIndexOf("\n</input>");
			if (start >= 0 && end >= start) sourceSizes.push(bytes(first.slice(start + "\n<input>\n".length, end)));
		}
	}
	const groupHistogram: Record<string, number> = {};
	const levels: Record<string, { groups: number; calls: number; retryCalls: number; initialOver: number; bestOver: number }> = {};
	const attemptOutcomes: Record<string, { calls: number; fits: number; over: number; empty: number; errors: number }> = {};
	const firstSizes: number[] = [], bestSizes: number[] = [];
	const reductions: number[] = [];
	let incompleteGroups = 0, fiveCallsAllOver = 0, retryNoNewBest = 0, retriesMeasured = 0, noLineGroups = 0;
	let bestByTwoOver = 0, bestByThreeOver = 0, rescuedAfterTwo = 0, rescuedAfterThree = 0, repeatedResponses = 0;
	const buildAttempts: StoredRequest[][] = [];
	for (const [label, group] of groups) {
		increment(groupHistogram, group.length);
		if (group[0]!.label.includes("(retry")) incompleteGroups++;
		const key = nodeKey(label);
		const l = key?.split("/")[0] ?? "unknown";
		const row = levels[l] ??= { groups: 0, calls: 0, retryCalls: 0, initialOver: 0, bestOver: 0 };
		row.groups++; row.calls += group.length; row.retryCalls += group.filter(r => r.label.includes("(retry")).length;
		const lengths = group.map(r => bytes(text(r.response).trim()));
		firstSizes.push(lengths[0]!);
		row.initialOver += Number(lengths[0]! > NODE);
		const nonempty = lengths.filter(n => n > 0);
		if (!nonempty.length) noLineGroups++;
		const best = nonempty.length ? Math.min(...nonempty) : Infinity;
		if (Number.isFinite(best)) bestSizes.push(best);
		row.bestOver += Number(Number.isFinite(best) && best > NODE);
		let priorBest = Infinity;
		const priorText = new Set<string>();
		let attempt = 0;
		let series: StoredRequest[] = [];
		for (const r of group) {
			if (!r.label.includes("(retry") || series.length === 0) {
				attempt = 0; priorBest = Infinity; priorText.clear();
				series = []; buildAttempts.push(series);
			}
			series.push(r);
			const out = attemptOutcomes[++attempt] ??= { calls: 0, fits: 0, over: 0, empty: 0, errors: 0 };
			const s = text(r.response).trim(), n = bytes(s);
			out.calls++; out.fits += Number(n > 0 && n <= NODE); out.over += Number(n > NODE); out.empty += Number(n === 0); out.errors += Number(r.error !== null);
			if (r.label.includes("(retry") && n > 0 && Number.isFinite(priorBest)) {
				retriesMeasured++; retryNoNewBest += Number(n >= priorBest); reductions.push(priorBest - n);
				repeatedResponses += Number(priorText.has(s));
			}
			if (n) { priorBest = Math.min(priorBest, n); priorText.add(s); }
		}
	}
	for (const series of buildAttempts) {
		const lengths = series.map(r => bytes(text(r.response).trim()));
		const best = Math.min(...lengths.filter(n => n > 0));
		const prefixBest = (n: number) => Math.min(...lengths.slice(0, n).filter(n => n > 0));
		fiveCallsAllOver += Number(series.length === 5 && lengths.every(n => n > NODE));
		bestByTwoOver += Number(series.length > 2 && prefixBest(2) > NODE);
		bestByThreeOver += Number(series.length > 3 && prefixBest(3) > NODE);
		rescuedAfterTwo += Number(series.length > 2 && prefixBest(2) > NODE && best <= NODE);
		rescuedAfterThree += Number(series.length > 3 && prefixBest(3) > NODE && best <= NODE);
	}
	console.log(JSON.stringify({ auditedAt: new Date().toISOString(), lifetime,
		recorded: { since: since === undefined ? null : new Date(since).toISOString(), from: requests[0] ? new Date(requests[0].started).toISOString() : null,
			to: requests.at(-1) ? new Date(requests.at(-1)!.started).toISOString() : null,
			calls: requests.length, unfinished: metas.filter(r => r.ended === null).length, groups: groups.size, buildAttempts: buildAttempts.length,
			groupHistogram, incompleteGroups, noLineGroups, errors, reasons, models, settings: [...settings].map(s => JSON.parse(s)), byLevel: levels, cacheTiming,
			attemptOutcomes, fiveCallsAllOver, bestByTwoOver, rescuedAfterTwo, bestByThreeOver, rescuedAfterThree,
			retriesMeasured, retryNoNewBest, repeatedResponses, retryByteReduction: distribution(reductions),
			responseBytes: distribution(sizes), firstResponseBytes: distribution(firstSizes), bestResponseBytes: distribution(bestSizes),
			flattenWouldFit, toolCalls, efficiencyPromptPresent, wireToolSchemaBytes: distribution(toolSizes), systemTextBytes: distribution(systemSizes),
			viewBytes: distribution(viewSizes), sourceBytes: distribution(sourceSizes) },
		caveats: ["Lifetime usage belongs to successful build commits; first-call failures can be absent from it.",
			"The request log starts later than the durable session and may be pruned; do not mix denominators.",
			"The optional since filter applies only to recorded requests, not lifetime durable statistics; a build can cross its boundary.",
			"Request groups identify nodes, not build attempts: a failed task retried later can have multiple initial calls.",
			"Reasoning is reported separately by some providers but is already included in output; do not add it twice.",
			"No paid replay, model-quality evaluation or counterfactual token-savings measurement was performed."] }, null, 2));
} finally { log?.close(); reader.close(); }
