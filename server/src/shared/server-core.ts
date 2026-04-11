import type { ConnectionAuth } from './auth.js'
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

  const log =
    config.log ??
    ((message: string) => {
      console.log(`[${new Date().toISOString()}] ${message}`)
    })

  function send(connId: string, payload: ServerMessage): boolean {
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
    handleClose(connId)
  }

  function handleHello(connId: string, message: HelloMessage): void {
    const auth = authContexts.get(connId)
    if (!auth) {
      send(connId, { type: 'error', message: 'Unauthorized connection' })
      transport.close(connId, 1008, 'Unauthorized')
      return
    }

    const role = message.role
    if (!['web', 'host-supervisor', 'interactive', 'background'].includes(role)) {
      send(connId, { type: 'error', message: `Unknown role: ${String(role)}` })
      transport.close(connId, 1008, 'Unknown role')
      return
    }

    if (role === 'web') {
      if (auth.kind !== 'admin') {
        send(connId, { type: 'error', message: 'Unauthorized role for this token' })
        transport.close(connId, 1008, 'Unauthorized role')
        return
      }
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
    clients.set(connId, {
      role: 'host-supervisor',
      hostId,
    })
    hosts.set(hostId, {
      hostId,
      hostname: message.hostname || hostId,
      platform: message.platform || null,
      pid: typeof message.pid === 'number' ? message.pid : null,
      conn: connId,
      connectedAt: Date.now(),
    })
    broadcastOverview()
    broadcastNotice({
      type: 'notice',
      level: 'info',
      message: `Host connected: ${message.hostname || hostId}`,
    })
  }

  async function handleWebMessage(connId: string, message: ClientMessage): Promise<void> {
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
      clearPendingSessionSnapshotLoad(message.sessionGuid || null)
      sendToAttached(message.sessionGuid || null, {
        type: 'notice',
        level: 'error',
        message: message.message || 'Failed to load session history',
      })
      return
    }

    if (message.type === 'runner_status') {
      if (message.sessionGuid) {
        const session = getOrCreateSession(message.sessionGuid)
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
    if (message.sessionGuid && message.sessionGuid !== client.sessionGuid) return

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
        'tool_start',
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
    if (message.role === 'interactive') {
      replaceConnection(session, 'interactiveConn', connId)
      session.pendingInteractiveConn = connId
    } else {
      replaceConnection(session, 'backgroundConn', connId)
    }

    session.hostId = hostId || session.hostId
    session.sessionFile = message.sessionFile || session.sessionFile
    session.sessionName = message.sessionName || session.sessionName
    session.cwd = message.cwd || session.cwd
    session.preview =
      getSessionPreview({
        history: Array.isArray(message.history) ? message.history : [],
      }) || session.preview
    session.model = message.model || session.model
    session.busy = !!message.busy
    session.history = Array.isArray(message.history) ? message.history : session.history
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

    if (message.launchRequestId) {
      broadcastWeb({
        type: 'background_session_started',
        requestId: message.launchRequestId,
        sessionGuid: session.sessionGuid,
        hostId: session.hostId,
        cwd: session.cwd,
      })
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
      case 'message':
        if (event.message) {
          session.history.push(event.message)
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
      if (host?.conn === connId) hosts.delete(client.hostId)
      hostCatalogs.delete(client.hostId)
      pruneInactiveSessionsForHost(client.hostId)
      broadcastOverview()
      broadcastNotice({
        type: 'notice',
        level: 'error',
        message: `Host disconnected: ${host?.hostname || client.hostId}`,
      })
      return
    }

    const session = sessions.get(client.sessionGuid)
    if (!session) return
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
      sessionFile: null,
      sessionName: null,
      cwd: null,
      model: null,
      preview: null,
      busy: false,
      history: [],
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
      sessionFile: null,
      sessionName: null,
      cwd: null,
      model: null,
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
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      cwd: session.cwd,
      model: session.model,
      busy: session.busy,
      history: session.history,
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
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      cwd: session.cwd,
      model: session.model,
      busy: session.busy,
    })
  }

  async function requestSessionSnapshotFromHost(sessionGuid: string): Promise<boolean> {
    if (!sessionGuid) return false
    const session = getKnownSession(sessionGuid)
    if (!session || session.history.length > 0) return false
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
    if (!sessionGuid) return
    clearPendingSessionSnapshotLoad(sessionGuid)

    const session = getOrCreateSession(sessionGuid)
    session.hostId = hostId || session.hostId
    session.sessionFile = snapshot.sessionFile || session.sessionFile
    session.sessionName = snapshot.sessionName || session.sessionName
    session.cwd = snapshot.cwd || session.cwd
    session.model = snapshot.model || session.model

    const loadedHistory = Array.isArray(snapshot.history) ? snapshot.history : []
    if (session.history.length === 0 || loadedHistory.length > session.history.length) {
      session.history = loadedHistory
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
      type: 'overview',
      hosts: buildOverviewHosts(),
    })
  }

  function broadcastOverview(): void {
    const payload: ServerMessage = {
      type: 'overview',
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
          runnerStatus: session.runnerStatus || null,
          queuedInputCount: session.queuedInputs.length,
        })
      }

      const sessionsForHost = Array.from(merged.values()).sort(
        (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      )
      list.push({
        hostId,
        hostname: host?.hostname || hostId,
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
