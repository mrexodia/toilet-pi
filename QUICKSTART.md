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

This advertises local pi session files and allows the web UI to start them in background mode.

## 4. Run pi interactively with the extension

```bash
pi -e ~/Projects/toilet-pi/websocket-extension.ts
```

## 5. Use the web UI

In the browser you can:

- pick a host
- view that host's discovered sessions
- attach to a session
- start an inactive session in background
- send live prompts
- abort the active owner

## Default URLs

- Web UI: `http://localhost:3457`
- WebSocket: `ws://localhost:3457/ws`

## Useful environment variables

```bash
TOILET_PI_SERVER_URL=ws://your-server:3457/ws
TOILET_PI_HOST_ID=my-machine
TOILET_PI_SESSION_DIR=/custom/pi/sessions
TOILET_PI_PI_COMMAND=/path/to/pi
PORT=3457
```

## Notes

- interactive pi does not block on server startup or event sends
- background runners are started by `supervisor.js`
- if you resume a background-owned session locally, the background runner aborts and releases it
