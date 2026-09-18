// Isolated E2E: real CLI/client/auth/server-core/WS transport; fake Pi APIs.
// No production entrypoint, config files, provider traffic, or fixed ports.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { createServerCore } from '../shared/server-core.js'
import { createNodeTransport } from '../node/transport.js'
import { createAdminSessionToken, createOrchestratorToken, serializeCookie, verifyAdminSessionCookie } from '../shared/auth.js'
import { authenticateOrchestratorHeader } from '../shared/orchestrator-auth.js'
import { createInputTracker } from '../../../input-tracker.js'
import { buildHistoryPage } from '../../../history-page.js'
import { createModelController } from '../../../model-control.js'

async function fixture() {
  const secret = randomUUID()
  const transport = createNodeTransport()
  const core = createServerCore(transport, {
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
  }, { serverToken: secret, publicUrl: 'http://127.0.0.1', publicServerUrl: 'ws://127.0.0.1/ws', wsPath: '/ws', log: () => {} })
  let loginRequests = 0
  const http = createServer(async (req, res) => {
    if (req.url !== '/auth/login' || req.method !== 'POST') { res.writeHead(404).end(); return }
    loginRequests++
    let body = ''
    for await (const chunk of req) body += chunk
    if (JSON.parse(body).token !== secret) { res.writeHead(401).end(); return }
    const token = await createAdminSessionToken(secret, { expiresInSeconds: 60 })
    res.writeHead(200, { 'Set-Cookie': serializeCookie('toilet-pi-admin', token) }).end('{"ok":true}')
  })
  const wss = new WebSocketServer({ noServer: true })
  let origin: string
  let emitOnAttach = false
  http.on('upgrade', (req, socket, head) => {
    void (async () => {
      // Only this in-memory test endpoint bypasses production machine auth.
      const isRunner = req.url === '/fake-runner'
      const auth = isRunner ? { kind: 'machine' as const, machineId: 'host-test' }
        : req.headers.authorization ? await authenticateOrchestratorHeader(secret, req.headers.authorization)
        : req.headers.origin === origin ? await verifyAdminSessionCookie(secret, req.headers.cookie) : null
      if (!auth) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
      wss.handleUpgrade(req, socket, head, ws => {
        const id = randomUUID()
        transport.register(id, ws)
        core.onConnect(id, 'isolated-test', auth)
        ws.on('message', async data => {
          await core.onMessage(id, String(data))
          if (emitOnAttach && JSON.parse(String(data)).type === 'attach') {
            runner.send(JSON.stringify({ type: 'session_event', sessionGuid: 'session-test-123', event: {
              type: 'message', message: { role: 'assistant', text: '\u001b[31mwatched output\u001b[0m' },
            } }))
          }
        })
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
  const dispatches: any[] = []
  let outcome = 'stop'
  const branch = [{ type: 'message', id: 'entry-1', parentId: null, message: { role: 'user', content: 'persisted text' } }]
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
  const tracker = createInputTracker({ getContext: () => ctx, configuring: () => false,
    emit: event => runner.send(JSON.stringify({ type: 'session_event', sessionGuid: 'session-test-123', event })),
    pi: { sendUserMessage: (text, options) => {
      dispatches.push({ text, options })
      tracker.messageStart({ role: 'user', content: text })
      tracker.messageEnd({ role: 'assistant', stopReason: outcome })
      tracker.settled()
    } },
  })
  runner.on('message', async raw => {
    const message = JSON.parse(String(raw))
    if (message.type === 'session_request' && !ignoreRequests) {
      runner.send(JSON.stringify(await controller.run(message)))
    }
    if (message.type === 'control_command' && !ignoreRequests) {
      if (message.operation === 'send') tracker.dispatch(message)
      else runner.send(JSON.stringify({ type: 'control_response', requestId: message.requestId, success: true,
        data: message.operation === 'history' ? { history: buildHistoryPage(branch, { last: message.last, since: message.since, leafId: 'entry-1' }) } : { status: 'requested' } }))
    }
  })
  await once(runner, 'open')
  runner.send(JSON.stringify({ type: 'hello', role: 'interactive', sessionGuid: 'session-test-123',
    hostname: 'isolated-host', cwd: '/fake/worktree', sessionName: 'Isolated task',
    capabilities: ['model_control_v1', 'input_tracking_v1', 'history_v1', 'agent_settled_v1'], configuration: controller.configuration(), history: [], busy: false }))

  // The runner's hello is processed before CLI login/upgrade completes.
  async function cli(args: string[], token: string = secret, scoped = false, savedFile?: string) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../cli/toilet-pi.js', import.meta.url)),
      ...(savedFile ? ['--auth-file', savedFile] : ['--server', origin]), '--timeout', '2', ...args], {
      // Deliberately do not inherit any PI_*, TOILET_PI_*, HOME, or provider secrets.
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, [scoped ? 'TOILET_PI_ORCHESTRATOR_TOKEN' : 'TOILET_PI_ADMIN_TOKEN']: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const [code] = await once(child, 'close')
    return { code, stdout, stderr }
  }
  return {
    cli, mutations, dispatches, get catalogueCalls() { return catalogueCalls },
    get loginRequests() { return loginRequests },
    outcome: (value: string) => { outcome = value },
    watchEvents: () => { emitOnAttach = true },
    grant: () => createOrchestratorToken(secret, { subject: 'e2e-worker', scopes: ['read'], hostIds: ['host-test'], expiresInSeconds: 60 }),
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
  it('logs in once, reuses a saved cookie without URL/environment credentials, and logs out locally', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'toilet-login-e2e-'))
    const file = path.join(dir, 'toilet-pi-auth.json')
    const f = await fixture()
    try {
      const login = await f.cli(['login', '--auth-file', file])
      expect(login.code).toBe(0)
      const stored = JSON.parse(await readFile(file, 'utf8'))
      expect(stored.cookie).toMatch(/^toilet-pi-admin=/)
      expect(stored).not.toHaveProperty('token')
      expect(login.stdout).not.toContain(stored.cookie)
      const hosts = await f.cli(['hosts'], '', false, file)
      expect(hosts.code).toBe(0); expect(hosts.stdout).toContain('isolated-host')
      expect(f.loginRequests).toBe(1)
      const logout = await f.cli(['logout'], '', false, file)
      expect(logout.code).toBe(0)
      const missing = await f.cli(['hosts'], '', false, file)
      expect(missing.code).toBe(1); expect(missing.stderr).toContain('Not logged in')
      expect(f.loginRequests).toBe(1)
    } finally { await f.close(); await rm(dir, { recursive: true, force: true }) }
  }, 15000)

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

  it('dispatches, survives a fresh CLI connection, reads history and reports abort/provider failures', async () => {
    const f = await fixture()
    try {
      const sent = await f.cli(['send', 'session-test', 'literal task', '--wait'])
      expect(sent.code).toBe(0); expect(sent.stdout).toContain('settled')
      const id = sent.stdout.match(/Input ID: ([a-z0-9-]+)/)![1]
      const resumed = await f.cli(['wait', 'session-test', '--input', id])
      expect(resumed.code).toBe(0); expect(resumed.stdout).toContain('settled')
      expect(f.dispatches).toHaveLength(1)
      expect((await f.cli(['history', 'session-test', '--last', '1'])).stdout).toContain('entry-1 user: persisted text')
      expect((await f.cli(['abort', 'session-test'])).stdout).toContain('abort: requested')
      expect((await f.cli(['resume', 'session-test'])).stdout).toContain('resume: running')
      expect((await f.cli(['terminate', 'session-test'])).stdout).toContain('terminate: requested')
      f.watchEvents()
      const watched = await f.cli(['watch', 'session-test', '--timeout', '0.5'])
      expect(watched.code).toBe(0)
      expect(watched.stdout).toContain('assistant: watched output')
      expect(watched.stdout).not.toContain('\u001b')
      f.outcome('error')
      const failed = await f.cli(['send', 'session-test', 'failing task', '--wait'])
      expect(failed.code).toBe(3); expect(failed.stdout).toContain('failed')
      const token = await f.grant()
      expect((await f.cli(['sessions'], token, true)).stdout).toContain('session-test-123')
      const forbidden = await f.cli(['send', 'session-test', 'not allowed'], token, true)
      expect(forbidden.code).toBe(1); expect(forbidden.stderr).toContain('forbidden')
      expect(forbidden.stderr).not.toContain(token)
      expect(f.dispatches).toHaveLength(2)
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
