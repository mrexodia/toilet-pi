# Optchat compaction efficiency: canonical comparison and session measurements

Sections 1–6 record the **pre-optimization baseline**. See [Implementation follow-up](#implementation-follow-up) for the
changes made afterward, including the ChatGPT-login limitation discovered during real SDK payload tests.

## Scope

Read-only investigation on 2026-11-18 of `C:/Users/Admin/optchat/.optchat/{agent,requests}.sqlite`, compared with
`C:/CodeBlocks/UniiChat` at **0500bf6a8ea4bf0ce047488562022b1b6532cc30**. This is the same upstream revision as the
[earlier implementation review](optchat-unii-audit.md), with a deeper look at OpenAI caching, request coordination,
and actual shortening attempts. No live session/configuration was changed, no summaries were regenerated, and no
model requests were made. Upstream's production performance was not measured.

Reproduce the aggregate analysis (no prompt, summary or tool-result text is printed):

```sh
node optchat/examples/compaction-audit.ts C:/Users/Admin/optchat
```

The script uses the visualizer's read-only durable reader and the read-only request log. It does not load the home's
extensions, credentials or model runtime. The durable statistics are read in one transaction. Request analysis uses
completed rows through the captured request-id cutoff; these two stores are not one atomic cross-database snapshot.
A running session may advance between them.

## Main conclusions

1. **The binary tree, contextual summaries, five-attempt shortening and shortest-answer fallback are canonical.**
   The extra calls are not an accidental second summary pass introduced by Optchat.
2. **The retries are overwhelmingly length corrections, and the problem gets much worse higher in the tree.**
3. **There are canonical efficiency mechanisms missing from Optchat:** tool-free compaction requests, a final
   efficiency paragraph in the system prompt, OpenAI view-block cache breakpoints, and cache-writer coordination.
4. **There are optimizations worth trying without weakening the memory design.** Start with request/caching parity
   and benchmark prompt changes. Do not claim that cutting context or attempts is capability-neutral.
5. **The logs cannot prove a new prompt preserves memory quality.** That requires a paired replay and retrieval test,
   including upper-level merges, not just fewer tokens or a lower average call count.

## 1. Full-session accounting

Snapshot: durable sequence **1175154**, 459 indexed messages, first message 2026-10-09, latest 2026-11-18. The session
advanced since the earlier conversation's 482 builds / 846 calls. Those older numbers were **1.755 calls/build**;
this snapshot is **495 successful model-backed builds / 876 calls = 1.770 calls/build**.

There are 912 tree nodes in total: 495 model-backed and **417 requiring no model call**. Short sources already bypass
the model, including merges whose concatenated children fit. Usage is attributed by replaying chat revisions: each
successful Build atomically commits its usage and one node. All usage deltas in this snapshot were attributable.

| Calls in a successful build | Builds |
|---|---:|
| 1 | 325 |
| 2 | 76 |
| 3 | 28 |
| 4 | 15 |
| 5 | 51 |
| **Total** | **495** |

**65.7% finish in one call; 34.3% take more than one.** There are 381 calls beyond one per successful build, or 43.5%
of the 876 calls. A build can include a later error after a useful answer; first-call failures are not included in this
successful-build usage total.

| Messages covered by a node | Model-backed builds | Calls | Calls/build |
|---|---:|---:|---:|
| 1 | 179 | 221 | 1.23 |
| 2 | 105 | 146 | 1.39 |
| 4 | 101 | 184 | 1.82 |
| 8 | 57 | 126 | 2.21 |
| 16 | 28 | 89 | 3.18 |
| 32 | 14 | 60 | 4.29 |
| 64 | 7 | 31 | 4.43 |
| 128 | 3 | 14 | 4.67 |
| 256 | 1 | 5 | 5.00 |

The highest levels have small samples, but the trend is pronounced. Merging already dense summaries into 512 bytes
while retaining names, decisions and retrieval clues is harder than compressing an individual verbose message.

Upstream recognizes a depth-related cost too: `UniiChat/Import.ts:64-72,296-310` estimates 480-byte summaries and
includes a positive summary-depth cost term, described there as fitted to 5,617 real import compaction calls. That is
not a published retry-rate benchmark and does not establish that this session's rate is optimal.

## 2. What the extra calls actually do

The recorded-request window is **2026-10-25 through 2026-11-18**, not the whole durable session. It contains **621
compaction requests for 313 distinct nodes**: 316 initial attempts (three nodes were restarted after a failed initial
attempt), plus 305 correction calls. All recorded calls used `openai/gpt-6-luna`, reasoning `medium`.

| Request reason | Calls | Uncached input | Cache reads | Output |
|---|---:|---:|---:|---:|
| Initial | 316 | 2,506,674 | 667,776 | 45,661 |
| Too-long correction | 303 | 766,912 | 2,182,016 | 54,804 |
| Correction after a tool call | 2 | 8,650 | 9,472 | 364 |

**303 of 305 correction calls (99.3%) are shortening retries.** Four requests report errors, including a fifth-call
error after usable lines had already arrived. This is not primarily an outage/restart or accidental-tool-use problem.

The later request window is almost 1.98 calls per distinct node; do not substitute that denominator for the full-session
1.77. It contains a different mix of work and repeated failed initial attempts.

### Diminishing returns, but not zero returns

| Attempt within a build attempt | Requests | Nonempty answers at or below 512 bytes |
|---|---:|---:|
| 1 | 316 | 193 |
| 2 | 120 | 45 |
| 3 | 75 | 15 |
| 4 | 60 | 10 |
| 5 | 50 | 5 |

- **44 builds returned an over-limit line on all five calls.**
- On **97 of 302** comparable nonempty correction responses, the answer was not shorter than the best already seen.
- **18** comparable corrections repeated a prior response exactly.
- Median improvement relative to the previous best was only **20 bytes** (negative improvements are included).
- **46 stored nodes** in the full session exceed 512 bytes; the largest is **991 bytes**.
- Flattening summary newlines before measuring length would have rescued **zero** over-limit recorded responses.

The 512-byte limit is a **target, not an enforced final cap**, in both implementations. After five tries they keep the
shortest available answer, even if it is still long. Blindly slicing a useful answer to 512 bytes would be a behavior
change and could remove the only retrieval clue for an item.

Stopping at two attempts would have discarded **30 observed later successes at meeting the byte target**. Stopping at
three would have discarded **15**. This measures length compliance only: it does not say that the shortest line always
has the best facts, or that the extra attempts are necessary for quality. It does rule out calling a lower attempt cap
an obviously equivalent optimization.

### Token volume is not the same as expense

Corrections are **49.1% of recorded calls**, but only **23.6% of recorded uncached input**, because they cache better.
They account for about **31.2% of the request log's estimated compaction cost**. These are recorded model-rate estimates,
not an independently verified provider invoice.

Initial input cache-read share is **21.0%**; correction input cache-read share is **73.8%**. Deleting all corrections is
therefore not a realistic way to halve the uncached bill, even if it could be done without losing quality.

The response usage reports **10,388 reasoning tokens**, already included in 100,829 output tokens. That is about
10.3% of output, but only **0.17% of all recorded compaction tokens**. Turning reasoning off is not the first lever for
this workload; any effect on length compliance or summary quality would have to be measured separately.

## 3. Canonical implementation comparison

### Matching behavior

`UniiChat/Memory.ts:142-148,733-760,811-817,1009-1021` and Optchat's `tree.ts`, `memory.ts`, `compactor.ts`, `prompt.ts`:

- 512-byte node target; free pass-through when the source fits.
- Eager binary-tree construction, not only summarization at a full context window.
- Five shortening attempts, shortest response retained, and a clipped-source fallback only when no line exists.
- Same initial leaf/merge task wording, including the 512-character ruler and approximate 70-word guidance.
- Each retry reuses the original input and view plus one bounded correction; prior reasoning/responses do not accumulate.
- Context up to the node/frontier, with merge tasks explicitly allowed to recover details from that context.
- Independent 64–128 KB turn view and 16–32 KB compactor view.

### Differences relevant to efficiency

| Area | Canonical UniiChat | Current Optchat / observed session |
|---|---|---|
| Tools during compaction | `Server.ts:335-340` gives no tool server and no web searches. | `compactor.ts:196-202` attaches all agent tools. Recorded payloads generally contain **15 definitions / 6,193 JSON bytes**, despite the instruction to call no tools. |
| Final prompt paragraph | `prompt.txt:92-97` describes a small mechanical job; use only relevant context, be fast, spend few tokens. | Missing from `prompt.ts` and all 621 recorded compaction requests. |
| OpenAI view caching | `OpenAI.ts:45-64` uses explicit cache mode for compaction and marks stable view text blocks with `prompt_cache_breakpoint`. | `cache.ts:60` passes non-Anthropic calls through. Recorded OpenAI payloads have one combined view/task text block, no view breakpoint, and no `prompt_cache_options`. |
| Cache-writer coordination | `AskAI.ts:218-279`, used by `Agent.ts`, coordinates overlapping prefixes until a leader response begins; errors release waiters. | No corresponding Optchat coordinator; the existing adapter only rewrites Anthropic payloads. |
| Model | Checkout default is `claude-api:haiku-5.5:high:slow`. | Recorded compactor is `openai/gpt-6-luna`, medium reasoning. No apples-to-apples provider/model performance comparison was run. |
| Concurrency | 64 per active side. | 8. Raising this alone is not a token-saving optimization and can increase simultaneous cold-prefix work. |

The earlier review's test requiring identical tools for turns and compaction encodes the current behavior, **not**
canonical behavior. A tool-free implementation should preserve the relevant system/instruction/environment sections
and the user's normal turn tools, while changing that test to assert the intentional separation.

## 4. Caching deserves attention independently of retries

The median request carries about **23.5 KB of memory view**, **6.4 KB of system text**, **6.2 KB of serialized tool
schemas**, and **957 bytes of source**. These byte measurements are not token estimates, nor is a sum of medians a
median request size. Much of the context being reread is not the small source being summarized.

An exact-prefix comparison matches model/settings, system sections (excluding timestamps), tool definitions and the
entire memory view, but excludes the node-specific task:

- **61 initial requests** started while another request with that exact prefix was still running.
- **98 other initial requests** had a request with the same prefix finish within the preceding five minutes, yet their
  aggregate input cache-read share was only **24.2%**.
- **282 correction requests** had a matching completed prefix in that interval; their cache-read share was **74.7%**.

For example, recorded requests **13 and 17** have identical system text, tools, model/reasoning and affinity key; their
user payloads share roughly 25 KB of serialized prefix before the changed merge target. The latter starts 5 ms after
the former ends, but each reports only 2,176 cached tokens against roughly 10,000 total input tokens.

These observations do **not** prove the provider's internal cache boundaries or that every overlap duplicated prefill:
request end is not cache-ready time, and backend routing and retention also matter. They do show why merely reducing
concurrency is not a complete answer. Upstream has both explicit view boundaries and coordination; Optchat currently
has neither for these OpenAI requests.

Installed pi-ai has a `supportsExplicitPromptCacheMode` compatibility flag, but that alone does not split Optchat's
combined view/task message or put breakpoints on its stable view. Any adapter must be gated by actual provider/API
support and tested with cache-disabled settings, retries and differing models. Do not blindly add upstream-only wire
fields to all OpenAI-compatible endpoints.

Improving caching changes **uncached input, cost and prefill work**, not the total number of input tokens in the usage
counter. Reducing schemas or retries can reduce token volume as well.

## 5. Recommended optimization order

### A. Preserve the memory algorithm; fix request/caching parity first

1. **Make compaction requests text-only, like upstream.** Do not expose callable tools. Preserve normal turn tools,
   original sources, tree, context and zoom. This removes an unnecessary request surface and usually 6.2 KB of schema
   JSON per compaction; it also removes the observed tool-call correction path. Actual token and cache savings require
   measurement. Tool metadata can help explain custom calls, so include custom-tool interpretation in quality tests;
   if needed, retain a concise descriptive vocabulary rather than executable schemas.
2. **Add provider-gated OpenAI stable-view blocks/breakpoints**, keeping the view and task text unchanged and leaving
   the task unmarked. Validate the actual endpoint accepts the fields and reports more cache reads; offline payload
   tests alone cannot establish a live cache hit rate.
3. **Add bounded, abortable cache-writer coordination** for matching prefixes. Freeze the request before waiting;
   release on a provider-appropriate cache-ready event, cancellation or failure, with a timeout. Key on actual
   model/provider/account scope, reasoning/cache settings, system, tools and view prefix. Different node tasks must
   still receive their own model answers—this is not deduplicating summary results. Test latency as well as cost.

Items 2–3 preserve the intended model-visible content and memory/retrieval mechanics. They can change timing, so they
must not introduce deadlocks, failed-leader stalls or excessive serialization. Keep different-prefix jobs parallel.

### B. Improve the probability of a usable first/second answer, then evaluate quality

4. **Restore the canonical final efficiency paragraph.** It is a sensible baseline alignment, not proof of fewer
   retries on this model. It does not require removing the context or shrinking the node target.
5. **Benchmark stronger byte-budget guidance on corrections.** The present "cut just enough" feedback produces small
   improvements and repeated overshoots. Try an explicit required reduction and a modest safety margin on retries,
   while retaining the same factual priorities, original source, context and 512-byte acceptance target. Do not quietly
   make every summary shorter or weaken the instruction to preserve names/decisions/retrieval cues.
6. **Compare compactor models on the same saved inputs**, especially 16–256-message merges. Better compliance could
   beat tuning the current model. Compare all-in cost and retrieval quality, not just price per token.

### Not recommended as capability-neutral changes

- Cutting the 32 KB compactor view or providing only the two child summaries: upstream explicitly uses context to
  resolve references and recover details. This can hurt fidelity on the very upper-level nodes causing the retries.
- Reducing the five-attempt cap without evaluation: later attempts demonstrably rescue length compliance.
- Hard-truncating answers, accepting wider nodes, or always aiming for much shorter summaries: changes discoverability,
  memory budgets or how quickly older detail is merged away.
- Deferring all parent construction: changes zoom readiness, view fitting and possibly turn latency; not an equivalent
  request-level optimization.
- Turning off thinking as the main fix: observed reasoning tokens are a small part of total usage.

## 6. Validation before changing the live session

Use saved requests as a **read-only offline dataset**, with any paid replay run explicitly against a scratch home and
separate request log. Never overwrite the user's existing node summaries.

1. Stratify by level and source kind: single messages, tool calls/results, user corrections, and deep merges; include
   multibyte text and exact identifiers, plus all observed five-attempt cases.
2. Compare baseline and each change separately before testing combinations. Keep source/context fixed. Control cold
   versus warm cache state and request order; otherwise a second variant can appear cheaper just by running later.
3. Measure first-answer compliance, calls/build, final byte length, non-improving retries, uncached/cache/output/reasoning
   usage, estimated/actual cost, summary latency and user-turn wait time.
4. Score factual accuracy, attribution, chronological/correction handling, exact names/IDs/paths, unresolved work and
   coverage of retrieval clues. A 480-byte line with fewer retrieval cues is not necessarily a better result.
5. Test tree-to-leaf retrieval: ask about facts in original messages, give the agent the candidate view and `zoom`, and
   measure correct answers, zoom depth and failures to find facts. Test after several main-view merge batches.
6. Regression-test request text equality for cache-only changes, no tools on summaries, tools retained on turns,
   canonical merge order, independent view budgets, immutable stored nodes and failure/abort/restart behavior.

## Baseline verification performed

- Ran the read-only audit on the live stores; no pending compactions were present in the measured snapshot.
- Checked histogram, level, request-reason and cache-timing totals against their independent aggregate counters.
- Type-checked the audit example explicitly (the normal tsconfig excludes examples); passed.
- Ran the existing Optchat suite: **45 tests passed**. These establish the unchanged baseline, not that any proposed
  optimization improves live caching or memory quality.
- No runtime code or home configuration was changed. Deliverables are this report and the aggregate audit script.

**Baseline conclusion:** the roughly 1.77 calls/build is mostly a real byte-budget compliance problem inherited from the
canonical design, especially on dense higher-level merges. There is also avoidable request overhead and missing
canonical caching machinery. Fix those before trading away context, retry opportunities or retrieval information.

## Implementation follow-up

Implemented without modifying the running home, its configuration, or its existing nodes:

- `compactor.ts` keeps the same rendered system/instruction/environment sections but no longer adds callable tools.
  Turn tools remain available. The former test requiring tool equality now checks this intentional separation.
- `prompt.ts` includes the final canonical "small, mechanical job" paragraph. No smaller summary target, hard output
  truncation, reduced context or reduced attempt cap was introduced.
- `cache.ts` splits the memory view into four-line blocks without changing any text, including blank lines and Unicode.
  Anthropic retains its four-breakpoint budget. OpenAI Responses is gated on the model's explicit-cache capability;
  other API types are untouched. Caller payload replacements and stream observers remain authoritative.
- For supported **API-key OpenAI** requests, the last complete view block is explicitly marked. Compaction disables
  the implicit end-of-request write and preserves any requested TTL. Ordinary turns retain their normal end caching.
- **Important correction to the baseline interpretation:** pi-ai deliberately strips `prompt_cache_options` from
  direct OpenAI **ChatGPT-login** requests because that auth path rejects the field. Its absence in this session is
  not simply a missing Optchat optimization. These requests now receive ordinary stable text blocks, with **neither
  explicit breakpoints nor explicit cache options added**. The host supplies its non-secret `isUsingOAuth` state;
  explicit per-request credentials take precedence, and unknown direct-OpenAI auth stays conservative. No second
  credential resolution/refresh is performed just to classify auth. Plain-block automatic cache benefits remain to be
  measured; they cannot be inferred from the API-key implementation or offline tests.
- `cache-flight.ts` coordinates **background compaction requests only**, by their actual post-callback wire prefix.
  Requests are scoped to one host wrapper and include model/provider/endpoint, system, tools, reasoning, affinity and
  request credential/header/environment overrides. Only hashes are stored, never transcript text or keys. Different
  node tasks still make separate calls and receive separate answers.
- Coordination waits for Anthropic `message_start` or OpenAI `response.output_item.added`, not HTTP headers or Pi's
  generic stream-start event. Success settlement is a fallback. Both waits and abandoned-writer leases are capped at
  **10 seconds**; failure or abort releases waiters, and stale callbacks cannot remove another writer's entry. Normal
  turns do not wait. The map is capped at **512 entries**, with **60-second warm scheduling hints**, not asserted
  provider cache lifetimes. Under pressure/timeouts it proceeds without coordination rather than blocking work.
- The audit example accepts an optional ISO timestamp to restrict **recorded-request** statistics after deployment;
  lifetime durable totals stay unfiltered. A build crossing the time boundary is flagged as an incomplete request group.

```sh
# Use the actual restart time, not the date of this baseline.
node optchat/examples/compaction-audit.ts C:/Users/Admin/optchat 2026-11-19T00:00:00Z
```

Restart the Optchat process to activate these changes. Existing nodes are not regenerated and no schema migration is
needed. Expect a one-time cold prefix from changed system/tool/layout inputs. No source-context reduction, aggressive
shortening prompt, lower retry cap or model swap was applied without a quality comparison. The paired model-quality
and retrieval benchmark in section 6 remains follow-up work; offline regressions do not establish a new calls/build
rate or live cost reduction.

### Follow-up verification

- **74 Optchat tests passed**, including 29 new cache-layout/coordination tests. Real pi-ai request conversion is
  exercised with API-key-shaped and ChatGPT-shaped test credentials; tests stop before network access.
- Offline replay of **829 recorded compaction payloads** verified exact preservation of every input message's text in
  both explicit and OAuth-safe layouts, with tools untouched by the cache adapter and no explicit fields added in
  OAuth-safe mode. This later read-only sample is larger than the baseline because the live session continued running.
- The Optchat TypeScript check and the audit example's separate TypeScript check passed.
- The read-only audit's `since` filter was smoke-tested: request totals filter correctly while lifetime totals remain.
- Root suite: **94 passed, 2 failed** in the existing Claude-process tests (`parent pid resolves` and spawning an
  extensionless `claude` executable). Both failures were reproduced from an untouched **HEAD archive** in a temporary
  directory on this Windows host. No root runtime code or those tests were changed.
- `git diff --check` passed. No paid provider requests were made and the live Optchat process was not restarted.

