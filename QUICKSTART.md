# Quick Start

## 1. Install

```bash
cd ~/Projects/toilet-pi
npm install
```

## 2. Start the central server

```bash
npm start
```

Open:

```text
http://localhost:3457
```

## 3. Start the host supervisor

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

## Useful environment variables

```bash
TOILET_PI_SERVER_URL=ws://your-server:3457/ws
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
