import type {
  OverviewHost,
  QueuedInput,
  RunnerRole,
  SanitizedMessage,
  ServerMessage,
} from './protocol.js'

export interface Transport {
  send(connId: string, payload: unknown): boolean
  close(connId: string, code?: number, reason?: string): void
  isOpen(connId: string): boolean
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ServerCore {
  onConnect(connId: string, remoteAddr: string): void
  onMessage(connId: string, data: string): Promise<void>
  onClose(connId: string): void
}

export interface ServerConfig {
  serverToken: string
  publicUrl: string
  publicServerUrl: string
  wsPath: string
  log?: (message: string) => void
}

export interface ActiveTool {
  toolCallId: string
  toolName: string
  args?: unknown
}

export interface PendingInput {
  inputId: string
  text: string
}

export interface WebClientState {
  attachedSessionGuid: string | null
}

export interface HostCatalog {
  hostId: string
  updatedAt: number
  sessions: CatalogSession[]
}

export interface CatalogSession {
  sessionGuid: string
  sessionFile: string | null
  sessionName: string | null
  cwd: string | null
  preview: string | null
  updatedAt: number
  model?: string | null
  busy?: boolean
}

export interface HostState {
  hostId: string
  hostname: string
  platform: string | null
  pid: number | null
  conn: string
  connectedAt: number
}

export type ClientState =
  | { role: 'web' }
  | { role: 'host-supervisor'; hostId: string }
  | {
      role: RunnerRole
      hostId: string | null
      sessionGuid: string
    }

export interface SessionState {
  sessionGuid: string
  interactiveConn: string | null
  backgroundConn: string | null
  pendingInteractiveConn: string | null
  owner: RunnerRole | null
  hostId: string | null
  sessionFile: string | null
  sessionName: string | null
  cwd: string | null
  model: string | null
  preview: string | null
  busy: boolean
  history: SanitizedMessage[]
  streamingText: string | null
  streamingThinkingText: string | null
  activeTools: Map<string, ActiveTool>
  runnerStatus: string | null
  pendingInputs: PendingInput[]
  queuedInputs: QueuedInput[]
  updatedAt: number
}

export interface SnapshotData {
  sessionGuid: string
  sessionFile?: string | null
  sessionName?: string | null
  cwd?: string | null
  model?: string | null
  history?: SanitizedMessage[]
  updatedAt?: number
}

export interface FoundCatalogSession {
  hostId: string
  session: CatalogSession
}

export interface SharedState {
  hosts: Map<string, HostState>
  hostCatalogs: Map<string, HostCatalog>
  sessions: Map<string, SessionState>
  webClients: Map<string, WebClientState>
  clients: Map<string, ClientState>
  pendingSessionSnapshotLoads: Map<string, unknown>
}

export interface SendHelpers {
  send(connId: string, payload: ServerMessage): boolean
  sendOverview(connId: string): void
  broadcastOverview(): void
  broadcastWeb(payload: ServerMessage): void
  broadcastNotice(payload: Extract<ServerMessage, { type: 'notice' }>): void
  sendToAttached(sessionGuid: string | null, payload: ServerMessage): void
  buildOverviewHosts(): OverviewHost[]
}
