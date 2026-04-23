# Toilet-Pi

Toilet-Pi is a central web control plane for pi and oh-my-pi.

The easiest way to describe it is:

> It is basically the same idea as pizza, except it has a central server and a shared extension that connects over WebSocket. That means you can interact with all sessions on all machines live, and it also works for normal interactive pi and oh-my-pi sessions. If you send a message from your phone, the message shows up in the desktop TUI too, so the experience stays seamless.

## Why this exists

Normal pi and oh-my-pi sessions live inside one terminal on one machine.

Toilet-Pi adds a thin remote layer on top:

- one **central server** with a web UI
- one **host supervisor** per machine
- one **extension** loaded by pi or oh-my-pi that connects interactive and background sessions to the server

That gives you a few nice advantages:

- **See sessions from every machine in one place**
- **Control already-running interactive sessions remotely**
- **Resume inactive sessions in background without going back to the desk first**
- **Send a message from mobile and have it appear inside the real TUI**
- **Take over a background session locally and make the background runner abort automatically**
- **Keep the architecture simple**: WebSocket + extension + one lightweight supervisor

## Core idea

There are four pieces:

### 1. Central server

The server:

- serves the web UI
- accepts WebSocket connections from browsers, host supervisors, and pi or oh-my-pi extensions
- keeps all state in memory
- tracks the current owner of each session
- routes messages and aborts to the active owner only

### 2. Host supervisor

Each machine runs one long-lived supervisor process.

It:

- scans local pi and oh-my-pi session files
- advertises them to the server
- can start background runners on demand
- kills all of its children when it exits

### 3. Interactive pi or oh-my-pi + extension

Normal pi and oh-my-pi sessions can load `extension.ts`.

Those sessions:

- connect to the central server in the background
- stream messages and status changes
- accept live remote input
- stay fully usable even if the server is down

### 4. Background pi or oh-my-pi + same extension

The supervisor starts headless pi or oh-my-pi processes in RPC mode, using the same extension.

Those background sessions:

- connect directly to the server
- stream events live to the web UI
- exit if the server connection disappears

## Ownership model

For each session GUID, Toilet-Pi keeps exactly one active command target:

- `interactive`
- `background`
- or `none`

This prevents the web UI from blasting commands at multiple copies of the runtime at once.

### Takeover behavior

Interactive session wins.

If a session is running in background and you resume it locally:

1. the interactive session connects
2. the server tells the background runner to `abort_and_release`
3. the background runner aborts and exits
4. ownership flips to the interactive session

That makes local takeover feel natural.

## Design goals

This project intentionally optimizes for simplicity over distributed-systems purity.

### Things it does on purpose

- **No startup blocking**
  - the runtime does not wait for the server to come up
- **No event-send blocking**
  - server sends are best effort
- **No database**
  - server state is in memory only
- **No SDK embedding**
  - background sessions are just real pi or oh-my-pi processes in RPC mode
- **No auth or multi-user permissions yet**
  - this is still a focused personal tool

### Important asymmetry

- **Interactive sessions can survive without the server**
- **Background sessions cannot**

If a background runner loses its server connection, it exits. That avoids hidden orphan writers mutating a session in the dark.

## User experience

The web UI is meant to be useful from a phone.

Current capabilities:

- browse sessions across connected machines
- switch between **Sessions** and **Projects** views
- attach to a session and watch it live
- send messages to active sessions
- send a message to an inactive session and have it auto-start in background
- start a brand-new background session in a project
- abort the currently active owner
- take over a background session locally from the normal TUI

## Files

- `server/` - TypeScript server subproject for Node.js and Cloudflare Workers
- `server/public/` - browser UI
- `extension.ts` - Toilet-Pi extension used by interactive and background pi/oh-my-pi sessions; loaded by `pi install` or direct `omp -e` loading
- `supervisor.js` - one-per-machine supervisor
- `session-scanner.js` - scans local session files
- `scripts/test-client.js` - raw protocol debug client
- `docs/quickstart.md` - short setup guide
- `docs/archive/v2-plan.md` / `docs/archive/v3-plan.md` - archived architecture plans

