export type ClientRole = 'web' | 'host-supervisor' | 'interactive' | 'background'
export type RunnerRole = 'interactive' | 'background'
export type NoticeLevel = 'info' | 'error'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]

export interface SessionConfiguration {
  provider: string | null
  modelId: string | null
  thinkingLevel: ThinkingLevel | null
}

export interface ModelOption {
  provider: string
  id: string
  name: string
  thinkingLevels: ThinkingLevel[]
}

export interface SessionRequest {
  type: 'session_request'
  requestId: string
  sessionGuid: string
  operation: 'get_models' | 'get_config' | 'configure'
  provider?: string
  modelId?: string
  thinkingLevel?: ThinkingLevel
}

export interface SessionResponse {
  type: 'session_response'
  requestId: string
  sessionGuid: string
  success: boolean
  data?: { configuration: SessionConfiguration; models?: ModelOption[] }
  error?: { code: string; message: string }
}

export const INPUT_STATES = ['accepted', 'submitted', 'running', 'settled', 'failed', 'aborted', 'unknown'] as const
export type InputState = typeof INPUT_STATES[number]
export interface InputStatus {
  inputId: string
  sessionGuid: string
  state: InputState
  updatedAt: number
}

export interface ControlRequest {
  type: 'control_request'
  requestId: string
  operation: 'send' | 'abort' | 'terminate' | 'resume' | 'new' | 'get_input' | 'history'
  sessionGuid?: string
  hostId?: string
  cwd?: string
  text?: string
  mode?: 'prompt' | 'steer' | 'followUp'
  requireSettled?: boolean
  inputId?: string
  since?: string
  last?: number
}
export interface HistoryPage {
  source: 'runtime-branch' | 'persisted-branch'
  sanitized: true
  complete: boolean
  truncated: boolean
  leafId: string | null
  nextCursor: string | null
  hasMore: boolean
  messages: SanitizedMessage[]
}
export interface ControlResponse {
  type: 'control_response'
  requestId: string
  success: boolean
  data?: { sessionGuid?: string; status?: string; input?: InputStatus; history?: HistoryPage }
  error?: { code: string; message: string }
}
export interface ControlCommand extends Omit<ControlRequest, 'type'> {
  type: 'control_command'
  sessionFile?: string | null
}

export interface UserHistoryMessage {
  entryId?: string
  role: 'user'
  timestamp?: number
  text: string
  remoteInputId?: string
}

export interface AssistantHistoryMessage {
  entryId?: string
  role: 'assistant'
  timestamp?: number
  text: string
  thinkingText?: string
  stopReason?: string
}

export interface ToolResultHistoryMessage {
  entryId?: string
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
  configuration?: SessionConfiguration
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
  | { type: 'input_status'; input: InputStatus }
  | { type: 'configuration'; configuration: SessionConfiguration }
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
  capabilities?: string[]
  type: 'hello'
  role: 'host-supervisor'
  hostId: string
  hostname?: string | null
  platform?: string | null
  pid?: number | null
}

export interface HelloRunnerMessage {
  capabilities?: string[]
  configuration?: SessionConfiguration
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
  | ControlRequest
  | ControlResponse
  | SessionRequest
  | SessionResponse
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
  capabilities?: string[]
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
  | { type: 'control_progress'; requestId: string; sessionGuid?: string; state: 'loading' | 'starting' }
  | ControlCommand
  | ControlResponse
  | SessionRequest
  | SessionResponse
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
  if (!isRecord(value) || !isOptionalNumber(value.timestamp) || !isOptionalString(value.entryId)) return false

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

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel)
}

function isConfiguration(value: unknown): value is SessionConfiguration {
  return isRecord(value) &&
    (value.provider === null || isNonEmptyString(value.provider)) &&
    (value.modelId === null || isNonEmptyString(value.modelId)) &&
    (value.thinkingLevel === null || isThinkingLevel(value.thinkingLevel))
}

