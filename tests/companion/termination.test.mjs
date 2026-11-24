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
const companionServer = new URL('../../src/companion/server.mjs', import.meta.url);
const fixture = new URL('./fixture.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL === companion.href || context.parentURL === companionServer.href)
      && ['electron', 'node:net', '../browser/host.mjs', '../shared/rpc.mjs'].includes(specifier)) {
      return { url: fixture, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

test('companion authenticates single gateway role, issues fresh per-call ids, and closes cleanly on native revocation', async () => {
  const channel = randomUUID(), key = randomBytes(32).toString('base64url');
  process.env.WB_CHANNEL = channel;
  process.env.WB_IPC_KEY = key;
  process.env.WB_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'companion-termination-'));
  await import(companion.href);
  await state.listening.promise;
  assert.doesNotMatch(app.userAgentFallback, /Electron\/|IndependentWindowsBrowser\//);

  // Hook role is no longer accepted on companion hello.
  state.listener.accept({});
  const rejected = state.peers[0];
  await assert.rejects(rejected.handler('hello', { channel, key, role: 'hook' }), /Unauthenticated local connection/);

  // Single gateway peer authenticates with constant-time key + channel.
  state.listener.accept({});
  const gateway = state.peers[1];
  await gateway.handler('hello', { channel, key, role: 'gateway' });

  // A second concurrent gateway connection is rejected.
  state.listener.accept({});
  const secondGateway = state.peers[2];
  await assert.rejects(secondGateway.handler('hello', { channel, key, role: 'gateway' }), /Gateway already connected/);

  // Each call gets a fresh callId, strips _channel/_lease, and shares the connection abort signal.
  const first = await gateway.handler('call', { args: { action: 'list_tabs', _channel: channel, _lease: 'ignored' } });
  const second = await gateway.handler('call', { args: { action: 'list_tabs', _channel: channel } });
  assert.notEqual(first.callId, second.callId, 'every call must receive a distinct callId');
  assert.deepEqual(state.host.calls[0].body, { action: 'list_tabs' });
  assert.equal(state.host.calls[0].caller.sessionId, 'mcp-connection');
  assert.equal(state.host.calls[0].caller.signal.aborted, false);
  assert.doesNotThrow(() => state.host.calls[0].caller.assertLive());

  gateway.close();
  assert.doesNotThrow(() => state.host.options.onRevokeConnection());
  assert.equal(state.host.calls[0].caller.signal.aborted, true, 'revocation aborts connection-scoped caller signal');
  assert.throws(() => state.host.calls[0].caller.assertLive(), /terminating|ended/i);
  assert.equal(await bounded(state.exited.promise, 1000, 'Companion revocation'), 0);
  assert.equal(state.host.closed, true, 'A failed flush must not skip browser cleanup');
  assert.equal(secondGateway.closed, true);
  assert.equal(state.listener.closed, true);
});