## Quick start

### 1. Install dependencies

```bash
cd ~/Projects/toilet-pi
npm run setup
```

### 2. Start the central server

```bash
npm start
```

On startup the server prints an **Admin URL** with `#token=...` for seamless web login.

Open the **Admin URL** in your browser.

Important distinction:

- **Admin URL / admin token** - browser sign-in only
- **Machine Connect URL** - used with `/toilet-pi` on one computer

### 3. Configure pi or oh-my-pi and start the host supervisor

After logging into the web UI, open **Installation** and mint a machine-scoped **Connect URL** for the computer you want to set up.

For pi, run `/toilet-pi` inside pi and paste that machine **Connect URL**.
Do **not** paste the browser admin URL into `/toilet-pi`.

For oh-my-pi, load the extension with `omp -e ~/Projects/toilet-pi/extension.ts` or add that path to your configured `extensions` paths. Use the same machine **Connect URL** when the extension prompts.

You can skip the interactive prompt by passing the URL directly:

```text
/toilet-pi ws://your-server/ws?token=...
```

That writes machine-local config to `~/.pi/agent/toilet-pi.json` for pi (respecting `PI_CODING_AGENT_DIR` if set) or `~/.omp/agent/toilet-pi.json` for oh-my-pi.

Then start the host supervisor on that same machine:

```bash
cd ~/Projects/toilet-pi
npm run supervisor
```

This advertises local pi and oh-my-pi session files and lets the web UI start background runners when needed.

### 4. Install and run the extension

Recommended for pi users: install this repo as a local pi package, then start `pi` normally:

```bash
pi install ~/Projects/toilet-pi
pi
```

To install it only for the current project instead of globally:

```bash
cd /path/to/your/project
pi install -l ~/Projects/toilet-pi
```

For one-off testing without installing, load the extension file directly:

```bash
pi -e ~/Projects/toilet-pi/extension.ts
```

For oh-my-pi, load the same extension directly:

```bash
omp -e ~/Projects/toilet-pi/extension.ts
```

To keep it loaded automatically, add `~/Projects/toilet-pi/extension.ts` to your configured `extensions` paths.

On first run the extension stays unconfigured until you run `/toilet-pi` and give it a machine-scoped **Connect URL** minted from the web UI.

Because the extension loads from a local path, changes in this checkout are picked up after restarting the runtime or running `/reload`.

### 5. Use the web UI

From the browser you can:

- inspect sessions from all connected hosts
- open an existing session
- send live prompts into the active owner
- auto-start inactive sessions in background by just sending a message
- start a brand-new session in a project
- abort long-running work

## Deploying the server to Cloudflare Workers

The Cloudflare deployment only hosts the central server and web UI.

You still run these locally on each machine you want to control:

- `npm run supervisor`
- the `extension.ts` extension loaded by `pi` or `omp`

### 1. Install dependencies

```bash
cd ~/Projects/toilet-pi
npm run setup
```

### 2. Log in to Cloudflare

```bash
cd server
npx wrangler login
```

You do **not** need to create the Worker manually in the Cloudflare dashboard first. `wrangler deploy` creates it automatically.

### 3. Create a server token

Generate a token and save it somewhere safe. You will use it for browser admin login and for minting machine-scoped connect URLs from the web UI.

```bash
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"
```

Then store it as a Cloudflare secret:

```bash
cd server
npx wrangler secret put TOILET_PI_SERVER_TOKEN
```

Paste the generated token when prompted.

### 4. Deploy

From the repo root:

```bash
npm run deploy
```

Or directly from `server/`:

```bash
npx wrangler deploy
```

### 5. Open the deployed URLs

