# CLI and orchestration protocol

A compact plain-text client of the existing Toilet-Pi broker. Stdout contains results; stderr contains diagnostics. An explicit login can save CLI credentials separately from machine configuration and agent settings. The CLI never reads the server's secret file or calls provider APIs.

## Running and authentication

```bash
node cli/toilet-pi.js --help
npm run client -- --help
```

The package also exposes the `toilet-pi` executable. Recommended flow (including PowerShell):

```text
npx toilet-pi login --server https://toilet.example.com
# Enter the admin token at the hidden prompt.
npx toilet-pi hosts
npx toilet-pi sessions
npx toilet-pi logout
```

`login` without a URL prompts for one; `login URL` also works. No token argument is accepted. After successful HTTP authentication, login saves the canonical server URL and **session cookie, not the admin secret**, to `~/.pi/agent/toilet-pi-auth.json`. Ordinary commands reuse it without environment variables or another login request. A new login replaces the saved server only after authentication succeeds. Authentication failure leaves the previous file untouched.

The cookie is a **plaintext, full-access credential**, not encrypted storage. The file is atomically replaced with mode `0600` on Unix; unsafe file permissions and symlinked auth files are rejected. On Windows, access depends on the containing directory's ACLs—keep it in your private user profile. Do not commit/share/back up this file to an untrusted location. `--auth-file PATH` selects a different private location; no Pi agent-directory override or machine configuration is consulted.

`logout` deletes this file locally without contacting a server. It does **not** revoke copied cookies or remove environment credentials. Expired/rejected cookies require another `login`; credentials are never silently refreshed or mutations replayed. Cookie expiry follows the server policy (currently up to one year). Use scoped, short-lived tokens for automation requiring less authority.

Optional environment overrides remain available:

- `TOILET_PI_CLI_SERVER` or `--server URL`: HTTP(S) base URL without embedded credentials/query parameters.
- **Exactly one** of `TOILET_PI_ADMIN_TOKEN` (admin secret) or `TOILET_PI_ORCHESTRATOR_TOKEN` (scoped signed token). With either override, supply the URL explicitly: the saved auth file is not read. Admin override authentication obtains a temporary in-memory cookie for that invocation and does not save it unless the command is `login`.

With no environment credential, the saved URL is the default. An explicit URL must match the saved canonical base URL (including path), or the command fails **before connecting**. The CLI never sends a saved cookie to a different server. For noninteractive login, `--server` plus `TOILET_PI_ADMIN_TOKEN` is supported; piped stdin is not silently consumed as a token.

Admin authentication uses `/auth/login`, then a cookie and matching WebSocket Origin. Scoped authentication uses the WebSocket `Authorization: Bearer` header, never a URL token. Machine tokens cannot control sessions. HTTPS is required except on loopback. Redirects and automatic replay/reconnect are disabled.

`--timeout SECONDS` defaults to 20 (maximum 3600). It bounds each connection/request, the overall settlement wait, or the observation window for `watch`. For slower launches, use e.g. `--timeout 90 resume SESSION`. The broker independently expires runner/history requests after 15 seconds and launches after 60 seconds. A timeout does **not** cancel remote work or prove it did not run.

Use updated servers/extensions/supervisors in an isolated environment first. Do not reload an actively used session merely to try new commands. Older peers return `unsupported`; there is no fallback to uncorrelated mutation messages.

## Discovery and selection

```text
toilet-pi hosts
toilet-pi sessions --host desktop
toilet-pi status SESSION
toilet-pi models SESSION [FILTER]
toilet-pi model SESSION
toilet-pi model SESSION PROVIDER/MODEL --thinking high
toilet-pi thinking SESSION [LEVEL]
```

Session references are full GUIDs or unambiguous GUID prefixes. Host references are full IDs, exact hostnames, or unambiguous ID prefixes. Lists print full IDs; ambiguous references are errors.

