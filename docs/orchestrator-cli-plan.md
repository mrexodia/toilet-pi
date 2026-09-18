# Orchestrator CLI and session control plan

## Outcome and constraints

Build a compact, plain-text CLI over Toilet-Pi's existing authenticated WebSocket hub. Humans and orchestrator agents should discover sessions across machines, inspect history, select model/thinking, dispatch work, and observe completion without replacing the normal TUI.

**Development safety:** never connect tests to the user's live Toilet-Pi deployment, reload/control a live Pi session, or read/write real credentials or agent configuration. Use in-memory transports, loopback servers on ephemeral ports, fake runners, and temporary directories. No real model calls or deployment during development.

The CLI will require an explicit server URL and credentials; it will not implicitly reuse the machine-connect config. Plain text goes to stdout, errors to stderr; no ANSI or JSON-output mode is required. Secrets must not appear in output or command-line arguments. The protocol remains structured JSON.

## API findings

Pi 0.85.1 exports `getSupportedThinkingLevels(model)` from `@earendil-works/pi-ai`. `ctx.modelRegistry.getAvailable()` supplies the target runtime's available models. Enumerating both in one request requires no inference calls or model switches. Export only provider, ID, display name, and supported levels: never serialize model headers, auth, environment, or base URLs.

`pi.setModel(model)` and `pi.setThinkingLevel(level)` change session selection without changing configured defaults on this Pi version. The latter can clamp, so validate requested levels first and return effective state. OMP/older Pi capability support must be detected, not guessed; unsupported operations must fail clearly without breaking the existing extension.

## Delivery stages

### 1. CLI foundation and model control (first implementation slice)

- [x] Add a package executable and reusable WebSocket client.
- [x] Explicit URL + admin secret from environment; login through `/auth/login` and use the resulting cookie with the correct WebSocket Origin. No config persistence.
- [x] Compact `hosts`, `sessions`, `status`, `models`, `model`, and `thinking` commands; accept full IDs or unambiguous prefixes.
- [x] A correlated `session_request` / `session_response` channel with `get_models`, `get_config`, and `configure` operations.
- [x] Model enumeration returns every model with supported thinking levels, plus current configuration, in one response.
- [x] Configuration validates model + thinking as a pair before changing state. Reject busy/queued sessions; serialize remote mutations and remote input dispatch. Report effective state and partial failures honestly; native runtime APIs are not a transactional pair setter.
- [x] Bind pending requests to the exact owner connection and session. Bound outstanding requests, expire them, discard forged/stale replies, clean up on disconnect; never replay mutations automatically.
- [x] Advertise request support; old runners return unsupported rather than hanging. Inactive sessions require explicit resume before runtime capability/configuration requests.
- [x] Broadcast configuration state and include it in snapshots for other clients, without changing existing model field semantics.
- [x] Unit tests and isolated CLI -> WebSocket -> hub -> fake runner integration tests, including auth, invalid input, busy state, timeout, owner replacement, and concurrent clients.

Implemented in `cli/`, `model-control.js`, the shared protocol/server core, and `toilet-pi.ts`. Usage and wire examples are in [cli.md](cli.md). Tests also load the actual extension with a fake context and an isolated socket to exercise capability advertisement, configuration queries, local thinking events, and busy rejection. Native Pi APIs were inspected locally; no live Pi session was probed. OMP enumeration/mutation certification remains deferred. Native setters are not transactional, and broker timeout cannot cancel a hung setter; these limitations are explicit in CLI documentation.

### 2. Work dispatch and reliable lifecycle

- Correlate input, abort, new, and resume requests. Return input IDs and distinguish broker acceptance, runtime acceptance, and completion.
- Add `send SESSION [--stdin] [--steer|--follow-up]`, `abort`, `terminate`, `resume`, and `new --host HOST --cwd PATH`.
- Add `watch`, `wait --input ID`, and `send --wait` based on `agent_settled`, not transient `agent_end`/`busy:false`. Preserve conservative behavior on runtimes lacking settled notifications.
- Track acceptance/settlement/failure so quick completion cannot race a waiter. An interrupted connection means unknown outcome, not safe-to-retry; add status reconciliation and bounded idempotency before automatic retry.
- Distinguish agent settlement from task success; surface provider errors/aborts separately.
- Define clear-queue support explicitly; do not pretend ordinary abort removes pending work.

### 3. Trustworthy history

- Add correlated history reads with loading/error/completeness metadata, independent of launching a runner.
- Repair inactive-session parsing to follow `id`/`parentId`, matching the active branch rather than mixing abandoned branches.
- Include entry IDs, branch/leaf state and cursor pagination (`history --since ID --last N`). Handle partial JSONL records and compaction without duplicating retained messages.
- Distinguish sanitized/truncated mirrored history from complete persisted entries; expose truncation rather than hiding it.
- Bound message/output sizes and strip terminal control characters from all CLI rendering.

### 4. Permissions and polish

- Scoped orchestrator tokens (read/input/abort/start/configure), host/session restrictions, and audit attribution.
- Explicit login/logout with separate CLI credential storage only if desired; never overwrite machine configuration.
- Browser model/thinking controls; runtime capability compatibility testing with OMP.
- Protocol version/capability documentation and reconnect tests across Node and Cloudflare transports.

## Proposed CLI scenarios

1. **Check existing work:** `sessions`, `status ID`, `history ID --last 6`, then `watch ID` or `send ID 'Focus on the regression'`.
2. **Resume with a stronger model:** inspect history without starting inference; `resume ID`; `models ID`; `model ID PROVIDER/MODEL --thinking high`; `send ID --stdin --wait < task.txt`.
3. **Parallel delegation:** create sessions on selected hosts in separate prepared worktrees; select model/thinking; dispatch tasks; retain returned input IDs; wait for both and inspect evidence before synthesizing results. Creating sessions does not create/synchronize worktrees.
4. **Human intervention:** abort explicitly, change configuration while idle, submit a narrower instruction. Attached browser/CLI clients observe the same effective configuration. Busy model changes fail rather than implicitly aborting work.
5. **Disconnect:** CLI exits nonzero with an unknown-outcome warning if a mutation loses its response. It does not resend the command. Reconnect and inspect actual state before deciding the next action.

## Verification and iteration

First-slice verification: `npm test` (36 tests), `npm run check --prefix server`, `npm test --prefix server` (24 tests, including executable E2E), and `git diff --check` pass. `node cli/toilet-pi.js --help` was also checked without connecting to any server. No live session or user configuration was accessed by the new tests.

Run root Node tests, server typecheck, and server Vitest tests after each coherent slice. Add negative/race tests before expanding operations. Keep browser wire compatibility through additive fields/messages. Test isolated end-to-end behavior through the real server core and authentication helpers, with fake Pi APIs and loopback-only servers. Mark completed work and record remaining limitations here.

If a runtime cannot enumerate exact levels or cannot safely change configuration, return `unsupported` and preserve existing behavior. Do not substitute guessed capability tables or probe the user's running session to fill gaps.
