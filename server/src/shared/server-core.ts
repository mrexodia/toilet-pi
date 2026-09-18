import { permits, type ConnectionAuth, type OrchestratorScope } from './auth.js'
import { createControlRouter } from './control-router.js'
import {
  parseClientMessage,
  type ClientMessage,
  type HelloHostSupervisorMessage,
  type HelloMessage,
  type HelloRunnerMessage,
  type NoticeMessage,
  type OverviewHost,
  type QueuedInput,
  type SanitizedMessage,
  type ServerMessage,
  type SessionEvent,
  type SessionSnapshot,
  type SessionRequest,
  type SessionResponse,
} from './protocol.js'
import type {
  ActiveTool,
  CatalogSession,
  ClientState,
  FoundCatalogSession,
  HostCatalog,
  HostState,
  PendingInput,
  ServerConfig,
  ServerCore,
  SessionState,
  SnapshotData,
  Timers,
  Transport,
  WebClientState,
} from './types.js'

interface EnsureBackgroundOptions {
  hostId?: string | null
  sessionFile?: string | null
  cwd?: string | null
  requestId?: string | null
}

const DEFAULT_MAX_SESSION_HISTORY_BYTES = 4 * 1024 * 1024

export function createServerCore(
  transport: Transport,
  timers: Timers,
  config: ServerConfig,
): ServerCore {
  const hosts = new Map<string, HostState>()
  const hostCatalogs = new Map<string, HostCatalog>()
  const sessions = new Map<string, SessionState>()
  const webClients = new Map<string, WebClientState>()
  const clients = new Map<string, ClientState>()
  const authContexts = new Map<string, ConnectionAuth>()
  const pendingSessionSnapshotLoads = new Map<string, unknown>()
  const runnerCapabilities = new Map<string, Set<string>>()
  const pendingRequests = new Map<string, {
    requester: string; runner: string; request: SessionRequest; timeout: unknown
  }>()
  const maxSessionHistoryBytes =
    typeof config.maxSessionHistoryBytes === 'number' &&
    Number.isFinite(config.maxSessionHistoryBytes) &&
    config.maxSessionHistoryBytes > 0
      ? Math.floor(config.maxSessionHistoryBytes)
      : DEFAULT_MAX_SESSION_HISTORY_BYTES

  const log =
    config.log ??
    ((message: string) => {
      console.log(`[${new Date().toISOString()}] ${message}`)
    })

  const control = createControlRouter({
    send, timers, session: getKnownSession, owner: getOwnerConnection,
    host: id => { const conn = hosts.get(id)?.conn; return conn && transport.isOpen(conn) ? conn : null },
    capable: (id, cap) => runnerCapabilities.get(id)?.has(cap) || false,
    configuring: isConfiguring,
    authorized: (client, request) => {
      const session = getKnownSession(request.sessionGuid)
      const scope = ({ send: 'input', abort: 'abort', terminate: 'abort', resume: 'start', new: 'start', history: 'read', get_input: 'read' } as const)[request.operation]
      return transport.isOpen(client) && permits(authContexts.get(client), scope, request.hostId || session?.hostId, request.sessionGuid)
    },
    publish: (sessionGuid, event) => {
      const session = sessions.get(sessionGuid)
      const queuedBefore = session?.queuedInputs.length || 0
      if (session) applySessionEvent(session, event)
      sendToAttached(sessionGuid, { type: 'session_event', sessionGuid, event })
      if ((session?.queuedInputs.length || 0) !== queuedBefore) broadcastOverview()
    },
  })

  function canRead(connId: string, sessionGuid: string): boolean {
    const session = getKnownSession(sessionGuid)
    return permits(authContexts.get(connId), 'read', session?.hostId, sessionGuid)
  }

  function send(connId: string, payload: ServerMessage): boolean {
    const auth = authContexts.get(connId)
    if (auth?.kind === 'orchestrator') {
      if (auth.exp <= Math.floor(Date.now() / 1000)) { transport.close(connId, 1008, 'Expired'); return false }
      if (payload.type === 'overview') {
        payload = { ...payload, hosts: payload.hosts.filter(h => !auth.hostIds || auth.hostIds.includes(h.hostId)).map(h => ({ ...h,
          sessions: h.sessions.filter(s => permits(auth, 'read', h.hostId, s.sessionGuid)),
        })).filter(h => !auth.sessionIds || h.sessions.length > 0) }
      } else if (payload.type === 'notice' || payload.type === 'launch_status' || payload.type === 'background_session_started') return true
      else if (!((payload.type === 'session_response' || payload.type === 'control_response') && !payload.success)) {
        const sessionGuid = 'sessionGuid' in payload ? payload.sessionGuid : payload.type === 'session_snapshot' ? payload.session.sessionGuid :
          payload.type === 'control_response' ? payload.data?.sessionGuid || payload.data?.input?.sessionGuid : null
        if (sessionGuid && !canRead(connId, sessionGuid)) return true
      }
    }
    if (!transport.isOpen(connId)) return false
    const sent = transport.send(connId, payload)
    if (!sent) {
      log(`socket send failed for ${connId}`)
      try {
        transport.close(connId)
      } catch {
        // Ignore.
      }
    }
    return sent
  }

  function onConnect(connId: string, remoteAddr: string, auth?: ConnectionAuth | null): void {
    if (auth) authContexts.set(connId, auth)
    log(`client connected from ${remoteAddr}`)
  }

  async function onMessage(connId: string, data: string): Promise<void> {
    const auth = authContexts.get(connId)
    if (auth?.kind === 'orchestrator' && auth.exp <= Math.floor(Date.now() / 1000)) {
      transport.close(connId, 1008, 'Expired'); onClose(connId); return
    }
    if (data.length > 8 * 1024 * 1024) { transport.close(connId, 1009, 'Message too large'); onClose(connId); return }
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      send(connId, { type: 'error', message: 'Invalid JSON' })
      return
    }

    const message = parseClientMessage(raw)
    if (!clients.has(connId) && message.type !== 'hello') {
      send(connId, { type: 'error', message: 'Send hello first' })
      return
    }

    if (message.type === '__invalid__') {
      send(connId, { type: 'error', message: `Invalid message: ${message.message}` })
      return
    }

    if (message.type === '__unknown__') {
      return
    }

    if (message.type === 'hello') {
      handleHello(connId, message)
      return
    }

    const client = clients.get(connId)
    if (!client) return

    if (client.role === 'web') {
      await handleWebMessage(connId, message)
      return
    }

    if (client.role === 'host-supervisor') {
      await handleHostMessage(connId, message)
      return
    }

    handleRunnerMessage(connId, message, client)
  }

  function onClose(connId: string): void {
    control.close(connId)
    runnerCapabilities.delete(connId)
    for (const [id, pending] of pendingRequests) {
      if (pending.requester === connId) {
        timers.clearTimeout(pending.timeout)
        pendingRequests.delete(id)
      } else if (pending.runner === connId) {
        failRequest(id, 'disconnected', 'Runner disconnected; command outcome may be unknown. Inspect state before retrying.')
      }
    }
    handleClose(connId)
  }

  function requestError(connId: string, request: SessionRequest, code: string, message: string): void {
    send(connId, { type: 'session_response', requestId: request.requestId,
      sessionGuid: request.sessionGuid, success: false, error: { code, message } })
  }

  function failRequest(id: string, code: string, message: string): void {
    const pending = pendingRequests.get(id)
    if (!pending) return
    timers.clearTimeout(pending.timeout)
    pendingRequests.delete(id)
    requestError(pending.requester, pending.request, code, message)
  }

  function isConfiguring(sessionGuid: string): boolean {
    return Array.from(pendingRequests.values()).some(p =>
      p.request.sessionGuid === sessionGuid && p.request.operation === 'configure')
  }

  function handleSessionRequest(connId: string, request: SessionRequest): void {
    const ownRequests = Array.from(pendingRequests.values()).filter(p => p.requester === connId)
    if (ownRequests.some(p => p.request.requestId === request.requestId)) {
      requestError(connId, request, 'duplicate_request', 'Request ID is already pending')
      return
    }
    if (ownRequests.length >= 32 || pendingRequests.size >= 256) {
      requestError(connId, request, 'overloaded', 'Too many pending requests')
      return
    }
    const session = getKnownSession(request.sessionGuid)
    const runner = getOwnerConnection(session)
    const runnerClient = runner ? clients.get(runner) : null
    const ownsSession = runnerClient && (runnerClient.role === 'interactive' || runnerClient.role === 'background') &&
      runnerClient.sessionGuid === request.sessionGuid
    if (!session || !runner || !ownsSession) {
      requestError(connId, request, session ? 'inactive' : 'unknown_session',
        session ? 'Session is inactive; resume it explicitly before querying runtime capabilities or configuration' : 'Unknown session')
      return
    }
    if (!runnerCapabilities.get(runner)?.has('model_control_v1')) {
      requestError(connId, request, 'unsupported', 'Runner does not support model control; update its extension when convenient')
      return
    }
    if (isConfiguring(session.sessionGuid) || (request.operation === 'configure' &&
        (session.busy || session.queuedInputs.length > 0 || session.pendingInputs.length > 0 || control.isDispatching(session.sessionGuid)))) {
      requestError(connId, request, 'busy', 'Session is busy, queued, or being configured; wait or abort first')
      return
    }
    // Broker-generated IDs prevent collisions between independent clients.
    const id = createId()
    const timeout = timers.setTimeout(() => failRequest(id, 'timeout',
      'Runner response timed out; command outcome may be unknown. Inspect state before retrying.'), 15000)
    pendingRequests.set(id, { requester: connId, runner, request, timeout })
    if (!send(runner, {
      type: 'session_request', requestId: id, sessionGuid: request.sessionGuid, operation: request.operation,
      ...(request.provider !== undefined ? { provider: request.provider, modelId: request.modelId } : {}),
      ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
    })) {
      failRequest(id, 'disconnected', 'Could not contact runner; inspect state before retrying')
    }
  }

  function handleSessionResponse(connId: string, response: SessionResponse): void {
    const pending = pendingRequests.get(response.requestId)
    if (!pending || pending.runner !== connId || pending.request.sessionGuid !== response.sessionGuid) return
    const session = sessions.get(response.sessionGuid)
    if (!session || getOwnerConnection(session) !== connId) {
      failRequest(response.requestId, 'owner_changed', 'Session owner changed; inspect state before retrying')
      return
    }
    if (response.success && pending.request.operation === 'get_models' && !response.data?.models) {
      failRequest(response.requestId, 'invalid_response', 'Runner omitted the model catalogue')
      return
    }
    timers.clearTimeout(pending.timeout)
    pendingRequests.delete(response.requestId)
    // Project onto the public schema; never forward arbitrary model/auth fields.
    const data = response.success ? response.data : undefined
    const configuration = data ? {
      provider: data.configuration.provider, modelId: data.configuration.modelId,
      thinkingLevel: data.configuration.thinkingLevel,
    } : undefined
    if (response.success && configuration) {
      session.configuration = configuration
      session.model = configuration.modelId
      sendToAttached(session.sessionGuid, { type: 'session_event', sessionGuid: session.sessionGuid,
        event: { type: 'configuration', configuration } })
    }
    send(pending.requester, {
      type: 'session_response', requestId: pending.request.requestId,
      sessionGuid: response.sessionGuid, success: response.success,
      ...(response.success && data && configuration ? { data: { configuration,
        ...(data.models ? { models: data.models.map(m => ({ provider: m.provider, id: m.id,
          name: m.name, thinkingLevels: m.thinkingLevels })) } : {}),
      } } : { error: { code: response.error!.code, message: response.error!.message } }),
    })
  }

  function handleHello(connId: string, message: HelloMessage): void {
    const auth = authContexts.get(connId)
    if (!auth) {
      send(connId, { type: 'error', message: 'Unauthorized connection' })
      transport.close(connId, 1008, 'Unauthorized')
      return
    }

    const role = message.role
    if (role === 'web' ? auth.kind !== 'admin' && auth.kind !== 'orchestrator' : auth.kind !== 'machine') {
      send(connId, { type: 'error', message: 'Unauthorized role for this token' })
      transport.close(connId, 1008, 'Unauthorized role')
      return
    }
    const previousClient = clients.get(connId)
    if (previousClient && (previousClient.role !== role ||
        ((previousClient.role === 'interactive' || previousClient.role === 'background') && previousClient.sessionGuid !== ('sessionGuid' in message ? message.sessionGuid : null)))) {
      send(connId, { type: 'error', message: 'Reconnect before changing connection identity' })
      transport.close(connId, 1008, 'Identity changed')
      onClose(connId)
      return
    }
    if (!['web', 'host-supervisor', 'interactive', 'background'].includes(role)) {
      send(connId, { type: 'error', message: `Unknown role: ${String(role)}` })
      transport.close(connId, 1008, 'Unknown role')
      return
    }

    if (role === 'web') {
      clients.set(connId, { role: 'web' })
      webClients.set(connId, { attachedSessionGuid: null })
      sendOverview(connId)
      return
    }

    if (auth.kind !== 'machine') {
      send(connId, { type: 'error', message: 'Unauthorized role for this token' })
      transport.close(connId, 1008, 'Unauthorized role')
      return
    }

    if (role === 'host-supervisor') {
      registerHostSupervisor(connId, message, auth.machineId)
      return
    }

    if (!message.sessionGuid) {
      send(connId, { type: 'error', message: 'Missing sessionGuid' })
      transport.close(connId, 1008, 'Missing sessionGuid')
      return
    }

    const known = getKnownSession(message.sessionGuid)
    if (known?.hostId && known.hostId !== auth.machineId) {
      send(connId, { type: 'error', message: 'Session belongs to another host' })
      transport.close(connId, 1008, 'Host mismatch')
      return
    }
    clients.set(connId, {
      role,
      hostId: auth.machineId,
      sessionGuid: message.sessionGuid,
    })
    registerRunner(connId, message, auth.machineId)
  }

  function registerHostSupervisor(
    connId: string,
    message: HelloHostSupervisorMessage,
    hostId: string,
  ): void {
    const previous = hosts.get(hostId)
    if (previous && previous.conn !== connId && transport.isOpen(previous.conn)) {
      transport.close(previous.conn, 1000, 'replaced')
    }
    clients.set(connId, {
      role: 'host-supervisor',
      hostId,
    })
    runnerCapabilities.set(connId, new Set(message.capabilities || []))
    const hostname = message.hostname || hostId
    hosts.set(hostId, {
      hostId,
      hostname,
      platform: message.platform || null,
      pid: typeof message.pid === 'number' ? message.pid : null,
      conn: connId,
      connectedAt: Date.now(),
    })
    for (const session of sessions.values()) {
      if (session.hostId === hostId) session.hostname = hostname
    }
    broadcastOverview()
    broadcastNotice({
      type: 'notice',
      level: 'info',
      message: `Host connected: ${message.hostname || hostId}`,
    })
  }

  async function handleWebMessage(connId: string, message: ClientMessage): Promise<void> {
    const auth = authContexts.get(connId)
    if (auth?.kind === 'orchestrator') {
      const sessionGuid = 'sessionGuid' in message ? message.sessionGuid : null
      const session = sessionGuid ? getKnownSession(sessionGuid) : null
      const hostId = message.type === 'control_request' && message.operation === 'new' ? message.hostId : session?.hostId
      let scope: OrchestratorScope | null = null
      if (message.type === 'attach') scope = 'read'
      if (message.type === 'session_request') scope = message.operation === 'configure' ? 'configure' : 'read'
      if (message.type === 'control_request') scope = ({ send: 'input', abort: 'abort', terminate: 'abort', resume: 'start', new: 'start', history: 'read', get_input: 'read' } as const)[message.operation]
      const allowed = scope !== null && ((message.type === 'attach' && message.sessionGuid === null) || permits(auth, scope, hostId, sessionGuid))
      log(JSON.stringify({ audit: 'orchestrator', subject: auth.sub, tokenId: auth.jti, operation: 'operation' in message ? message.operation : message.type,
        sessionGuid, hostId, allowed }))
      if (!allowed) {
        if (message.type === 'session_request') requestError(connId, message, 'forbidden', 'Operation outside token scope')
        else if (message.type === 'control_request') send(connId, { type: 'control_response', requestId: message.requestId, success: false, error: { code: 'forbidden', message: 'Operation outside token scope' } })
        else send(connId, { type: 'error', message: 'Operation outside token scope; use correlated control requests' })
        return
      }
    }
    if (message.type === 'control_request') {
      await control.request(connId, message)
      return
    }
    if (message.type === 'session_request') {
      handleSessionRequest(connId, message)
      return
    }
    if (message.type === 'attach') {
      const sessionGuid = typeof message.sessionGuid === 'string' ? message.sessionGuid : null
      const state = webClients.get(connId)
      if (state) state.attachedSessionGuid = sessionGuid
      send(connId, {
        type: 'session_snapshot',
        session: buildSessionSnapshot(sessionGuid),
      })
      if (sessionGuid) {
        await requestSessionSnapshotFromHost(sessionGuid)
      }
      return
    }

    if (message.type === 'input') {
      const text = String(message.text || '').trim()
      if (!message.sessionGuid || !text) return

      const session = getKnownSession(message.sessionGuid)
      if (!session) {
        send(connId, {
          type: 'error',
          message: `Unknown session ${message.sessionGuid}`,
        })
        return
      }

      if (isConfiguring(session.sessionGuid)) {
        send(connId, { type: 'error', message: 'Session is being configured; retry input after configuration completes' })
        return
      }
      const inputId = createId()
      const target = getOwnerConnection(session)
      const shouldQueueVisibly = !target || session.busy

      if (shouldQueueVisibly) {
        addQueuedInput(session, {
          inputId,
          text,
          timestamp: Date.now(),
        })
      }

      if (target) {
        send(target, { type: 'input', text, inputId })
        return
      }

      session.pendingInputs.push({ inputId, text })
      const started = ensureBackgroundSession(session)
      if (!started) {
        session.pendingInputs.pop()
        if (shouldQueueVisibly) removeQueuedInput(session, inputId)
        send(connId, {
          type: 'error',
          message: 'This session cannot be started in background right now',
        })
        return
      }

      send(connId, {
        type: 'notice',
        level: 'info',
        message: `Starting background runner for ${formatSessionLabel(session)}`,
      })
      return
    }

    if (message.type === 'abort') {
      const session = getKnownSession(message.sessionGuid)
      const target = getOwnerConnection(session)
      if (!target) {
        send(connId, {
          type: 'error',
          message: 'Session is not currently owned by an active runner',
        })
        return
      }
      send(target, { type: 'abort' })
      return
    }

    if (message.type === 'terminate_session') {
      const session = getKnownSession(message.sessionGuid)
      const target = getOwnerConnection(session)
      if (!session || !target) {
        send(connId, {
          type: 'error',
          message: 'Session is not currently owned by an active runner',
        })
        return
      }
      send(target, { type: 'terminate_session' })
      send(connId, {
        type: 'notice',
        level: 'info',
        message: `Closing ${formatSessionLabel(session)}…`,
      })
      return
    }

    if (message.type === 'start_background_session') {
      const session = getKnownSession(message.sessionGuid) || getOrCreateSession(message.sessionGuid)
      if (message.hostId) session.hostId = message.hostId
      if (message.sessionFile) session.sessionFile = message.sessionFile
      if (message.cwd) session.cwd = message.cwd
      const started = ensureBackgroundSession(session, {
        requestId: message.requestId || null,
      })
      if (!started) {
        send(connId, {
          type: 'error',
          message: 'Could not start background session',
        })
      }
      return
    }

    if (message.type === 'create_background_session') {
      const host = hosts.get(message.hostId)
      const cwd = typeof message.cwd === 'string' ? message.cwd : null
      if (!host?.conn || !transport.isOpen(host.conn)) {
        send(connId, {
          type: 'error',
          message: `Host ${message.hostId} is not connected`,
        })
        return
      }
      if (!cwd) {
        send(connId, { type: 'error', message: 'Missing cwd for new session' })
        return
      }

      send(host.conn, {
        type: 'start_background_session',
        hostId: message.hostId,
        requestId: message.requestId || null,
        cwd,
        createNew: true,
      })

      send(connId, {
        type: 'notice',
        level: 'info',
        message: `Starting new background session in ${cwd}`,
      })
      return
    }

    if (message.type === 'refresh_host_sessions') {
      const host = hosts.get(message.hostId)
      if (!host?.conn || !transport.isOpen(host.conn)) {
        send(connId, {
          type: 'error',
          message: `Host ${message.hostId} is not connected`,
        })
        return
      }
      send(host.conn, { type: 'list_sessions' })
    }
  }

  async function handleHostMessage(connId: string, message: ClientMessage): Promise<void> {
    const client = clients.get(connId)
    if (!client || client.role !== 'host-supervisor') return
    if (hosts.get(client.hostId)?.conn !== connId) return

    if (message.type === 'control_response') {
      control.response(connId, message)
      return
    }
    if (message.type === 'host_sessions') {
      hostCatalogs.set(client.hostId, {
        hostId: client.hostId,
        updatedAt: Date.now(),
        sessions: Array.isArray(message.sessions)
          ? message.sessions.map((session) => normalizeCatalogSession(session))
          : [],
      })
      broadcastOverview()
      return
    }

    if (message.type === 'session_snapshot_data') {
      mergeLoadedSessionSnapshot(client.hostId, normalizeSnapshot(message.session))
      return
    }

    if (message.type === 'session_snapshot_error') {
      if (getKnownSession(message.sessionGuid)?.hostId !== client.hostId) return
      clearPendingSessionSnapshotLoad(message.sessionGuid || null)
      sendToAttached(message.sessionGuid || null, {
        type: 'notice',
        level: 'error',
        message: message.message || 'Failed to load session history',
      })
      return
    }

    if (message.type === 'runner_status') {
      if (message.requestId && ['error', 'exited'].includes(message.status || '')) control.launchError(connId, message.requestId)
      if (message.sessionGuid) {
        const known = getKnownSession(message.sessionGuid)
        if (known?.hostId && known.hostId !== client.hostId) return
        const session = known || getOrCreateSession(message.sessionGuid)
        session.hostId = client.hostId
        session.runnerStatus = message.status || null
        session.updatedAt = Date.now()
      }

      if (message.requestId) {
        broadcastWeb({
          type: 'launch_status',
          requestId: message.requestId,
          status: message.status,
          sessionGuid: message.sessionGuid || null,
          error: message.error || null,
        })
      }

      broadcastOverview()
      broadcastNotice({
        type: 'notice',
        level: message.status === 'error' ? 'error' : 'info',
        message: formatRunnerStatus(message),
      })
    }
  }

  function handleRunnerMessage(
    connId: string,
    message: ClientMessage,
    client: Extract<ClientState, { role: 'interactive' | 'background' }>,
  ): void {
    const session = sessions.get(client.sessionGuid)
    if (!session) return

    if (message.type === 'control_response') {
      control.response(connId, message)
      return
    }
    if (message.type === 'session_response') {
      if (message.sessionGuid !== client.sessionGuid) return
      handleSessionResponse(connId, message)
      return
    }

    if (message.type === 'released') {
      if (client.role === 'background' && session.backgroundConn === connId) {
        session.backgroundConn = null
        session.busy = false
        session.streamingText = null
        session.streamingThinkingText = null
        session.activeTools.clear()
        session.runnerStatus = 'released'
        promoteSessionOwner(session)
        deliverPendingInputs(session)
        try {
          transport.close(connId, 1000, 'released')
        } catch {
          // Ignore.
        }
        broadcastOverview()
        notifySessionMeta(session.sessionGuid)
      }
      return
    }

    if (message.type !== 'session_event') return
    if (getOwnerConnection(session) !== connId) return
    if (message.sessionGuid && message.sessionGuid !== client.sessionGuid) return

    if (message.event?.type === 'input_status') {
      if (message.event.input.sessionGuid === session.sessionGuid) control.event(connId, message.event.input)
      return
    }
    applySessionEvent(session, message.event)
    sendToAttached(session.sessionGuid, {
      type: 'session_event',
      sessionGuid: session.sessionGuid,
      event: message.event,
    })

    if (
      [
        'message',
        'busy',
        'model',
        'configuration',
        'usage',
        'tool_start',
        'tool_update',
        'tool_end',
        'session_name',
        'queued_input_add',
        'queued_input_remove',
      ].includes(String(message.event?.type || ''))
    ) {
      broadcastOverview()
      notifySessionMeta(session.sessionGuid)
    }
  }

  function registerRunner(connId: string, message: HelloRunnerMessage, hostId: string): void {
    if (!message.sessionGuid) return
    const session = getOrCreateSession(message.sessionGuid)
    runnerCapabilities.set(connId, new Set(message.capabilities || []))
    session.configuration = message.configuration
    if (message.role === 'interactive') {
      replaceConnection(session, 'interactiveConn', connId)
      session.pendingInteractiveConn = connId
    } else {
      replaceConnection(session, 'backgroundConn', connId)
    }

    session.hostId = hostId || session.hostId
    session.hostname = message.hostname || session.hostname || hosts.get(hostId)?.hostname || null
    session.sessionFile = message.sessionFile || session.sessionFile
    session.sessionName = message.sessionName || session.sessionName
    session.cwd = message.cwd || session.cwd
    session.preview =
      getSessionPreview({
        history: Array.isArray(message.history) ? message.history : [],
      }) || session.preview
    session.model = message.model || session.model
    session.contextWindowTokens =
      typeof message.contextWindowTokens === 'number' && Number.isFinite(message.contextWindowTokens)
        ? message.contextWindowTokens
        : session.contextWindowTokens
    session.contextTokens =
      typeof message.contextTokens === 'number' && Number.isFinite(message.contextTokens)
        ? message.contextTokens
        : session.contextTokens
    session.costUsd =
      typeof message.costUsd === 'number' && Number.isFinite(message.costUsd)
        ? message.costUsd
        : session.costUsd
    session.busy = !!message.busy
    if (Array.isArray(message.history)) {
      const limited = limitHistoryByBytes(message.history, maxSessionHistoryBytes)
      session.history = limited.history
      session.historyBytes = limited.bytes
      if (limited.dropped > 0) {
        log(`trimmed ${limited.dropped} history entries for ${message.sessionGuid}`)
      }
    }
    session.streamingText =
      typeof message.streamingText === 'string' ? message.streamingText : null
    session.streamingThinkingText =
      typeof message.streamingThinkingText === 'string' ? message.streamingThinkingText : null
    session.runnerStatus = 'running'
    session.updatedAt = getRunnerUpdatedAt(message, session.history)
    clearFinishedTools(session)

    if (message.role === 'interactive') {
      if (session.backgroundConn && transport.isOpen(session.backgroundConn)) {
        session.owner = 'background'
        send(session.backgroundConn, { type: 'abort_and_release' })
      } else {
        session.pendingInteractiveConn = null
        session.owner = 'interactive'
      }
    } else {
      if (
        (session.interactiveConn && transport.isOpen(session.interactiveConn)) ||
        (session.pendingInteractiveConn && transport.isOpen(session.pendingInteractiveConn))
      ) {
        session.owner = 'interactive'
        send(connId, { type: 'abort_and_release' })
      } else {
        session.owner = 'background'
      }
    }

    control.hello(connId, hostId, message)
    if (message.launchRequestId) {
      broadcastWeb({
        type: 'background_session_started',
        requestId: message.launchRequestId,
        sessionGuid: session.sessionGuid,
        hostId: session.hostId,
        hostname: session.hostname,
        cwd: session.cwd,
      })
    }

    for (const [id, pending] of pendingRequests) {
      if (pending.request.sessionGuid === session.sessionGuid && getOwnerConnection(session) !== pending.runner) {
        failRequest(id, 'owner_changed', 'Session owner changed; inspect state before retrying')
      }
    }
    deliverPendingInputs(session)
    broadcastOverview()
    notifySessionMeta(session.sessionGuid)
  }

  function replaceConnection(
    session: SessionState,
    key: 'interactiveConn' | 'backgroundConn',
    connId: string,
  ): void {
    const previous = session[key]
    if (previous && previous !== connId && transport.isOpen(previous)) {
      try {
        transport.close(previous, 1000, 'replaced')
      } catch {
        // Ignore.
      }
    }
    session[key] = connId
  }

  function applySessionEvent(session: SessionState, event: SessionEvent | undefined): void {
    if (!event || typeof event !== 'object') return
    session.updatedAt = Date.now()

    switch (event.type) {
      case 'configuration':
        session.configuration = event.configuration
        session.model = event.configuration.modelId
        break
      case 'message':
        if (event.message) {
          session.history.push(event.message)
          session.historyBytes += serializedByteLength(event.message)
          trimSessionHistory(session, maxSessionHistoryBytes)
        }
        if (event.message?.role === 'user' && event.message.remoteInputId) {
          removeQueuedInput(session, event.message.remoteInputId)
        }
        if (event.message?.role === 'assistant') {
          session.streamingText = null
          session.streamingThinkingText = null
        }
        break

      case 'assistant_stream_start':
        session.streamingText = ''
        session.streamingThinkingText = ''
        break

      case 'assistant_stream_update':
        session.streamingText = typeof event.text === 'string' ? event.text : ''
        session.streamingThinkingText =
          typeof event.thinkingText === 'string' ? event.thinkingText : ''
        break

      case 'assistant_stream_end':
        break

      case 'tool_start':
        if (event.toolCallId) {
          session.activeTools.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName || 'tool',
            args: event.args,
          })
        }
        break

      case 'tool_update':
        if (event.toolCallId) {
          const previous = session.activeTools.get(event.toolCallId)
          session.activeTools.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName || previous?.toolName || 'tool',
            args: event.args ?? previous?.args,
            text: typeof event.text === 'string' ? event.text : previous?.text,
            details: event.details ?? previous?.details,
          })
        }
        break

      case 'tool_end':
        if (event.toolCallId) session.activeTools.delete(event.toolCallId)
        break

      case 'busy':
        session.busy = !!event.busy
        if (!session.busy) {
          session.streamingText = null
          session.streamingThinkingText = null
          session.activeTools.clear()
        }
        break

      case 'model':
        session.model = event.modelId || null
        if (
          typeof event.contextWindowTokens === 'number' &&
          Number.isFinite(event.contextWindowTokens)
        ) {
          session.contextWindowTokens = event.contextWindowTokens
        }
        break

      case 'usage':
        if (typeof event.contextTokens === 'number' && Number.isFinite(event.contextTokens)) {
          session.contextTokens = event.contextTokens
        }
        if (typeof event.costUsd === 'number' && Number.isFinite(event.costUsd)) {
          session.costUsd = event.costUsd
        }
        break

      case 'session_name':
        session.sessionName = event.sessionName || null
        break

      case 'remote_input_failed':
        removeQueuedInput(session, event.inputId || null)
        break

      case 'queued_input_add':
        if (event.queuedInput?.inputId) {
          const existingIndex = session.queuedInputs.findIndex(
            (entry) => entry.inputId === event.queuedInput?.inputId,
          )
          if (existingIndex >= 0) session.queuedInputs[existingIndex] = event.queuedInput
          else session.queuedInputs.push(event.queuedInput)
        }
        break

      case 'queued_input_remove':
        if (event.inputId) {
          session.queuedInputs = session.queuedInputs.filter(
            (entry) => entry.inputId !== event.inputId,
          )
        } else {
          session.queuedInputs.shift()
        }
        break
    }
  }

  function promoteSessionOwner(session: SessionState): void {
    if (session.pendingInteractiveConn && transport.isOpen(session.pendingInteractiveConn)) {
      session.interactiveConn = session.pendingInteractiveConn
      session.pendingInteractiveConn = null
      session.owner = 'interactive'
      return
    }

    if (session.interactiveConn && transport.isOpen(session.interactiveConn)) {
      session.owner = 'interactive'
      return
    }

    if (session.backgroundConn && transport.isOpen(session.backgroundConn)) {
      session.owner = 'background'
      return
    }

    session.owner = null
  }

  function handleClose(connId: string): void {
    const client = clients.get(connId)
    clients.delete(connId)
    authContexts.delete(connId)

    if (!client) return

    if (client.role === 'web') {
      webClients.delete(connId)
      return
    }

    if (client.role === 'host-supervisor') {
      const host = hosts.get(client.hostId)
      if (host?.conn !== connId) return
      hosts.delete(client.hostId)
      hostCatalogs.delete(client.hostId)
      pruneInactiveSessionsForHost(client.hostId)
      broadcastOverview()
      broadcastNotice({
        type: 'notice',
        level: 'error',
        message: `Host disconnected: ${host.hostname || client.hostId}`,
      })
      return
    }

    const session = sessions.get(client.sessionGuid)
    if (!session) return
    const isCurrentConnection =
      client.role === 'interactive'
        ? session.interactiveConn === connId || session.pendingInteractiveConn === connId
        : session.backgroundConn === connId
    if (!isCurrentConnection) return

    const previousOwner = session.owner

    if (client.role === 'interactive') {
      if (session.interactiveConn === connId) session.interactiveConn = null
      if (session.pendingInteractiveConn === connId) session.pendingInteractiveConn = null
    } else if (client.role === 'background') {
      if (session.backgroundConn === connId) session.backgroundConn = null
    }

    if (!session.interactiveConn && session.pendingInteractiveConn) {
      session.pendingInteractiveConn = null
    }

    if (client.role === 'background') {
      session.busy = false
      session.streamingText = null
      session.streamingThinkingText = null
      session.activeTools.clear()
      session.runnerStatus = 'exited'
    }

    promoteSessionOwner(session)
    deliverPendingInputs(session)
    const removed = maybeRemoveSession(session)
    broadcastOverview()
    if (!removed) notifySessionMeta(session.sessionGuid)

    const roleLabel = client.role === 'interactive' ? 'Interactive session' : 'Background runner'
    const level = previousOwner === client.role ? 'error' : 'info'
    broadcastNotice({
      type: 'notice',
      level,
      message: `${roleLabel} disconnected: ${formatSessionLabel(session)}`,
    })
  }

  function getKnownSession(sessionGuid: string | null | undefined): SessionState | null {
    if (!sessionGuid) return null
    const existing = sessions.get(sessionGuid)
    if (existing) return existing

    const found = findCatalogSession(sessionGuid)
    if (!found) return null

    const session = createSessionState(sessionGuid)
    session.hostId = found.hostId
    session.hostname = hosts.get(found.hostId)?.hostname || session.hostname
    session.sessionFile = found.session.sessionFile || null
    session.sessionName = found.session.sessionName || null
    session.cwd = found.session.cwd || null
    session.preview = found.session.preview || null
    session.model = found.session.model || null
    session.busy = !!found.session.busy
    session.updatedAt = found.session.updatedAt || Date.now()
    sessions.set(sessionGuid, session)
    return session
  }

  function getOrCreateSession(sessionGuid: string): SessionState {
    return sessions.get(sessionGuid) || createAndStoreSession(sessionGuid)
  }

  function createAndStoreSession(sessionGuid: string): SessionState {
    const session = createSessionState(sessionGuid)
    sessions.set(sessionGuid, session)
    return session
  }

  function createSessionState(sessionGuid: string): SessionState {
    return {
      sessionGuid,
      interactiveConn: null,
      backgroundConn: null,
      pendingInteractiveConn: null,
      owner: null,
      hostId: null,
      hostname: null,
      sessionFile: null,
      sessionName: null,
      cwd: null,
      model: null,
      contextWindowTokens: null,
      contextTokens: null,
      costUsd: null,
      preview: null,
      busy: false,
      history: [],
      historyBytes: 0,
      streamingText: null,
      streamingThinkingText: null,
      activeTools: new Map<string, ActiveTool>(),
      runnerStatus: null,
      pendingInputs: [],
      queuedInputs: [],
      updatedAt: Date.now(),
    }
  }

  function buildEmptySessionSnapshot(sessionGuid: string | null): SessionSnapshot {
    return {
      sessionGuid: sessionGuid || null,
      owner: null,
      hostId: null,
      hostname: null,
      sessionFile: null,
      sessionName: null,
      cwd: null,
      model: null,
      contextWindowTokens: null,
      contextTokens: null,
      costUsd: null,
      busy: false,
      history: [],
      streamingText: null,
      streamingThinkingText: null,
      activeTools: [],
      queuedInputs: [],
    }
  }

  function buildSessionSnapshot(sessionGuid: string | null): SessionSnapshot {
    const session = getKnownSession(sessionGuid)
    if (!session) return buildEmptySessionSnapshot(sessionGuid)

    return {
      sessionGuid: session.sessionGuid,
      owner: session.owner,
      hostId: session.hostId,
      hostname: session.hostname,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      cwd: session.cwd,
      model: session.model,
      contextWindowTokens: session.contextWindowTokens,
      contextTokens: session.contextTokens,
      costUsd: session.costUsd,
      busy: session.busy,
      history: session.history,
      ...(session.configuration ? { configuration: session.configuration } : {}),
      streamingText: session.streamingText,
      streamingThinkingText: session.streamingThinkingText,
      activeTools: Array.from(session.activeTools.values()),
      queuedInputs: session.queuedInputs,
    }
  }

  function hasConnectedSupervisor(hostId: string | null): boolean {
    if (!hostId) return false
    const host = hosts.get(hostId)
    return !!host?.conn && transport.isOpen(host.conn)
  }

  function maybeRemoveSession(session: SessionState | null | undefined): boolean {
    if (!session) return false
    if (session.owner) return false
    if (
      (session.interactiveConn && transport.isOpen(session.interactiveConn)) ||
      (session.backgroundConn && transport.isOpen(session.backgroundConn)) ||
      (session.pendingInteractiveConn && transport.isOpen(session.pendingInteractiveConn))
    ) {
      return false
    }
    if (hasConnectedSupervisor(session.hostId)) return false

    clearPendingSessionSnapshotLoad(session.sessionGuid)
    sessions.delete(session.sessionGuid)
    sendToAttached(session.sessionGuid, {
      type: 'session_snapshot',
      session: buildEmptySessionSnapshot(session.sessionGuid),
    })
    log(`pruned inactive session without supervisor: ${session.sessionGuid}`)
    return true
  }

  function pruneInactiveSessionsForHost(hostId: string | null): void {
    if (!hostId) return
    for (const session of Array.from(sessions.values())) {
      if (session.hostId !== hostId) continue
      maybeRemoveSession(session)
    }
  }

  function notifySessionMeta(sessionGuid: string): void {
    const session = sessions.get(sessionGuid)
    if (!session) return
    sendToAttached(sessionGuid, {
      type: 'session_meta',
      sessionGuid,
      owner: session.owner,
      hostId: session.hostId,
      hostname: session.hostname,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      cwd: session.cwd,
      model: session.model,
      contextWindowTokens: session.contextWindowTokens,
      contextTokens: session.contextTokens,
      costUsd: session.costUsd,
      busy: session.busy,
    })
  }

  async function requestSessionSnapshotFromHost(sessionGuid: string): Promise<boolean> {
    if (!sessionGuid) return false
    const session = getKnownSession(sessionGuid)
    if (!session || getOwnerConnection(session) || session.history.length > 0) return false
    if (pendingSessionSnapshotLoads.has(sessionGuid)) return true

    const found = findCatalogSession(sessionGuid)
    const hostId = session.hostId || found?.hostId || null
    const host = hostId ? hosts.get(hostId) : null
    if (!host?.conn || !transport.isOpen(host.conn)) return false

    const timeout = timers.setTimeout(() => {
      pendingSessionSnapshotLoads.delete(sessionGuid)
    }, 10000)
    pendingSessionSnapshotLoads.set(sessionGuid, timeout)

    send(host.conn, {
      type: 'read_session_snapshot',
      sessionGuid,
      sessionFile: session.sessionFile || found?.session?.sessionFile || null,
    })
    return true
  }

  function clearPendingSessionSnapshotLoad(sessionGuid: string | null | undefined): void {
    if (!sessionGuid) return
    const timeout = pendingSessionSnapshotLoads.get(sessionGuid)
    if (timeout) timers.clearTimeout(timeout)
    pendingSessionSnapshotLoads.delete(sessionGuid)
  }

  function mergeLoadedSessionSnapshot(
    hostId: string | null | undefined,
    snapshot: SnapshotData | null,
  ): void {
    const sessionGuid = snapshot?.sessionGuid
    if (!sessionGuid || !pendingSessionSnapshotLoads.has(sessionGuid)) return
    const session = getKnownSession(sessionGuid)
    if (!session || session.hostId !== hostId || getOwnerConnection(session)) return
    clearPendingSessionSnapshotLoad(sessionGuid)

    session.hostId = hostId || session.hostId
    session.sessionFile = snapshot.sessionFile || session.sessionFile
    session.sessionName = snapshot.sessionName || session.sessionName
    session.cwd = snapshot.cwd || session.cwd
    session.model = snapshot.model || session.model

    const loadedHistory = Array.isArray(snapshot.history) ? snapshot.history : []
    if (session.history.length === 0 || loadedHistory.length > session.history.length) {
      const limited = limitHistoryByBytes(loadedHistory, maxSessionHistoryBytes)
      session.history = limited.history
      session.historyBytes = limited.bytes
      if (limited.dropped > 0) {
        log(`trimmed ${limited.dropped} snapshot history entries for ${sessionGuid}`)
      }
    }

    session.preview = getSessionPreview({ history: session.history }) || session.preview
    session.updatedAt = Math.max(session.updatedAt || 0, snapshot.updatedAt || 0, Date.now())

    sendToAttached(sessionGuid, {
      type: 'session_snapshot',
      session: buildSessionSnapshot(sessionGuid),
    })
    broadcastOverview()
    notifySessionMeta(sessionGuid)
  }

  function sendToAttached(sessionGuid: string | null, payload: ServerMessage): void {
    for (const [connId, state] of webClients) {
      if (state.attachedSessionGuid === sessionGuid) send(connId, payload)
    }
  }

  function broadcastNotice(payload: NoticeMessage): void {
    for (const connId of webClients.keys()) {
      send(connId, payload)
    }
  }

  function broadcastWeb(payload: ServerMessage): void {
    for (const connId of webClients.keys()) {
      send(connId, payload)
    }
  }

  function sendOverview(connId: string): void {
    send(connId, {
      type: 'overview', capabilities: ['orchestration_v1', 'scoped_tokens_v1'],
      hosts: buildOverviewHosts(),
    })
  }

  function broadcastOverview(): void {
    const payload: ServerMessage = {
      type: 'overview', capabilities: ['orchestration_v1', 'scoped_tokens_v1'],
      hosts: buildOverviewHosts(),
    }
    for (const connId of webClients.keys()) {
      send(connId, payload)
    }
  }

  function buildOverviewHosts(): OverviewHost[] {
    const hostIds = new Set<string>([...hosts.keys(), ...hostCatalogs.keys()])
    for (const session of sessions.values()) {
      if (session.hostId) hostIds.add(session.hostId)
    }

    const list: OverviewHost[] = []
    for (const hostId of hostIds) {
      const host = hosts.get(hostId)
      const catalog = hostCatalogs.get(hostId)
      const merged = new Map<string, any>()

      for (const entry of catalog?.sessions || []) {
        merged.set(entry.sessionGuid, {
          sessionGuid: entry.sessionGuid,
          sessionFile: entry.sessionFile || null,
          sessionName: entry.sessionName || null,
          cwd: entry.cwd || null,
          preview: entry.preview || null,
          updatedAt: entry.updatedAt || 0,
          owner: null,
          busy: false,
          model: null,
          contextWindowTokens: null,
          contextTokens: null,
          costUsd: null,
          runnerStatus: null,
          queuedInputCount: 0,
        })
      }

      for (const session of sessions.values()) {
        if (session.hostId !== hostId) continue
        const current =
          merged.get(session.sessionGuid) || {
            sessionGuid: session.sessionGuid,
          }
        merged.set(session.sessionGuid, {
          ...current,
          sessionGuid: session.sessionGuid,
          sessionFile: session.sessionFile || current.sessionFile || null,
          sessionName: session.sessionName || current.sessionName || null,
          cwd: session.cwd || current.cwd || null,
          preview: getSessionPreview(session) || session.preview || current.preview || null,
          updatedAt: Math.max(session.updatedAt || 0, current.updatedAt || 0),
          owner: session.owner,
          busy: session.busy,
          model: session.model,
          contextWindowTokens: session.contextWindowTokens,
          contextTokens: session.contextTokens,
          costUsd: session.costUsd,
          runnerStatus: session.runnerStatus || null,
          queuedInputCount: session.queuedInputs.length,
        })
      }

      const sessionsForHost = Array.from(merged.values()).sort(
        (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      )
      const sessionHostname = Array.from(sessions.values()).find(
        (session) => session.hostId === hostId && session.hostname,
      )?.hostname
      list.push({
        hostId,
        hostname: host?.hostname || sessionHostname || hostId,
        platform: host?.platform || null,
        connected: !!host,
        sessions: sessionsForHost,
      })
    }

    list.sort((a, b) => a.hostname.localeCompare(b.hostname))
    return list
  }

  function findCatalogSession(sessionGuid: string): FoundCatalogSession | null {
    for (const [hostId, catalog] of hostCatalogs) {
      for (const session of catalog.sessions || []) {
        if (session.sessionGuid === sessionGuid) {
          return { hostId, session }
        }
      }
    }
    return null
  }

  function getSessionPreview(session: { history: SanitizedMessage[] }): string | null {
    for (const message of session.history) {
      if (message.role === 'user' && message.text) return message.text
    }
    return null
  }

  function getOwnerConnection(session: SessionState | null): string | null {
    if (!session) return null
    if (session.owner === 'interactive' && session.interactiveConn && transport.isOpen(session.interactiveConn)) {
      return session.interactiveConn
    }
    if (session.owner === 'background' && session.backgroundConn && transport.isOpen(session.backgroundConn)) {
      return session.backgroundConn
    }
    return null
  }

  function deliverPendingInputs(session: SessionState): void {
    const target = getOwnerConnection(session)
    if (!target || session.pendingInputs.length === 0) return
    while (session.pendingInputs.length > 0) {
      const input = session.pendingInputs.shift()
      if (!input?.text) continue
      send(target, { type: 'input', text: input.text, inputId: input.inputId })
    }
  }

  function ensureBackgroundSession(
    session: SessionState,
    options: EnsureBackgroundOptions = {},
  ): boolean {
    const host = hosts.get(options.hostId || session.hostId || '')
    if (!host?.conn || !transport.isOpen(host.conn)) return false
    if (session.backgroundConn && transport.isOpen(session.backgroundConn)) return true
    if (session.runnerStatus === 'starting') return true

    session.runnerStatus = 'starting'
    session.updatedAt = Date.now()
    broadcastOverview()

    send(host.conn, {
      type: 'start_background_session',
      hostId: host.hostId,
      sessionGuid: session.sessionGuid,
      sessionFile: options.sessionFile || session.sessionFile || null,
      cwd: options.cwd || session.cwd || null,
      requestId: options.requestId || null,
      createNew: false,
    })

    broadcastNotice({
      type: 'notice',
      level: 'info',
      message: `Starting background runner for ${formatSessionLabel(session)}`,
    })
    return true
  }

  function clearFinishedTools(session: SessionState): void {
    if (!(session.activeTools instanceof Map)) {
      session.activeTools = new Map<string, ActiveTool>()
    }
  }

  function getRunnerUpdatedAt(
    message: HelloRunnerMessage,
    history: SanitizedMessage[] = [],
  ): number {
    const direct =
      typeof message.updatedAt === 'number' && Number.isFinite(message.updatedAt)
        ? message.updatedAt
        : 0
    const historyTimestamp = history.reduce((max, entry) => {
      const value = typeof entry?.timestamp === 'number' && Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : 0
      return Math.max(max, value)
    }, 0)
    const latest = Math.max(direct, historyTimestamp)
    return latest || Date.now()
  }

  function formatSessionLabel(session: SessionState): string {
    return (
      session.sessionName ||
      getSessionPreview(session) ||
      session.preview ||
      session.sessionGuid.slice(0, 8)
    )
  }

  function addQueuedInput(session: SessionState, queuedInput: QueuedInput): void {
    if (!queuedInput?.inputId || !queuedInput.text) return
    session.queuedInputs.push(queuedInput)
    session.updatedAt = Date.now()
    sendToAttached(session.sessionGuid, {
      type: 'session_event',
      sessionGuid: session.sessionGuid,
      event: {
        type: 'queued_input_add',
        queuedInput,
      },
    })
    broadcastOverview()
  }

  function removeQueuedInput(session: SessionState, inputId: string | null = null): void {
    if (!Array.isArray(session.queuedInputs) || session.queuedInputs.length === 0) {
      return
    }

    const index = inputId
      ? session.queuedInputs.findIndex((entry) => entry.inputId === inputId)
      : 0
    if (index < 0) return

    const [queuedInput] = session.queuedInputs.splice(index, 1)
    session.updatedAt = Date.now()
    sendToAttached(session.sessionGuid, {
      type: 'session_event',
      sessionGuid: session.sessionGuid,
      event: {
        type: 'queued_input_remove',
        inputId: queuedInput?.inputId || inputId || null,
      },
    })
    broadcastOverview()
  }

  function createId(): string {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
    return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function formatRunnerStatus(message: {
    status?: string | null
    sessionGuid?: string | null
    error?: string | null
  }): string {
    if (message.status === 'starting') {
      return `Starting background runner${message.sessionGuid ? ` for ${message.sessionGuid}` : ''}`
    }
    if (message.status === 'already-running') {
      return `Background runner already active for ${message.sessionGuid}`
    }
    if (message.status === 'error') {
      return `Background runner error${message.sessionGuid ? ` for ${message.sessionGuid}` : ''}: ${message.error}`
    }
    if (message.status === 'exited') {
      return `Background runner exited${message.sessionGuid ? ` for ${message.sessionGuid}` : ''}`
    }
    if (message.status === 'released') {
      return `Background runner released${message.sessionGuid ? ` for ${message.sessionGuid}` : ''}`
    }
    return `Runner status${message.sessionGuid ? ` for ${message.sessionGuid}` : ''}: ${message.status}`
  }

  function normalizeCatalogSession(session: any): CatalogSession {
    return {
      sessionGuid: String(session?.sessionGuid || ''),
      sessionFile: session?.sessionFile || null,
      sessionName: session?.sessionName || null,
      cwd: session?.cwd || null,
      preview: session?.preview || null,
      updatedAt: typeof session?.updatedAt === 'number' ? session.updatedAt : 0,
      model: session?.model || null,
      busy: !!session?.busy,
    }
  }

  function normalizeSnapshot(snapshot: any): SnapshotData | null {
    if (!snapshot || typeof snapshot !== 'object') return null
    return {
      sessionGuid: String(snapshot.sessionGuid || ''),
      sessionFile: snapshot.sessionFile || null,
      sessionName: snapshot.sessionName || null,
      cwd: snapshot.cwd || null,
      model: snapshot.model || null,
      history: Array.isArray(snapshot.history) ? snapshot.history : [],
      updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : undefined,
    }
  }

  return {
    onConnect,
    onMessage,
    onClose,
  }
}

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return 0
  }
}

function limitHistoryByBytes(
  history: SanitizedMessage[],
  maxBytes: number,
): { history: SanitizedMessage[]; bytes: number; dropped: number } {
  let bytes = 0
  let start = history.length

  while (start > 0) {
    const entryBytes = serializedByteLength(history[start - 1])
    if (bytes + entryBytes > maxBytes) break
    bytes += entryBytes
    start -= 1
  }

  return {
    history: history.slice(start),
    bytes,
    dropped: start,
  }
}

function trimSessionHistory(session: SessionState, maxBytes: number): void {
  while (session.history.length > 0 && session.historyBytes > maxBytes) {
    const removed = session.history.shift()
    session.historyBytes = Math.max(0, session.historyBytes - serializedByteLength(removed))
  }
}
