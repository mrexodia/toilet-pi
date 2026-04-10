# Toilet-Pi Server Refactor: Dual-Runtime Support

## Goal

Rewrite the legacy single-file server in TypeScript as a shared-core architecture that runs on both:

1. **Node.js** — long-running process with `ws` library (for users self-hosting on a VPS)
2. **Cloudflare Workers** — single Durable Object hub with WebSocket Hibernation (for Cloudflare deployments)

Both entry points must produce identical behavior from a client's perspective. The existing client contract (raw WebSocket at `<host>/<path>/ws?token=...`) must be preserved — no client changes required beyond reconnection handling.

## Package Structure

The root package is the pi extension. The server lives in its own subproject so that server-only dependencies don't pollute the extension package that users install via `pi install`.

```
toilet-pi/
  package.json              # Extension package — what `pi install` sees
  extension.ts              # Pi extension (unchanged)
  supervisor.js             # Host supervisor (unchanged)
  session-scanner.js        # Session scanner (unchanged)
  toilet-pi-config.js       # Client-side config (unchanged, not shared with server)
  test-client.js            # Debug client (unchanged)
  server/
    package.json            # Server subproject — own deps, own tsconfig
    tsconfig.json
    wrangler.toml           # Cloudflare config
    public/                 # Static web UI files (moved from root)
    src/
      shared/               # All business logic, types, protocol, auth
      node/                 # Node entry point + transport
      cloudflare/           # Worker + DO entry point + transport
      __tests__/            # Shared-core tests with fake Transport/Timers
```

### Root `package.json`

Server scripts delegate into the subproject. Pi extension discovery uses `"pi.extensions"`, not npm `"main"` — don't change `"main"`.

```json
{
  "scripts": {
    "start": "npm start --prefix server",
    "dev": "npm run dev --prefix server",
    "dev:cf": "npm run dev:cf --prefix server",
    "deploy": "npm run deploy --prefix server",
    "server": "npm start --prefix server",
    "supervisor": "node supervisor.js",
    "client": "node test-client.js",
    "setup": "npm install && npm install --prefix server"
  }
}
```

`npm run setup` installs both root and server deps. This is intentionally not `postinstall` — `pi install <path>` must not trigger server dependency installation.

### Server `package.json`

```json
{
  "name": "toilet-pi-server",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/node/entry.ts",
    "dev": "tsx --watch src/node/entry.ts",
    "build": "tsc",
    "check": "tsc --noEmit",
    "dev:cf": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "ws": "^8.x"
  },
  "devDependencies": {
    "tsx": "^4.x",
    "typescript": "^5.x",
    "vitest": "^3.x",
    "wrangler": "^3.x"
  }
}
```

The server is a clean break from the root package. It does not import `toilet-pi-config.js` or anything else from the root. The Node entry point handles its own config (token generation, URL printing, etc.). The Cloudflare entry point reads config from Wrangler secrets/vars.

## Key Abstractions

The shared core is a factory function that accepts two injected interfaces:

### Transport

The current code only touches WebSocket objects in three ways: send, check if open, and close. The refactor replaces WebSocket object references with opaque string connection IDs.

```ts
interface Transport {
  send(connId: string, payload: unknown): boolean
  close(connId: string, code?: number, reason?: string): void
  isOpen(connId: string): boolean
}
```

### Timers

The current code uses `setTimeout` for pending snapshot load timeouts. The shared logic must go through an injected interface rather than calling globals directly. This prevents accidental use of `setInterval` (not on the interface), enables fake timers in tests, and gives the Cloudflare entry point a seam to swap in the Alarms API if ever needed.

```ts
interface Timers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
```

### Factory

```ts
function createServerCore(transport: Transport, timers: Timers, config: ServerConfig): ServerCore
```

Returns `{ onConnect, onMessage, onClose }` — the three lifecycle hooks that both entry points call into. All state (hosts, sessions, clients, etc.) lives as closures inside the factory. All Maps are keyed by string connection IDs.

## Cloudflare Architecture

Uses a plain Durable Object with the raw WebSocket Hibernation API. No additional frameworks.

A Worker-level `fetch` handler routes WebSocket upgrades to a single DO instance:

```ts
// Worker fetch handler
const url = new URL(request.url)
if (url.pathname.endsWith('/ws') && request.headers.get('upgrade') === 'websocket') {
  const id = env.TOILET_PI_HUB.idFromName('hub')
  return env.TOILET_PI_HUB.get(id).fetch(request)
}
return env.ASSETS.fetch(request)
```

The DO class uses `this.ctx.acceptWebSocket(server, [connId])` for hibernation support and `this.ctx.getWebSockets(connId)` for tag-based connection lookup in the transport. Token validation happens in the DO's `fetch` method before accepting the WebSocket.

The web UI path prefix (e.g., `/toilet-pi/`) is handled by the Worker's static asset binding. The WebSocket path just needs to end in `/ws` — both `/ws?token=...` and `/toilet-pi/ws?token=...` work.

