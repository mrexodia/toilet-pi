import { describe, expect, it } from 'vitest'
import { createServerCore } from '../shared/server-core.js'
import { parseClientMessage } from '../shared/protocol.js'

const configuration = { provider: 'test', modelId: 'model', thinkingLevel: 'off' }

async function fixture() {
  const open = new Set<string>()
  const messages = new Map<string, any[]>()
  const timers = new Set<() => void>()
  const core = createServerCore({
    send: (id, payload) => { if (!open.has(id)) return false; messages.get(id)!.push(payload); return true },
    close: id => { open.delete(id) },
    isOpen: id => open.has(id),
  }, {
    setTimeout: callback => { timers.add(callback); return callback },
    clearTimeout: handle => { timers.delete(handle as () => void) },
  }, { serverToken: 'unused', publicUrl: 'http://isolated', publicServerUrl: 'ws://isolated/ws', wsPath: '/ws', log: () => {} })
  const send = (id: string, payload: unknown) => core.onMessage(id, JSON.stringify(payload))
  const drain = (id: string) => { const result = messages.get(id) || []; messages.set(id, []); return result }
  const connect = async (id: string, role = 'web', sessionGuid = 'session') => {
    open.add(id); messages.set(id, [])
    core.onConnect(id, 'test', role === 'web' ? { kind: 'admin' } : { kind: 'machine', machineId: 'host' })
    await send(id, role === 'web' ? { type: 'hello', role } : role === 'host-supervisor'
      ? { type: 'hello', role, hostId: 'host' }
      : { type: 'hello', role, sessionGuid, busy: false, capabilities: ['model_control_v1'], configuration })
  }
  await connect('web-a'); await connect('web-b'); await connect('runner', 'interactive')
  for (const id of open) drain(id)
  const request = (fields = {}) => ({ type: 'session_request', requestId: 'client-id', sessionGuid: 'session', operation: 'get_models', ...fields })
  const answer = (wire: any, fields = {}) => ({ type: 'session_response', requestId: wire.requestId,
    sessionGuid: wire.sessionGuid, success: true, data: { configuration, models: [
      { provider: 'test', id: 'model', name: 'Model', thinkingLevels: ['off'], headers: { Authorization: 'private' } },
    ] }, ...fields })
  return { core, send, drain, connect, request, answer, timers, open }
}

