import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionBroker } from '../../src/core/permissions.mjs';

const request = (requesterId = 'a', scope = { deviceId: 'device-1', access: ['read'] }) => ({
  requesterId, documentId: `document-${requesterId}`, origin: 'https://site.test',
  embeddingOrigin: 'https://host.test', kind: 'hid', scope,
});
const setup = (extra = {}) => {
  const prompts = [], dismissed = [];
  const broker = new PermissionBroker({
    connectionId: 'connection-1', verifyRequest: () => true,
    onPrompt: prompt => prompts.push(prompt), onDismiss: id => dismissed.push(id),
    revokePermission: async () => true, ...extra,
  });
  return { broker, prompts, dismissed };
};

test('shared prompt survives one abort or navigation; callbacks settle independently', async () => {
  const { broker, prompts, dismissed } = setup();
  const controller = new AbortController();
  const a = broker.request(request('a'), { signal: controller.signal });
  const b = broker.request(request('b'));
  const c = broker.request(request('c'));
  assert.equal(prompts.length, 1);
  controller.abort();
  assert.equal((await a).status, 'withdrawn');
  broker.withdraw('c', 'document-c');
  assert.equal((await c).status, 'withdrawn');
  assert.equal(dismissed.length, 0);
  assert.equal(broker.decide(prompts[0].id, 'approve'), true);
  assert.equal((await b).status, 'granted');
  assert.equal(broker.decide(prompts[0].id, 'deny'), false);
});

test('deny and human cancel are terminal for the connection', async () => {
  for (const decision of ['deny', 'cancel']) {
    const { broker, prompts } = setup();
    const first = broker.request(request());
    broker.decide(prompts[0].id, decision);
    assert.equal((await first).status, decision === 'deny' ? 'denied' : 'cancelled');
    assert.equal((await broker.request(request('b'))).status, decision === 'deny' ? 'denied' : 'cancelled');
    assert.equal(prompts.length, 1);
  }
});

test('only normalized identical scope reuses approval; new exact device asks again', async () => {
  const { broker, prompts } = setup();
  const first = broker.request(request());
  broker.decide(prompts[0].id, 'approve');
  assert.equal((await first).status, 'granted');
  assert.equal((await broker.request(request('b', { access: ['read'], deviceId: 'device-1' }))).status, 'granted');
  assert.equal(prompts.length, 1);
  const other = broker.request(request('c', { deviceId: 'device-2', access: ['read'] }));
  assert.equal(prompts.length, 2);
  broker.decide(prompts[1].id, 'approve');
  assert.equal((await other).status, 'granted');
});

test('unverified identity, origin, document and device scope fail closed', async () => {
  const { broker, prompts } = setup({ verifyRequest: value => value.requesterId !== 'untrusted' });
  for (const value of [
    request('untrusted'), { ...request(), documentId: '' },
    { ...request(), origin: 'null' }, { ...request(), embeddingOrigin: '' },
    request('a', { access: ['read'] }),
    { ...request(), scope: { deviceId: 'device-1', extra: undefined } },
  ]) {
    const result = await broker.request(value);
    assert.equal(result.status, 'denied');
    assert.ok(result.reason);
  }
  assert.equal(prompts.length, 0);
});

test('revoke blocks synchronously, cancels pending members, awaits actual revocation', async () => {
  let finish;
  const { broker, prompts } = setup({
    revokePermission: () => new Promise(resolve => { finish = resolve; }),
  });
  const pending = broker.request(request());
  const revocation = broker.revoke(request());
  assert.equal((await pending).status, 'blocked');
  assert.equal((await broker.request(request('b'))).status, 'blocked');
  assert.equal(broker.decide(prompts[0].id, 'approve'), false);
  let complete = false;
  revocation.then(() => { complete = true; });
  await Promise.resolve();
  assert.equal(complete, false);
  finish(true);
  assert.deepEqual(await revocation, { status: 'revoked', confirmed: true });
  assert.equal((await broker.request(request())).status, 'blocked');
});

test('failed or unknown real revoke never reports confirmation or restores admission', async () => {
  for (const revokePermission of [async () => { throw new Error('device failure'); }, async () => undefined, async () => false]) {
    const { broker, prompts } = setup({ revokePermission });
    const first = broker.request(request());
    broker.decide(prompts[0].id, 'approve');
    const authorization = await first;
    const outcome = await broker.revoke(request());
    assert.equal(outcome.status, 'not-confirmed');
    assert.equal(outcome.confirmed, false);
    assert.equal(authorization.signal.aborted, true);
    assert.equal((await broker.request(request())).status, 'blocked');
    assert.equal(prompts.length, 1);
  }
});

test('revocation cancels authorized work before the real adapter and handles reentrant close', async () => {
  let realCalls = 0;
  const { broker, prompts } = setup({ revokePermission: async () => { realCalls++; return true; } });
  const pending = broker.request(request());
  broker.decide(prompts[0].id, 'approve');
  const granted = await pending;
  granted.signal.addEventListener('abort', () => broker.close());
  const outcome = await broker.revoke(request());
  assert.equal(outcome.confirmed, false);
  assert.equal(realCalls, 0);
});

test('closing settles prompts and in-flight revoke, destroys grants, and rejects late decisions', async () => {
  const { broker, prompts } = setup({ revokePermission: () => new Promise(() => {}) });
  const granted = broker.request(request());
  broker.decide(prompts[0].id, 'approve');
  await granted;
  const pending = broker.request(request('b', { deviceId: 'device-2' }));
  const revoke = broker.revoke(request());
  broker.close();
  assert.equal((await pending).status, 'closed');
  assert.equal((await revoke).confirmed, false);
  assert.equal((await broker.request(request())).status, 'closed');
  assert.equal(broker.decide(prompts[1].id, 'approve'), false);
  const fresh = setup();
  const newPending = fresh.broker.request(request());
  assert.equal(fresh.prompts.length, 1);
  fresh.broker.close();
  assert.equal((await newPending).status, 'closed');
});

test('last withdrawal dismisses only that prompt without recording human cancel', async () => {
  const { broker, prompts, dismissed } = setup();
  const pending = broker.request(request());
  broker.withdraw('a', 'wrong-document');
  assert.equal(dismissed.length, 0);
  broker.withdraw('a', 'document-a');
  assert.equal((await pending).status, 'withdrawn');
  assert.deepEqual(dismissed, [prompts[0].id]);
  const again = broker.request(request());
  assert.equal(prompts.length, 2);
  broker.close();
  assert.equal((await again).status, 'closed');
});
