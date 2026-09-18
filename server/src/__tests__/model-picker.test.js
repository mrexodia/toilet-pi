// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createModelPicker } from '../../public/model-picker.js';

function fixture() {
  const root = document.createElement('div');
  let session = { sessionGuid: 'session', owner: 'interactive', busy: false, queuedInputs: [] };
  const sent = [];
  const picker = createModelPicker({ root, send: message => { sent.push(message); return true; }, getSession: () => session, notify: vi.fn() });
  picker.sync(true);
  const [load, model, thinking, apply, status] = root.children;
  const respond = (fields = {}) => picker.receive({ type: 'session_response', requestId: sent.at(-1).requestId, sessionGuid: 'session', success: true,
    data: { configuration: { provider: 'fake', modelId: 'small', thinkingLevel: 'off' }, models: [
      { provider: 'fake', id: 'small', thinkingLevels: ['off'] }, { provider: 'fake', id: '<script>large</script>', thinkingLevels: ['off', 'high'] },
    ] }, ...fields });
  return { root, picker, load, model, thinking, apply, status, sent, respond, session, switchSession: () => { session = { ...session, sessionGuid: 'other', configuration: null }; picker.sync(true); } };
}

describe('browser model picker', () => {
  it('enumerates models and levels together, renders literal labels and validates the selected pair', () => {
    const f = fixture();
    try {
      expect(f.model.disabled).toBe(true);
      f.load.click(); expect(f.sent[0].operation).toBe('get_models'); expect(f.load.disabled).toBe(true);
      f.respond();
      expect(f.root.querySelector('script')).toBeNull();
      expect(f.model.options[1].textContent).toBe('fake/<script>large</script>');
      f.model.value = '1'; f.model.dispatchEvent(new Event('change'));
      expect([...f.thinking.options].map(o => o.value)).toEqual(['off', 'high']);
      f.thinking.value = 'high'; f.apply.click();
      expect(f.sent[1]).toMatchObject({ operation: 'configure', provider: 'fake', modelId: '<script>large</script>', thinkingLevel: 'high' });
    } finally { f.picker.dispose(); }
  });
  it('disables mutations while busy/queued and discards stale responses after selection changes', () => {
    const f = fixture();
    try {
      f.load.click(); f.respond();
      f.session.busy = true; f.picker.sync(true); expect(f.apply.disabled).toBe(true);
      f.session.busy = false; f.session.queuedInputs = [{}]; f.picker.sync(true); expect(f.apply.disabled).toBe(true);
      f.session.queuedInputs = []; f.picker.sync(true);
      f.load.click(); const old = { ...f.sent.at(-1) }; f.switchSession();
      f.picker.receive({ ...old, type: 'session_response', success: true, data: {} });
      expect(f.model.options.length).toBe(0);
    } finally { f.picker.dispose(); }
  });
  it('clears selections on disconnect/timeout instead of replaying configuration', () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.load.click(); vi.advanceTimersByTime(20000);
      expect(f.status.textContent).toContain('unknown'); expect(f.sent).toHaveLength(1);
      f.load.click(); f.picker.sync(false);
      expect(f.status.textContent).toContain('Disconnected'); expect(f.apply.disabled).toBe(true);
      f.picker.sync(true); expect(f.sent).toHaveLength(2);
    } finally { f.picker.dispose(); vi.useRealTimers(); }
  });
});
