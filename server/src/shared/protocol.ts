export type ClientRole = 'web' | 'host-supervisor' | 'interactive' | 'background'
export type RunnerRole = 'interactive' | 'background'
export type NoticeLevel = 'info' | 'error'

export interface UserHistoryMessage {
  role: 'user'
  timestamp?: number
  text: string
  remoteInputId?: string
}

export interface AssistantHistoryMessage {
  role: 'assistant'
  timestamp?: number
  text: string
  thinkingText?: string
  stopReason?: string
}

export interface ToolResultHistoryMessage {
  role: 'toolResult'
  timestamp?: number
  toolCallId?: string
  toolName: string
  text: string
  isError: boolean
  args?: unknown
  details?: unknown
  durationMs?: number
}

export type SanitizedMessage =
  | UserHistoryMessage
  | AssistantHistoryMessage
  | ToolResultHistoryMessage

export interface ActiveToolSnapshot {
  toolCallId: string
  toolName: string
  args?: unknown
  text?: string
  details?: unknown
}

export interface QueuedInput {
  inputId: string
  text: string
  timestamp: number
}

export interface SessionSnapshot {
  sessionGuid: string | null
  owner: RunnerRole | null
  hostId: string | null
  hostname: string | null
  sessionFile: string | null
  sessionName: string | null
  cwd: string | null
  model: string | null
  contextWindowTokens: number | null
  contextTokens: number | null
  costUsd: number | null
  busy: boolean
  history: SanitizedMessage[]
  streamingText: string | null
  streamingThinkingText: string | null
  activeTools: ActiveToolSnapshot[]
  queuedInputs: QueuedInput[]
}

export interface OverviewSession {
  sessionGuid: string
  sessionFile: string | null
  sessionName: string | null
  cwd: string | null
  preview: string | null
  updatedAt: number
  owner: RunnerRole | null
  busy: boolean
  model: string | null
  contextWindowTokens: number | null
  contextTokens: number | null
  costUsd: number | null
  runnerStatus: string | null
  queuedInputCount: number
}

export interface OverviewHost {
  hostId: string
  hostname: string
  platform: string | null
  connected: boolean
  sessions: OverviewSession[]
}

export interface MessageEvent {
  type: 'message'
  message: SanitizedMessage
}

export interface AssistantStreamStartEvent {
  type: 'assistant_stream_start'
}

export interface AssistantStreamUpdateEvent {
  type: 'assistant_stream_update'
  text: string
  thinkingText?: string | null
}

export interface AssistantStreamEndEvent {
  type: 'assistant_stream_end'
}

export interface ToolStartEvent {
  type: 'tool_start'
  toolCallId: string
  toolName?: string
  args?: unknown
}

export interface ToolUpdateEvent {
  type: 'tool_update'
  toolCallId: string
  toolName?: string
  args?: unknown
  text?: string
  details?: unknown
}

export interface ToolEndEvent {
  type: 'tool_end'
  toolCallId: string
  toolName?: string
  isError?: boolean
}

export interface BusyEvent {
  type: 'busy'
  busy: boolean
}

export interface ModelEvent {
  type: 'model'
  modelId: string | null
  contextWindowTokens?: number | null
}

export interface UsageEvent {
  type: 'usage'
  contextTokens?: number | null
  costUsd?: number | null
}

export interface SessionNameEvent {
  type: 'session_name'
  sessionName: string | null
}

export interface RemoteInputFailedEvent {
  type: 'remote_input_failed'
  inputId?: string | null
}

export interface QueuedInputAddEvent {
  type: 'queued_input_add'
  queuedInput: QueuedInput
}

export interface QueuedInputRemoveEvent {
  type: 'queued_input_remove'
  inputId: string | null
}

export type SessionEvent =
  | MessageEvent
  | AssistantStreamStartEvent
  | AssistantStreamUpdateEvent
  | AssistantStreamEndEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | BusyEvent
  | ModelEvent
  | UsageEvent
  | SessionNameEvent
  | RemoteInputFailedEvent
  | QueuedInputAddEvent
  | QueuedInputRemoveEvent

export interface CatalogSessionMessage {
  sessionGuid: string
  sessionFile?: string | null
  sessionName?: string | null
  cwd?: string | null
  preview?: string | null
  updatedAt?: number
  model?: string | null
  busy?: boolean
}

export interface SessionSnapshotDataMessage {
  sessionGuid: string
  sessionFile?: string | null
  sessionName?: string | null
  cwd?: string | null
  model?: string | null
  history?: SanitizedMessage[]
  updatedAt?: number
}

export interface HelloWebMessage {
  type: 'hello'
  role: 'web'
}

