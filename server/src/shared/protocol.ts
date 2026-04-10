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
  sessionFile: string | null
  sessionName: string | null
  cwd: string | null
  model: string | null
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
  | ToolEndEvent
  | BusyEvent
  | ModelEvent
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
  launchRequestId?: string | null
  sessionGuid?: string
  sessionFile?: string | null
  sessionName?: string | null
  cwd?: string | null
  model?: string | null
  busy?: boolean
  streamingText?: string | null
  streamingThinkingText?: string | null
  history?: SanitizedMessage[]
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

export type ClientMessage =
  | HelloMessage
  | AttachMessage
  | InputMessage
  | AbortMessage
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
  sessionFile: string | null
  sessionName: string | null
  cwd: string | null
  model: string | null
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
  | ListSessionsMessage
  | ReadSessionSnapshotMessage
  | StartBackgroundSessionCommandMessage
  | SessionEventMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function parseClientMessage(raw: unknown): ClientMessage {
  if (!isRecord(raw)) {
    return { type: '__unknown__', rawType: null, raw: {} }
  }

  const messageType = typeof raw.type === 'string' ? raw.type : null
  switch (messageType) {
    case 'hello':
    case 'attach':
    case 'input':
    case 'abort':
    case 'start_background_session':
    case 'create_background_session':
    case 'refresh_host_sessions':
    case 'host_sessions':
    case 'session_snapshot_data':
    case 'session_snapshot_error':
    case 'runner_status':
    case 'released':
    case 'session_event':
      return raw as unknown as ClientMessage
    default:
      return {
        type: '__unknown__',
        rawType: messageType,
        raw,
      }
  }
}
