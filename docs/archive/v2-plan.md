# Toilet-Pi v2 Plan

## Goal

Turn the current local WebSocket relay into a simple remote-control system for pi sessions across machines, while keeping the implementation intentionally small and easy to reason about.

The v2 design keeps these priorities:

- do **not** block pi startup waiting for the server
- do **not** block pi on event send
- use pi's **existing session GUID** as the session identity
- use the **same extension** in interactive and headless/background pi
- keep the server **in-memory only**
- avoid SDK usage
- avoid auth, heartbeats, persistence, leases, and other heavy control-plane machinery for v1

---

## Non-goals for v1

These are explicitly out of scope for the first implementation:

- authentication / multi-user permissions
- database persistence
- durable recovery after server restart
- heartbeat/lease/TTL logic
- perfect split-brain prevention under every possible disconnect race
- cross-session branch ownership semantics beyond pi's built-in session GUID

If a tiny race occasionally causes a little weirdness in the JSONL file during a takeover, that is acceptable for v1.

---

## Terms

To keep implementation clear:

- **Central server**: the in-memory WebSocket/HTTP hub
- **Host supervisor**: one long-lived daemon process per machine
- **Background runner**: one headless pi child process for one session
- **Interactive runner**: a normal user-started pi process with the same extension loaded
- **Web UI**: browser client that watches sessions and sends prompts/abort requests

---

## Core rules

### 1. Session identity
Use pi's built-in session GUID as the canonical session ID.

Do **not** invent another UUID layer.

### 2. One command target per session
For any session GUID, the server routes commands to **one active owner** only:

- `interactive`
- `background`
- or `none`

The server must never broadcast a prompt or abort command to every connected pi client.

### 3. Interactive wins over background
If a user resumes a session locally while a background runner owns it:

1. the interactive runner connects
2. the server sends `abort_and_release` to the background runner
3. the background runner aborts its current work, releases ownership, and exits
4. the interactive runner becomes owner

This is the default takeover policy for v1.

### 4. Local pi must stay responsive
The extension should:

- connect in the background
- retry in the background
- send events on a best-effort basis
- drop events if the socket is unavailable or send fails

The local pi process must continue working even if the server is down.

### 5. Background runners are disposable
A background runner exists only to serve one remote-controlled session.

If it loses the server connection, it should abort/exit rather than continuing as an uncontrolled hidden writer.

### 6. Host supervisor owns child lifetimes
If the host supervisor exits, it kills all background runners it started.

---

## Architecture overview

```text
Browser Web UI
    |
    v
Central Server  <------------------------------>  Host Supervisor (one per machine)
    ^                                                  |
    |                                                  | spawns
    |                                                  v
Interactive pi + extension                       Background pi + same extension
(normal CLI)                                     (headless child, RPC mode)
```

Important detail:

- the **host supervisor** has a long-lived control connection to the server
- each **background runner** also connects **directly** to the central server using the same extension as interactive pi
- the host supervisor does **not** proxy every session event from children

That keeps the process model simple.

---

## Components

## 1. Central server

Responsibilities:

- keep an in-memory registry of hosts and sessions
- accept connections from:
  - web UI
  - host supervisors
  - interactive runners
  - background runners
- track current per-session owner
- fan out session events to attached web clients
- route `input` / `abort` only to the current owner
- trigger background abort/release during interactive takeover

No persistence required.

The server can stay in TypeScript initially or be rewritten in Go later. The protocol should stay plain JSON over WebSocket so either implementation is easy.

## 2. Host supervisor

One per machine.

Responsibilities:

- connect to the server and identify the machine (`hostId`)
- receive `start_background_session` requests
- spawn one headless pi child per background session
- track child processes by session GUID
- kill children on shutdown

The host supervisor should be dumb. It is a process supervisor, not a pi session engine.

## 3. Background runner

One per active background session.

Responsibilities:

- run pi headlessly
- load the same websocket extension
- connect directly to the server
- stream session events to the server
- receive `input`, `abort`, and `abort_and_release`
- exit after release or server disconnect

## 4. Interactive runner

A normal pi CLI instance with the same extension loaded.

Responsibilities:

- connect to the server in the background
- send session metadata + event stream
- accept commands from the web UI when it is the owner
- trigger background takeover implicitly by connecting with the same session GUID

## 5. Web UI

Responsibilities:

- show sessions and their owners
- attach to a session and watch its event stream
- send prompts and abort requests
- trigger background starts on a selected host

---

## Server state model

All state is in-memory.

