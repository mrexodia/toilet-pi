# Orchestrator CLI and session control plan

## Outcome and constraints

Build a compact, plain-text CLI over Toilet-Pi's existing authenticated WebSocket hub. Humans and orchestrator agents should discover sessions across machines, inspect history, select model/thinking, dispatch work, and observe completion without replacing the normal TUI.

**Development safety:** never connect tests to the user's live Toilet-Pi deployment, reload/control a live Pi session, or read/write real credentials or agent configuration. Use in-memory transports, loopback servers on ephemeral ports, fake runners, and temporary directories. No real model calls or deployment during development.

The CLI uses explicit login with a server-bound cookie in `~/.pi/agent/toilet-pi-auth.json`, or explicit environment credentials; it does not reuse the machine-connect config. Plain text goes to stdout, errors to stderr; no ANSI or JSON-output mode is required. Secrets must not appear in output or command-line arguments. The protocol remains structured JSON.

## API findings

Pi 0.85.1 exports `getSupportedThinkingLevels(model)` from `@earendil-works/pi-ai`. `ctx.modelRegistry.getAvailable()` supplies the target runtime's available models. Enumerating both in one request requires no inference calls or model switches. Export only provider, ID, display name, and supported levels: never serialize model headers, auth, environment, or base URLs.

`pi.setModel(model)` and `pi.setThinkingLevel(level)` change session selection without changing configured defaults on this Pi version. The latter can clamp, so validate requested levels first and return effective state. OMP/older Pi capability support must be detected, not guessed; unsupported operations must fail clearly without breaking the existing extension.

## Delivery stages

### 1. CLI foundation and model control (first implementation slice)

- [x] Add a package executable and reusable WebSocket client.
- [x] Authenticate through `/auth/login` and use the resulting cookie with the correct WebSocket Origin. Environment credentials remain supported; explicit `login`/`logout` now manages a separate, server-bound CLI auth file.
- [x] Compact `hosts`, `sessions`, `status`, `models`, `model`, and `thinking` commands; accept full IDs or unambiguous prefixes.
- [x] A correlated `session_request` / `session_response` channel with `get_models`, `get_config`, and `configure` operations.
- [x] Model enumeration returns every model with supported thinking levels, plus current configuration, in one response.
- [x] Configuration validates model + thinking as a pair before changing state. Reject busy/queued sessions; serialize remote mutations and remote input dispatch. Report effective state and partial failures honestly; native runtime APIs are not a transactional pair setter.
- [x] Bind pending requests to the exact owner connection and session. Bound outstanding requests, expire them, discard forged/stale replies, clean up on disconnect; never replay mutations automatically.
- [x] Advertise request support; old runners return unsupported rather than hanging. Inactive sessions require explicit resume before runtime capability/configuration requests.
- [x] Broadcast configuration state and include it in snapshots for other clients, without changing existing model field semantics.
- [x] Unit tests and isolated CLI -> WebSocket -> hub -> fake runner integration tests, including auth, invalid input, busy state, timeout, owner replacement, and concurrent clients.

Implemented in `cli/`, `model-control.js`, the shared protocol/server core, and `toilet-pi.ts`. Usage and wire examples are in [cli.md](cli.md). Tests also load the actual extension with a fake context and an isolated socket to exercise capability advertisement, configuration queries, local thinking events, and busy rejection. Native Pi APIs were inspected locally; no live Pi session was probed. OMP enumeration/mutation certification remains deferred. Native setters are not transactional, and broker timeout cannot cancel a hung setter; these limitations are explicit in CLI documentation.

### 2. Work dispatch and reliable lifecycle — implemented

- [x] Correlated send/abort/terminate/new/resume and fresh connection reconciliation by input ID.
- [x] `send SESSION [TEXT | --stdin] [--steer|--follow-up]`, `abort`, `terminate`, `resume`, `new --host HOST --cwd PATH`.
- [x] `watch`, `wait --input ID`, `send --wait`, and `status --input ID`; no busy/idle completion emulation.
- [x] Explicit accepted/submitted/running/settled/failed/aborted/unknown states, bounded in-memory input idempotency (4096 records, one hour), stale/forged reply protection, deadlines, and disconnect cleanup. **No automatic retries.**
- [x] Provider error/abort batch outcomes are separate from settlement and task correctness. New/resume require an owning runner hello; terminate is only a graceful-shutdown request acknowledgement.
- [x] Clear-queue explicitly unsupported: abort does not promise queue removal.

Implementation: `server/src/shared/control-router.ts`, `input-tracker.js`, shared extension, CLI. Pi's fire-and-forget input API has no native ID/preflight result: tracked prompts contain a visible correlation marker. Marker consumption plus `agent_settled` is required to claim settlement. Dropped markers, async preflight errors with no events, or owner loss remain unknown/unresolved, not inferred success. The ledger is not durable exactly-once execution and does not cover launch/configure retries.

