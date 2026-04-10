import { hasMatchingToken } from '../shared/auth.js'
import { createServerCore } from '../shared/server-core.js'
import type { ServerConfig, ServerCore, Timers } from '../shared/types.js'
import { createCloudflareTransport, type DurableObjectStateLike } from './transport.js'

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
  TOILET_PI_PUBLIC_URL?: string
  TOILET_PI_WS_PATH?: string
  TOILET_PI_SERVER_HISTORY_LIMIT?: string
}

interface DurableObjectStateWithSockets extends DurableObjectStateLike {
  acceptWebSocket(webSocket: WebSocket, tags?: string[]): void
}

type HibernatingWebSocket = WebSocket & {
  serializeAttachment?: (value: unknown) => void
  deserializeAttachment?: () => unknown
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket }
}

export class ToiletPiHub {
  private readonly core: ServerCore
  private readonly state: DurableObjectStateWithSockets
  private readonly env: Env

  constructor(state: DurableObjectStateWithSockets, env: Env) {
    this.state = state
    this.env = env

    for (const socket of this.state.getWebSockets()) {
      try {
        socket.close(1012, 'server restart')
      } catch {
        // Ignore.
      }
    }

    const timers: Timers = {
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    }
    const config: ServerConfig = {
      serverToken: env.TOILET_PI_SERVER_TOKEN,
      publicUrl: env.TOILET_PI_PUBLIC_URL || '',
      publicServerUrl: env.TOILET_PI_PUBLIC_URL || '',
      maxSessionHistory: Math.max(
        1,
        Number.parseInt(env.TOILET_PI_SERVER_HISTORY_LIMIT || '200', 10) || 200,
      ),
      wsPath: env.TOILET_PI_WS_PATH || '/ws',
      log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
    }

    this.core = createServerCore(createCloudflareTransport(this.state), timers, config)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    const token = url.searchParams.get('token')
    if (!hasMatchingToken(this.env.TOILET_PI_SERVER_TOKEN, token)) {
      return new Response('Unauthorized', { status: 401 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1] as HibernatingWebSocket
    const connId = globalThis.crypto?.randomUUID?.() || `cf-${Date.now()}-${Math.random()}`

    try {
      server.serializeAttachment?.({ connId })
    } catch {
      // Ignore.
    }

    this.state.acceptWebSocket(server, [connId])
    this.core.onConnect(connId, request.headers.get('cf-connecting-ip') || 'unknown')

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connId = this.getConnectionId(ws)
    if (!connId) return
    await this.core.onMessage(connId, decodeWebSocketMessage(message))
  }

  webSocketClose(ws: WebSocket): void {
    const connId = this.getConnectionId(ws)
    if (!connId) return
    this.core.onClose(connId)
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[${new Date().toISOString()}] socket error: ${message}`)
  }

  private getConnectionId(ws: WebSocket): string | null {
    const attachment = (ws as HibernatingWebSocket).deserializeAttachment?.()
    if (attachment && typeof attachment === 'object' && typeof (attachment as any).connId === 'string') {
      return (attachment as any).connId
    }
    return null
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/ws') && request.headers.get('upgrade') === 'websocket') {
      const id = env.TOILET_PI_HUB.idFromName('hub')
      return env.TOILET_PI_HUB.get(id).fetch(request)
    }

    return env.ASSETS.fetch(request)
  },
}

function decodeWebSocketMessage(message: string | ArrayBuffer): string {
  if (typeof message === 'string') return message
  return new TextDecoder().decode(message)
}