export interface HelloHostSupervisorMessage {
  type: 'hello'
  role: 'host-supervisor'
  hostId: string
  hostname?: string | null
  platform?: string | null
  pid?: number | null
}

export interface HelloRunnerMessage {
  type: 'hello'
  role: RunnerRole
  hostId?: string | null
  hostname?: string | null
  launchRequestId?: string | null
  sessionGuid?: string
  sessionFile?: string | null
  sessionName?: string | null
  cwd?: string | null
  model?: string | null
  contextWindowTokens?: number | null
  contextTokens?: number | null
  costUsd?: number | null
  busy?: boolean
  streamingText?: string | null
  streamingThinkingText?: string | null
  history?: SanitizedMessage[]
  updatedAt?: number
}

export type HelloMessage =
  | HelloWebMessage
  | HelloHostSupervisorMessage
  | HelloRunnerMessage

export interface AttachMessage {
  type: 'attach'
  sessionGuid: string | null
}

export interface InputMessage {
  type: 'input'
  sessionGuid?: string
  text?: string
}

export interface AbortMessage {
  type: 'abort'
  sessionGuid?: string
}

export interface TerminateSessionMessage {
  type: 'terminate_session'
  sessionGuid?: string
}

export interface StartBackgroundSessionMessage {
  type: 'start_background_session'
  hostId?: string | null
  sessionGuid: string
  sessionFile?: string | null
  cwd?: string | null
  requestId?: string | null
}

export interface CreateBackgroundSessionMessage {
  type: 'create_background_session'
  hostId: string
  requestId?: string | null
  cwd?: string | null
}

export interface RefreshHostSessionsMessage {
  type: 'refresh_host_sessions'
  hostId: string
}

export interface HostSessionsMessage {
  type: 'host_sessions'
  hostId: string
  sessions?: CatalogSessionMessage[]
}

export interface SessionSnapshotDataEnvelope {
  type: 'session_snapshot_data'
  hostId?: string | null
  session?: SessionSnapshotDataMessage
}

export interface SessionSnapshotErrorMessage {
  type: 'session_snapshot_error'
  hostId?: string | null
  sessionGuid?: string | null
  message?: string
}

export interface RunnerStatusMessage {
  type: 'runner_status'
  hostId?: string | null
  sessionGuid?: string | null
  requestId?: string | null
  status?: string | null
  error?: string | null
  pid?: number | null
  code?: number | null
  signal?: string | null
}

export interface ReleasedMessage {
  type: 'released'
  sessionGuid?: string | null
}

export interface SessionEventEnvelope {
  type: 'session_event'
  sessionGuid?: string | null
  event?: SessionEvent
}

export interface UnknownClientMessage {
  type: '__unknown__'
  rawType: string | null
  raw: Record<string, unknown>
}

export interface InvalidClientMessage {
  type: '__invalid__'
  rawType: string | null
  message: string
  raw: Record<string, unknown>
}

export type ClientMessage =
  | HelloMessage
  | AttachMessage
  | InputMessage
  | AbortMessage
  | TerminateSessionMessage
  | StartBackgroundSessionMessage
  | CreateBackgroundSessionMessage
  | RefreshHostSessionsMessage
  | HostSessionsMessage
  | SessionSnapshotDataEnvelope
  | SessionSnapshotErrorMessage
  | RunnerStatusMessage
  | ReleasedMessage
  | SessionEventEnvelope
  | UnknownClientMessage
  | InvalidClientMessage

export interface ErrorMessage {
  type: 'error'
  message: string
}

export interface NoticeMessage {
  type: 'notice'
  level: NoticeLevel
  message: string
}

export interface OverviewMessage {
  type: 'overview'
  hosts: OverviewHost[]
}

export interface SessionSnapshotMessage {
  type: 'session_snapshot'
  session: SessionSnapshot
}

export interface SessionMetaMessage {
  type: 'session_meta'
  sessionGuid: string
  owner: RunnerRole | null
  hostId: string | null
  hostname: string | null
  sessionFile: string | null
  sessionName: string | null
  cwd: string | null
  model: string | null
  contextWindowTokens: number | null
  contextTokens: number | null
  costUsd: number | null
  busy: boolean
}

export interface LaunchStatusMessage {
  type: 'launch_status'
  requestId: string
  status: string | null | undefined
  sessionGuid: string | null
  error: string | null
}

export interface BackgroundSessionStartedMessage {
  type: 'background_session_started'
  requestId: string
  sessionGuid: string
  hostId: string | null
  hostname: string | null
  cwd: string | null
}

export interface InputCommandMessage {
  type: 'input'
  text: string
  inputId: string
}

export interface AbortCommandMessage {
  type: 'abort'
}

