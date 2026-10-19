# Optchat / UniiChat implementation review

## Scope and reference

Compared `optchat/` against Victor Taelin's actual [UniiChat implementation](https://github.com/VictorTaelin/UniiChat/tree/0500bf6a8ea4bf0ce047488562022b1b6532cc30),
revision `0500bf6a8ea4bf0ce047488562022b1b6532cc30`, cloned at `C:/CodeBlocks/UniiChat`.
The local checkout started clean. Changes are confined to Optchat and this documentation; no existing memory database
was opened or rewritten and no provider credentials were used for testing.

This is a focused source-code and regression-test review of memory, summary scheduling, request construction and
caching, not a security audit or a claim that every feature of either application is correct.

Reference implementation:

- `Memory.ts`: `ctx`, `starts`, `build`, `fit`, `merge`, `settle`, `view`.
- `Anthropic.ts`: the wire-format cache breakpoints and four-breakpoint budget.
- `cache.test.ts`: Anthropic's breakpoint/prefix lookup model.
- `failsafe.test.ts`: failures must not destroy summaries or leave turns waiting on work that cannot progress.
- Installed pi-ai and pi-durable **1.1.0**: actual request conversion, generation hooks, system sections and stream options.

## Issues fixed

| Issue | Consequence before the fix | Correction / regression evidence |
|---|---|---|
| Missing stable Anthropic view breakpoint | The entire view and current task were one text block. Appending even one line prevented reuse of that block across turns/compactions; freezing helped within a run, not across different inputs. | `src/optchat/cache.ts` splits the converted Anthropic payload into four-line blocks and marks the last whole block, or the opening for a short view. System/tool/tail marks stay within four, including OAuth. A compaction's unique task is not marked. Wired into the host's Models boundary so both generations and summary tasks use it. |
| Coupled merge batches | A chat-view merge also forced a compactor-view merge, even when its own ceiling had not been crossed. This unnecessarily changed a prefix shared by background calls. | `memory.ts: fit` now treats the views independently, matching current UniiChat. A regression verifies an under-ceiling compactor view does not change when the chat view merges. |
| Growing summary retries | Every too-long retry appended the preceding assistant response, including reasoning, plus another correction. A large response could make each subsequent request much larger. | `compactor.ts: compact` reuses the original input plus at most one bounded correction. A five-attempt regression includes 20 KB answers, large thoughts and an accidental tool call; requests contain no assistant/tool-history messages and remain within 1 KB of the initial input size. |
| Discarded useful summary after a later error | A provider error during shortening discarded all lines already returned and left the node queued. | Keep the shortest received line on a later provider error, as upstream does. An actual cancellation still propagates. A regression supplies 800- and 700-byte lines followed by an outage and verifies the 700-byte line is committed. |
| Blocked summary frontier waited indefinitely | Failed calls were correctly prevented from retrying endlessly, but `settle()` kept waiting. `turn()` waits before submitting, so its own new message could not unlock the retry. | `compactor.ts: blocked` and the waiters in `index.ts` detect when every schedulable node has failed for the effective transcript/model fingerprint and no jobs are running. They reject with recovery instructions; queued sources/transcript remain intact. Regression covers `settle`, `turn`, `idle` and subsequent successful reconfiguration. |
| Steering could discard active-turn context | The generation hook searched backward using only the first 200 characters of an input. A steer sharing that head could replace the original input, dropping prior tool calls/results from the request. | `extension.ts` uses the first matching input rather than the latest matching steer. The regression sends such a steer during an actual faux-model/tool round and verifies the original request prefix and tool history survive. |
| Summary system sections lacked the execution environment | A home extension rendering a section from `env` could produce different system prompts for turns and summaries, preventing cache sharing and omitting workspace context from summaries. | The summary renderer supplies its task's environment. Regression compares complete turn/summary system prompts, instructions and tool declarations with an environment-dependent workspace section. |

The six non-cache regressions above were also run against the **pre-change sources from local HEAD**, loaded without
changing working files. All six failed there and pass with the fixes. The cache layout is checked separately against
actual pi-ai Anthropic payload conversion, not just an invented request shape.

## Invariants checked

- The existing rollback-push comparison checks every step through 4,000 messages.
- The most-due-pair rule is `(T + 1) / 2^l - i`, ties oldest first: **not simply oldest-first merging**.
  The heap agrees with an independent quadratic oracle for 1,000 randomized cases with unequal sizes and unavailable parents.
- Views remain ordered, aligned, gap-free covers of their message ranges. Only built parents can replace siblings.
- The turn view uses the 64–128 KB sawtooth and the compactor view the independent 16–32 KB sawtooth. These are
  UTF-8 summary-text byte budgets, not token counts or hard caps on the entire request. A batch can temporarily
  remain above its ceiling while necessary parents are unavailable.
- Out-of-order completions do not let the compactor view cross the first unbuilt leaf. Completed batches return to
  their budgets without losing retained size metadata.
- Long messages remain paged and zoomable; short sources are stored verbatim without a model call; thoughts are
  excluded from indexed summaries.
- The prefix and per-turn state stay fixed during a tool run, including after a same-head steer.
- Existing SQLite reopen tests retain built nodes and continue interrupted summary work.
- Anthropic payload tests cover empty/partial/full blocks, long tool histories, cache-disabled requests, API keys and
  OAuth. They use pi-ai's real conversion and stop in `onPayload` **before network access**.
- A synthetic growing-view replay reads at least 95% of input from cache under a 20-block breakpoint lookup model.
  This is an offline layout regression, **not a measured production cache-hit rate**; it does not model real TTL
  expiration, provider minimum cache sizes, concurrent writes, or model/reasoning switches.

## Intentional differences and limits

- Summary concurrency is 8 here versus 64 per side in the referenced UniiChat. This changes throughput, not merge order.
- A separate summary model/thinking level is supported. Different models or thinking configurations need not share
  cache entries, even with identical prompt text.
- Failure recovery is deliberately not upstream's patient automatic retry loop. Sources remain queued; a new
  transcript message, effective model change, explicit reconfiguration or restart permits another attempt. A blocked
  caller now receives an error rather than hanging. After fixing credentials, restart/reconfigure to retry unchanged work.
- Five shortening attempts and retaining the shortest response match upstream. **512 bytes is a target, not a strict
  guarantee** if all returned lines exceed it; keeping a useful over-target line is intentional. Only a no-line
  refusal uses the clipped-source fallback. A first-call provider error does not silently clip memory.
- Reasoning is retained in the durable transcript for provider tool-call continuity but excluded from summary sources.
- Images and `zoom("Name")` for separate subagent logs remain absent; other agents are reached through hub tools.
- The explicit breakpoint adapter covers `anthropic-messages`, not Bedrock, Google, or Anthropic-style cache controls
  carried through OpenAI Chat Completions. OpenAI/Codex automatic prefix caching is unchanged.
- Frozen views and retention/affinity IDs do not guarantee cache hits: real usage must be checked with the actual
  provider/model/workload. This review did not make paid requests, benchmark live billing, run the Bun upstream
  suite, or exhaustively exercise concurrent hub reporter/lifecycle races.

## Verification

From the repository root:

```bash
npm run optchat:test
optchat/node_modules/.bin/tsc -p optchat/tsconfig.json
npm test
```

At review completion: **38 Optchat tests passed** (20 before this review), the Optchat TypeScript check passed, and
**55 root tests passed**. No dependency upgrade or durable document schema migration is required. Restart the
Optchat service to load the changes; existing transcripts and stored nodes are preserved, not regenerated.