After deploy, Wrangler prints your Worker URL, for example:

```text
https://toilet-pi.your-subdomain.workers.dev
```

Toilet-Pi infers its public URLs automatically from the request origin, so no Cloudflare public URL config is required.

Use the **Admin URL**:

```text
https://toilet-pi.your-subdomain.workers.dev/#token=YOUR_TOKEN
```

Open the **Admin URL** in your browser.

Then use **Installation** in the web UI to mint a machine-scoped **Connect URL** for each computer you want to set up, and run that inside the local runtime on that machine:

```text
/toilet-pi wss://toilet-pi.your-subdomain.workers.dev/ws?token=...
```

Then start the host supervisor on that machine:

```bash
npm run supervisor
```

### Cloudflare config used by this repo

`server/wrangler.toml` only needs:

```toml
name = "toilet-pi"
main = "src/cloudflare/entry.ts"
compatibility_date = "2025-04-01"

[assets]
directory = "./public"

[durable_objects]
bindings = [
  { name = "TOILET_PI_HUB", class_name = "ToiletPiHub" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ToiletPiHub"]

[vars]
# TOILET_PI_SERVER_TOKEN: set via `wrangler secret put`
```

## Commands

### Server

```bash
npm start
```

### Host supervisor

```bash
npm run supervisor
```

### Interactive pi (installed package)

```bash
pi
```

### Interactive pi (direct from repo, no install)

```bash
pi -e ~/Projects/toilet-pi/extension.ts
```

### Interactive oh-my-pi (direct load)

```bash
omp -e ~/Projects/toilet-pi/extension.ts
```

### Raw debug client

```bash
npm run client
```

Debug client commands:

- `attach <sessionGuid>`
- `input <text>`
- `abort`
- `start <hostId> <sessionGuid>`
- `refresh <hostId>`
- `quit`

## Environment variables

### Shared

- `TOILET_PI_HOST_ID`
  - default: hostname
- `TOILET_PI_SESSION_DIR`
  - default: `~/.pi/agent/sessions` for pi, `~/.omp/agent/sessions` for oh-my-pi
- `PI_CODING_AGENT_DIR`
  - overrides the active runtime's agent dir (`~/.pi/agent/*` or `~/.omp/agent/*`)

### Server

- `PORT`
  - default: `3457`
- `HOST`
  - optional bind host for the Node server; set `0.0.0.0` for direct LAN/VPS access
- `TOILET_PI_PUBLIC_URL`
  - optional Node-only public base URL override used for printed URLs and browser/WebSocket origin checks; set it to the exact browser origin clients use

### Supervisor

- `TOILET_PI_PI_COMMAND`
  - default: `pi` for pi, `omp` for oh-my-pi
- `TOILET_PI_EXTENSION_PATH`
  - default: local `extension.ts`
- `TOILET_PI_SCAN_INTERVAL_MS`
  - default: `15000`

### Extension / background runner

- `TOILET_PI_SERVER_URL`
  - optional full connect URL override, including `?token=...`
- `TOILET_PI_ROLE`
  - set automatically to `background` for supervisor-launched sessions
- `TOILET_PI_HISTORY_LIMIT`
  - how many recent messages are mirrored to the web UI on connect
- `TOILET_PI_MESSAGE_LIMIT`
  - max per-message text mirrored to the web UI

For direct LAN access without a reverse proxy, start the Node server with `HOST=0.0.0.0` and `TOILET_PI_PUBLIC_URL=http://<LAN-IP>:3457`, then open that exact origin from other devices. If you want to serve Toilet-Pi at `http://<LAN-IP>/` or behind TLS, use a reverse proxy and forward both `/` and `/ws` to the Node server.

## Notes

- server state is in-memory only
- if the server restarts, clients reconnect and rebuild state
- session identity uses the built-in session GUID
- the project intentionally keeps the protocol and architecture small

## License

MPL-2.0
