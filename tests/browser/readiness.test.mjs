import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { firstRender } from '../../src/browser/readiness.mjs';

function guest() {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.destroyed = false;
  window.destroy = () => { window.destroyed = true; window.emit('closed'); };
  return window;
}
function detached(window) {
  assert.equal(window.listenerCount('ready-to-show'), 0);
  assert.equal(window.listenerCount('closed'), 0);
  assert.equal(window.webContents.listenerCount('render-process-gone'), 0);
}

test('first render records actual paint, not load completion, once per owned guest', async () => {
  const window = guest();
  const promise = firstRender(window);
  let completed = false;
  void promise.then(() => { completed = true; });
  window.webContents.emit('did-finish-load');
  await Promise.resolve();
  assert.equal(completed, false);
  window.emit('ready-to-show');
  await promise;
  detached(window);
  assert.equal(window.destroyed, false);
  window.webContents.emit('did-start-navigation');
  await promise;
});

for (const failure of ['closed', 'render-process-gone']) test(`first render rejects ${failure}, removes listeners and cannot be resurrected`, async () => {
  const window = guest();
  const promise = firstRender(window);
  (failure === 'closed' ? window : window.webContents).emit(failure);
  await assert.rejects(promise, /before first render/);
  window.emit('ready-to-show');
  await assert.rejects(promise);
  detached(window);
});

test('unrenderable guest times out, closes only itself and removes readiness listeners', async () => {
  const window = guest(), other = guest();
  const second = firstRender(other);
  const first = firstRender(window, 5);
  await assert.rejects(first);
  assert.equal(window.destroyed, true);
  assert.equal(other.destroyed, false);
  detached(window);
  other.emit('ready-to-show');
  await second;
  detached(other);
});
