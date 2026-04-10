import { describe, expect, it } from 'vitest'
import { createServerCore } from '../shared/server-core.js'
import type { ServerMessage } from '../shared/protocol.js'
import type { ServerConfig, Timers, Transport } from '../shared/types.js'

class FakeTransport implements Transport {
  readonly open = new Set<string>()
  readonly messages = new Map<string, ServerMessage[]>()
  readonly closes: Array<{ connId: string; code?: number; reason?: string }> = []

  connect(connId: string) {
    this.open.add(connId)
  }

  send(connId: string, payload: unknown): boolean {
    if (!this.open.has(connId)) return false
    const list = this.messages.get(connId) || []
    list.push(payload as ServerMessage)
    this.messages.set(connId, list)
    return true
  }

  close(connId: string, code?: number, reason?: string): void {
    this.closes.push({ connId, code, reason })
    this.open.delete(connId)
  }

  isOpen(connId: string): boolean {
    return this.open.has(connId)
  }

  drain(connId: string): ServerMessage[] {
    const list = this.messages.get(connId) || []
    this.messages.set(connId, [])
    return list
  }

  last(connId: string): ServerMessage | undefined {
    const list = this.messages.get(connId) || []
    return list[list.length - 1]
  }
}

class FakeTimers implements Timers {
  private nextId = 1
  readonly scheduled = new Map<number, () => void>()

  setTimeout(callback: () => void, _ms: number): unknown {
    const id = this.nextId
    this.nextId += 1
    this.scheduled.set(id, callback)
    return id
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(Number(handle))
  }

  run(handle: unknown): void {
    const id = Number(handle)
    const callback = this.scheduled.get(id)
    if (!callback) return
    this.scheduled.delete(id)
    callback()
  }

  runAll(): void {
    for (const id of Array.from(this.scheduled.keys())) {
      this.run(id)
    }
  }
}

function createTestServer() {
  const transport = new FakeTransport()
  const timers = new FakeTimers()
  const config: ServerConfig = {
    serverToken: 'token',
    publicUrl: 'http://localhost:3457',
    publicServerUrl: 'ws://localhost:3457/ws',
    maxSessionHistory: 200,
    wsPath: '/ws',
  }
  const core = createServerCore(transport, timers, config)
  return { core, transport, timers }
}

function connect(transport: FakeTransport, core: ReturnType<typeof createServerCore>, connId: string) {
  transport.connect(connId)
  core.onConnect(connId, 'test')
}

async function send(core: ReturnType<typeof createServerCore>, connId: string, payload: unknown) {
  await core.onMessage(connId, JSON.stringify(payload))
}

describe('createServerCore', () => {
  it('requires hello before other messages', async () => {
    const { core, transport } = createTestServer()
    connect(transport, core, 'web-1')

    await send(core, 'web-1', { type: 'attach', sessionGuid: 'session-1' })

    expect(transport.drain('web-1')).toEqual([
      { type: 'error', message: 'Send hello first' },
    ])
  })

  it('registers a web client and sends overview on hello', async () => {
    const { core, transport } = createTestServer()
    connect(transport, core, 'web-1')

    await send(core, 'web-1', { type: 'hello', role: 'web' })

    expect(transport.last('web-1')).toEqual({
      type: 'overview',
      hosts: [],
    })
  })

  it('lets interactive take ownership over background', async () => {
    const { core, transport } = createTestServer()
    connect(transport, core, 'background-1')
    connect(transport, core, 'interactive-1')

    await send(core, 'background-1', {
      type: 'hello',
      role: 'background',
      hostId: 'host-1',
      sessionGuid: 'session-1',
      history: [],
      busy: false,
    })
    await send(core, 'interactive-1', {
      type: 'hello',
      role: 'interactive',
      hostId: 'host-1',
      sessionGuid: 'session-1',
      history: [],
      busy: false,
    })

    expect(transport.last('background-1')).toEqual({
      type: 'abort_and_release',
    })
  })

  it('queues input for inactive sessions and delivers it when a background runner connects', async () => {
    const { core, transport } = createTestServer()
    connect(transport, core, 'host-conn')
    connect(transport, core, 'web-1')

    await send(core, 'host-conn', {
      type: 'hello',
      role: 'host-supervisor',
      hostId: 'host-1',
      hostname: 'host-1',
    })
    await send(core, 'host-conn', {
      type: 'host_sessions',
      hostId: 'host-1',
      sessions: [
        {
          sessionGuid: 'session-1',
          sessionFile: '/tmp/session-1.jsonl',
          cwd: '/tmp',
          updatedAt: 1,
        },
      ],
    })
    await send(core, 'web-1', { type: 'hello', role: 'web' })
    await send(core, 'web-1', { type: 'attach', sessionGuid: 'session-1' })
    transport.drain('host-conn')
    transport.drain('web-1')

    await send(core, 'web-1', {
      type: 'input',
      sessionGuid: 'session-1',
      text: 'hello from web',
    })

    expect(transport.messages.get('host-conn')).toContainEqual({
      type: 'start_background_session',
      hostId: 'host-1',
      sessionGuid: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
      cwd: '/tmp',
      requestId: null,
      createNew: false,
    })

    connect(transport, core, 'background-1')
    await send(core, 'background-1', {
      type: 'hello',
      role: 'background',
      hostId: 'host-1',
      sessionGuid: 'session-1',
      history: [],
      busy: false,
    })

    expect(transport.messages.get('background-1')).toContainEqual(
      expect.objectContaining({ type: 'input', text: 'hello from web' }),
    )
  })

  it('requests session snapshots from the host when a web client attaches', async () => {
    const { core, transport } = createTestServer()
    connect(transport, core, 'host-conn')
    connect(transport, core, 'web-1')

    await send(core, 'host-conn', {
      type: 'hello',
      role: 'host-supervisor',
      hostId: 'host-1',
      hostname: 'host-1',
    })
    await send(core, 'host-conn', {
      type: 'host_sessions',
      hostId: 'host-1',
      sessions: [
        {
          sessionGuid: 'session-1',
          sessionFile: '/tmp/session-1.jsonl',
          updatedAt: 1,
        },
      ],
    })
    await send(core, 'web-1', { type: 'hello', role: 'web' })
    transport.drain('host-conn')
    transport.drain('web-1')

    await send(core, 'web-1', { type: 'attach', sessionGuid: 'session-1' })

    expect(transport.messages.get('host-conn')).toContainEqual({
      type: 'read_session_snapshot',
      sessionGuid: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
    })
  })

  it('prunes unattached sessions when the host disconnects', async () => {
    const { core, transport } = createTestServer()
    connect(transport, core, 'host-conn')
    connect(transport, core, 'web-1')

    await send(core, 'host-conn', {
      type: 'hello',
      role: 'host-supervisor',
      hostId: 'host-1',
      hostname: 'host-1',
    })
    await send(core, 'host-conn', {
      type: 'host_sessions',
      hostId: 'host-1',
      sessions: [
        {
          sessionGuid: 'session-1',
          sessionFile: '/tmp/session-1.jsonl',
          updatedAt: 1,
        },
      ],
    })
    await send(core, 'web-1', { type: 'hello', role: 'web' })
    await send(core, 'web-1', { type: 'attach', sessionGuid: 'session-1' })
    transport.drain('web-1')

    transport.close('host-conn')
    core.onClose('host-conn')

    expect(transport.messages.get('web-1')).toContainEqual({
      type: 'session_snapshot',
      session: {
        sessionGuid: 'session-1',
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
      },
    })
  })
})