function isModelOption(value: unknown): value is ModelOption {
  return isRecord(value) && isNonEmptyString(value.provider) && isNonEmptyString(value.id) &&
    typeof value.name === 'string' && Array.isArray(value.thinkingLevels) &&
    value.thinkingLevels.length > 0 && value.thinkingLevels.every(isThinkingLevel)
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value)) return false

  switch (value.type) {
    case 'input_status':
      return isInputStatus(value.input)
    case 'configuration':
      return isConfiguration(value.configuration)
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

function isInputStatus(value: unknown): value is InputStatus {
  return isRecord(value) && isNonEmptyString(value.inputId) && isNonEmptyString(value.sessionGuid) &&
    INPUT_STATES.includes(value.state as InputState) && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
}

function isHistoryPage(value: unknown): value is HistoryPage {
  return isRecord(value) && ['runtime-branch', 'persisted-branch'].includes(String(value.source)) &&
    value.sanitized === true && typeof value.complete === 'boolean' && typeof value.truncated === 'boolean' &&
    typeof value.hasMore === 'boolean' && isOptionalString(value.leafId) && isOptionalString(value.nextCursor) &&
    Array.isArray(value.messages) && value.messages.length <= 1000 && value.messages.every(isSanitizedMessage) &&
    new TextEncoder().encode(JSON.stringify(value)).length <= 1024 * 1024 + 4096
}

export function parseClientMessage(raw: unknown): ClientMessage {
  if (!isRecord(raw)) {
    return { type: '__invalid__', rawType: null, message: 'Message must be an object', raw: {} }
  }

  const messageType = typeof raw.type === 'string' ? raw.type : null
  switch (messageType) {
    case 'control_request': {
      const op = raw.operation
      const fields: Record<string, string[]> = {
        send: ['sessionGuid', 'text', 'mode', 'inputId', 'requireSettled'], abort: ['sessionGuid'], terminate: ['sessionGuid'],
        resume: ['sessionGuid'], new: ['hostId', 'cwd'], get_input: ['sessionGuid', 'inputId'], history: ['sessionGuid', 'since', 'last'],
      }
      const allowed = typeof op === 'string' ? fields[op] : undefined
      const valid = allowed && Object.keys(raw).every(k => ['type', 'requestId', 'operation', ...allowed].includes(k)) &&
        isNonEmptyString(raw.requestId) && raw.requestId.length <= 128 &&
        (op === 'new' ? isNonEmptyString(raw.hostId) && isNonEmptyString(raw.cwd) && raw.cwd.length <= 4096 && !raw.cwd.includes('\0') : isNonEmptyString(raw.sessionGuid)) &&
        (op !== 'send' || (isNonEmptyString(raw.text) && new TextEncoder().encode(raw.text).length <= 50 * 1024 &&
          ['prompt', 'steer', 'followUp'].includes(String(raw.mode)))) &&
        (!['send', 'get_input'].includes(String(op)) || (isNonEmptyString(raw.inputId) && /^[a-zA-Z0-9_-]{16,128}$/.test(raw.inputId))) &&
        isOptionalBoolean(raw.requireSettled) &&
        (raw.since === undefined || (isNonEmptyString(raw.since) && raw.since.length <= 128)) &&
        (raw.last === undefined || (Number.isInteger(raw.last) && Number(raw.last) > 0 && Number(raw.last) <= 1000))
      return valid ? parsedMessage(raw) : invalidClientMessage(raw, messageType, 'Invalid control request')
    }
    case 'control_response': {
      const valid = raw.success === true ? isRecord(raw.data) &&
        isOptionalString(raw.data.sessionGuid) && isOptionalString(raw.data.status) &&
        (raw.data.input === undefined || isInputStatus(raw.data.input)) &&
        (raw.data.history === undefined || isHistoryPage(raw.data.history)) :
        raw.success === false && isRecord(raw.error) && isNonEmptyString(raw.error.code) && typeof raw.error.message === 'string'
      return isNonEmptyString(raw.requestId) && valid ? parsedMessage(raw) : invalidClientMessage(raw, messageType, 'Invalid control response')
    }
    case 'session_request': {
      const validBase = isNonEmptyString(raw.requestId) && raw.requestId.length <= 128 &&
        isNonEmptyString(raw.sessionGuid) && ['get_models', 'get_config', 'configure'].includes(String(raw.operation))
      const hasModel = raw.provider !== undefined || raw.modelId !== undefined
      const validSelection = (!hasModel || (isNonEmptyString(raw.provider) && isNonEmptyString(raw.modelId))) &&
        (raw.thinkingLevel === undefined || isThinkingLevel(raw.thinkingLevel))
      const validOperation = raw.operation === 'configure'
        ? hasModel || raw.thinkingLevel !== undefined
        : !hasModel && raw.thinkingLevel === undefined
      return validBase && validSelection && validOperation
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'Invalid session request or model/thinking selection')
    }
    case 'session_response': {
      const validResult = raw.success === true
        ? isRecord(raw.data) && isConfiguration(raw.data.configuration) &&
          (raw.data.models === undefined || (Array.isArray(raw.data.models) && raw.data.models.every(isModelOption)))
        : raw.success === false && isRecord(raw.error) && isNonEmptyString(raw.error.code) && typeof raw.error.message === 'string'
      return isNonEmptyString(raw.requestId) && isNonEmptyString(raw.sessionGuid) && validResult
        ? parsedMessage(raw)
        : invalidClientMessage(raw, messageType, 'Invalid session response')
    }
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
        (raw.capabilities !== undefined && (!Array.isArray(raw.capabilities) || !raw.capabilities.every(isNonEmptyString))) ||
        (raw.configuration !== undefined && !isConfiguration(raw.configuration)) ||
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
