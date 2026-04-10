import { WebSocket } from 'ws'
import type { Transport } from '../shared/types.js'

export interface NodeTransport extends Transport {
  register(connId: string, ws: WebSocket): void
  unregister(connId: string): void
  closeAll(): void
}

export function createNodeTransport(): NodeTransport {
  const connections = new Map<string, WebSocket>()

  return {
    register(connId, ws) {
      connections.set(connId, ws)
    },

    unregister(connId) {
      connections.delete(connId)
    },

    closeAll() {
      for (const ws of connections.values()) {
        try {
          ws.close()
        } catch {
          // Ignore.
        }
      }
    },

    send(connId, payload) {
      const ws = connections.get(connId)
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      try {
        ws.send(JSON.stringify(payload))
        return true
      } catch {
        return false
      }
    },

    close(connId, code, reason) {
      const ws = connections.get(connId)
      if (!ws) return
      try {
        ws.close(code, reason)
      } catch {
        // Ignore.
      }
    },

    isOpen(connId) {
      const ws = connections.get(connId)
      return ws?.readyState === WebSocket.OPEN
    },
  }
}
