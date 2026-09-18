import { describe, expect, it } from 'vitest'
import { createServerCore } from '../shared/server-core.js'
import { createNodeTransport } from '../node/transport.js'
import { createCloudflareTransport } from '../cloudflare/transport.js'
import worker from '../cloudflare/entry.js'
import { createAdminSessionToken } from '../shared/auth.js'

for (const kind of ['node', 'cloudflare']) describe(`${kind} transport orchestration`, () => {
  it('reconciles after client reconnect and rejects old owner replies after replacement', async () => {
    const connections = new Map<string, any>()
    const node = kind === 'node' ? createNodeTransport() : null
    const transport = node || createCloudflareTransport(connections)
    const callbacks = new Set<() => void>()
    const core = createServerCore(transport, { setTimeout: cb => { callbacks.add(cb); return cb }, clearTimeout: cb => { callbacks.delete(cb as () => void) } },
      { serverToken: 'unused', wsPath: '/ws', publicUrl: 'http://test', publicServerUrl: 'ws://test/ws', log: () => {} })
    const send = (id: string, message: unknown) => core.onMessage(id, JSON.stringify(message))
    const connect = async (id: string, role = 'web') => {
      const messages: any[] = []
      const ws = { readyState: 1, send: (text: string) => messages.push(JSON.parse(text)), close: () => { ws.readyState = 3 } }
      connections.set(id, ws); node?.register(id, ws as any)
      core.onConnect(id, 'test', role === 'web' ? { kind: 'admin' } : { kind: 'machine', machineId: 'host' })
      await send(id, { type: 'hello', role, sessionGuid: 'session', capabilities: ['input_tracking_v1', 'history_v1'] })
      return messages
    }
    const web = await connect('web'), runner = await connect('runner', 'interactive')
    const inputId = crypto.randomUUID()
    await send('web', { type: 'control_request', requestId: 'send', operation: 'send', sessionGuid: 'session', mode: 'prompt', inputId, text: 'task' })
    transport.close('web'); core.onClose('web')
    await send('runner', { type: 'session_event', sessionGuid: 'session', event: { type: 'input_status', input: { sessionGuid: 'session', inputId, state: 'running', updatedAt: 1 } } })
    await send('runner', { type: 'session_event', sessionGuid: 'session', event: { type: 'input_status', input: { sessionGuid: 'session', inputId, state: 'settled', updatedAt: 2 } } })
    const fresh = await connect('fresh')
    await send('fresh', { type: 'control_request', requestId: 'status', operation: 'get_input', sessionGuid: 'session', inputId })
    expect(fresh.at(-1).data.input.state).toBe('settled')
    await send('fresh', { type: 'control_request', requestId: 'history', operation: 'history', sessionGuid: 'session' })
    const history = runner.at(-1)
    await connect('replacement', 'interactive')
    expect(fresh.some(m => m.type === 'control_response' && m.error?.code === 'owner_changed')).toBe(true)
    core.onClose('runner')
    await send('runner', { type: 'control_response', requestId: history.requestId, success: false, error: { code: 'stale', message: 'stale' } })
    expect(fresh.some(m => m.error?.code === 'stale')).toBe(false)
    expect(web.some(m => m.type === 'control_response' && m.requestId === 'send')).toBe(true)
    expect(callbacks.size).toBe(0)
  })
})

it('Cloudflare token issuance uses shared validation, origin enforcement, no-store and body bounds', async () => {
  const secret = 'test-secret'
  const cookie = `toilet-pi-admin=${await createAdminSessionToken(secret)}`
  const env: any = { TOILET_PI_SERVER_TOKEN: secret }
  const grant = { subject: 'test', scopes: ['read'], hostIds: ['host'], expiresInSeconds: 60 }
  const request = (origin: string, body = JSON.stringify(grant)) => new Request('https://isolated.example/auth/orchestrator-token', {
    method: 'POST', headers: { Origin: origin, Cookie: cookie }, body,
  })
  const denied = await worker.fetch(request('https://wrong.example'), env)
  expect(denied.status).toBe(403)
  const issued = await worker.fetch(request('https://isolated.example'), env)
  expect(issued.status).toBe(200)
  expect(issued.headers.get('cache-control')).toContain('no-store')
  expect((await issued.json() as any).token).toBeTypeOf('string')
  expect((await worker.fetch(request('https://isolated.example', 'x'.repeat(16385)), env)).status).toBe(413)
})
