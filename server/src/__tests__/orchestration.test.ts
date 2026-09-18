import { describe, expect, it } from 'vitest'
import { createServerCore } from '../shared/server-core.js'
import { createOrchestratorToken, getConnectionAuthFromToken, createAdminSessionToken, permits } from '../shared/auth.js'
import { issueOrchestratorToken, authenticateOrchestratorHeader } from '../shared/orchestrator-auth.js'
import { parseClientMessage } from '../shared/protocol.js'

async function fixture() {
  const open = new Set<string>(), messages = new Map<string, any[]>(), callbacks = new Set<() => void>(), logs: string[] = []
  const core = createServerCore({ isOpen: id => open.has(id), close: id => { open.delete(id) },
    send: (id, message) => { if (!open.has(id)) return false; messages.get(id)!.push(message); return true } },
  { setTimeout: cb => { callbacks.add(cb); return cb }, clearTimeout: cb => { callbacks.delete(cb as () => void) } },
  { serverToken: 'test', wsPath: '/ws', publicUrl: 'http://isolated', publicServerUrl: 'ws://isolated/ws', log: s => logs.push(s) })
  const send = (id: string, message: any) => core.onMessage(id, JSON.stringify(message))
  const drain = (id: string) => { const result = messages.get(id) || []; messages.set(id, []); return result }
  const connect = async (id: string, role = 'web', sessionGuid = 'session', hostId = 'host', extra: any = {}, auth?: any) => {
    open.add(id); messages.set(id, [])
    core.onConnect(id, 'isolated', auth || (role === 'web' ? { kind: 'admin' } : { kind: 'machine', machineId: hostId }))
    await send(id, { type: 'hello', role, sessionGuid, hostId, capabilities: ['input_tracking_v1', 'history_v1', 'model_control_v1', 'agent_settled_v1'], ...extra })
  }
  const request = (operation: string, fields: any = {}) => ({ type: 'control_request', operation, requestId: crypto.randomUUID(), sessionGuid: 'session', ...fields })
  const command = () => request('send', { inputId: crypto.randomUUID(), mode: 'prompt', text: 'private task' })
  const event = (inputId: string, state: string) => ({ type: 'session_event', sessionGuid: 'session', event: {
    type: 'input_status', input: { inputId, sessionGuid: 'session', state, updatedAt: Date.now() },
  } })
  await connect('web'); await connect('runner', 'interactive'); await connect('host', 'host-supervisor')
  for (const id of open) drain(id)
  return { core, send, drain, connect, request, command, event, open, callbacks, logs }
}

