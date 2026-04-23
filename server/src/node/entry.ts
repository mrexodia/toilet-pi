import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  ADMIN_COOKIE_MAX_AGE_SECONDS,
  ADMIN_COOKIE_NAME,
  clearCookie,
  createAdminSessionToken,
  createMachineToken,
  getConnectionAuthFromToken,
  hasMatchingToken,
  serializeCookie,
  verifyAdminSessionCookie,
} from '../shared/auth.js'
import { createServerCore } from '../shared/server-core.js'
import type { ServerConfig, Timers } from '../shared/types.js'
import { resolveRuntimeTarget } from './runtime-target.js'
import { createNodeTransport } from './transport.js'

const PORT = Number.parseInt(process.env.PORT || '3457', 10)
const HOST = String(process.env.HOST || '').trim() || null
const WS_PATH = process.env.TOILET_PI_WS_PATH || '/ws'
const PUBLIC_URL = process.env.TOILET_PI_PUBLIC_URL || `http://localhost:${PORT}`
const PUBLIC_SERVER_URL = getPublicServerUrl(PUBLIC_URL, WS_PATH)
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url))
const SERVER_RUNTIME_TARGET = resolveRuntimeTarget()
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
  wsPath: WS_PATH,
  log,
}
const core = createServerCore(transport, timers, config)
const connectionIds = new WeakMap<WebSocket, string>()
const connectionAuthById = new Map<string, Awaited<ReturnType<typeof authorizeWebSocketRequest>>>()

const server = createServer(async (req, res) => {
  const requestUrl = getRequestUrl(req)

  try {
    if (requestUrl.pathname === '/auth/login') {
      await handleLoginRequest(req, res)
      return
    }

    if (requestUrl.pathname === '/auth/logout') {
      await handleLogoutRequest(req, res)
      return
    }

    if (requestUrl.pathname === '/auth/status') {
      await handleStatusRequest(req, res)
      return
    }

    if (requestUrl.pathname === '/auth/machine-token') {
      await handleMachineTokenRequest(req, res)
      return
    }

    const filePath = resolvePublicPath(requestUrl.pathname)
    if (!filePath) {
      sendText(res, 404, 'Not found')
      return
    }

    const content = await readFile(filePath)
    sendBuffer(res, 200, content, getContentType(filePath))
  } catch (error) {
    log(
      `http request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    sendText(res, 500, 'Internal server error')
  }
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  void (async () => {
    const requestUrl = getRequestUrl(req)
    if (requestUrl.pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const auth = await authorizeWebSocketRequest(req)
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    const connId = randomUUID()
    connectionAuthById.set(connId, auth)
    wss.handleUpgrade(req, socket, head, (ws) => {
      connectionIds.set(ws, connId)
      transport.register(connId, ws)
      wss.emit('connection', ws, req)
    })
  })().catch((error) => {
    log(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`)
    try {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
    } catch {
      // Ignore.
    }
    socket.destroy()
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
  core.onConnect(connId, remote, connectionAuthById.get(connId) || null)
  connectionAuthById.delete(connId)

  ws.on('message', async (data) => {
    await core.onMessage(connId, data.toString())
  })

  ws.on('close', () => {
    core.onClose(connId)
    transport.unregister(connId)
    connectionAuthById.delete(connId)
  })

  ws.on('error', (error) => {
    log(`socket error: ${error.message}`)
  })
})

server.listen(PORT, HOST || undefined, () => {
  console.log('='.repeat(60))
  console.log('toilet-pi server')
  console.log('='.repeat(60))
  console.log(`Bind: ${HOST || '*'}:${PORT}`)
  console.log(`Web UI: ${PUBLIC_URL}`)
  console.log(`WebSocket: ${PUBLIC_SERVER_URL}`)
  console.log(`Admin login URL: ${buildAdminUrl(PUBLIC_SERVER_URL, SERVER_TOKEN)}`)
  console.log('Machine connect URLs are minted from the web UI after admin login')
  console.log('State: in-memory only')
  console.log('='.repeat(60))
})

async function handleLoginRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }

  const body = await readRequestBody(req)
  const token = extractTokenFromBody(body, req.headers['content-type'])
  if (!hasMatchingToken(SERVER_TOKEN, token)) {
    sendJson(res, 401, { ok: false, message: 'Unauthorized' }, { cacheControl: 'no-store' })
    return
  }

  const sessionToken = await createAdminSessionToken(SERVER_TOKEN, {
    expiresInSeconds: ADMIN_COOKIE_MAX_AGE_SECONDS,
  })

  sendJson(
    res,
    200,
    { ok: true },
    {
      cacheControl: 'no-store',
      setCookie: serializeCookie(ADMIN_COOKIE_NAME, sessionToken, {
        path: '/',
        httpOnly: true,
        secure: isSecureRequest(req),
        sameSite: 'Strict',
        maxAge: ADMIN_COOKIE_MAX_AGE_SECONDS,
      }),
    },
  )
}

async function handleLogoutRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }

  if (!isAllowedCookieOrigin(req)) {
    sendJson(res, 403, { ok: false, message: 'Forbidden' }, { cacheControl: 'no-store' })
    return
  }

  sendJson(
    res,
    200,
    { ok: true },
    {
      cacheControl: 'no-store',
      setCookie: clearCookie(ADMIN_COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        secure: isSecureRequest(req),
        sameSite: 'Strict',
      }),
    },
  )
}