```ts
hosts: Map<hostId, {
  conn: WebSocket,
  platform?: string,
  hostname?: string,
}>;

sessions: Map<sessionGuid, {
  owner: "interactive" | "background" | null,
  interactiveConn?: WebSocket,
  backgroundConn?: WebSocket,
  hostId?: string,
  pendingInteractive?: WebSocket,
  sessionFile?: string,
  cwd?: string,
  model?: string,
  events: Array<object>,
}>;
```

Notes:

- `events` can be a simple in-memory list used to populate the web UI after attach
- after server restart, state is empty again
- state is rebuilt by fresh connections from interactive/background runners

---

## Why RPC mode for background runners

The background runner should be a real pi subprocess, not SDK code.

Use:

```bash
pi --mode rpc ... -e /path/to/extension.ts
```

Reasons:

- keeps all session logic inside pi
- reuses extension loading and existing pi behavior
- does not require embedding pi with the SDK
- gives a headless process that can stay alive and idle between remote messages

Implementation notes:

- keep the child stdin open so the RPC process stays alive
- the host supervisor does not need to actively drive the child over RPC for normal session input
- the extension inside the child handles server-driven prompts directly

Resume existing sessions via pi's existing session options, e.g. `--session <path|id>`.

---

## Extension behavior

The extension is the main bridge and should run in both interactive and background pi.

### On startup

- never block session startup on server connection
- open the WebSocket in the background
- if the connection fails, keep retrying in the background
- if connected, send a `hello` / `session_start` message with:
  - role (`interactive` or `background`)
  - host ID
  - session GUID
  - session file path if available
  - cwd
  - model

### On reconnect

After connecting, resend enough state for the server to rebuild the session view.

At minimum:

- session metadata
- current conversation snapshot from pi's current session state
- then live events going forward

Use the current branch/path view from pi's session state rather than inventing your own history layer.

### On server-sent input

When the extension receives text from the server, it should inject it as a real user message using pi's proper user-message API rather than a custom message wrapper.

### On abort

Call `ctx.abort()`.

### On `abort_and_release`

The extension should:

1. call `ctx.abort()`
2. wait until the agent settles / becomes idle
3. send `released`
4. if running in background mode, exit the pi process

---

## Minimal wire protocol

Keep the protocol tiny.

## Client -> server

### `hello`
Sent immediately after connect.

```json
{
  "type": "hello",
  "role": "host-supervisor | interactive | background | web",
  "hostId": "machine-123",
  "sessionGuid": "7212843e-b685-4426-888c-44f3d5f06785",
  "sessionFile": "/Users/alice/.pi/.../session.jsonl",
  "cwd": "/Users/alice/project",
  "model": "anthropic/claude-sonnet-4-5"
}
```

### `session_event`
Wraps pi lifecycle/tool/message events for the web UI.

```json
{
  "type": "session_event",
  "sessionGuid": "...",
  "event": { "type": "message_update", "...": "..." }
}
```

### `released`
Sent by a background runner after `abort_and_release` is finished.

```json
{
  "type": "released",
  "sessionGuid": "..."
}
```

### `attach`
Sent by web UI to subscribe to a session.

```json
{
  "type": "attach",
  "sessionGuid": "..."
}
```

### `input`
Sent by web UI to send a prompt to the active owner.

```json
{
  "type": "input",
  "sessionGuid": "...",
  "text": "continue and run the tests"
}
```

### `abort`
Sent by web UI to abort the active owner.

```json
{
  "type": "abort",
  "sessionGuid": "..."
}
```

### `start_background_session`
Sent by the web UI to the server, then forwarded to the selected host supervisor.

```json
{
  "type": "start_background_session",
  "hostId": "machine-123",
  "sessionGuid": "...",
  "sessionFile": "/Users/alice/.pi/.../session.jsonl"
}
```

For brand-new sessions this can later be extended with `cwd`, model selection, and startup prompt.

## Server -> client

### `session_snapshot`
Sent to a web UI after `attach`.

```json
{
  "type": "session_snapshot",
  "sessionGuid": "...",
  "owner": "interactive",
  "cwd": "/Users/alice/project",
  "model": "anthropic/claude-sonnet-4-5",
  "events": [ ... ]
}
```

### `owner_changed`
Broadcast to attached web clients when ownership flips.

```json
{
  "type": "owner_changed",
  "sessionGuid": "...",
  "owner": "background"
}
```

### `input`
Forwarded to the active runner.

```json
{
  "type": "input",
  "text": "continue and run the tests"
}
```

### `abort`
Forwarded to the active runner.

```json
{
  "type": "abort"
}
```

### `abort_and_release`
Sent to the background runner during interactive takeover.

```json
{
  "type": "abort_and_release"
}
```

### `start_background_session`
Forwarded from server to host supervisor.

```json
{
  "type": "start_background_session",
  "sessionGuid": "...",
  "sessionFile": "/Users/alice/.pi/.../session.jsonl"
}
```