### Wrangler config

```toml
name = "toilet-pi"
main = "src/cloudflare/entry.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

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
TOILET_PI_PUBLIC_URL = ""
# TOILET_PI_SERVER_TOKEN: set via `wrangler secret put`
```

## Hibernation Strategy

On Node, the process lives for months. On Cloudflare, if all connections drop, the DO hibernates and in-memory state is lost. If the DO wakes with previously accepted WebSockets still present, those sockets would otherwise survive transport-wise but no longer exist in the shared core's Maps.

**Strategy: treat hibernation wake-up as a server restart.** On DO constructor start, call `state.getWebSockets()` and immediately close any existing sockets. That forces every client to reconnect and send `hello` again, which avoids zombie connections that look open but are no longer registered in the shared core.

This means no DO storage API, no state serialization, no rehydration logic. Recovery happens entirely through reconnect + re-handshake.

**Consequence:** background runners will exit on this kind of restart, which is acceptable and consistent with the existing rule that background sessions do not survive server loss.

**Prerequisite:** before starting the rewrite, verify that `extension.ts`, `supervisor.js`, and `public/app.js` all handle reconnect-after-close correctly. If any client doesn't handle this, fix it first. Minor client-side changes here are acceptable.

## Refactor Steps

### Step 0: Verify client reconnection

Test all clients (extension, supervisor, web UI) against the current Node server:

1. Connect everything, kill the server, restart it. Do clients reconnect and re-hello?
2. Send an unexpected error to a connected client. Does it re-hello?

Fix any clients that don't handle this before proceeding.

### Step 1: Scaffold the server subproject

Set up `server/` with package.json, tsconfig.json, wrangler.toml, move `public/` in. Wire up root package.json scripts. Verify `npm run setup` and `npm start` work (can start with a placeholder entry point).

### Step 2: Rewrite shared core in TypeScript

Rewrite the legacy business logic as `server/src/shared/server-core.ts` (and supporting modules for types, protocol, auth).

Key structural changes from the current code:
- All Maps keyed by string connection IDs instead of WebSocket objects.
- Session state fields (`interactiveConn`, `backgroundConn`, `pendingInteractiveConn`, `host.conn`) are `string | null` connection IDs.
- `send(ws, payload)` → `transport.send(connId, payload)`.
- `isOpen(ws)` → `transport.isOpen(connId)`.
- `setTimeout`/`clearTimeout` → `timers.setTimeout`/`timers.clearTimeout`.
- Factory function named `createServerCore` (not `createServer`, to avoid confusion with `http.createServer`).

Type the message protocol as TypeScript discriminated unions — every `if (message.type === "...")` branch in the current code becomes a variant. This serves as protocol documentation and catches bugs.

Implement `hasMatchingToken` in the shared auth module without Node-specific APIs (no `node:crypto` — use a constant-time comparison loop or `crypto.subtle`).

### Step 3: Add shared-core tests

Test the core with fake Transport and Timers via vitest. High-priority test cases:

- Hello handshake for each role
- "Send hello first" for unknown connections
- Ownership transitions (interactive wins over background)
- Background promotion on interactive disconnect
- Queued input delivery
- Host disconnect → session pruning
- Session snapshot load and timeout
- Broadcast to attached web clients

### Step 4: Write the Node entry point

Handles HTTP static file serving, WebSocket upgrade with token validation, SIGINT/SIGTERM shutdown, startup banner. Generates/reads the server token, prints admin and connect URLs (reimplement the relevant bits from `toilet-pi-config.js` — this is a clean break, not a shared import).

### Step 5: Cloudflare proof-of-concept

Before writing the full CF entry point, build a minimal Worker + DO that accepts a raw WebSocket at `/ws`, echoes messages, and hibernates correctly. Test with `test-client.js`. This takes ~30 minutes and eliminates the biggest uncertainty.

### Step 6: Write the Cloudflare entry point

Worker routes `/ws` upgrades to the single DO. DO validates the token, accepts the WebSocket with a connection ID tag, and wires lifecycle hooks to `createServerCore`. Config comes from Wrangler secrets/vars.

### Step 7: Integration test both runtimes

Run the full test sequence against both `npm start` (Node) and `npm run dev:cf` (Cloudflare). Verify identical behavior including the hibernation reconnection flow on CF.

## Important Notes

- The supervisor, extension, session-scanner, and test-client are WebSocket *clients* — they connect to `/ws?token=...` and don't care about the server runtime. They require zero changes (beyond any reconnection fixes from Step 0).
- All connections route to a single Durable Object instance (`idFromName('hub')`). No per-session rooms. The DO is the equivalent of the Node process.
- The web UI can be served at any path prefix. The WebSocket endpoint just needs to be reachable relative to the UI (already configurable via `TOILET_PI_PUBLIC_URL`).