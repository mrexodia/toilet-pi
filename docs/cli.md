# CLI (first implementation slice)

The CLI is an admin client of the existing Toilet-Pi server. Output is compact plain text, with errors on stderr and no ANSI formatting. It does not read or write machine configuration or save credentials.

The implemented commands are **hosts, sessions, status, models, model, and thinking**. Work dispatch, resume/new, watch/wait, and history are planned separately; see [the implementation plan](orchestrator-cli-plan.md).

## Running

From this checkout:

```bash
node cli/toilet-pi.js --help
npm run client -- --help
```

The package also declares a `toilet-pi` executable for installations that expose package binaries.

Supply:

- `TOILET_PI_CLI_SERVER`: the HTTP(S) server base URL, e.g. `https://toilet.example.com` (or use `--server URL`). This is not a token-bearing login/connect URL.
- `TOILET_PI_ADMIN_TOKEN`: the admin login secret, supplied by your shell/secret manager. Do not put it in command-line arguments. A machine connect token will not work.

The CLI POSTs the secret to `/auth/login` and uses the resulting admin cookie plus matching Origin for `/ws`. The cookie exists only for that command. HTTPS is required except for loopback HTTP. Redirects are not followed. `--timeout SECONDS` defaults to 20 seconds per connection/request wait; a timed-out mutation has an **unknown outcome**, not an automatic rollback. The broker has a separate 15-second runtime-response deadline. No commands are automatically retried.

The server and target extension must include the new model-control protocol. **Do not reload an actively used session merely to try the CLI**; use an isolated session or update it when convenient. Older runners fail with `unsupported`. Runtime model queries/configuration require an active runner and will never start an inactive session implicitly.

## Commands

```text
toilet-pi hosts
toilet-pi sessions --host desktop
toilet-pi status SESSION
toilet-pi models SESSION
toilet-pi models SESSION sonnet
toilet-pi model SESSION
toilet-pi model SESSION PROVIDER/MODEL --thinking high
toilet-pi thinking SESSION
toilet-pi thinking SESSION high
```

Replace `SESSION` with a full session GUID or an unambiguous GUID prefix. Host filters accept an exact host ID, exact hostname, or unambiguous host-ID prefix. Ambiguity is an error, never an arbitrary choice. Lists print full IDs.

`models` makes one session request returning both the catalogue and each model's supported thinking levels. An optional filter matches provider, ID, or display name. For example, an isolated fake runtime might produce:

```text
fake/small  off
fake/large  off high max
Current: fake/small thinking=off
```

Actual levels come from the target Pi API, not a CLI-maintained model-name table. Only public fields are transmitted; complete model objects may contain secrets and must not be forwarded.

`model ... --thinking ...` validates both selections before mutation and sends them together. Busy sessions, queued input, unavailable models, and unsupported levels fail explicitly. Explicit levels are not silently clamped. Pi 0.85.1 extension setters change session selection, not configured defaults. OMP/older runtime compatibility is not certified: missing enumeration APIs return `unsupported` without disabling the rest of the extension.

Native model/thinking setters are not a transaction: a runtime error or concurrent native model selection may leave a partial change. The error tells you to inspect state before retrying. Remote configuration is serialized; remote inputs are rejected while it is in progress. Local input submissions through Pi's input hook are rejected with a notification (interactive text is returned to the editor). Native slash-command dispatch/model shortcuts are outside this lock. A hung native setter cannot be cancelled by the broker's timeout; inspect/recover the runtime rather than replaying the mutation.

`status` reports the hub's **mirrored state**, not an authoritative runtime query. To read current model/thinking directly, use `model SESSION` or `thinking SESSION`. Historical/inactive selections may be unknown. No transcript completeness claims are made by `status`.

## Exit codes

- `0`: command succeeded (configuration commands return effective state).
- `1`: connection, authentication, target resolution, or runtime error.
- `2`: invalid arguments.

## Protocol

A CLI authenticates as `hello { role: "web" }`, just like the browser. A runner advertises `capabilities: ["model_control_v1"]` in its hello. This means it implements the request channel; individual runtime operations can still return `unsupported`.

Client request:

```json
{"type":"session_request","requestId":"client-1","sessionGuid":"SESSION","operation":"get_models"}
```

Success:

```json
{
  "type":"session_response",
  "requestId":"client-1",
  "sessionGuid":"SESSION",
  "success":true,
  "data":{
    "configuration":{"provider":"fake","modelId":"small","thinkingLevel":"off"},
    "models":[{"provider":"fake","id":"small","name":"Small","thinkingLevels":["off"]}]
  }
}
```

Other operations:

```json
{"type":"session_request","requestId":"client-2","sessionGuid":"SESSION","operation":"get_config"}
{"type":"session_request","requestId":"client-3","sessionGuid":"SESSION","operation":"configure","provider":"fake","modelId":"large","thinkingLevel":"high"}
{"type":"session_request","requestId":"client-4","sessionGuid":"SESSION","operation":"configure","thinkingLevel":"off"}
```

Errors have `success:false` and `error:{code,message}`. Codes include `unknown_session`, `inactive`, `unsupported`, `busy`, `unavailable_model`, `unsupported_level`, `session_changed`, `configuration_changed`, `runtime_error`, `owner_changed`, `disconnected`, `timeout`, `duplicate_request`, and `overloaded`. Malformed protocol messages use the existing generic `error` message.

The hub replaces request IDs with its own IDs for routing and restores the client ID on reply. Replies are bound to the exact runner connection and session. Outstanding requests are limited to 32 per client and 256 globally. They are cleaned up on disconnect and expire after 15 seconds; late/stale/forged replies are ignored. A transport failure after sending does not prove the command was not executed.

Session snapshots optionally include `configuration:{provider,modelId,thinkingLevel}`. Attached clients also receive `session_event` with `event:{type:"configuration",configuration:...}` on native or remote selection changes. The existing `model` field retains its bare model-ID semantics for browser compatibility. Older browsers may ignore the new event; adding model/thinking selectors and rendering is a later stage.

## Isolated verification

```bash
npm test
npm run check --prefix server
npm test --prefix server
```

Tests use fake Pi APIs, in-memory transports, and loopback servers on OS-selected ports. The executable E2E tests supply generated admin secrets and do not inherit Pi/Toilet-Pi configuration or provider credentials. No production server or actual agent runtime is started.