describe('correlated session requests', () => {
  it('routes same client IDs independently, strips private metadata, and updates snapshots', async () => {
    const f = await fixture()
    await f.send('web-a', f.request()); await f.send('web-b', f.request())
    const [a, b] = f.drain('runner')
    expect(a.requestId).not.toBe(b.requestId)
    await f.send('runner', f.answer(b)); await f.send('runner', f.answer(a))
    for (const client of ['web-a', 'web-b']) {
      const replies = f.drain(client).filter(m => m.type === 'session_response')
      expect(replies).toHaveLength(1)
      expect(replies[0].requestId).toBe('client-id')
      expect(replies[0].data.models[0]).not.toHaveProperty('headers')
    }
    expect(f.timers.size).toBe(0)
    await f.send('web-a', { type: 'attach', sessionGuid: 'session' })
    expect(f.drain('web-a').at(-1).session.configuration).toEqual(configuration)
  })

  it('only accepts replies from the exact owning runner and matching session', async () => {
    const f = await fixture()
    await f.connect('other', 'interactive', 'other-session')
    f.drain('web-a')
    await f.send('web-a', f.request())
    const wire = f.drain('runner')[0]
    await f.send('other', f.answer(wire))
    await f.send('web-b', f.answer(wire))
    await f.send('runner', f.answer(wire, { sessionGuid: 'wrong' }))
    expect(f.drain('web-a')).toEqual([])
    expect(f.timers.size).toBe(1)
    await f.send('runner', f.answer(wire))
    expect(f.drain('web-a')[0].success).toBe(true)
  })

  it('projects error replies without inspecting unvalidated extra data', async () => {
    const f = await fixture()
    await f.send('web-a', f.request())
    const wire = f.drain('runner')[0]
    await f.send('runner', f.answer(wire, { success: false, data: {},
      error: { code: 'unsupported', message: 'Unavailable', privateField: 'secret' } }))
    expect(f.drain('web-a')[0]).toEqual({ type: 'session_response', requestId: 'client-id',
      sessionGuid: 'session', success: false, error: { code: 'unsupported', message: 'Unavailable' } })
  })

  it('times out and drops late replies without replaying', async () => {
    const f = await fixture()
    await f.send('web-a', f.request())
    const wire = f.drain('runner')[0]
    for (const timer of [...f.timers]) timer()
    expect(f.drain('web-a')[0].error.code).toBe('timeout')
    await f.send('runner', f.answer(wire))
    expect(f.drain('web-a')).toEqual([])
    expect(f.drain('runner')).toEqual([])
  })

  it('cleans pending requests on client and runner disconnect', async () => {
    const f = await fixture()
    await f.send('web-a', f.request())
    f.core.onClose('web-a'); f.open.delete('web-a')
    expect(f.timers.size).toBe(0)
    await f.send('web-b', f.request())
    f.open.delete('runner'); f.core.onClose('runner')
    expect(f.drain('web-b').find(m => m.type === 'session_response').error.code).toBe('disconnected')
    expect(f.timers.size).toBe(0)
  })

  it('owner replacement invalidates pending operations and ignores old events', async () => {
    const f = await fixture()
    await f.send('web-a', f.request())
    const wire = f.drain('runner')[0]
    await f.connect('replacement', 'interactive')
    expect(f.drain('web-a').find(m => m.type === 'session_response').error.code).toBe('owner_changed')
    await f.send('runner', f.answer(wire))
    await f.send('runner', { type: 'session_event', sessionGuid: 'session', event: {
      type: 'configuration', configuration: { ...configuration, modelId: 'stale' },
    } })
    await f.send('web-a', { type: 'attach', sessionGuid: 'session' })
    expect(f.drain('web-a').at(-1).session.configuration).toEqual(configuration)
  })

  it('rejects busy configuration and blocks remote input during configuration', async () => {
    const f = await fixture()
    await f.send('runner', { type: 'session_event', sessionGuid: 'session', event: { type: 'busy', busy: true } })
    f.drain('web-a')
    await f.send('web-a', f.request({ operation: 'configure', thinkingLevel: 'high' }))
    expect(f.drain('web-a')[0].error.code).toBe('busy')
    await f.send('runner', { type: 'session_event', sessionGuid: 'session', event: { type: 'busy', busy: false } })
    f.drain('web-a')
    await f.send('web-a', f.request({ operation: 'configure', thinkingLevel: 'off' }))
    await f.send('web-b', { type: 'input', sessionGuid: 'session', text: 'do work' })
    expect(f.drain('web-b').at(-1).message).toMatch(/being configured/)
    expect(f.drain('runner').map(m => m.type)).toEqual(['session_request'])
  })

  it('rejects unknown/inactive/old runners instead of silently starting a process', async () => {
    const f = await fixture()
    await f.send('web-a', f.request({ sessionGuid: 'missing' }))
    expect(f.drain('web-a')[0].error.code).toBe('unknown_session')
    await f.send('runner', { type: 'hello', role: 'interactive', sessionGuid: 'session' })
    f.drain('web-a')
    await f.send('web-a', f.request())
    expect(f.drain('web-a')[0].error.code).toBe('unsupported')
    await f.connect('host', 'host-supervisor')
    await f.send('host', { type: 'host_sessions', hostId: 'host', sessions: [{ sessionGuid: 'inactive' }] })
    f.drain('web-a'); f.drain('host')
    await f.send('web-a', f.request({ sessionGuid: 'inactive' }))
    expect(f.drain('web-a')[0].error.code).toBe('inactive')
    expect(f.drain('host')).toEqual([])
  })

  it('bounds outstanding requests and rejects duplicate IDs', async () => {
    const f = await fixture()
    await f.send('web-a', f.request())
    await f.send('web-a', f.request())
    expect(f.drain('web-a')[0].error.code).toBe('duplicate_request')
    for (let i = 1; i < 33; i++) await f.send('web-a', f.request({ requestId: `r${i}` }))
    expect(f.drain('web-a')[0].error.code).toBe('overloaded')
    expect(f.drain('runner')).toHaveLength(32)
  })

  it('machine clients cannot become controllers or send session requests', async () => {
    const f = await fixture()
    await f.connect('host', 'host-supervisor')
    await f.send('host', f.request())
    expect(f.drain('runner')).toEqual([])
    await f.send('host', { type: 'hello', role: 'web' })
    expect(f.drain('host').at(-1).message).toBe('Unauthorized role for this token')
    expect(f.open.has('host')).toBe(false)
  })

  it('validates request selection pairs and nested catalogue responses', () => {
    for (const fields of [
      {}, { provider: 'p' }, { modelId: 'm' }, { thinkingLevel: 'banana' },
    ]) {
      expect(parseClientMessage({ type: 'session_request', requestId: 'r', sessionGuid: 's', operation: 'configure', ...fields }).type).toBe('__invalid__')
    }
    expect(parseClientMessage({ type: 'session_response', requestId: 'r', sessionGuid: 's', success: true,
      data: { configuration, models: [{ provider: 'p', id: 'm', name: 'm', thinkingLevels: ['bogus'] }] } }).type).toBe('__invalid__')
  })
})