async function handleStatusRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }

  const auth = await verifyAdminSessionCookie(
    SERVER_TOKEN,
    req.headers.cookie || null,
    ADMIN_COOKIE_NAME,
  )

  sendJson(
    res,
    200,
    {
      authenticated: auth?.kind === 'admin',
    },
    { cacheControl: 'no-store' },
  )
}

async function handleMachineTokenRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }

  if (!isAllowedCookieOrigin(req)) {
    sendJson(res, 403, { ok: false, message: 'Forbidden' }, { cacheControl: 'no-store' })
    return
  }

  const auth = await verifyAdminSessionCookie(
    SERVER_TOKEN,
    req.headers.cookie || null,
    ADMIN_COOKIE_NAME,
  )
  if (auth?.kind !== 'admin') {
    sendJson(res, 401, { ok: false, message: 'Unauthorized' }, { cacheControl: 'no-store' })
    return
  }

  const machineToken = await createMachineToken(SERVER_TOKEN, randomUUID())
  sendJson(
    res,
    200,
    {
      token: machineToken,
    },
    { cacheControl: 'no-store' },
  )
}

async function authorizeWebSocketRequest(req: IncomingMessage) {
  const requestUrl = getRequestUrl(req)
  const bearerAuth = await getConnectionAuthFromToken(SERVER_TOKEN, requestUrl.searchParams.get('token'))
  if (bearerAuth) return bearerAuth

  if (!isAllowedWebSocketOrigin(req)) return null
  return verifyAdminSessionCookie(SERVER_TOKEN, req.headers.cookie || null, ADMIN_COOKIE_NAME)
}

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
  if (filePath.endsWith('.webmanifest')) return 'application/manifest+json; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.png')) return 'image/png'
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

function getServerStatePath(): string {
  return path.join(SERVER_RUNTIME_TARGET.agentDir, 'toilet-pi-server.json')
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
  await mkdir(SERVER_RUNTIME_TARGET.agentDir, { recursive: true })
  await writeFile(getServerStatePath(), `${JSON.stringify({ token }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return token
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url || '/', getRequestBaseUrl(req))
}

function getRequestBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host || `localhost:${PORT}`
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
  const protocol = forwardedProto || new URL(PUBLIC_URL).protocol.replace(/:$/, '') || 'http'
  return `${protocol}://${host}`
}

function getExpectedBrowserOrigin(req: IncomingMessage): string {
  if (process.env.TOILET_PI_PUBLIC_URL) {
    return new URL(PUBLIC_URL).origin
  }
  return new URL(getRequestBaseUrl(req)).origin
}

function isSecureRequest(req: IncomingMessage): boolean {
  return getExpectedBrowserOrigin(req).startsWith('https://')
}

function isAllowedCookieOrigin(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin || '').trim()
  if (!origin) return true
  return safeGetOrigin(origin) === getExpectedBrowserOrigin(req)
}

function isAllowedWebSocketOrigin(req: IncomingMessage): boolean {
  const origin = String(req.headers.origin || '').trim()
  if (!origin) return false
  return safeGetOrigin(origin) === getExpectedBrowserOrigin(req)
}

function safeGetOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > 16 * 1024) {
      throw new Error('Request body too large')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function extractTokenFromBody(body: string, contentType: string | string[] | undefined): string | null {
  const normalizedType = Array.isArray(contentType) ? contentType[0] : contentType || ''
  if (normalizedType.includes('application/json')) {
    try {
      const parsed = JSON.parse(body)
      return typeof parsed?.token === 'string' ? parsed.token : null
    } catch {
      return null
    }
  }

  if (normalizedType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(body).get('token')
  }

  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.token === 'string' ? parsed.token : null
  } catch {
    return new URLSearchParams(body).get('token')
  }
}

function getSecurityHeaders(contentType: string, cacheControl?: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
  }
}

function sendBuffer(
  res: ServerResponse,
  statusCode: number,
  content: Buffer,
  contentType: string,
  options: { cacheControl?: string; setCookie?: string } = {},
): void {
  res.writeHead(statusCode, {
    ...getSecurityHeaders(contentType, options.cacheControl),
    ...(options.setCookie ? { 'Set-Cookie': options.setCookie } : {}),
  })
  res.end(content)
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  options: { cacheControl?: string; setCookie?: string } = {},
): void {
  res.writeHead(statusCode, {
    ...getSecurityHeaders('text/plain; charset=utf-8', options.cacheControl),
    ...(options.setCookie ? { 'Set-Cookie': options.setCookie } : {}),
  })
  res.end(body)
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  options: { cacheControl?: string; setCookie?: string } = {},
): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  sendBuffer(res, statusCode, body, 'application/json; charset=utf-8', options)
}

function sendMethodNotAllowed(res: ServerResponse, allowedMethod: string): void {
  res.writeHead(405, {
    ...getSecurityHeaders('text/plain; charset=utf-8', 'no-store'),
    Allow: allowedMethod,
  })
  res.end('Method not allowed')
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