describe('orchestration', () => {
  it('returns an input ID, reconciles immediate settlement and deduplicates without replay', async () => {
    const f = await fixture(), command = f.command()
    await f.send('web', command)
    expect(f.drain('web')[0].data.input.state).toBe('accepted')
    expect(f.drain('runner')[0]).toMatchObject({ type: 'control_command', operation: 'send', inputId: command.inputId })
    await f.send('runner', f.event(command.inputId, 'running'))
    await f.send('runner', f.event(command.inputId, 'settled'))
    await f.send('web', f.request('get_input', { inputId: command.inputId }))
    expect(f.drain('web')[0].data.input.state).toBe('settled')
    await f.send('web', command)
    expect(f.drain('web')[0].data.input.state).toBe('settled')
    expect(f.drain('runner')).toEqual([])
    await f.send('web', { ...command, text: 'different task' })
    expect(f.drain('web')[0].error.code).toBe('id_conflict')
  })
  it('never settles unconsumed inputs, trusts only the owner, and ignores transient busy:false', async () => {
    const f = await fixture(), command = f.command()
    await f.send('web', command); f.drain('web'); f.drain('runner')
    await f.connect('wrong', 'interactive', 'other'); f.drain('web')
    await f.send('wrong', f.event(command.inputId, 'running'))
    await f.send('web', f.event(command.inputId, 'running'))
    await f.send('runner', f.event(command.inputId, 'settled'))
    await f.send('runner', { type: 'session_event', sessionGuid: 'session', event: { type: 'busy', busy: false } })
    await f.send('web', f.request('get_input', { inputId: command.inputId }))
    expect(f.drain('web').at(-1).data.input.state).toBe('accepted')
    await f.connect('replacement', 'interactive'); f.drain('web')
    await f.send('runner', f.event(command.inputId, 'running'))
    await f.send('web', f.request('get_input', { inputId: command.inputId }))
    expect(f.drain('web').at(-1).data.input.state).toBe('unknown')
  })
  it('bounds concurrent hashing and deduplicates simultaneous identical input IDs', async () => {
    const f = await fixture(), same = { ...f.command(), mode: 'steer' }
    await Promise.all([f.send('web', same), f.send('web', same)])
    expect(f.drain('runner').filter(m => m.type === 'control_command')).toHaveLength(1)
    f.drain('web')
    await Promise.all(Array.from({ length: 33 }, () => f.send('web', { ...f.command(), mode: 'steer' })))
    const responses = f.drain('web').filter(m => m.type === 'control_response')
    expect(responses).toHaveLength(33)
    expect(responses.some(m => m.error?.code === 'overloaded')).toBe(true)
    expect(f.drain('runner').filter(m => m.type === 'control_command').length).toBeLessThanOrEqual(32)
  })
  it('requires explicit active ownership/modes, blocks configure during preflight, and refuses uncertified wait before dispatch', async () => {
    const f = await fixture()
    await f.send('host', { type: 'host_sessions', hostId: 'host', sessions: [{ sessionGuid: 'inactive' }] }); f.drain('web')
    await f.send('web', { ...f.command(), sessionGuid: 'inactive' })
    expect(f.drain('web').at(-1).error.code).toBe('inactive')
    expect(f.drain('host')).toEqual([])
    await f.send('web', f.command()); f.drain('web'); f.drain('runner')
    await f.send('web', f.command()); expect(f.drain('web').at(-1).error.code).toBe('busy')
    await f.send('web', { type: 'session_request', sessionGuid: 'session', requestId: 'model', operation: 'configure', thinkingLevel: 'off' })
    expect(f.drain('web').at(-1).error.code).toBe('busy')
    await f.send('web', { ...f.command(), mode: 'steer' }); expect(f.drain('runner')[0].mode).toBe('steer')
    await f.connect('old', 'interactive', 'old-session', 'host', { capabilities: ['input_tracking_v1'] }); f.drain('web')
    await f.send('web', { ...f.command(), sessionGuid: 'old-session', requireSettled: true })
    expect(f.drain('web').at(-1).error.code).toBe('unsupported')
    expect(f.drain('old')).toEqual([])
  })
  it('correlates history and lifecycle, drops stale replies, cleans timeout/disconnect state', async () => {
    const f = await fixture()
    const request = f.request('history', { last: 2 }); await f.send('web', request)
    const command = f.drain('runner')[0]
    expect(f.drain('web')[0]).toMatchObject({ type: 'control_progress', state: 'loading', requestId: request.requestId })
    await f.send('host', { type: 'control_response', requestId: command.requestId, success: true, data: {} })
    expect(f.drain('web')).toEqual([])
    await f.send('runner', { type: 'control_response', requestId: command.requestId, success: true, data: { history: {
      source: 'runtime-branch', sanitized: true, complete: true, truncated: false, leafId: 'a', nextCursor: 'a', hasMore: false,
      messages: [{ role: 'user', entryId: 'a', text: 'hello', privateKey: 'secret' }], privateKey: 'secret',
    } } })
    const response = f.drain('web')[0]
    expect(response.requestId).toBe(request.requestId)
    expect(JSON.stringify(response)).not.toContain('secret')
    await f.send('web', f.request('abort')); f.drain('runner')
    for (const cb of [...f.callbacks]) cb()
    expect(f.drain('web')[0].error.code).toBe('timeout')
    expect(f.callbacks.size).toBe(0)
    await f.send('web', f.request('terminate')); f.drain('runner')
    f.core.onClose('runner'); f.open.delete('runner')
    expect(f.drain('web').find(m => m.type === 'control_response').error.code).toBe('disconnected')
    expect(f.callbacks.size).toBe(0)
  })
  it('launch success requires authenticated matching host/owner hello, not supervisor starting', async () => {
    const f = await fixture()
    const request = f.request('new', { sessionGuid: undefined, hostId: 'host', cwd: '/prepared-worktree' })
    await f.send('web', request)
    const launch = f.drain('host')[0]
    await f.send('host', { type: 'runner_status', requestId: launch.requestId, status: 'starting' })
    expect(f.drain('web').some(m => m.type === 'control_response')).toBe(false)
    await f.connect('forged', 'background', 'wrong', 'wrong-host', { launchRequestId: launch.requestId })
    expect(f.drain('web').some(m => m.type === 'control_response')).toBe(false)
    await f.connect('new-runner', 'background', 'new-session', 'host', { launchRequestId: launch.requestId })
    expect(f.drain('web').find(m => m.type === 'control_response')).toMatchObject({ requestId: request.requestId, data: { sessionGuid: 'new-session', status: 'running' } })
    expect(f.callbacks.size).toBe(0)
  })
  it('reads inactive history without launching and resumes only on explicit request', async () => {
    const f = await fixture()
    await f.send('host', { type: 'host_sessions', hostId: 'host', sessions: [{ sessionGuid: 'inactive', sessionFile: '/fake/session.jsonl' }] })
    f.drain('web')
    await f.send('web', f.request('history', { sessionGuid: 'inactive' }))
    const read = f.drain('host')[0]
    expect(read).toMatchObject({ type: 'control_command', operation: 'history', sessionGuid: 'inactive', sessionFile: '/fake/session.jsonl' })
    await f.send('host', { type: 'control_response', requestId: read.requestId, success: true, data: { history: {
      source: 'persisted-branch', sanitized: true, complete: true, truncated: false, leafId: null, nextCursor: null, hasMore: false, messages: [],
    } } })
    expect(f.drain('web').find(m => m.type === 'control_response').data.history.source).toBe('persisted-branch')
    expect(f.drain('runner')).toEqual([])
    await f.send('web', f.request('resume', { sessionGuid: 'inactive' }))
    const launch = f.drain('host')[0]
    expect(launch).toMatchObject({ type: 'start_background_session', sessionGuid: 'inactive', createNew: false })
    await f.connect('resumed', 'background', 'inactive', 'host', { launchRequestId: launch.requestId })
    expect(f.drain('web').find(m => m.type === 'control_response').data).toEqual({ sessionGuid: 'inactive', status: 'running' })
    expect(f.callbacks.size).toBe(0)
  })
  it('does not let another machine reassign a session through runner status, snapshots, or hello', async () => {
    const f = await fixture()
    await f.connect('evil-host', 'host-supervisor', 'unused', 'other-host')
    await f.send('evil-host', { type: 'runner_status', sessionGuid: 'session', status: 'running' })
    await f.send('evil-host', { type: 'session_snapshot_data', session: { sessionGuid: 'session', history: [{ role: 'user', text: 'forged' }] } })
    await f.connect('evil-runner', 'interactive', 'session', 'other-host')
    expect(f.open.has('evil-runner')).toBe(false)
    await f.send('web', { type: 'attach', sessionGuid: 'session' })
    const snapshot = f.drain('web').filter(m => m.type === 'session_snapshot').at(-1).session
    expect(snapshot.hostId).toBe('host')
    expect(snapshot.history).toEqual([])
    await f.send('web', f.command())
    expect(f.drain('runner').some(m => m.type === 'control_command')).toBe(true)
    expect(f.drain('evil-runner').some(m => m.type === 'control_command')).toBe(false)
  })
  it('rejects malformed, overlong, conflicting and irrelevant operation fields', () => {
    for (const fields of [{ text: 'x'.repeat(51201) }, { mode: 'silent' }, { clearQueue: true }, { inputId: 'bad' }]) {
      expect(parseClientMessage({ type: 'control_request', operation: 'send', sessionGuid: 'session', requestId: 'r', inputId: crypto.randomUUID(), text: 'x', mode: 'prompt', ...fields }).type).toBe('__invalid__')
    }
    expect(parseClientMessage({ type: 'control_request', operation: 'history', sessionGuid: 's', requestId: 'r', last: 1001 }).type).toBe('__invalid__')
  })
})