### 3. Trustworthy history — implemented

- [x] Correlated runtime/supervisor history reads, loading progress, explicit errors, completeness/truncation metadata; no runner launch for reads.
- [x] Inactive files follow `id`/`parentId` from the last persisted leaf. Active reads use the runtime's current branch. No abandoned branches are mixed in.
- [x] Entry/leaf IDs, cursor pagination (`history --since ID --last N`), cursor-not-found errors, partial/cyclic/broken file detection, bounded snapshots, labeled compaction summaries without retained-tail duplication.
- [x] Explicit sanitized **transcript**, not a complete raw-entry export or reconstructed compacted model context. Legacy files without IDs have no reliable cursor.
- [x] Text/page/file/concurrency/output bounds; terminal-safe rendering. Old mirrored snapshots remain a separate, non-authoritative surface.

Implementation: `history-page.js`, `session-scanner.js`, supervisor and extension control handlers. Unpersisted inactive leaf navigation cannot be recovered from JSONL; the source label documents this limitation. Added host/session identity validation and rejected stale/unsolicited cross-host snapshots while introducing scoped access.

### 4. Permissions and polish — implemented except native OMP certification

- [x] Short-lived scoped orchestrator tokens (read/input/abort/start/configure), exact host/session restrictions, filtered discovery/broadcasts, operation authorization, and prompt-free structured audit attribution.
- [x] Admin-cookie/Origin-protected token issuance on Node and Cloudflare; CLI header-only scoped authentication. No secrets in URLs; only an explicit `login` persists an admin session cookie.
- [x] Browser model/thinking controls, paired selection, busy/queue gating, stale-session/disconnect/timeout handling, and DOM tests.
- [x] Capability/protocol docs and isolated Node/Cloudflare transport reconnect tests, Worker issuance tests, executable CLI E2E.
- [ ] Native OMP capability certification: no OMP runtime is installed locally. Shared entrypoint, discovery, and launch-argument compatibility tests pass; missing API/event behavior is tested with fakes. Need an approved disposable OMP runtime/version to certify further; do not probe live sessions or install/change the user's runtime automatically.

Persistent login/logout was subsequently requested and implemented: hidden token entry, atomic cookie storage at `~/.pi/agent/toilet-pi-auth.json`, owner-only Unix permissions, exact server binding, local logout, and explicit environment overrides. The admin secret itself is never saved. Tests use injected stores or temporary `--auth-file` paths, never the user's actual auth file. There is no per-token revocation database; logout removes only the local cookie. Use short expiries or rotate the signing secret for revocation. No Cloudflare deployment or real inference was used in verification.

## Proposed CLI scenarios

1. **Check existing work:** `sessions`, `status ID`, `history ID --last 6`, then `watch ID` or `send ID 'Focus on the regression'`.
2. **Resume with a stronger model:** inspect history without starting inference; `resume ID`; `models ID`; `model ID PROVIDER/MODEL --thinking high`; `send ID --stdin --wait < task.txt`.
3. **Parallel delegation:** create sessions on selected hosts in separate prepared worktrees; select model/thinking; dispatch tasks; retain returned input IDs; wait for both and inspect evidence before synthesizing results. Creating sessions does not create/synchronize worktrees.
4. **Human intervention:** abort explicitly, change configuration while idle, submit a narrower instruction. Attached browser/CLI clients observe the same effective configuration. Busy model changes fail rather than implicitly aborting work.
5. **Disconnect:** CLI exits nonzero with an unknown-outcome warning if a mutation loses its response. It does not resend the command. Reconnect and inspect actual state before deciding the next action.

## Verification and iteration

Verification passed: `npm test` (51 tests), `npm run check --prefix server`, `npm test --prefix server` (52 tests), `npm run build --prefix server`, `git diff --check`, and offline CLI help. The suites cover real extension routing with fake contexts, tracked dispatch, immediate settlement/read-side reconnect, permission denial/expiry, cross-host forgery, history branches/partial files, UI controls, and Node/Cloudflare adapters. No live session, user credential/configuration, real agent process, or provider API is used. See [CLI documentation](cli.md) for the exact guarantees, limits, and compatibility matrix.

Run root Node tests, server typecheck, and server Vitest tests after each coherent slice. Add negative/race tests before expanding operations. Keep browser wire compatibility through additive fields/messages. Test isolated end-to-end behavior through the real server core and authentication helpers, with fake Pi APIs and loopback-only servers. Mark completed work and record remaining limitations here.

If a runtime cannot enumerate exact levels or cannot safely change configuration, return `unsupported` and preserve existing behavior. Do not substitute guessed capability tables or probe the user's running session to fill gaps.