`status` is **mirrored broker state**, not a fresh runtime query or a completion guarantee. `model`/`thinking` without a selection query the active runner. Inactive sessions are never resumed implicitly.

`models` returns the target runtime's models **and supported thinking levels in one request**. Only provider, ID, display name, and supported levels are exported—not full model objects/auth metadata. Model IDs can contain slashes.

`model ... --thinking ...` validates the pair before mutation. Busy/queued sessions, unavailable models, and unsupported levels fail. Pi 0.85.1 setters change session selection, not configured defaults. Setters are sequential, **not transactional**: native shortcuts or runtime errors can leave partial changes. Remote configuration/input dispatch are interlocked, but native model shortcuts/slash commands bypass this lock. Broker timeout cannot cancel a hung setter.

## Dispatch, lifecycle, and observation

```text
toilet-pi send SESSION 'Review the changes'
toilet-pi send SESSION --stdin --wait
toilet-pi send SESSION 'Focus on the failing test' --steer
toilet-pi send SESSION 'Then summarize' --follow-up
toilet-pi wait SESSION --input INPUT_ID
toilet-pi status SESSION --input INPUT_ID
toilet-pi watch SESSION --timeout 60
toilet-pi abort SESSION
toilet-pi terminate SESSION
toilet-pi resume SESSION --timeout 90
toilet-pi new --host HOST --cwd /prepared/worktree --timeout 90
```

`send` requires an active runner. Default delivery rejects busy/in-flight sessions; explicitly choose `--steer` or `--follow-up` to queue. Input is literal text (at most 50 KiB): no slash-command/skill/template expansion. `--stdin` and positional text are mutually exclusive.

**Correlation marker:** Pi's `pi.sendUserMessage()` is fire-and-forget and has no native input ID/acceptance result. Each tracked prompt therefore begins with a visible `[toilet-pi input UUID]` line. This is part of the message seen by the agent and saved in its transcript. We do not associate unrelated local messages by FIFO or equal prompt text. If another extension removes/moves the marker or handles the input without producing a user message, the outcome is unknown rather than falsely complete.

The CLI prints the input ID **before transmission**, so it is available after a lost response. Retain it for `status --input`/`wait --input`; a full session ID can reconcile even if it disappeared from discovery (subject to token access restrictions).

| Input state | Evidence |
| --- | --- |
| `accepted` | Broker recorded and attempted delivery; not runtime acceptance |
| `submitted` | Extension invoked the fire-and-forget input API; asynchronous preflight may still fail |
| `running` | Runtime emitted a user message containing that input's correlation marker |
| `settled` | Consumed input's agent batch emitted `agent_settled`, with no pending messages and an idle context |
| `failed` / `aborted` | Dispatch failed, or the settled batch's final assistant ended with provider error/abort |
| `unknown` | Ownership/disconnection/branch change or insufficient execution evidence |

**Settlement is not task success**, nor per-prompt correctness. Multiple steering/follow-up inputs may share a settled batch. Final-generation stop reason describes that batch; it does not certify that each requested task succeeded. Inspect history and independent evidence.

Only `agent_settled` ends a wait. `agent_end` and `busy:false` can precede retries, compaction, or follow-ups and are not substituted. `send --wait` requires the runner's settlement capability before dispatching. Missing capability fails without submitting work. A standalone `wait` is bounded and never guesses on older runtimes.

`abort` requests interruption; it **does not clear pending queues**. Clear-queue control is not exposed because the extension API does not provide the needed guarantee. `terminate` acknowledges a graceful shutdown request, **not process exit**; native shutdown may be deferred. `resume`/`new` return only after an authenticated owning runner hello, not a supervisor's “starting” notice. These commands request no inference themselves, but independently installed startup extensions may do work. `new` does not create/synchronize a worktree; its directory must exist on that host.

`watch` observes session events for the chosen window, without replaying missed events, and caps printed output at 1 MiB. Disconnect exits with an error. It is not a durable event log or a replacement for `wait --input`.