describe('scoped orchestrator credentials', () => {
  it('signs expiring least-privilege grants and rejects invalid grants, wrong secrets and expired tokens', async () => {
    const token = await createOrchestratorToken('secret', { subject: 'worker', scopes: ['read'], hostIds: ['host'], sessionIds: ['session'], expiresInSeconds: 60 })
    const auth = await getConnectionAuthFromToken('secret', token)
    expect(auth?.kind).toBe('orchestrator')
    expect(permits(auth!, 'read', 'host', 'session')).toBe(true)
    expect(permits(auth!, 'input', 'host', 'session')).toBe(false)
    expect(permits(auth!, 'read', 'other', 'session')).toBe(false)
    expect(await getConnectionAuthFromToken('wrong', token)).toBeNull()
    expect(await authenticateOrchestratorHeader('secret', `Bearer ${token}`)).toEqual(auth)
    await expect(createOrchestratorToken('secret', { subject: 'bad', scopes: ['read', 'admin'], expiresInSeconds: 60 })).rejects.toThrow()
    if (auth?.kind === 'orchestrator') expect(permits({ ...auth, exp: 0 }, 'read', 'host', 'session')).toBe(false)
  })
  it('requires an admin cookie and matching origin to issue credentials', async () => {
    const body = JSON.stringify({ subject: 'worker', scopes: ['read'], hostIds: ['host'], expiresInSeconds: 60 })
    const cookie = `toilet-pi-admin=${await createAdminSessionToken('secret')}`
    expect((await issueOrchestratorToken('secret', null, true, body)).status).toBe(401)
    expect((await issueOrchestratorToken('secret', cookie, false, body)).status).toBe(403)
    expect((await issueOrchestratorToken('secret', cookie, true, body)).status).toBe(200)
  })
  it('filters overview/broadcasts, denies legacy mutation paths, enforces restrictions and attributes without logging prompts', async () => {
    const f = await fixture()
    await f.connect('hidden', 'interactive', 'hidden-session', 'hidden-host')
    const token = await createOrchestratorToken('secret', { subject: 'worker', scopes: ['read'], hostIds: ['host'], sessionIds: ['session'], expiresInSeconds: 60 })
    const auth = await getConnectionAuthFromToken('secret', token)
    await f.connect('scoped', 'web', 'session', 'host', {}, auth)
    const overview = f.drain('scoped')[0]
    expect(overview.hosts.map((h: any) => h.hostId)).toEqual(['host'])
    expect(overview.hosts[0].sessions.map((s: any) => s.sessionGuid)).toEqual(['session'])
    await f.send('scoped', f.command())
    expect(f.drain('scoped')[0].error.code).toBe('forbidden')
    await f.send('scoped', { type: 'input', sessionGuid: 'session', text: 'private task' })
    expect(f.drain('scoped')[0].type).toBe('error')
    await f.send('scoped', { type: 'attach', sessionGuid: 'hidden-session' })
    expect(f.drain('scoped')[0].type).toBe('error')
    await f.send('scoped', { type: 'attach', sessionGuid: 'session' })
    expect(f.drain('scoped')[0].type).toBe('session_snapshot')
    expect(f.logs.some(s => s.includes('"subject":"worker"'))).toBe(true)
    expect(f.logs.join('\n')).not.toContain('private task')
    expect(f.drain('runner')).toEqual([])
    await f.connect('expired', 'web', 'session', 'host', {}, { ...auth, exp: 0 })
    expect(f.open.has('expired')).toBe(false)
  })
})
