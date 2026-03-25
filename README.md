# Toilet-Pi

Toilet-Pi is a central web control plane for pi.

The easiest way to describe it is:

> It is basically the same idea as pizza, except it has a central server and a pi extension that connects over WebSocket. That means you can interact with all sessions on all machines live, and it also works for normal interactive pi sessions. If you send a message from your phone, the message shows up in the desktop TUI too, so the experience stays seamless.

## Why this exists

Normal pi sessions live inside one terminal on one machine.

Toilet-Pi adds a thin remote layer on top:

- one **central server** with a web UI
- one **host supervisor** per machine
- one **pi extension** that connects interactive and background sessions to the server

That gives you a few nice advantages:

- **See sessions from every machine in one place**
- **Control already-running interactive sessions remotely**
- **Resume inactive sessions in background without going back to the desk first**
- **Send a message from mobile and have it appear inside the real pi TUI**
- **Take over a background session locally and make the background runner abort automatically**
- **Keep the architecture simple**: WebSocket + extension + one lightweight supervisor

## Core idea

There are four pieces:

### 1. Central server

The server:

- serves the web UI
- accepts WebSocket connections from browsers, host supervisors, and pi extensions
- keeps all state in memory
- tracks the current owner of each session
- routes messages and aborts to the active owner only

### 2. Host supervisor

Each machine runs one long-lived supervisor process.

It:

- scans local pi session files
- advertises them to the server
- can start background pi runners on demand
- kills all of its children when it exits

### 3. Interactive pi + extension

Normal pi sessions can load `websocket-extension.ts`.

Those sessions:

- connect to the central server in the background
- stream messages and status changes
- accept live remote input
- stay fully usable even if the server is down

### 4. Background pi + same extension

The supervisor starts headless pi processes in RPC mode, using the same extension.

Those background sessions:

- connect directly to the server
- stream events live to the web UI
- exit if the server connection disappears

## Ownership model

For each pi session GUID, Toilet-Pi keeps exactly one active command target:

- `interactive`
- `background`
- or `none`

This prevents the web UI from blasting commands at multiple copies of pi at once.

### Takeover behavior

Interactive pi wins.

If a session is running in background and you resume it locally:

1. the interactive pi instance connects
2. the server tells the background runner to `abort_and_release`
3. the background runner aborts and exits
4. ownership flips to the interactive pi session

That makes local takeover feel natural.

## Design goals

This project intentionally optimizes for simplicity over distributed-systems purity.

### Things it does on purpose

- **No startup blocking**
  - pi does not wait for the server to come up
- **No event-send blocking**
  - server sends are best effort
- **No database**
  - server state is in memory only
- **No SDK embedding**
  - background sessions are just real pi processes in RPC mode
- **No auth or multi-user permissions yet**
  - this is still a focused personal tool

### Important asymmetry

- **Interactive pi can survive without the server**
- **Background pi cannot**

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
- take over a background session locally from the normal pi TUI

## Files

- `websocket-server.js` - central HTTP/WebSocket server
- `websocket-extension.ts` - pi extension used by interactive and background pi
- `supervisor.js` - one-per-machine supervisor
- `session-scanner.js` - scans local pi session files
- `public/` - browser UI
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

### 3. Start the host supervisor

On each machine you want to expose:

```bash
cd ~/Projects/toilet-pi
npm run supervisor
```

### 4. Start pi interactively with the extension

```bash
pi -e ~/Projects/toilet-pi/websocket-extension.ts
```

### 5. Use the web UI

From the browser you can:

- inspect sessions from all connected hosts
- open an existing session
- send live prompts into the active owner
- auto-start inactive sessions in background by just sending a message
- start a brand-new session in a project
- abort long-running work

## Commands

### Server

```bash
npm start
```

### Host supervisor

```bash
npm run supervisor
```

### Interactive pi

```bash
pi -e ~/Projects/toilet-pi/websocket-extension.ts
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

- `TOILET_PI_SERVER_URL`
  - default: `ws://localhost:3457/ws`
- `TOILET_PI_HOST_ID`
  - default: hostname
- `TOILET_PI_SESSION_DIR`
  - default: `~/.pi/agent/sessions`

### Server

- `PORT`
  - default: `3457`

### Supervisor

- `TOILET_PI_PI_COMMAND`
  - default: `pi`
- `TOILET_PI_EXTENSION_PATH`
  - default: local `websocket-extension.ts`
- `TOILET_PI_SCAN_INTERVAL_MS`
  - default: `15000`

### Extension / background runner

- `TOILET_PI_ROLE`
  - set automatically to `background` for supervisor-launched sessions
- `TOILET_PI_HISTORY_LIMIT`
  - how many recent messages are mirrored to the web UI on connect
- `TOILET_PI_MESSAGE_LIMIT`
  - max per-message text mirrored to the web UI

## Notes

- server state is in-memory only
- if the server restarts, clients reconnect and rebuild state
- session identity uses pi's built-in session GUID
- the project intentionally keeps the protocol and architecture small

## License

MIT
