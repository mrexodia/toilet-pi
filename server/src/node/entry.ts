import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { hasMatchingToken } from '../shared/auth.js'
import { createServerCore } from '../shared/server-core.js'
import type { ServerConfig, Timers } from '../shared/types.js'
import { createNodeTransport } from './transport.js'

const PORT = Number.parseInt(process.env.PORT || '3457', 10)
const WS_PATH = process.env.TOILET_PI_WS_PATH || '/ws'
const PUBLIC_URL = process.env.TOILET_PI_PUBLIC_URL || `http://localhost:${PORT}`
const PUBLIC_SERVER_URL = getPublicServerUrl(PUBLIC_URL, WS_PATH)
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url))
const MAX_SESSION_HISTORY = Math.max(
  1,
  Number.parseInt(
    process.env.TOILET_PI_SERVER_HISTORY_LIMIT || process.env.TOILET_PI_HISTORY_LIMIT || '200',
    10,
  ) || 200,
)
const SERVER_TOKEN = await ensureServerToken()

const transport = createNodeTransport()
const timers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
}
const config: ServerConfig = {
  serverToken: SERVER_TOKEN,
  publicUrl: PUBLIC_URL,
  publicServerUrl: PUBLIC_SERVER_URL,
  maxSessionHistory: MAX_SESSION_HISTORY,
  wsPath: WS_PATH,
  log,
}
const core = createServerCore(transport, timers, config)
const connectionIds = new WeakMap<WebSocket, string>()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`)
    const filePath = resolvePublicPath(url.pathname)
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }

    const content = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': getContentType(filePath) })
    res.end(content)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`)
  if (url.pathname !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }

  const token = url.searchParams.get('token')
  if (!hasMatchingToken(SERVER_TOKEN, token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  const connId = randomUUID()
  wss.handleUpgrade(req, socket, head, (ws) => {
    connectionIds.set(ws, connId)
    transport.register(connId, ws)
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws, req) => {
  const connId = connectionIds.get(ws)
  if (!connId) {
    try {
      ws.close(1011, 'Missing connection id')
    } catch {
      // Ignore.
    }
    return
  }

  const remote = req.socket.remoteAddress || 'unknown'
  core.onConnect(connId, remote)

  ws.on('message', async (data) => {
    await core.onMessage(connId, data.toString())
  })

  ws.on('close', () => {
    core.onClose(connId)
    transport.unregister(connId)
  })

  ws.on('error', (error) => {
    log(`socket error: ${error.message}`)
  })
})

server.listen(PORT, () => {
  console.log('='.repeat(60))
  console.log('toilet-pi v3 server')
  console.log('='.repeat(60))
  console.log(`Web UI: ${PUBLIC_URL}`)
  console.log(`WebSocket: ${PUBLIC_SERVER_URL}`)
  console.log(`Admin URL: ${buildAdminUrl(PUBLIC_SERVER_URL, SERVER_TOKEN)}`)
  console.log(
    `Connect URL: ${buildConnectUrl({ serverUrl: PUBLIC_SERVER_URL, token: SERVER_TOKEN })}`,
  )
  console.log('State: in-memory only')
  console.log('='.repeat(60))
})

function resolvePublicPath(requestPath: string): string | null {
  const pathname = requestPath === '/' ? '/index.html' : requestPath
  const fullPath = path.normalize(path.join(PUBLIC_DIR, pathname))
  if (!fullPath.startsWith(PUBLIC_DIR)) return null
  return fullPath
}

function getContentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

function getPublicServerUrl(publicUrl: string, wsPath: string): string {
  const url = new URL(publicUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('TOILET_PI_PUBLIC_URL must use http://, https://, ws://, or wss://')
  }
  url.pathname = wsPath
  url.search = ''
  url.hash = ''
  return url.toString()
}

function normalizeConnectConfig(configValue: { serverUrl: string; token: string }) {
  const serverUrl = String(configValue?.serverUrl || '').trim()
  const token = String(configValue?.token || '').trim()
  if (!serverUrl || !token) {
    throw new Error('Invalid toilet-pi config')
  }

  const url = new URL(serverUrl)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('toilet-pi serverUrl must use ws:// or wss://')
  }
  url.pathname = url.pathname && url.pathname !== '/' ? url.pathname : WS_PATH
  url.search = ''
  url.hash = ''

  return {
    serverUrl: url.toString(),
    token,
  }
}

function buildConnectUrl(configValue: { serverUrl: string; token: string }): string {
  const normalized = normalizeConnectConfig(configValue)
  const url = new URL(normalized.serverUrl)
  url.searchParams.set('token', normalized.token)
  return url.toString()
}

function buildAdminUrl(serverUrl: string, token: string): string {
  const url = new URL(serverUrl)
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol === 'wss:') url.protocol = 'https:'
  if (url.pathname === WS_PATH) {
    url.pathname = '/'
  } else if (url.pathname.endsWith(WS_PATH)) {
    url.pathname = url.pathname.slice(0, -WS_PATH.length) || '/'
  }
  url.search = ''
  url.hash = new URLSearchParams({ token }).toString()
  return url.toString()
}

function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir) {
    if (envDir === '~') return homedir()
    if (envDir.startsWith('~/')) return path.join(homedir(), envDir.slice(2))
    return envDir
  }
  return path.join(homedir(), '.pi', 'agent')
}

function getServerStatePath(): string {
  return path.join(getAgentDir(), 'toilet-pi-server.json')
}

async function ensureServerToken(): Promise<string> {
  const envToken = String(process.env.TOILET_PI_SERVER_TOKEN || '').trim()
  if (envToken) return envToken

  try {
    const raw = await readFile(getServerStatePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.token === 'string' && parsed.token.trim()) {
      return parsed.token.trim()
    }
  } catch {
    // Ignore.
  }

  const token = randomBytes(32).toString('base64url')
  await mkdir(getAgentDir(), { recursive: true })
  await writeFile(getServerStatePath(), `${JSON.stringify({ token }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return token
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

let shuttingDown = false

function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, shutting down server...`)
  transport.closeAll()
  wss.close(() => {
    server.close(() => {
      console.log('Server closed')
      process.exit(0)
    })
  })
  setTimeout(() => process.exit(1), 1000)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