export interface AbortAndReleaseMessage {
  type: 'abort_and_release'
}

export interface TerminateSessionCommandMessage {
  type: 'terminate_session'
}

export interface ListSessionsMessage {
  type: 'list_sessions'
}

export interface ReadSessionSnapshotMessage {
  type: 'read_session_snapshot'
  sessionGuid: string
  sessionFile: string | null
}

export interface StartBackgroundSessionCommandMessage {
  type: 'start_background_session'
  hostId: string
  sessionGuid?: string
  sessionFile?: string | null
  cwd?: string | null
  requestId?: string | null
  createNew: boolean
}

export interface SessionEventMessage {
  type: 'session_event'
  sessionGuid: string
  event: SessionEvent
}

export type ServerMessage =
  | ErrorMessage
  | NoticeMessage
  | OverviewMessage
  | SessionSnapshotMessage
  | SessionMetaMessage
  | LaunchStatusMessage
  | BackgroundSessionStartedMessage
  | InputCommandMessage
  | AbortCommandMessage
  | AbortAndReleaseMessage
  | TerminateSessionCommandMessage
  | ListSessionsMessage
  | ReadSessionSnapshotMessage
  | StartBackgroundSessionCommandMessage
  | SessionEventMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isQueuedInput(value: unknown): value is QueuedInput {
  return (
    isRecord(value) &&
    isNonEmptyString(value.inputId) &&
    typeof value.text === 'string' &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp)
  )
}

function isSanitizedMessage(value: unknown): value is SanitizedMessage {
  if (!isRecord(value) || !isOptionalNumber(value.timestamp)) return false

  switch (value.role) {
    case 'user':
      return typeof value.text === 'string' && isOptionalString(value.remoteInputId)
    case 'assistant':
      return (
        typeof value.text === 'string' &&
        isOptionalString(value.thinkingText) &&
        isOptionalString(value.stopReason)
      )
    case 'toolResult':
      return (
        isNonEmptyString(value.toolName) &&
        typeof value.text === 'string' &&
        typeof value.isError === 'boolean' &&
        isOptionalString(value.toolCallId) &&
        isOptionalNumber(value.durationMs)
      )
    default:
      return false
  }
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value)) return false

  switch (value.type) {
    case 'message':
      return isSanitizedMessage(value.message)
    case 'assistant_stream_start':
    case 'assistant_stream_end':
      return true
    case 'assistant_stream_update':
      return typeof value.text === 'string' && isOptionalString(value.thinkingText)
    case 'tool_start':
      return isNonEmptyString(value.toolCallId) && isOptionalString(value.toolName)
    case 'tool_update':
      return (
        isNonEmptyString(value.toolCallId) &&
        isOptionalString(value.toolName) &&
        isOptionalString(value.text)
      )
    case 'tool_end':
      return (
        isNonEmptyString(value.toolCallId) &&
        isOptionalString(value.toolName) &&
        isOptionalBoolean(value.isError)
      )
    case 'busy':
      return typeof value.busy === 'boolean'
    case 'model':
      return isOptionalString(value.modelId) && isOptionalNumber(value.contextWindowTokens)
    case 'usage':
      return isOptionalNumber(value.contextTokens) && isOptionalNumber(value.costUsd)
    case 'session_name':
      return isOptionalString(value.sessionName)
    case 'remote_input_failed':
      return isOptionalString(value.inputId)
    case 'queued_input_add':
      return isQueuedInput(value.queuedInput)
    case 'queued_input_remove':
      return isOptionalString(value.inputId)
    default:
      return false
  }
}

function isCatalogSession(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.sessionGuid) &&
    isOptionalString(value.sessionFile) &&
    isOptionalString(value.sessionName) &&
    isOptionalString(value.cwd) &&
    isOptionalString(value.preview) &&
    isOptionalNumber(value.updatedAt) &&
    isOptionalString(value.model) &&
    isOptionalBoolean(value.busy)
  )
}

function isSnapshotData(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.sessionGuid) &&
    isOptionalString(value.sessionFile) &&
    isOptionalString(value.sessionName) &&
    isOptionalString(value.cwd) &&
    isOptionalString(value.model) &&
    isOptionalNumber(value.updatedAt) &&
    (value.history === undefined ||
      (Array.isArray(value.history) && value.history.every(isSanitizedMessage)))
  )
}

function invalidClientMessage(
  raw: Record<string, unknown>,
  rawType: string | null,
  message: string,
): InvalidClientMessage {
  return { type: '__invalid__', rawType, message, raw }
}

function parsedMessage(raw: Record<string, unknown>): ClientMessage {
  return raw as unknown as ClientMessage
}

