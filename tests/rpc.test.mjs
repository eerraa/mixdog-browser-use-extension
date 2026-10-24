import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { RpcPeer } from '../src/rpc.mjs';

async function pair(t, handler, options) {
  const address = `\\\\.\\pipe\\independent-browser-test-${randomUUID()}`;
  let accept;
  const accepted = new Promise(resolve => { accept = resolve; });
  const server = net.createServer(socket => accept(new RpcPeer(socket, handler, options)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  const socket = net.createConnection(address);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const client = new RpcPeer(socket);
  const service = await accepted;
  t.after(async () => {
    client.close();
    service.close();
    await new Promise(resolve => server.close(resolve));
  });
  return { client, service, socket };
}

test('local RPC preserves Unicode and independent concurrent results', async t => {
  const { client } = await pair(t, async (method, params) => ({ method, ...params }));
  const values = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    client.request('echo', { i, text: '한글·日本語·🪟'.repeat(100) })));
  assert.deepEqual(values.map(v => v.i), Array.from({ length: 16 }, (_, i) => i));
  assert.ok(values.every(v => v.text === '한글·日本語·🪟'.repeat(100)));
});

test('cancellation reaches only its request and never reissues work', async t => {
  let started, calls = 0, cancelled = false;
  const ready = new Promise(resolve => { started = resolve; });
  const { client } = await pair(t, async (method, _params, signal) => {
    if (method === 'echo') return 'unrelated';
    calls++;
    started();
    return new Promise(resolve => signal.addEventListener('abort', () => {
      cancelled = true;
      resolve('late completion');
    }, { once: true }));
  });
  const controller = new AbortController();
  const first = client.request('work', {}, { signal: controller.signal });
  await ready;
  controller.abort(new Error('caller cancellation'));
  await assert.rejects(first, /caller cancellation/);
  assert.equal(await client.request('echo', {}), 'unrelated');
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test('transport closure aborts owned handlers and rejects pending calls without retry', async t => {
  let started, observed;
  const ready = new Promise(resolve => { started = resolve; });
  const stopped = new Promise(resolve => { observed = resolve; });
  let calls = 0;
  const { client, service } = await pair(t, async (_method, _params, signal) => {
    calls++;
    started();
    await new Promise(resolve => signal.addEventListener('abort', () => {
      observed();
      resolve();
    }, { once: true }));
    return null;
  });
  const request = client.request('work', {});
  await ready;
  service.close();
  await assert.rejects(request, /closed|lost/i);
  await stopped;
  assert.equal(calls, 1);
});

test('structured failures preserve actionable target evidence without changing it', async t => {
  const candidates = [{ ref: 'fresh-ref', name: 'Save', frameId: 'frame-1' }];
  const { client } = await pair(t, () => {
    throw Object.assign(new Error('Ambiguous target'), {
      code: 'AMBIGUOUS_TARGET', snapshotId: 'fresh-snapshot', candidates,
    });
  });
  await assert.rejects(client.request('work', {}), error =>
    error.code === 'AMBIGUOUS_TARGET' && error.snapshotId === 'fresh-snapshot'
      && JSON.stringify(error.candidates) === JSON.stringify(candidates));
});

test('oversized input is rejected before service dispatch', async t => {
  let calls = 0;
  const { client, socket } = await pair(t, () => { calls++; return null; }, { maxFrameBytes: 256 });
  const closed = new Promise(resolve => client.once('closed', resolve));
  socket.write(JSON.stringify({ id: 'large', method: 'work', params: { data: 'x'.repeat(1000) } }) + '\n');
  await closed;
  assert.equal(calls, 0);
});
