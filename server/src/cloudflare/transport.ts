import type { Transport } from '../shared/types.js'

export function createCloudflareTransport(connections: Map<string, WebSocket>): Transport {
  return {
    send(connId, payload) {
      const connection = connections.get(connId)
      if (!connection) return false
      try {
        connection.send(JSON.stringify(payload))
        return true
      } catch {
        connections.delete(connId)
        return false
      }
    },

    close(connId, code, reason) {
      const connection = connections.get(connId)
      if (!connection) return
      connections.delete(connId)
      try {
        connection.close(code, reason)
      } catch {
        // Ignore.
      }
    },

    isOpen(connId) {
      return connections.has(connId)
    },
  }
}
