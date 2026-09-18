// Isolated E2E: real CLI/client/auth/server-core/WS transport; fake Pi APIs.
// No production entrypoint, config files, provider traffic, or fixed ports.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { createServerCore } from '../shared/server-core.js'
import { createNodeTransport } from '../node/transport.js'
import { createAdminSessionToken, serializeCookie, verifyAdminSessionCookie } from '../shared/auth.js'
import { createModelController } from '../../../model-control.js'

async function fixture() {
  const secret = randomUUID()
  const transport = createNodeTransport()
  const core = createServerCore(transport, {
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
  }, { serverToken: secret, publicUrl: 'http://127.0.0.1', publicServerUrl: 'ws://127.0.0.1/ws', wsPath: '/ws', log: () => {} })
  const http = createServer(async (req, res) => {
    if (req.url !== '/auth/login' || req.method !== 'POST') { res.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of req) body += chunk
    if (JSON.parse(body).token !== secret) { res.writeHead(401).end(); return }
    const token = await createAdminSessionToken(secret, { expiresInSeconds: 60 })
    res.writeHead(200, { 'Set-Cookie': serializeCookie('toilet-pi-admin', token) }).end('{"ok":true}')
  })
  const wss = new WebSocketServer({ noServer: true })
  let origin: string
  http.on('upgrade', (req, socket, head) => {
    void (async () => {
      // Only this in-memory test endpoint bypasses production machine auth.
      const runner = req.url === '/fake-runner'
      const auth = runner ? { kind: 'machine' as const, machineId: 'host-test' }
        : req.headers.origin === origin ? await verifyAdminSessionCookie(secret, req.headers.cookie) : null
      if (!auth) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
      wss.handleUpgrade(req, socket, head, ws => {
        const id = randomUUID()
        transport.register(id, ws)
        core.onConnect(id, 'isolated-test', auth)
        ws.on('message', data => void core.onMessage(id, String(data)))
        ws.on('close', () => { transport.unregister(id); core.onClose(id) })
      })
    })()
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('No isolated port')
  origin = `http://127.0.0.1:${address.port}`

  const models = [
    { provider: 'fake', id: 'small', name: 'Small', levels: ['off'], headers: { Authorization: 'never-forward-this' } },
    { provider: 'fake', id: 'large', name: 'Large', levels: ['off', 'high', 'max'] },
  ]
  let level = 'off', busy = false, catalogueCalls = 0, ignoreRequests = false
  const mutations: string[] = []
  const ctx = {
    model: models[0], sessionManager: { getSessionId: () => 'session-test-123' },
    modelRegistry: { getAvailable: () => { catalogueCalls++; return models } },
    isIdle: () => !busy, hasPendingMessages: () => false,
  }
  const controller = createModelController({
    getContext: () => ctx, loadThinkingLevels: async () => model => model.levels,
    pi: {
      getThinkingLevel: () => level,
      setThinkingLevel: value => { level = value; mutations.push(`thinking:${value}`) },
      setModel: async model => { ctx.model = model; mutations.push(`model:${model.id}`); return true },
    },
  })
  const runner = new WebSocket(`${origin.replace('http', 'ws')}/fake-runner`)
  runner.on('message', async raw => {
    const message = JSON.parse(String(raw))
    if (message.type === 'session_request' && !ignoreRequests) {
      runner.send(JSON.stringify(await controller.run(message)))
    }
  })
  await once(runner, 'open')
  runner.send(JSON.stringify({ type: 'hello', role: 'interactive', sessionGuid: 'session-test-123',
    hostname: 'isolated-host', cwd: '/fake/worktree', sessionName: 'Isolated task',
    capabilities: ['model_control_v1'], configuration: controller.configuration(), history: [], busy: false }))

  // The runner's hello is processed before CLI login/upgrade completes.
  async function cli(args: string[], token: string = secret) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../cli/toilet-pi.js', import.meta.url)),
      '--server', origin, '--timeout', '2', ...args], {
      // Deliberately do not inherit any PI_*, TOILET_PI_*, HOME, or provider secrets.
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TOILET_PI_ADMIN_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const [code] = await once(child, 'close')
    return { code, stdout, stderr }
  }
  return {
    cli, mutations, get catalogueCalls() { return catalogueCalls },
    setBusy: (value: boolean) => { busy = value },
    ignore: () => { ignoreRequests = true },
    async close() {
      for (const socket of wss.clients) socket.terminate()
      runner.terminate()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      http.closeAllConnections()
      await new Promise<void>(resolve => http.close(() => resolve()))
    },
  }
}

describe('isolated executable E2E', () => {
  it('discovers, enumerates in one request, configures, and observes the new selection', async () => {
    const f = await fixture()
    try {
      const sessions = await f.cli(['sessions'])
      expect(sessions.code).toBe(0)
      expect(sessions.stdout).toContain('session-test-123  isolated-host  idle  Isolated task')
      const catalogue = await f.cli(['models', 'session-test'])
      expect(catalogue).toEqual({ code: 0, stdout:
        'fake/small  off\nfake/large  off high max\nCurrent: fake/small thinking=off\n', stderr: '' })
      expect(f.catalogueCalls).toBe(1)
      expect(f.mutations).toEqual([])
      const configured = await f.cli(['model', 'session-test', 'fake/large', '--thinking', 'max'])
      expect(configured.code).toBe(0)
      expect(configured.stdout).toContain('Configured session-test-123: fake/large thinking=max')
      expect(f.mutations).toEqual(['model:large', 'thinking:max'])
      expect((await f.cli(['thinking', 'session-test'])).stdout).toContain('thinking=max')
      expect((await f.cli(['status', 'session-test'])).stdout).toContain('fake/large thinking=max')
      const invalid = await f.cli(['model', 'session-test', 'fake/small', '--thinking', 'high'])
      expect(invalid.code).toBe(1)
      expect(invalid.stderr).toContain('unsupported_level')
      expect(f.mutations).toHaveLength(2)
    } finally { await f.close() }
  }, 15000)

  it('fails safely for auth, busy runtime, and timeout without repeating mutations', async () => {
    const f = await fixture()
    try {
      const denied = await f.cli(['hosts'], 'wrong-secret')
      expect(denied.code).toBe(1)
      expect(denied.stderr).toContain('HTTP 401')
      expect(denied.stderr).not.toContain('wrong-secret')
      f.setBusy(true)
      const busy = await f.cli(['thinking', 'session-test', 'off'])
      expect(busy.code).toBe(1)
      expect(busy.stderr).toContain('busy')
      expect(f.mutations).toEqual([])
      f.ignore()
      const timeout = await f.cli(['model', 'session-test', 'fake/large'])
      expect(timeout.code).toBe(1)
      expect(timeout.stderr).toMatch(/timed out.*unknown/)
      expect(f.mutations).toEqual([])
    } finally { await f.close() }
  }, 15000)
})
