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

## 3. Configure pi and start the host supervisor

Inside pi, run `/toilet-pi` and paste the **Connect URL** printed by the server.

Or skip the prompt:

```text
/toilet-pi ws://your-server/ws?token=...
```

That writes config to `~/.pi/agent/toilet-pi.json` (respecting `PI_CODING_AGENT_DIR` if set).

Then start the host supervisor:

```bash
npm run supervisor
```

This advertises local pi session files and lets the web UI start background pi runners when needed.

## 4. Install and run the pi extension

Recommended: install this repo as a local pi package, then start `pi` normally:

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

## 5. Use the web UI

The UI has two sidebar views:

- **Sessions** - every visible session across all connected hosts, sorted by recent activity
- **Projects** - sessions grouped by project folder and host, with a **New Session** action

Useful behaviors:

- opening an interactive pi session makes it visible in the browser
- sending a message to an inactive session auto-starts it in background
- starting a new session from **Projects** launches a fresh background pi session in that project
- resuming a background-owned session locally makes the background runner abort and release ownership

## Default URLs

- Web UI: `http://localhost:3457`
- WebSocket: `ws://localhost:3457/ws`
- Local config file: `~/.pi/agent/toilet-pi.json`

## Useful environment variables

```bash
PI_CODING_AGENT_DIR=~/.pi/agent
TOILET_PI_PUBLIC_URL=https://your-server
TOILET_PI_SERVER_URL=ws://your-server/ws?token=...   # optional override
TOILET_PI_HOST_ID=my-machine
TOILET_PI_SESSION_DIR=/custom/pi/sessions
TOILET_PI_PI_COMMAND=/path/to/pi
TOILET_PI_SCAN_INTERVAL_MS=15000
PORT=3457
```

## Notes

- interactive pi does not block on server startup or event sends
- background runners are started by `supervisor.js`
- if a background runner loses the server, it exits
