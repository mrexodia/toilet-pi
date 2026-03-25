# Toilet-Pi

Remote control pi sessions from a central web UI.

## What this does

Toilet-Pi v2 has four pieces:

- **Central server**: serves the web UI and routes session traffic
- **Host supervisor**: one long-lived daemon per machine that can start background pi sessions
- **Interactive pi + extension**: normal local pi sessions, visible and steerable from the web UI
- **Background pi + same extension**: headless pi child processes started by the supervisor

The design is intentionally simple:

- no auth
- no persistence beyond pi's own session files
- no startup blocking
- no event-send blocking
- one active owner per session
- interactive pi wins over background pi by aborting the background runner

## Ports and URLs

By default the server uses a single port:

- Web UI: `http://localhost:3457`
- WebSocket: `ws://localhost:3457/ws`

Override with:

```bash
PORT=4567 npm start
```

## Files

- `websocket-server.js` - central server + static web UI hosting
- `websocket-extension.ts` - pi extension used by interactive and background pi
- `supervisor.js` - host supervisor that spawns background pi runners
- `session-scanner.js` - scans local pi session files for the supervisor
- `public/` - web UI
- `test-client.js` - raw protocol debug client
- `V2-PLAN.md` - architecture plan

## Quick start

### 1. Install dependencies

```bash
cd ~/Projects/toilet-pi
npm install
```

### 2. Start the central server

```bash
npm start
```

Open:

```text
http://localhost:3457
```

### 3. Start the host supervisor on a machine

```bash
npm run supervisor
```

This machine will now advertise its local pi sessions and can start background runners for them.

### 4. Run pi interactively with the extension

In another terminal on that machine:

```bash
pi -e ~/Projects/toilet-pi/websocket-extension.ts
```

Open a session normally, or resume an existing one.

### 5. Use the web UI

From the web UI you can:

- see connected hosts
- see discovered session files on each host
- attach to a live session
- send messages to the current owner
- abort the current owner
- start an inactive session in background on a selected host

If a session is currently running in background and you resume it locally with pi, the server tells the background runner to abort and release the session so the interactive runner takes over.

## Environment variables

### Shared

- `TOILET_PI_SERVER_URL` - WebSocket URL for the central server
  - default: `ws://localhost:3457/ws`
- `TOILET_PI_HOST_ID` - override machine ID
  - default: hostname
- `TOILET_PI_SESSION_DIR` - override pi session directory
  - default: `~/.pi/agent/sessions`

### Server

- `PORT` - HTTP + WebSocket port
  - default: `3457`

### Supervisor

- `TOILET_PI_PI_COMMAND` - pi executable to launch
  - default: `pi`
- `TOILET_PI_EXTENSION_PATH` - extension path to load in background runners
  - default: local `websocket-extension.ts`

### Background runners

The supervisor sets these automatically for child pi processes:

- `TOILET_PI_ROLE=background`
- `TOILET_PI_SERVER_URL=...`
- `TOILET_PI_HOST_ID=...`

Interactive pi defaults to `interactive` mode automatically.

## Background runner model

The host supervisor is a single process per machine.

It does **not** proxy all session traffic. Instead, it spawns one headless pi child per active background session, and that child connects directly to the central server using the same extension as interactive pi.

That keeps the process model simple:

- 1 server
- 1 supervisor per machine
- N background pi children per machine
- normal interactive pi processes whenever the user starts them

## Important behaviors

### Server optional for interactive pi

If the server is down, interactive pi still works normally. The extension reconnects in the background when possible.

### Server required for background pi

If a background runner loses its server connection, it exits. This avoids hidden uncontrolled writers continuing to mutate a session.

### No event-send blocking

All server sends are best effort. If the socket is unavailable or a send fails, the extension drops the event rather than slowing down local pi.

## Debug client

A raw debug client is included:

```bash
npm run client
```

Commands:

- `attach <sessionGuid>`
- `input <text>`
- `abort`
- `start <hostId> <sessionGuid>`
- `refresh <hostId>`
- `quit`

## Notes

- State in the server is in-memory only
- If the server restarts, clients reconnect and rebuild state
- Session identity uses pi's built-in session GUID
- Fork/tree state stays within pi's normal session file behavior

## License

MIT