### Disconnects, idempotency, and limits

No mutation is automatically retried. Reconnect explicitly, query the **same input ID**, and inspect history before deciding to submit new work. A fresh CLI connection can observe completion that happened before it started waiting.

The broker retains at most 4096 input records for one hour, in memory, hashing rather than retaining prompts in that ledger. Within that retention window, reusing an input ID with the same session/text/mode returns its existing status without dispatch; different work with that ID is rejected. This is **not durable exactly-once delivery**. Broker restart/Cloudflare instance loss, expiry, or missing records mean unknown outcome, not permission to replay. New/resume/abort/configure are correlated but do not have cross-connection idempotency keys.

Runner disconnect/replacement makes unfinished records unknown. They are not silently restored to success from a new owner. Read-only client reconnects do not invalidate input records. Both request channels bound outstanding operations (32/client/channel, 256/channel globally); input hashing is also bounded. Timeouts are not cancellation.

If native asynchronous preflight fails without a user message or settlement event, a submitted input may remain unresolved. The extension keeps its configuration guard rather than assuming that delayed work cannot still arrive. Inspect/recover the runtime explicitly; do not replay or assume idle polling proves cancellation.

## Trustworthy history

```text
toilet-pi history SESSION --last 6
toilet-pi history SESSION --since ENTRY_ID --last 100
```

History is a **sanitized branch transcript**, not raw persisted entries or reconstructed model context. User/assistant/tool text is included; compaction/branch summaries are labeled transcript rows. Images, thinking, arbitrary tool details, custom state, and model/auth metadata are omitted. `retainedTail` is not expanded because its original transcript messages already occur on the ancestor path; this avoids duplication and does not claim to reproduce compacted model context.

- Active sessions: fresh `sessionManager.getBranch()` from the exact owning runner.
- Inactive sessions: supervisor reads the catalogued file without launching a process and follows `id`/`parentId` from the **last persisted leaf**, matching Pi's reload behavior. Unpersisted in-memory tree navigation can only be known by the active runner.
- File identity is checked against the requested session. A malformed/partial JSONL record, broken/cyclic parent chain, or concurrently changed file marks the result incomplete. Abandoned branches are not mixed into the transcript.
- Requests emit correlated `control_progress: loading`; failures return an explicit correlated error, never a fabricated empty complete history.

Output includes source, sanitized/completeness/truncation flags, leaf ID, entry IDs, next cursor, and `more`. Without `--since`, `--last N` selects a tail window; with `--since`, it returns up to N rows after that entry. Missing/abandoned cursors fail with `cursor_not_found`; refresh explicitly. Legacy linear files without entry IDs cannot supply reliable cursors.

`complete=true` means the entire supported sanitized transcript fit in this response and the source was not detected as partial—not that all raw fields/entry types were exported. Normal pagination can make `complete=false` without source truncation. `truncated=true` reports source/text loss. Pagination omissions are indicated by the cursor/window and `more` flag.

Bounds: 1..1000 rows/request (default 100), 50 KiB per text, approximately 1 MiB/page. Inactive reads reject files over 64 MiB or 200,000 entries; at most four concurrent supervisor reads. CLI rendering strips terminal controls and folds multiline rows to compact plain text. The older browser mirror/status cache is separately bounded and makes no transcript completeness claim.

## Scoped orchestrator tokens

Both Node and Cloudflare provide `POST /auth/orchestrator-token`. It requires an admin session cookie and a matching Origin. JSON body:

```json
{
  "subject": "review-worker",
  "scopes": ["read", "input", "abort", "configure"],
  "hostIds": ["EXACT_HOST_ID"],
  "sessionIds": ["EXACT_SESSION_GUID"],
  "expiresInSeconds": 900
}
```

The response contains `{ "token": "..." }` with `Cache-Control: no-store`. Transfer it directly to your secret manager/environment; do not log it. Scoped tokens remain environment overrides; the `login` flow saves only an admin session cookie.

