import { hasMatchingToken } from '../shared/auth.js'
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
      log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
    }

    this.core = createServerCore(createCloudflareTransport(this.connections), timers, this.config)
  }

  async fetch(request: Request): Promise<Response> {
    this.updatePublicUrls(request.url)

    if (!isWebSocketRequest(request)) {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    const url = new URL(request.url)
    const token = url.searchParams.get('token')
    if (!hasMatchingToken(this.env.TOILET_PI_SERVER_TOKEN, token)) {
      return new Response('Unauthorized', { status: 401 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1] as AcceptedWebSocket
    const connId = globalThis.crypto?.randomUUID?.() || `cf-${Date.now()}-${Math.random()}`

    server.accept()
    this.connections.set(connId, server)
    this.attachSocket(connId, server)
    this.core.onConnect(connId, request.headers.get('cf-connecting-ip') || 'unknown')

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket })
  }

  private attachSocket(connId: string, ws: AcceptedWebSocket): void {
    ws.addEventListener('message', (event) => {
      void this.core.onMessage(connId, decodeWebSocketMessage((event as MessageEvent).data))
    })

    ws.addEventListener('close', () => {
      this.connections.delete(connId)
      this.core.onClose(connId)
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
    if (isWebSocketRequest(request) && url.pathname.endsWith(DEFAULT_WS_PATH)) {
      const id = env.TOILET_PI_HUB.idFromName('hub')
      return env.TOILET_PI_HUB.get(id).fetch(request)
    }

    return env.ASSETS.fetch(request)
  },
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
    return new TextDecoder().decode(message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength))
  }
  return String(message ?? '')
}
