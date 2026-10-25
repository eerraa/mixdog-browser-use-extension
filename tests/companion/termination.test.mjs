import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bounded } from '../../src/shared/async.mjs';
import { app, state } from './fixture.mjs';

const companion = new URL('../../src/companion/main.mjs', import.meta.url);
const fixture = new URL('./fixture.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === companion.href
      && ['electron', 'node:net', '../browser/host.mjs', '../shared/rpc.mjs'].includes(specifier)) {
      return { url: fixture, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

test('native revocation after gateway disconnect still closes host, peers and listener and exits', async () => {
  const channel = randomUUID(), key = randomBytes(32).toString('base64url');
  process.env.WB_CHANNEL = channel;
  process.env.WB_IPC_KEY = key;
  process.env.MIXDOG_PLUGIN_DATA = await mkdtemp(path.join(os.tmpdir(), 'companion-termination-'));
  await import(companion.href);
  await state.listening.promise;
  assert.doesNotMatch(app.userAgentFallback, /Electron\/|IndependentWindowsBrowser\//);
  state.listener.accept({});
  const gateway = state.peers[0];
  await gateway.handler('hello', { channel, key, role: 'gateway' });
  state.listener.accept({});
  const hook = state.peers[1];
  await hook.handler('hello', { channel, key, role: 'hook' });
  gateway.close();
  assert.doesNotThrow(() => state.host.options.onRevokeConnection());
  assert.equal(await bounded(state.exited.promise, 1000, 'Companion revocation'), 0);
  assert.equal(state.host.closed, true, 'A failed flush must not skip browser cleanup');
  assert.equal(hook.closed, true);
  assert.equal(state.listener.closed, true);
});