`read` is mandatory. Other scopes: `input` (send), `abort` (abort/terminate), `start` (resume/new), `configure` (model/thinking mutation). `read` includes history/model enumeration and input status. Host/session restrictions use exact IDs and intersect when both are present. Omitting restrictions grants access across that dimension. `new` cannot be used with a session-ID restriction because the new ID is not yet known. Max lifetime is 24 hours; shorter grants are recommended. There is no per-token revocation store: expiry or rotation of the signing secret invalidates access (rotation also affects other signed credentials).

The broker filters discovery and all session broadcasts, rechecks authorization, denies legacy unscoped mutation paths for these tokens, and logs structured attribution (subject, token ID, operation, target, allowed/denied)—never prompt text or the token. Scoped credentials cannot act as machines, mint tokens, or become admins. Machine clients cannot reassign another machine's known session identity through hello/status/snapshot messages.

**Scopes are not a sandbox.** `input` can instruct an agent to use its normal tools; `start` can launch on a permitted host in a caller-selected directory. Grant only to trusted orchestrators.

## Browser model/thinking controls

Expand **Session model / thinking**, load models, choose a supported pair, then apply. The browser uses the same model-control request channel as the CLI. Busy/queued/inactive/disconnected sessions disable mutation. Responses are bound to the selected session/request; switching sessions, timeouts, and disconnects discard stale selection state. Errors are shown without automatic retry. Native selection/configuration events update the displayed state. Server/runtime validation remains authoritative.

## Wire capabilities and compatibility

The broker advertises `orchestration_v1` and `scoped_tokens_v1` in `overview.capabilities`.

- Runner `model_control_v1`: existing `session_request`/`session_response`, operations `get_models`, `get_config`, `configure`.
- Runner `input_tracking_v1`: `control_command` for tracked send/abort/terminate and `session_event.input_status`.
- Runner `agent_settled_v1`: settlement waits enabled. Currently gated on optional event registration and the known Pi 0.85.1+ (0.x) API generation. Missing/unknown runtime versions are conservative; no busy/idle completion emulation.
- Runner/supervisor `history_v1`: fresh correlated branch reads.

Example client request:

```json
{"type":"control_request","requestId":"client-1","operation":"send","sessionGuid":"SESSION","inputId":"CLIENT_GENERATED_UUID","mode":"followUp","text":"Review changes","requireSettled":true}
```

`control_response` restores the client request ID and carries `success` plus `data:{input|history|sessionGuid,status}`, or `error:{code,message}`. Lifecycle and history commands use broker-generated wire IDs bound to the exact peer. `control_progress` communicates `loading`/`starting`, not success. Forged/stale responses are ignored. Model responses continue to use the original public schema; configuration events/snapshots remain additive.

| Runtime/transport | Verification |
| --- | --- |
| Pi 0.85.1 | Installed docs/source inspected; actual extension exercised with injected fake APIs and isolated socket |
| Older/missing APIs | Mocked unsupported/event-rejection behavior; no guessed model level table or completion |
| OMP | Shared entrypoint/scanning/launch-argument tests; native new capability behavior **not certified** (runtime not installed locally) |
| Node | Real CLI + HTTP/auth + WebSocket + broker + fake runner E2E |
| Cloudflare | Shared core/transport reconnect tests and Worker token endpoint tests; no live deployment |

## Exit codes and isolated verification

- `0`: requested operation succeeded, or agent batch settled (not task correctness).
- `1`: connection/auth/target/runtime error, timeout, or unknown outcome.
- `2`: invalid arguments.
- `3`: tracked input failed or settled aborted/provider-error.

```bash
npm test
npm run check --prefix server
npm test --prefix server
git diff --check
```

Tests use fake Pi APIs, in-memory transports, temporary files, and ephemeral loopback servers. Executable E2E supplies generated credentials, not inherited provider/Pi configuration. No production entrypoint, real agent process, inference request, or deployment is started.