---

## Ownership rules

## Case 1: Background runner connects first

- register it as `backgroundConn`
- set owner to `background`
- web commands route to it

## Case 2: Interactive runner connects first

- register it as `interactiveConn`
- set owner to `interactive`
- web commands route to it

## Case 3: Interactive runner connects while background owns the session

- register the interactive connection
- store it as `pendingInteractive`
- send `abort_and_release` to background
- once background sends `released` or disconnects:
  - set owner to `interactive`
  - clear `pendingInteractive`

Important: do **not** block the interactive local pi startup while this happens. The handoff is best-effort and fast.

## Case 4: Interactive runner disconnects

- clear `interactiveConn`
- if no background runner exists, owner becomes `null`
- do not automatically start a background runner

## Case 5: Background runner disconnects

- clear `backgroundConn`
- if no interactive runner exists, owner becomes `null`

## Case 6: Host supervisor disconnects or exits

- it should kill all child background runners it started
- the server will observe those runner disconnects and clear ownership

---

## Main flows

## Flow A: Resume a session locally while it runs in background

1. user opens pi locally on the same session
2. interactive extension connects to server
3. server sees that the session is currently owned by a background runner
4. server sends `abort_and_release` to the background runner
5. background runner aborts, becomes idle, sends `released`, exits
6. server marks owner = `interactive`
7. web UI now routes commands to the interactive runner

This is the core migration flow.

## Flow B: Start or resume a session remotely in background

1. web UI selects a host and session
2. server forwards `start_background_session` to that host's supervisor
3. host supervisor spawns a headless pi child in RPC mode
4. background child connects to server using the extension
5. server marks owner = `background`
6. web UI now observes and controls that background session

## Flow C: Normal live remote prompting

1. web UI attaches to a session
2. server sends `session_snapshot`
3. live `session_event` messages stream to the browser
4. browser sends `input` or `abort`
5. server forwards only to the current owner

---

## Failure behavior

Keep failure behavior simple and explicit.

### Interactive runner cannot reach server

- local pi continues normally
- remote control simply does not work until reconnect

### Sending an event fails

- drop the event
- do not block pi
- continue trying on future events

### Background runner loses server connection

- abort if needed
- exit the background runner

This avoids a hidden writer continuing without the control plane.

### Server restarts

- all in-memory state is lost
- runners reconnect and re-advertise themselves
- web UIs must reattach

Good enough for v1.

---

## Suggested implementation phases

## Phase 1: Clean up current repo

- remove the stale duplicate extension file
- extract protocol/types from the current ad hoc server/extension code
- stop broadcasting commands to every extension client
- switch browser-sent prompts to pi's real user-message API
- split the embedded web UI out of the server file

## Phase 2: Build the in-memory server registry

- add connection roles: `host-supervisor`, `interactive`, `background`, `web`
- add in-memory `hosts` and `sessions` maps
- implement per-session owner routing
- implement attach + snapshot for web clients

## Phase 3: Update the extension

- support role = interactive/background
- send session GUID + metadata on connect
- send best-effort session events
- handle `input`, `abort`, and `abort_and_release`
- background mode exits after release / server disconnect

## Phase 4: Implement the host supervisor

- one process per machine
- connect to server with `hostId`
- spawn background runners in RPC mode
- track child PIDs by session GUID
- kill children on shutdown

## Phase 5: Update the web UI

- list hosts
- list visible sessions
- attach to a session
- start background session on a host
- show current owner
- send prompt / abort to active owner

## Phase 6: Polish

- better reconnect behavior
- clearer owner state in UI
- optional "abort background run and take over?" prompt later if desired

---

## Deferred questions

These do not need to block v1, but should be noted.

### 1. How should a brand-new background session be started?
Likely options:

- spawn in a specific `cwd`
- optionally select model/thinking level
- optionally send an initial prompt

This can be added after background resume works.

### 2. How much history should the extension resend on reconnect?
Probably:

- current session metadata
- current branch/path messages
- then live events

That is enough for the web UI without introducing persistence.

### 3. Node server or Go server?
Both are fine.

Recommendation:

- implement v1 quickly in TypeScript if reusing the current repo is the priority
- move to Go later if a small long-running daemon/server binary becomes more attractive

The protocol should stay simple enough that the server language is not a core architecture decision.

---

## Summary

The simplest useful v2 is:

- one central in-memory server
- one host supervisor per machine
- one background pi child per active background session
- the same extension in interactive and background pi
- direct extension-to-server WebSocket connections
- no startup blocking
- no send blocking
- interactive takeover always aborts the background runner

That should deliver the desired UX without turning the project into a full distributed systems project.