export function parseClientMessage(raw: unknown): ClientMessage {
  if (!isRecord(raw)) {
    return { type: '__invalid__', rawType: null, message: 'Message must be an object', raw: {} }
  }

  const messageType = typeof raw.type === 'string' ? raw.type : null
  switch (messageType) {
    case 'hello': {
      if (!['web', 'host-supervisor', 'interactive', 'background'].includes(String(raw.role || ''))) {
        return invalidClientMessage(raw, messageType, 'hello.role is invalid')
      }
      if (raw.role === 'host-supervisor' && !isNonEmptyString(raw.hostId)) {
        return invalidClientMessage(raw, messageType, 'hello.hostId must be a non-empty string')
      }
      if (
        (raw.role === 'interactive' || raw.role === 'background') &&
        !isNonEmptyString(raw.sessionGuid)
      ) {
        return invalidClientMessage(raw, messageType, 'hello.sessionGuid must be a non-empty string')
      }
      if (
        !isOptionalString(raw.hostId) ||
        !isOptionalString(raw.sessionGuid) ||
        !isOptionalString(raw.hostname) ||
        !isOptionalString(raw.platform) ||
        !isOptionalString(raw.launchRequestId) ||
        !isOptionalString(raw.sessionFile) ||
        !isOptionalString(raw.sessionName) ||
        !isOptionalString(raw.cwd) ||
        !isOptionalString(raw.model) ||
        !isOptionalNumber(raw.pid) ||
        !isOptionalNumber(raw.contextWindowTokens) ||
        !isOptionalNumber(raw.contextTokens) ||
        !isOptionalNumber(raw.costUsd) ||
        !isOptionalNumber(raw.updatedAt) ||
        !isOptionalBoolean(raw.busy) ||
        !isOptionalString(raw.streamingText) ||
        !isOptionalString(raw.streamingThinkingText) ||
        (raw.history !== undefined &&
          (!Array.isArray(raw.history) || !raw.history.every(isSanitizedMessage)))
      ) {
        return invalidClientMessage(raw, messageType, 'hello contains invalid fields')
      }
      return parsedMessage(raw)
    }
    case 'attach':
      return raw.sessionGuid === null || isNonEmptyString(raw.sessionGuid)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'attach.sessionGuid must be a string or null')
    case 'input':
      return isNonEmptyString(raw.sessionGuid) && typeof raw.text === 'string'
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'input requires string sessionGuid and text fields')
    case 'abort':
    case 'terminate_session':
      return isNonEmptyString(raw.sessionGuid)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, `${messageType}.sessionGuid must be a non-empty string`)
    case 'start_background_session':
      return isNonEmptyString(raw.sessionGuid) &&
        isOptionalString(raw.hostId) &&
        isOptionalString(raw.sessionFile) &&
        isOptionalString(raw.cwd) &&
        isOptionalString(raw.requestId)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'start_background_session contains invalid fields')
    case 'create_background_session':
      return isNonEmptyString(raw.hostId) && isNonEmptyString(raw.cwd) && isOptionalString(raw.requestId)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'create_background_session requires hostId and cwd')
    case 'refresh_host_sessions':
      return isNonEmptyString(raw.hostId)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'refresh_host_sessions.hostId must be a non-empty string')
    case 'host_sessions':
      return isNonEmptyString(raw.hostId) &&
        (raw.sessions === undefined ||
          (Array.isArray(raw.sessions) && raw.sessions.every(isCatalogSession)))
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'host_sessions contains an invalid session catalog')
    case 'session_snapshot_data':
      return isOptionalString(raw.hostId) && isSnapshotData(raw.session)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'session_snapshot_data.session is invalid')
    case 'session_snapshot_error':
      return isOptionalString(raw.hostId) &&
        isOptionalString(raw.sessionGuid) &&
        isOptionalString(raw.message)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'session_snapshot_error contains invalid fields')
    case 'runner_status':
      return isOptionalString(raw.hostId) &&
        isOptionalString(raw.sessionGuid) &&
        isOptionalString(raw.requestId) &&
        isNonEmptyString(raw.status) &&
        isOptionalString(raw.error) &&
        isOptionalNumber(raw.pid) &&
        isOptionalNumber(raw.code) &&
        isOptionalString(raw.signal)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'runner_status contains invalid fields')
    case 'released':
      return isOptionalString(raw.sessionGuid)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'released.sessionGuid is invalid')
    case 'session_event':
      return isNonEmptyString(raw.sessionGuid) && isSessionEvent(raw.event)
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'session_event contains an invalid session event')
    default:
      return {
        type: '__unknown__',
        rawType: messageType,
        raw,
      }
  }
}
