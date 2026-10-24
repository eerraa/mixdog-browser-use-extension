import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRequests } from '../../src/browser/requests.mjs';

const actor = sessionId => {
  const controller = new AbortController();
  return {
    controller,
    caller: { sessionId, signal: controller.signal, assertLive() { controller.signal.throwIfAborted(); } },
  };
};
function fixture() {
  let time = 1000, valid = true, dispatched = 0, withdrawn = 0;
  const registry = new BrowserRequests({ now: () => time, ttlMs: 1000 });
  const { caller, controller } = actor('owner');
  const page = { id: 'page', owner: 'owner' };
  const record = registry.create({
    page, caller, kind: 'hid', context: { origin: 'https://app.invalid' },
    options: [{ label: 'Fixture keyboard', metadata: { serial: 'A' }, value: 'exact-native-device' }],
    isCurrent: () => valid,
    validate: (_response, value) => value,
    respond: async value => { dispatched++; return { resolution: 'selected', value }; },
    withdraw: () => { withdrawn++; },
  });
  return {
    registry, caller, controller, page, record,
    state: () => ({ dispatched, withdrawn }),
    expire: () => { time = 2001; },
    invalidate: () => { valid = false; },
  };
}

test('browser-generated refs resolve one exact option once, without exposing internal authority', async () => {
  const f = fixture();
  try {
    const [request] = f.registry.list(f.page, f.caller);
    assert.equal(request.kind, 'hid');
    assert.equal(request.options[0].metadata.serial, 'A');
    assert.equal(Object.hasOwn(request.options[0], 'value'), false);
    request.options[0].metadata.serial = 'forged';
    assert.equal(f.registry.list(f.page, f.caller)[0].options[0].metadata.serial, 'A');
    let guarded = 0;
    const result = await f.registry.respond(f.page, f.caller, request.requestRef,
      { optionRef: request.options[0].optionRef }, () => { guarded++; });
    assert.deepEqual(result, { resolution: 'selected', value: 'exact-native-device' });
    assert.equal(guarded, 1);
    assert.equal(f.state().dispatched, 1);
    await assert.rejects(f.registry.respond(f.page, f.caller, request.requestRef,
      { optionRef: request.options[0].optionRef }, () => {}), /no longer pending/);
  } finally { f.registry.close(); }
});

test('foreign pages/generations and fabricated options cannot resolve or cancel another request', async () => {
  const f = fixture();
  try {
    const [request] = f.registry.list(f.page, f.caller);
    const other = actor('owner').caller;
    for (const [page, caller, response] of [
      [f.page, other, { optionRef: request.options[0].optionRef }],
      [{ ...f.page }, f.caller, { cancel: true }],
      [f.page, f.caller, { optionRef: 'fabricated-option' }],
      [f.page, f.caller, { approved: true }],
    ]) await assert.rejects(f.registry.respond(page, caller, request.requestRef, response, () => {}));
    assert.deepEqual(f.state(), { dispatched: 0, withdrawn: 0 });
    assert.equal(f.registry.list(f.page, f.caller).length, 1);
  } finally { f.registry.close(); }
});

test('option revisions invalidate old refs even when validation was already awaiting', async () => {
  const f = fixture();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  try {
    const [before] = f.registry.list(f.page, f.caller);
    f.record.validate = async (_response, value) => { await wait; return value; };
    const response = f.registry.respond(f.page, f.caller, before.requestRef,
      { optionRef: before.options[0].optionRef }, () => {});
    f.registry.replaceOptions(f.record, [{ label: 'Updated', metadata: { serial: 'B' }, value: 'new-native-device' }]);
    release();
    await assert.rejects(response, /options changed/);
    const [after] = f.registry.list(f.page, f.caller);
    assert.equal(after.revision, before.revision + 1);
    assert.notEqual(after.options[0].optionRef, before.options[0].optionRef);
    assert.equal(f.state().dispatched, 0);
  } finally { release(); f.registry.close(); }
});

test('caller end, document change, expiry and closure withdraw once and never revive old refs', async () => {
  for (const condition of ['caller', 'document', 'expiry', 'close']) {
    const f = fixture();
    const [request] = f.registry.list(f.page, f.caller);
    if (condition === 'caller') f.controller.abort(new Error('Caller ended'));
    else if (condition === 'document') f.invalidate();
    else if (condition === 'expiry') f.expire();
    else f.registry.close();
    assert.equal(f.registry.list(f.page, f.caller).length, 0);
    assert.deepEqual(f.state(), { dispatched: 0, withdrawn: 1 });
    await assert.rejects(f.registry.respond(f.page, f.caller, request.requestRef,
      { optionRef: request.options[0].optionRef }, () => {}));
    f.registry.close();
    assert.equal(f.state().withdrawn, 1);
  }
});
