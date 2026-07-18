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
import type { ServerConfig, ServerCore, Timers } from '../shared/types.js'
import { createCloudflareTransport } from './transport.js'

const DEFAULT_WS_PATH = '/ws'

interface AssetFetcher {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectIdLike {}

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike
  get(id: DurableObjectIdLike): DurableObjectStubLike
}

interface Env {
  ASSETS: AssetFetcher
  TOILET_PI_HUB: DurableObjectNamespaceLike
  TOILET_PI_SERVER_TOKEN: string
  TOILET_PI_SERVER_HISTORY_BYTES?: string
}

type AcceptedWebSocket = WebSocket & {
  accept(): void
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket }
}

export class ToiletPiHub {
  private readonly core: ServerCore
  private readonly env: Env
  private readonly config: ServerConfig
  private readonly connections = new Map<string, WebSocket>()

  constructor(_state: unknown, env: Env) {
    this.env = env

    const timers: Timers = {
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    }

    this.config = {
      serverToken: env.TOILET_PI_SERVER_TOKEN,
      publicUrl: '',
      publicServerUrl: '',
      wsPath: DEFAULT_WS_PATH,
      maxSessionHistoryBytes: Math.max(
        1,
        Number.parseInt(env.TOILET_PI_SERVER_HISTORY_BYTES || '', 10) || 4 * 1024 * 1024,
      ),
      log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
    }

    this.core = createServerCore(createCloudflareTransport(this.connections), timers, this.config)
  }

  async fetch(request: Request): Promise<Response> {
    this.updatePublicUrls(request.url)

    if (!isWebSocketRequest(request)) {
      return plainTextResponse('Expected WebSocket upgrade', 426)
    }

    const auth = await authorizeWebSocketRequest(request, this.env.TOILET_PI_SERVER_TOKEN)
    if (!auth) {
      return plainTextResponse('Unauthorized', 401)
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1] as AcceptedWebSocket
    const connId = globalThis.crypto?.randomUUID?.() || `cf-${Date.now()}-${Math.random()}`

    server.accept()
    this.connections.set(connId, server)
    this.attachSocket(connId, server)
    this.core.onConnect(connId, request.headers.get('cf-connecting-ip') || 'unknown', auth)

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket })
  }

  private attachSocket(connId: string, ws: AcceptedWebSocket): void {
    ws.addEventListener('message', (event) => {
      void this.core.onMessage(connId, decodeWebSocketMessage((event as MessageEvent).data))
    })

    ws.addEventListener('close', (event) => {
      this.connections.delete(connId)
      this.core.onClose(connId)
      const close = event as CloseEvent
      console.log(
        `[${new Date().toISOString()}] socket closed: ${connId} code=${close.code} reason=${close.reason || '(none)'}`,
      )
      try {
        ws.close(close.code, close.reason)
      } catch {
        // The runtime may already have completed the close handshake.
      }
    })

    ws.addEventListener('error', (event) => {
      const error = (event as ErrorEvent).error
      const message = error instanceof Error ? error.message : 'WebSocket error'
      console.log(`[${new Date().toISOString()}] socket error: ${message}`)
    })
  }

  private updatePublicUrls(requestUrl: string): void {
    const inferred = inferPublicUrls(requestUrl)
    this.config.publicUrl = inferred.publicUrl
    this.config.publicServerUrl = inferred.publicServerUrl
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.endsWith('/auth/login')) {
      return handleLoginRequest(request, env)
    }

    if (url.pathname.endsWith('/auth/logout')) {
      return handleLogoutRequest(request, env)
    }

    if (url.pathname.endsWith('/auth/status')) {
      return handleStatusRequest(request, env)
    }

    if (url.pathname.endsWith('/auth/machine-token')) {
      return handleMachineTokenRequest(request, env)
    }

    if (isWebSocketRequest(request) && url.pathname.endsWith(DEFAULT_WS_PATH)) {
      const id = env.TOILET_PI_HUB.idFromName('hub')
      return env.TOILET_PI_HUB.get(id).fetch(request)
    }

    const assetResponse = await env.ASSETS.fetch(request)
    return withSecurityHeaders(assetResponse)
  },
}

async function handleLoginRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowedResponse('POST')
  }

  const token = await extractTokenFromRequest(request)
  if (!hasMatchingToken(env.TOILET_PI_SERVER_TOKEN, token)) {
    return jsonResponse({ ok: false, message: 'Unauthorized' }, 401)
  }

  const sessionToken = await createAdminSessionToken(env.TOILET_PI_SERVER_TOKEN, {
    expiresInSeconds: ADMIN_COOKIE_MAX_AGE_SECONDS,
  })

  return jsonResponse(
    { ok: true },
    200,
    {
      'Set-Cookie': serializeCookie(ADMIN_COOKIE_NAME, sessionToken, {
        path: '/',
        httpOnly: true,
        secure: new URL(request.url).protocol === 'https:',
        sameSite: 'Strict',
        maxAge: ADMIN_COOKIE_MAX_AGE_SECONDS,
      }),
    },
  )
}

