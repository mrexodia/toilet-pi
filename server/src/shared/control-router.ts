import type { ControlRequest, ControlResponse, InputStatus, SessionEvent, HelloRunnerMessage, ServerMessage } from './protocol.js'
import type { SessionState, Timers } from './types.js'

type Pending = { requester: string; target: string; hostId: string | null; request: ControlRequest; timeout: unknown }
type InputRecord = { input: InputStatus; runner: string; fingerprint: string; expires: number }
const terminal = new Set(['settled', 'failed', 'aborted', 'unknown'])

/** Transport-independent v1 orchestration. No inference, process launch, or disk IO here. */
export function createControlRouter(deps: {
  send: (id: string, payload: ServerMessage) => boolean
  timers: Timers
  session: (id?: string) => SessionState | null
  owner: (session: SessionState | null) => string | null
  host: (id: string) => string | null
  capable: (id: string, capability: string) => boolean
  configuring: (id: string) => boolean
  authorized: (client: string, request: ControlRequest) => boolean
  publish: (id: string, event: SessionEvent) => void
}) {
  const pending = new Map<string, Pending>()
  const inputs = new Map<string, InputRecord>()
  const hashing = new Map<string, number>()
  let hashCount = 0
  function reply(client: string, request: ControlRequest, data: ControlResponse['data']) {
    deps.send(client, { type: 'control_response', requestId: request.requestId, success: true, data })
  }
  function error(client: string, request: ControlRequest, code: string, message: string) {
    deps.send(client, { type: 'control_response', requestId: request.requestId, success: false, error: { code, message } })
  }
  function finish(id: string, data?: ControlResponse['data'], code = 'unknown', message = 'Command outcome may be unknown; inspect state before retrying') {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id); deps.timers.clearTimeout(p.timeout)
    if (data) reply(p.requester, p.request, data)
    else error(p.requester, p.request, code, message)
  }
  function setInput(record: InputRecord, state: InputStatus['state']) {
    record.input = { ...record.input, state, updatedAt: Date.now() }
    if (state === 'running' || terminal.has(state)) deps.publish(record.input.sessionGuid, { type: 'queued_input_remove', inputId: record.input.inputId })
    deps.publish(record.input.sessionGuid, { type: 'input_status', input: { ...record.input } })
  }
  function prune() {
    for (const [id, record] of inputs) if (record.expires <= Date.now()) inputs.delete(id)
  }
  function isDispatching(sessionGuid: string) {
    prune()
    return [...inputs.values()].some(r => r.input.sessionGuid === sessionGuid && !terminal.has(r.input.state))
  }
  async function request(client: string, request: ControlRequest) {
    prune()
    const own = [...pending.values()].filter(p => p.requester === client)
    if (own.length + (hashing.get(client) || 0) >= 32 || pending.size + hashCount >= 256) return error(client, request, 'overloaded', 'Too many outstanding operations')
    if (own.some(p => p.request.requestId === request.requestId)) return error(client, request, 'duplicate_request', 'Request already pending')
    const session = deps.session(request.sessionGuid)
    const runner = deps.owner(session)
    if (request.operation === 'get_input') {
      const record = inputs.get(request.inputId!)
      if (!record || record.input.sessionGuid !== request.sessionGuid) return error(client, request, 'unknown_input', 'Input is unknown or expired; this does NOT mean it was not executed')
      return reply(client, request, { input: { ...record.input } })
    }
    if (request.operation !== 'new' && !session) return error(client, request, 'unknown_session', 'Unknown session')
    if (request.operation === 'send') {
      // Hash payloads rather than retaining prompts in the idempotency ledger.
      const bytes = new TextEncoder().encode(JSON.stringify([request.sessionGuid, request.mode, request.text]))
      hashing.set(client, (hashing.get(client) || 0) + 1); hashCount++
      let fingerprint: string
      try {
        fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('')
      } catch {
        return error(client, request, 'runtime_error', 'Could not register input; nothing was dispatched')
      } finally {
        hashCount--
        const count = (hashing.get(client) || 1) - 1
        if (count) hashing.set(client, count); else hashing.delete(client)
      }
      if (!deps.authorized(client, request)) return error(client, request, 'forbidden', 'Authorization expired or target changed')
      const previous = inputs.get(request.inputId!)
      if (previous) {
        if (previous.fingerprint !== fingerprint) return error(client, request, 'id_conflict', 'Input ID was used for different work')
        return reply(client, request, { input: { ...previous.input } })
      }
      if (inputs.size >= 4096) return error(client, request, 'overloaded', 'Input ledger is full; retry later with no automatic replay')
      // Re-check after the digest await: ownership/configuration can change.
      if (!runner || runner !== deps.owner(session)) return error(client, request, 'inactive', 'Resume the session explicitly before sending input')
      if (!deps.capable(runner, 'input_tracking_v1')) return error(client, request, 'unsupported', 'Runner does not support tracked input')
      if (request.requireSettled && !deps.capable(runner, 'agent_settled_v1')) return error(client, request, 'unsupported', 'Runtime settlement support is not verified; send without --wait or update the runtime')
      if (deps.configuring(session!.sessionGuid)) return error(client, request, 'busy', 'Session is being configured')
      if (request.mode === 'prompt' && (session!.busy || session!.queuedInputs.length || isDispatching(session!.sessionGuid))) {
        return error(client, request, 'busy', 'Session has work in flight; choose --steer or --follow-up explicitly')
      }
      const record: InputRecord = { input: { inputId: request.inputId!, sessionGuid: request.sessionGuid!, state: 'accepted', updatedAt: Date.now() },
        runner, fingerprint, expires: Date.now() + 60 * 60 * 1000 }
      inputs.set(request.inputId!, record)
      if (session!.busy || request.mode !== 'prompt') deps.publish(request.sessionGuid!, {
        type: 'queued_input_add', queuedInput: { inputId: request.inputId!, text: request.text!, timestamp: Date.now() },
      })
      if (!deps.send(runner, { ...request, type: 'control_command', requestId: crypto.randomUUID() })) setInput(record, 'unknown')
      return reply(client, request, { input: { ...record.input } })
    }
    if (request.operation === 'resume' && runner) return reply(client, request, { sessionGuid: session!.sessionGuid, status: 'running' })
    const hostId = request.operation === 'new' ? request.hostId! : session!.hostId
    const host = hostId ? deps.host(hostId) : null
    const launching = request.operation === 'resume' || request.operation === 'new'
    const target = launching ? host : request.operation === 'history' ? runner || host : runner
    if (!target) return error(client, request, 'inactive', 'Required runner or host is not connected')
    if (!launching && !deps.capable(target, request.operation === 'history' ? 'history_v1' : 'input_tracking_v1')) {
      return error(client, request, 'unsupported', 'Target does not support this operation')
    }
    if (launching && request.operation === 'resume' && [...pending.values()].some(p => p.request.operation === 'resume' && p.request.sessionGuid === request.sessionGuid)) {
      return error(client, request, 'busy', 'Session launch is already pending')
    }
    const id = crypto.randomUUID()
    const timeout = deps.timers.setTimeout(() => finish(id, undefined, 'timeout'), launching ? 60000 : 15000)
    pending.set(id, { requester: client, target, hostId, request, timeout })
    if (launching || request.operation === 'history') deps.send(client, { type: 'control_progress', requestId: request.requestId,
      ...(request.sessionGuid ? { sessionGuid: request.sessionGuid } : {}), state: launching ? 'starting' : 'loading' })
    if (launching) {
      if (!deps.send(target, { type: 'start_background_session', hostId: hostId!, requestId: id,
        createNew: request.operation === 'new', ...(request.operation === 'new' ? { cwd: request.cwd } : {
          sessionGuid: session!.sessionGuid, sessionFile: session!.sessionFile, cwd: session!.cwd,
        }) })) finish(id)
    } else if (!deps.send(target, { ...request, type: 'control_command', requestId: id,
      ...(target === host ? { sessionFile: session!.sessionFile } : {}) })) finish(id)
  }
  function response(target: string, message: ControlResponse) {
    const p = pending.get(message.requestId)
    if (!p || p.target !== target || ['new', 'resume'].includes(p.request.operation)) return
    if (p.request.operation === 'history' && message.success && !message.data?.history) return finish(message.requestId, undefined, 'invalid_response')
    if (p.request.operation !== 'history' && deps.owner(deps.session(p.request.sessionGuid)) !== target) return finish(message.requestId, undefined, 'owner_changed')
    if (!message.success) return finish(message.requestId, undefined, message.error!.code, message.error!.message)
    const history = message.data?.history
    // Schema projection: no arbitrary runner fields or tool details cross this API.
    finish(message.requestId, history ? { sessionGuid: p.request.sessionGuid, history: {
      source: history.source, sanitized: true, complete: history.complete, truncated: history.truncated,
      leafId: history.leafId, nextCursor: history.nextCursor, hasMore: history.hasMore,
      messages: history.messages.map(m => ({ role: m.role, text: m.text, entryId: m.entryId, timestamp: m.timestamp,
        ...(m.role === 'assistant' ? { stopReason: m.stopReason } : {}),
        ...(m.role === 'toolResult' ? { toolName: m.toolName, isError: m.isError } : {}),
      } as typeof m)),
    } } : { sessionGuid: p.request.sessionGuid, status: 'requested' })
  }
  function event(runner: string, input: InputStatus) {
    const record = inputs.get(input.inputId)
    if (!record || record.runner !== runner || record.input.sessionGuid !== input.sessionGuid || terminal.has(record.input.state)) return
    if (deps.owner(deps.session(input.sessionGuid)) !== runner) return
    const transitions: Record<string, string[]> = {
      accepted: ['submitted', 'running', 'failed', 'unknown'], submitted: ['running', 'failed', 'unknown'],
      running: ['settled', 'failed', 'aborted', 'unknown'],
    }
    if (transitions[record.input.state]?.includes(input.state)) setInput(record, input.state)
  }
  function ownerChanged(sessionGuid: string) {
    const owner = deps.owner(deps.session(sessionGuid))
    for (const record of inputs.values()) if (record.input.sessionGuid === sessionGuid && record.runner !== owner && !terminal.has(record.input.state)) setInput(record, 'unknown')
    for (const [id, p] of pending) if (p.request.sessionGuid === sessionGuid && !['resume', 'new'].includes(p.request.operation) && p.target !== owner && p.target !== (p.hostId && deps.host(p.hostId))) finish(id, undefined, 'owner_changed')
  }
  function hello(runner: string, hostId: string, message: HelloRunnerMessage) {
    const p = message.launchRequestId ? pending.get(message.launchRequestId) : null
    if (p && ['new', 'resume'].includes(p.request.operation) && p.hostId === hostId &&
        deps.host(hostId) === p.target && deps.owner(deps.session(message.sessionGuid)) === runner &&
        (p.request.operation === 'new' || p.request.sessionGuid === message.sessionGuid)) {
      finish(message.launchRequestId!, { sessionGuid: message.sessionGuid, status: 'running' })
    }
    if (message.sessionGuid) ownerChanged(message.sessionGuid)
  }
  function launchError(host: string, id: string) {
    if (pending.get(id)?.target === host) finish(id, undefined, 'launch_failed', 'Runner failed to start')
  }
  function close(id: string) {
    for (const [key, p] of pending) {
      if (p.requester === id) { deps.timers.clearTimeout(p.timeout); pending.delete(key) }
      else if (p.target === id) finish(key, undefined, 'disconnected')
    }
    for (const record of inputs.values()) if (record.runner === id && !terminal.has(record.input.state)) setInput(record, 'unknown')
  }
  return { request, response, event, hello, launchError, close, isDispatching, ownerChanged }
}
