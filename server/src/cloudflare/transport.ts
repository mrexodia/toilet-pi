import type { Transport } from '../shared/types.js'

export interface DurableObjectStateLike {
  getWebSockets(tag?: string): WebSocket[]
}

export function createCloudflareTransport(state: DurableObjectStateLike): Transport {
  function getConnection(connId: string): WebSocket | null {
    return state.getWebSockets(connId)[0] || null
  }

  return {
    send(connId, payload) {
      const connection = getConnection(connId)
      if (!connection) return false
      try {
        connection.send(JSON.stringify(payload))
        return true
      } catch {
        return false
      }
    },

    close(connId, code, reason) {
      const connection = getConnection(connId)
      if (!connection) return
      try {
        connection.close(code, reason)
      } catch {
        // Ignore.
      }
    },

    isOpen(connId) {
      return !!getConnection(connId)
    },
  }
}