async function handleLogoutRequest(request: Request, _env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowedResponse('POST')
  }

  if (!isAllowedCookieOrigin(request)) {
    return jsonResponse({ ok: false, message: 'Forbidden' }, 403)
  }

  return jsonResponse(
    { ok: true },
    200,
    {
      'Set-Cookie': clearCookie(ADMIN_COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        secure: new URL(request.url).protocol === 'https:',
        sameSite: 'Strict',
      }),
    },
  )
}

async function handleStatusRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowedResponse('GET')
  }

  const auth = await verifyAdminSessionCookie(
    env.TOILET_PI_SERVER_TOKEN,
    request.headers.get('cookie'),
    ADMIN_COOKIE_NAME,
  )

  return jsonResponse({ authenticated: auth?.kind === 'admin' }, 200)
}

async function handleMachineTokenRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowedResponse('POST')
  }

  if (!isAllowedCookieOrigin(request)) {
    return jsonResponse({ ok: false, message: 'Forbidden' }, 403)
  }

  const auth = await verifyAdminSessionCookie(
    env.TOILET_PI_SERVER_TOKEN,
    request.headers.get('cookie'),
    ADMIN_COOKIE_NAME,
  )
  if (auth?.kind !== 'admin') {
    return jsonResponse({ ok: false, message: 'Unauthorized' }, 401)
  }

  const machineToken = await createMachineToken(
    env.TOILET_PI_SERVER_TOKEN,
    globalThis.crypto?.randomUUID?.() || `machine-${Date.now()}-${Math.random()}`,
  )

  return jsonResponse({ token: machineToken }, 200)
}

async function authorizeWebSocketRequest(request: Request, expectedAdminToken: string) {
  const url = new URL(request.url)
  const bearerAuth = await getConnectionAuthFromToken(expectedAdminToken, url.searchParams.get('token'))
  if (bearerAuth) return bearerAuth

  if (!isAllowedWebSocketOrigin(request)) return null
  return verifyAdminSessionCookie(expectedAdminToken, request.headers.get('cookie'), ADMIN_COOKIE_NAME)
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get('upgrade') === 'websocket'
}

function inferPublicUrls(requestUrl: string): { publicUrl: string; publicServerUrl: string } {
  const url = new URL(requestUrl)
  const publicUrl = new URL(url.toString())
  const publicPathname = normalizePublicPathname(url.pathname)

  publicUrl.pathname = publicPathname
  publicUrl.search = ''
  publicUrl.hash = ''

  const publicServerUrl = new URL(publicUrl.toString())
  if (publicServerUrl.protocol === 'https:') publicServerUrl.protocol = 'wss:'
  else if (publicServerUrl.protocol === 'http:') publicServerUrl.protocol = 'ws:'
  publicServerUrl.pathname = getWebSocketPathname(publicPathname)

  return {
    publicUrl: publicUrl.toString(),
    publicServerUrl: publicServerUrl.toString(),
  }
}

function normalizePublicPathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  if (pathname.endsWith(DEFAULT_WS_PATH)) {
    return pathname.slice(0, -DEFAULT_WS_PATH.length) || '/'
  }
  if (pathname.endsWith('/index.html')) {
    return pathname.slice(0, -'/index.html'.length) || '/'
  }
  return pathname
}

function getWebSocketPathname(publicPathname: string): string {
  if (publicPathname === '/') return DEFAULT_WS_PATH
  return `${publicPathname.replace(/\/+$/, '')}${DEFAULT_WS_PATH}`
}

function decodeWebSocketMessage(message: unknown): string {
  if (typeof message === 'string') return message
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message)
  if (ArrayBuffer.isView(message)) {
    return new TextDecoder().decode(
      message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength),
    )
  }
  return String(message ?? '')
}

async function extractTokenFromRequest(request: Request): Promise<string | null> {
  const contentType = request.headers.get('content-type') || ''
  const body = await request.text()

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(body)
      return typeof parsed?.token === 'string' ? parsed.token : null
    } catch {
      return null
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(body).get('token')
  }

  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.token === 'string' ? parsed.token : null
  } catch {
    return new URLSearchParams(body).get('token')
  }
}

function isAllowedCookieOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  return safeGetOrigin(origin) === new URL(request.url).origin
}

function isAllowedWebSocketOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  return safeGetOrigin(origin) === new URL(request.url).origin
}

function safeGetOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  applySecurityHeaders(headers)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function jsonResponse(
  payload: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  applySecurityHeaders(headers)
  return new Response(`${JSON.stringify(payload)}\n`, { status, headers })
}

function plainTextResponse(body: string, status = 200): Response {
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  applySecurityHeaders(headers)
  return new Response(body, { status, headers })
}

function methodNotAllowedResponse(allowedMethod: string): Response {
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    Allow: allowedMethod,
  })
  applySecurityHeaders(headers)
  return new Response('Method not allowed', { status: 405, headers })
}

function applySecurityHeaders(headers: Headers): void {
  headers.set(
    'Content-Security-Policy',
    [
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
  )
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
}
