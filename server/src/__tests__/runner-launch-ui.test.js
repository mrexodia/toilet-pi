import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'

const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

function fixture() {
  const dom = new JSDOM(html, { url: 'http://isolated/', runScripts: 'outside-only' })
  const w = dom.window
  w.matchMedia = () => ({ matches: false, addEventListener() {} })
  w.requestAnimationFrame = () => 1
  w.createModelPicker = () => ({ receive() {}, sync() {} })
  w.groupCollapsedHistory = () => []
  w.renderMarkdown = text => text
  w.__sent = []
  w.eval(source.replace(/^import .*;\n/gm, '').replace('void initializeAuth();', '') + `
    window.__test = {
      setup(hostsValue) {
        hosts = hostsValue; isAuthenticated = true;
        ws = { readyState: WebSocket.OPEN, send(text) { window.__sent.push(JSON.parse(text)); } };
        currentSessionGuid = 'entry'; currentSession = createEmptySession('entry');
        currentSession.owner = 'interactive'; updateControls();
      },
      handleMessage, triggerNewSession,
      current() { return currentSessionGuid; }, pending() { return pendingLaunchRequests.size; }
    };`)
  const host = { hostId: 'host', hostname: 'remote', connected: false, canLaunch: true,
    sessions: [{ sessionGuid: 'entry', cwd: '/entry-folder', owner: 'interactive', busy: false }] }
  w.__test.setup([host])
  return { dom, w, host }
}

describe('runner-based browser launch', () => {
  it('enables New without a supervisor, accepts another folder and attaches only after the correlated response', () => {
    const { dom, w } = fixture()
    try {
      expect(w.document.getElementById('new-session-btn').disabled).toBe(false)
      w.prompt = () => '/different-folder'
      w.__test.triggerNewSession()
      const request = w.__sent.find(m => m.type === 'control_request')
      expect(request).toMatchObject({ operation: 'new', hostId: 'host', cwd: '/different-folder' })
      expect(w.__test.current()).toBe('entry')
      w.__test.handleMessage({ type: 'control_response', requestId: 'wrong', success: true, data: { sessionGuid: 'forged' } })
      expect(w.__test.current()).toBe('entry')
      w.__test.handleMessage({ type: 'control_response', requestId: request.requestId, success: true, data: { sessionGuid: 'child', status: 'running' } })
      expect(w.__test.current()).toBe('child')
      expect(w.__test.pending()).toBe(0)
    } finally { dom.window.close() }
  })
  it('handles cancellation and launch errors without changing the selected session', () => {
    const { dom, w } = fixture()
    try {
      w.prompt = () => null
      w.__test.triggerNewSession()
      expect(w.__sent).toHaveLength(0)
      w.prompt = () => '/invalid-folder'
      w.__test.triggerNewSession()
      const request = w.__sent[0]
      w.__test.handleMessage({ type: 'control_response', requestId: request.requestId, success: false,
        error: { code: 'launch_failed', message: 'Check target directory' } })
      expect(w.__test.current()).toBe('entry')
      expect(w.__test.pending()).toBe(0)
      expect(w.document.getElementById('notice-bar').textContent).toContain('Check target directory')
    } finally { dom.window.close() }
  })
  it('does not enable launching for an older runner without the capability', () => {
    const { dom, w, host } = fixture()
    try {
      w.__test.setup([{ ...host, canLaunch: false }])
      expect(w.document.getElementById('new-session-btn').disabled).toBe(true)
    } finally { dom.window.close() }
  })
})
