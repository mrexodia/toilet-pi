# Quick Start

## 1. Install

```bash
cd ~/Projects/toilet-pi
npm run setup
```

## 2. Start the central server

```bash
npm start
```

The server prints:

- an **Admin URL** with `#token=...` for the browser
- a **Connect URL** with `?token=...` for `/toilet-pi`

Open the **Admin URL** in your browser.

## 3. Configure pi or oh-my-pi and start the host supervisor

For pi, run `/toilet-pi` inside pi and paste the **Connect URL** printed by the server.
Do **not** paste the browser admin URL into `/toilet-pi`.

For oh-my-pi, load the extension with `omp -e /path/to/toilet-pi/extension.ts` or add that path to your configured `extensions` paths. Use the same machine **Connect URL** when the extension prompts.

Or skip the prompt:

```text
/toilet-pi ws://your-server/ws?token=...
```

That writes machine-local config to `~/.pi/agent/toilet-pi.json` for pi (respecting `PI_CODING_AGENT_DIR` if set) or `~/.omp/agent/toilet-pi.json` for oh-my-pi.

Then start the host supervisor:

```bash
npm run supervisor
```

This advertises local pi and oh-my-pi session files and lets the web UI start background runners when needed.

## 4. Install and run the extension

Recommended for pi users: install this repo as a local pi package, then start `pi` normally:

```bash
pi install ~/Projects/toilet-pi
pi
```

Project-local install:

```bash
cd /path/to/your/project
pi install --local ~/Projects/toilet-pi
```

One-off testing without installing:

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

## 5. Use the web UI

The UI has two sidebar views:

- **Sessions** - every visible session across all connected hosts, sorted by recent activity
- **Projects** - sessions grouped by project folder and host, with a **New Session** action

Useful behaviors:

- opening an interactive session makes it visible in the browser
- sending a message to an inactive session auto-starts it in background
- starting a new session from **Projects** launches a fresh background session in that project
- resuming a background-owned session locally makes the background runner abort and release ownership

## Cloudflare Workers deploy

You do not need to create the Worker manually in the Cloudflare dashboard first. `wrangler deploy` creates it automatically.

### 1. Log in

```bash
cd ~/Projects/toilet-pi/server
npx wrangler login
```

### 2. Set the shared server token secret

Generate a token:

```bash
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"
```

Then store it in Cloudflare:

```bash
cd ~/Projects/toilet-pi/server
npx wrangler secret put TOILET_PI_SERVER_TOKEN
```

Paste the generated token when prompted.

### 3. Deploy

From the repo root:

```bash
cd ~/Projects/toilet-pi
npm run deploy
```

### 4. Use the deployed URLs

If Wrangler prints a URL like:

```text
https://toilet-pi.your-subdomain.workers.dev
```

then use:

- Admin URL: `https://toilet-pi.your-subdomain.workers.dev/#token=YOUR_TOKEN`
- Connect URL: `wss://toilet-pi.your-subdomain.workers.dev/ws?token=YOUR_TOKEN`

The Worker infers its public origin automatically from the incoming request, so no extra Cloudflare public URL config is needed.

## Default URLs

- Web UI: `http://localhost:3457`
- WebSocket: `ws://localhost:3457/ws`
- Local config file: `~/.pi/agent/toilet-pi.json` for pi, `~/.omp/agent/toilet-pi.json` for oh-my-pi
- Local session dir: `~/.pi/agent/sessions` for pi, `~/.omp/agent/sessions` for oh-my-pi

## Useful environment variables

```bash
PI_CODING_AGENT_DIR=~/.pi/agent            # overrides the active runtime's agent dir (`~/.pi/agent` or `~/.omp/agent`)
HOST=0.0.0.0                                # optional Node server bind host for LAN/VPS access
TOILET_PI_PUBLIC_URL=https://your-server    # optional Node-only public base URL; set this to the exact browser origin
TOILET_PI_SERVER_URL=ws://your-server/ws?token=...  # optional override
TOILET_PI_HOST_ID=my-machine
TOILET_PI_SESSION_DIR=/custom/agent/sessions        # overrides the active runtime's session dir (`~/.pi/agent/sessions` or `~/.omp/agent/sessions`)
TOILET_PI_PI_COMMAND=/path/to/runtime               # overrides the active runtime command (`pi` or `omp`)
TOILET_PI_SCAN_INTERVAL_MS=15000
PORT=3457
```

For direct LAN access without a reverse proxy, start the Node server with `HOST=0.0.0.0`, keep the default port, and set `TOILET_PI_PUBLIC_URL` to the exact address clients will use, for example `http://192.168.0.20:3457`. If you want `http://192.168.0.20/` without a port suffix, put a reverse proxy in front of Toilet-Pi and forward both `/` and `/ws`.


## Notes

- interactive sessions do not block on server startup or event sends
- background runners are started by `supervisor.js`
- if a background runner loses the server, it exits
