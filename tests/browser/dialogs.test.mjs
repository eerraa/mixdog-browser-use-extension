import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: new URL('./electron-fixture.mjs', import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { dialog } = await import('./electron-fixture.mjs');
const { BrowserDialogs, showManualMessageBox } = await import('../../src/browser/dialogs.mjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const original = dialog.showMessageBox;
  let nativeCalls = 0;
  dialog.showMessageBox = async () => { nativeCalls++; return { response: 0 }; };
  const fences = new Set(), ready = [], notes = [];
  const pages = [0, 1].map(index => ({
    id: `page-${index}`, closed: false, paused: null,
    frame: {}, contents: { isDestroyed: () => false }, presentation: { mode: 'automation' },
    driver: {
      trackNativeResponse(actual) {
        fences.add(actual);
        actual.then(() => fences.delete(actual));
        return actual;
      },
    },
  }));
  const adapter = new BrowserDialogs({
    pageForWindow: window => pages.find(page => page.frame === window),
    onReady: (page, event) => { ready.push({ page, event }); return true; },
    note: (page, reason) => notes.push({ page, reason }),
  });
  return {
    adapter, pages, ready, fences, notes, nativeCalls: () => nativeCalls,
    capture: (page, controller = new AbortController()) => ({
      controller, promise: dialog.showMessageBox(page.frame, { signal: controller.signal }),
    }),
    close: () => { adapter.close(); dialog.showMessageBox = original; },
  };
}

test('owned native invocations and actual CDP events associate in either order without native UI', async () => {
  for (const order of ['native-first', 'event-first']) {
    const f = fixture(), page = f.pages[0], event = { type: 'confirm', message: 'Untrusted page text' };
    try {
      let native;
      if (order === 'native-first') {
        native = f.capture(page);
        assert.equal(f.ready.length, 0);
        f.adapter.opened(page, event);
      } else {
        f.adapter.opened(page, event);
        assert.equal(f.ready.length, 0);
        native = f.capture(page);
      }
      assert.equal(f.ready.length, 1);
      assert.equal(f.nativeCalls(), 0);
      assert.equal(f.fences.size, 1);
      let complete = false;
      const response = f.adapter.answer(page, event, true).then(() => { complete = true; });
      assert.deepEqual(await native.promise, { response: 0, checkboxChecked: false });
      await tick();
      assert.equal(complete, false, 'Resolving the held message-box promise is not actual dialog closure');
      assert.equal(f.fences.size, 1);
      f.adapter.closed(page, event);
      await response;
      assert.equal(complete, true);
      assert.equal(f.fences.size, 0);
      assert.throws(() => f.adapter.answer(page, event, true), /already answered or withdrawn/);
    } finally { f.close(); }
  }
});

test('two pages cannot exchange dialog decisions; cancellation and Stop never become approval', async () => {
  const f = fixture();
  try {
    const [first, second] = f.pages;
    const events = [{ type: 'confirm' }, { type: 'alert' }];
    const firstNative = f.capture(first), secondNative = f.capture(second);
    f.adapter.opened(first, events[0]);
    f.adapter.opened(second, events[1]);
    assert.throws(() => f.adapter.answer(first, events[1], true), /unassociated/);
    first.paused = 'explicit-stop';
    f.adapter.withdraw(first);
    assert.equal((await firstNative.promise).response, 1);
    assert.throws(() => f.adapter.answer(first, events[0], true), /withdrawn/);
    secondNative.controller.abort(new Error('Native browser cancelled'));
    assert.equal((await secondNative.promise).response, 1);
    assert.throws(() => f.adapter.answer(second, events[1], true), /withdrawn/);
    assert.equal(f.fences.size, 2);
    f.adapter.closed(first, events[0]);
    f.adapter.closed(second, events[1]);
    await tick();
    assert.equal(f.fences.size, 0);
    assert.equal(f.nativeCalls(), 0);
  } finally { f.close(); }
});

test('unassociated, unsupported and ambiguous dialogs are never published as agent choices', async t => {
  const f = fixture(), page = f.pages[0];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const native = f.capture(page);
    t.mock.timers.tick(5000);
    assert.equal((await native.promise).response, 1);
    f.adapter.opened(page, { type: 'confirm' });
    assert.equal(f.ready.length, 0, 'Late association cannot revive expired choice authority');
    f.adapter.closed(page);
    f.adapter.opened(page, { type: 'prompt' });
    const unsupported = f.capture(page);
    assert.equal((await unsupported.promise).response, 1);
    assert.equal(f.ready.length, 0);
    f.adapter.closed(page);
    const ambiguous = f.capture(page), sibling = f.capture(page);
    assert.equal((await ambiguous.promise).response, 1);
    assert.equal((await sibling.promise).response, 1);
    assert.equal(f.ready.length, 0);
    assert.equal(f.nativeCalls(), 0);
  } finally { t.mock.timers.reset(); f.close(); }
});

test('manual and non-page surfaces retain native UI while automated pages do not', async () => {
  const f = fixture(), page = f.pages[0];
  try {
    await showManualMessageBox(page.frame, { message: 'Explicit application-owned manual consent' });
    await dialog.showMessageBox({ message: 'Non-page application surface' });
    page.presentation.mode = 'native-handoff';
    await dialog.showMessageBox(page.frame, { message: 'Human page dialog' });
    assert.equal(f.nativeCalls(), 3);
    assert.equal(f.ready.length, 0);
    assert.equal(f.fences.size, 0);
  } finally { f.close(); }
});
