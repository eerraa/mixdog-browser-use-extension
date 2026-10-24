import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { FrameDriver } from '../../src/browser/frames.mjs';
import { bounded } from '../../src/async.mjs';
import { BROWSER_STABLE_RECT } from '../../build/upstream.mjs';

function fixture() {
  const changes = [], sent = [];
  const debuggerAPI = new EventEmitter();
  debuggerAPI.attach = () => {};
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    return {};
  };
  const page = { window: { webContents: { debugger: debuggerAPI } }, connected: true };
  const driver = new FrameDriver(page, reason => changes.push(reason));
  return { driver, page, changes, sent, debuggerAPI };
}

test('stable geometry measurement never scrolls the target or its ancestors', async () => {
  const rect = { left: 20, top: 30, width: 80, height: 40 };
  let samples = 0;
  const view = { setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout };
  const target = {
    ownerDocument: { defaultView: view },
    getBoundingClientRect() { samples++; return rect; },
    scrollIntoView() { throw new Error('Measurement must not mutate scroll'); },
  };
  const ancestor = { scrollIntoView() { throw new Error('Measurement must not scroll an ancestor'); } };
  const measure = vm.runInNewContext(`(${BROWSER_STABLE_RECT})`);
  assert.deepEqual(await measure(target, [ancestor]), rect);
  assert.equal(samples, 2);
});

test('preparation scrolls the pinned node and frame ancestors under the input guard', async () => {
  const { driver, sent, debuggerAPI } = fixture();
  const parent = { id: 'root', contextId: 1 };
  const child = { id: 'child', parentId: 'root', contextId: 2, sessionId: 'child-cdp' };
  driver.frames.set(parent.id, parent);
  driver.frames.set(child.id, child);
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 7 };
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 100, 0, 100, 100, 0, 100] } };
    return {};
  };
  driver.callOn = async () => true;
  let guarded = 0, prepared = 0;
  driver.beforeInputDispatch = () => { guarded++; };
  await driver.prepare(child, 'pinned-object', () => { prepared++; });
  assert.equal(guarded, 2);
  assert.equal(prepared, 2);
  assert.deepEqual(sent.filter(value => value.method === 'DOM.scrollIntoViewIfNeeded').map(value => ({
    params: value.params, sessionId: value.sessionId,
  })), [
    { params: { objectId: 'pinned-object' }, sessionId: 'child-cdp' },
    { params: { backendNodeId: 7 }, sessionId: undefined },
  ]);
});

test('fresh refs follow the pinned DOM object, never an identical replacement', async () => {
  const { driver } = fixture();
  const document = {};
  const target = { ownerDocument: document, isConnected: true };
  const replacement = { ownerDocument: document, isConnected: true };
  const refs = new Map([['fresh-ref', { element: target }]]);
  driver.callOn = async (_frame, _objectId, source) =>
    vm.runInNewContext(`(${source})`, { document, __mixdogAgentSnapshot: { refs } }).call(target);
  assert.equal(await driver.refForObject({}, 'pinned-object'), 'fresh-ref');
  refs.set('fresh-ref', { element: replacement });
  await assert.rejects(driver.refForObject({}, 'pinned-object'), /replaced|absent/);
});

test('main-target binding events with Electron empty session ID invalidate authoritative observations', () => {
  const { driver, changes } = fixture();
  driver.frames.set('root', { contextId: 42, sessionId: undefined });
  driver.onMessage('Runtime.bindingCalled', { name: '__independentChanged', executionContextId: 42 }, '');
  assert.deepEqual(changes, ['document-revision']);
  driver.onMessage('Runtime.bindingCalled', { name: '__independentChanged', executionContextId: 99 }, '');
  assert.equal(changes.length, 1);
});

test('user evaluation gets a separate isolated world without universal access or fake user activation', async () => {
  const { driver, sent, debuggerAPI } = fixture();
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 900 };
    return { result: { value: 'no private refs' } };
  };
  const frame = { id: 'child', contextId: 42, sessionId: 'oopif' };
  assert.equal(await driver.evaluateUser(frame, 'typeof __mixdogAgentSnapshot'), 'no private refs');
  assert.notEqual(sent[0].params.worldName, driver.worldName);
  assert.equal(sent[0].params.grantUniveralAccess, false);
  assert.equal(sent[1].params.contextId, 900);
  assert.equal(sent[1].params.userGesture, undefined);
  assert.equal(sent[1].sessionId, 'oopif');
});

test('detached child target drops documents and unblocks only that CDP session', () => {
  const { driver, changes } = fixture();
  driver.sessions.set('gone', 'child');
  driver.frames.set('root', { sessionId: undefined });
  driver.frames.set('child', { sessionId: 'gone' });
  driver.onMessage('Target.detachedFromTarget', { sessionId: 'gone' });
  assert.equal(driver.frames.has('child'), false);
  assert.equal(driver.frames.has('root'), true);
  assert.equal(driver.sessions.has('gone'), false);
  assert.deepEqual(changes, ['frame-detached']);
});

test('worker startup is session-scoped, recursive and never receives iframe authority or native-mode commands', async () => {
  for (const type of ['worker', 'shared_worker', 'service_worker']) {
    const { driver, sent } = fixture();
    const stopped = new AbortController();
    stopped.abort(new Error('actor stopped'));
    driver.actorSignal = stopped.signal;
    driver.onMessage('Target.attachedToTarget', {
      sessionId: type, targetInfo: { type, targetId: `${type}-target` }, waitingForDebugger: true,
    });
    await driver.waitForIdle();
    assert.deepEqual(sent.map(command => [command.method, command.sessionId]), [
      ['Target.setAutoAttach', type], ['Runtime.runIfWaitingForDebugger', type],
    ]);
    const policy = sent[0].params;
    assert.equal(policy.waitForDebuggerOnStart, true);
    assert.equal(policy.flatten, true);
    assert.deepEqual(policy.filter, [
      ...['iframe', 'worker', 'shared_worker', 'service_worker'].map(type => ({ type, exclude: false })),
      { exclude: true },
    ]);
    assert.equal(driver.sessions.has(type), false);
    assert.equal(driver.frames.size, 0);
    await driver.setNativeMode(true);
    assert.equal(sent.filter(command => command.method.startsWith('Page.')).length, 1);
    assert.equal(sent.at(-1).sessionId, undefined);
  }
});

test('iframe initialization still precedes startup release and worker descendants remain separate', async () => {
  const { driver, sent } = fixture();
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'frame', targetInfo: { type: 'iframe', targetId: 'child-frame' }, waitingForDebugger: true,
  });
  await driver.waitForIdle();
  assert.deepEqual(sent.map(command => command.method), [
    'Page.enable', 'Runtime.enable', 'DOM.enable', 'Page.setInterceptFileChooserDialog',
    'Runtime.addBinding', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger',
  ]);
  assert.equal(driver.sessions.get('frame'), 'child-frame');
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'parent-worker', targetInfo: { type: 'worker', targetId: 'parent' }, waitingForDebugger: true,
  }, 'frame');
  await driver.waitForIdle();
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'nested-worker', targetInfo: { type: 'worker', targetId: 'nested' }, waitingForDebugger: true,
  }, 'parent-worker');
  await driver.waitForIdle();
  assert.equal(sent.filter(command => command.method === 'Page.enable').length, 1);
  for (const id of ['parent-worker', 'nested-worker']) {
    assert.deepEqual(sent.filter(command => command.sessionId === id).map(command => command.method),
      ['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
  }
  driver.onMessage('Target.detachedFromTarget', { sessionId: 'frame' });
  assert.equal(driver.sessions.has('frame'), false);
  assert.equal(driver.targets.has('parent-worker'), true,
    'A parent event is not native termination proof for another session');
  driver.onMessage('Target.detachedFromTarget', { sessionId: 'parent-worker' });
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'late-worker', targetInfo: { type: 'worker', targetId: 'late' }, waitingForDebugger: true,
  }, 'parent-worker');
  assert.equal(driver.targets.has('nested-worker'), true);
  driver.onMessage('Target.detachedFromTarget', { sessionId: 'nested-worker' });
  assert.equal(driver.targets.size, 0);
  assert.equal(driver.pending.size, 0);
  assert.equal(sent.some(command => command.sessionId === 'late-worker'), false);
});

test('failed worker setup attempts one owned startup release and surfaces both failures', async () => {
  const { driver, debuggerAPI, page, sent } = fixture();
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    throw new Error(method === 'Target.setAutoAttach' ? 'setup rejected' : 'release rejected');
  };
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'target' }, waitingForDebugger: true,
  });
  await driver.waitForIdle();
  assert.match(page.frameFailure, /Worker target initialization failed/);
  const failure = driver.targets.get('worker').failure;
  assert.deepEqual(failure.errors.map(error => error.message), ['setup rejected', 'release rejected']);
  assert.deepEqual(sent.map(command => command.method),
    ['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
  await assert.rejects(driver.refresh(), error => error.code === 'FRAME_UNAVAILABLE');
});

test('failed iframe initialization never becomes an uninitialized iframe startup release', async () => {
  const { driver, debuggerAPI, page, sent } = fixture();
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    throw new Error('iframe setup rejected');
  };
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'frame', targetInfo: { type: 'iframe', targetId: 'target' }, waitingForDebugger: true,
  });
  await driver.waitForIdle();
  assert.match(page.frameFailure, /Child target initialization failed/);
  assert.equal(sent.some(command => command.method === 'Runtime.runIfWaitingForDebugger'), false);
});

test('target startup actual replies remain fenced after actor cancellation', async () => {
  const { driver, debuggerAPI, sent } = fixture();
  let finish;
  const release = new Promise(resolve => { finish = resolve; });
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    return method === 'Runtime.runIfWaitingForDebugger' ? release : {};
  };
  const actor = new AbortController();
  driver.actorSignal = actor.signal;
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'target' }, waitingForDebugger: true,
  });
  await new Promise(resolve => setImmediate(resolve));
  actor.abort(new Error('actor cancelled'));
  let idle = false;
  const fence = driver.waitForIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);
  assert.equal(sent.filter(command => command.method === 'Runtime.runIfWaitingForDebugger').length, 1);
  finish({});
  await fence;
  assert.equal(idle, true);
});

test('the final native-reveal guard catches startup attached after the earlier idle check', async () => {
  const { driver, debuggerAPI } = fixture();
  let finish;
  const release = new Promise(resolve => { finish = resolve; });
  debuggerAPI.sendCommand = async method => method === 'Runtime.runIfWaitingForDebugger' ? release : {};
  await driver.waitForIdle();
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'target' }, waitingForDebugger: true,
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    await driver.setNativeMode(true);
    assert.throws(() => driver.assertNoDialogCleanup(), error => error.code === 'TARGET_STARTUP_PENDING');
    await assert.rejects(driver.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }),
      error => error.code === 'TARGET_STARTUP_PENDING');
  } finally {
    finish({});
    await driver.waitForIdle();
  }
  assert.doesNotThrow(() => driver.assertNoDialogCleanup());
});

test('owned worker setup and startup release bypass cancelled execution without releasing its actual cleanup fence', async () => {
  const { driver, debuggerAPI, sent } = fixture();
  let finishEvaluation, finishRelease;
  const evaluation = new Promise(resolve => { finishEvaluation = resolve; });
  const release = new Promise(resolve => { finishRelease = resolve; });
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === 'Runtime.evaluate') return evaluation;
    if (method === 'Runtime.runIfWaitingForDebugger') return release;
    return {};
  };
  const actor = new AbortController();
  driver.actorSignal = actor.signal;
  const execution = driver.send('Runtime.evaluate', { expression: 'waiting for worker' });
  actor.abort(new Error('actor cancelled'));
  await assert.rejects(execution, /actor cancelled/);
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'target' }, waitingForDebugger: true,
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.filter(command => command.sessionId === 'worker'
      && command.method === 'Target.setAutoAttach').length, 1);
    assert.equal(sent.filter(command => command.sessionId === 'worker'
      && command.method === 'Runtime.runIfWaitingForDebugger').length, 1);
    let idle = false;
    const fence = driver.waitForIdle().then(() => { idle = true; });
    finishEvaluation({ result: { value: null } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(idle, false, 'The actual startup reply remains fenced after execution settles');
    finishRelease({});
    await fence;
    assert.equal(idle, true);
  } finally {
    finishEvaluation({ result: { value: null } });
    finishRelease({});
    driver.onMessage('Target.detachedFromTarget', { sessionId: 'worker' });
    await driver.waitForIdle();
  }
});

test('caller timeout cannot release an unsettled worker configuration or its actual startup reply', async () => {
  const { driver, debuggerAPI, sent } = fixture();
  let finishSetup, finishRelease;
  const setup = new Promise(resolve => { finishSetup = resolve; });
  const release = new Promise(resolve => { finishRelease = resolve; });
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    return method === 'Target.setAutoAttach' ? setup : release;
  };
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'target' }, waitingForDebugger: true,
  });
  try {
    await assert.rejects(bounded(driver.waitForIdle(), 5, 'fixture setup consumer'), /timed out/);
    assert.throws(() => driver.assertNoDialogCleanup(), error => error.code === 'TARGET_STARTUP_PENDING');
    assert.equal(sent.some(command => command.method === 'Runtime.runIfWaitingForDebugger'), false);
    finishSetup({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.filter(command => command.method === 'Runtime.runIfWaitingForDebugger').length, 1);
    await assert.rejects(bounded(driver.waitForIdle(), 5, 'fixture release consumer'), /timed out/);
    assert.throws(() => driver.assertNoDialogCleanup(), error => error.code === 'TARGET_STARTUP_PENDING');
  } finally {
    finishSetup({});
    finishRelease({});
    await driver.waitForIdle();
  }
});

test('only native proof for the particular worker ends its raw startup fence', async () => {
  const { driver, debuggerAPI, page } = fixture();
  let finish;
  const reply = new Promise(resolve => { finish = resolve; });
  debuggerAPI.sendCommand = async (method, _params, sessionId) =>
    method === 'Runtime.runIfWaitingForDebugger' && sessionId === 'child' ? reply : {};
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'parent', targetInfo: { type: 'worker', targetId: 'parent-target' }, waitingForDebugger: true,
  });
  await driver.waitForIdle();
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'child', targetInfo: { type: 'worker', targetId: 'child-target' }, waitingForDebugger: true,
  }, 'parent');
  await new Promise(resolve => setImmediate(resolve));
  driver.onMessage('Target.detachedFromTarget', { sessionId: 'parent' });
  assert.throws(() => driver.assertNoDialogCleanup(), error => error.code === 'TARGET_STARTUP_PENDING');
  await assert.rejects(driver.reconnect(), error => error.code === 'TARGET_STARTUP_PENDING');
  driver.onMessage('Target.detachedFromTarget', { sessionId: 'child' });
  await driver.waitForIdle();
  assert.doesNotThrow(() => driver.assertNoDialogCleanup());
  assert.equal(page.frameFailure ?? null, null);
  finish({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.frameFailure ?? null, null);
});

test('detach or debugger replacement retires initialization without stale failure or late startup release', async () => {
  for (const transition of ['target-detached', 'debugger-detached', 'reconnect']) {
    const { driver, debuggerAPI, sent, page } = fixture();
    let finish;
    const setup = new Promise(resolve => { finish = resolve; });
    debuggerAPI.isAttached = () => false;
    debuggerAPI.sendCommand = async (method, params, sessionId) => {
      sent.push({ method, params, sessionId });
      return sessionId === 'old' ? setup : {};
    };
    driver.onMessage('Target.attachedToTarget', {
      sessionId: 'old', targetInfo: { type: 'worker', targetId: 'target' }, waitingForDebugger: true,
    });
    await new Promise(resolve => setImmediate(resolve));
    if (transition === 'target-detached') driver.onMessage('Target.detachedFromTarget', { sessionId: 'old' });
    else if (transition === 'debugger-detached') driver.detached();
    else {
      await assert.rejects(driver.reconnect(), error => error.code === 'TARGET_STARTUP_PENDING');
      driver.onMessage('Target.detachedFromTarget', { sessionId: 'old' });
      await driver.reconnect();
    }
    await driver.waitForIdle();
    finish({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(driver.pending.size, 0);
    assert.equal(driver.targets.has('old'), false);
    assert.equal(page.frameFailure ?? null, null);
    assert.equal(sent.some(command => command.sessionId === 'old'
      && command.method === 'Runtime.runIfWaitingForDebugger'), false);
  }
});

test('actual child content-box scaling and parent occlusion are checked before root input', async () => {
  const { driver } = fixture();
  const parent = { id: 'root', contextId: 1 };
  const child = { id: 'child', parentId: 'root', sessionId: 'oopif', contextId: 2 };
  driver.frames.set('root', parent);
  driver.frames.set('child', child);
  driver.checkpoint = async f => ({ width: f === child ? 200 : 1000, height: f === child ? 100 : 800 });
  driver.send = async method => {
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 7 };
    if (method === 'DOM.getBoxModel') return { model: { content: [100, 50, 500, 50, 500, 250, 100, 250] } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'iframe-owner' } };
    return {};
  };
  let checked;
  driver.callOn = async (_frame, _object, _fn, values) => { checked = values; return true; };
  assert.deepEqual(await driver.toRoot(child, { x: 25, y: 30 }), { x: 150, y: 110 });
  assert.deepEqual(checked, [150, 110]);
  driver.callOn = async () => false;
  await assert.rejects(driver.toRoot(child, { x: 25, y: 30 }), /occluded/);
});

test('nested same-target quads are normalized into the immediate parent before composition and hit testing', async () => {
  for (const scaled of [false, true]) {
    const { driver } = fixture();
    const root = { id: 'root', contextId: 1 };
    const outer = { id: 'outer', parentId: 'root', contextId: 2 };
    const inner = { id: 'inner', parentId: 'outer', contextId: 3 };
    for (const frame of [root, outer, inner]) driver.frames.set(frame.id, frame);
    const sizes = { root: [1000, 800], outer: [700, 500], inner: [400, 250] };
    driver.checkpoint = async frame => ({ width: sizes[frame.id][0], height: sizes[frame.id][1] });
    const quads = scaled ? {
      outer: [100, 100, 625, 100, 625, 475, 100, 475],
      inner: [137.5, 145, 377.5, 145, 377.5, 295, 137.5, 295],
    } : {
      outer: [100, 100, 800, 100, 800, 600, 100, 600],
      inner: [150, 160, 550, 160, 550, 410, 150, 410],
    };
    driver.send = async (method, params) => {
      if (method === 'DOM.getFrameOwner') return { backendNodeId: params.frameId };
      if (method === 'DOM.getBoxModel') return { model: { content: quads[params.backendNodeId] } };
      if (method === 'DOM.resolveNode') return { object: { objectId: params.backendNodeId } };
      return {};
    };
    const hits = [];
    driver.callOn = async (frame, _object, _fn, values) => { hits.push({ frame: frame.id, point: values }); return true; };
    const point = await driver.toRoot(inner, { x: 70, y: 40 });
    assert.deepEqual({ point, hits }, scaled ? {
      point: { x: 179.5, y: 169 },
      hits: [{ frame: 'outer', point: [106, 92] }, { frame: 'root', point: [179.5, 169] }],
    } : {
      point: { x: 220, y: 200 },
      hits: [{ frame: 'outer', point: [120, 100] }, { frame: 'root', point: [220, 200] }],
    });
  }
});

test('frame membership, property revisions and viewport changes reject old checkpoints', async () => {
  const { driver } = fixture();
  const root = { id: 'root' };
  const base = { documentId: 'd', revision: 0, width: 100, height: 100, x: 0, y: 0 };
  driver.refresh = async () => [root];
  driver.checkpoint = async () => ({ ...base });
  await driver.assertCheckpoints(new Map([['root', base]]));
  driver.checkpoint = async () => ({ ...base, revision: 1 });
  await assert.rejects(driver.assertCheckpoints(new Map([['root', base]])), /Stale/);
  driver.refresh = async () => [root, { id: 'new-frame' }];
  await assert.rejects(driver.assertCheckpoints(new Map([['root', base]])), /membership/);
});

test('rotated frames fail rather than falling back to guessed offsets', async () => {
  const { driver } = fixture();
  driver.frames.set('root', { id: 'root' });
  driver.send = async method => method === 'DOM.getFrameOwner' ? { backendNodeId: 1 }
    : { model: { content: [0, 0, 100, 20, 100, 100, 0, 80] } };
  await assert.rejects(driver.toRoot({ id: 'child', parentId: 'root' }, { x: 5, y: 5 }), /Rotated/);
});

test('even subpixel rotation/skew is rejected rather than approximated as an axis-aligned frame', async () => {
  const { driver } = fixture();
  driver.frames.set('root', { id: 'root' });
  driver.checkpoint = async () => ({ width: 100, height: 100 });
  driver.callOn = async () => true;
  driver.send = async method => {
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 1 };
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 100, .1, 99.9, 100.1, -.1, 100] } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'owner' } };
    return {};
  };
  await assert.rejects(driver.toRoot({ id: 'child', parentId: 'root' }, { x: 50, y: 50 }),
    error => error.code === 'UNSUPPORTED_FRAME_GEOMETRY');
});

test('silent property writes, shadow values and nested scroll advance revision without returning passwords', async () => {
  const { driver } = fixture();
  const password = { value: 'PRIVATE_PASSWORD', isConnected: true, children: [], scrollTop: 0 };
  const shadowInput = { value: 'one', isConnected: true, children: [], scrollTop: 0 };
  const context = vm.createContext({
    document: { documentElement: { children: [password], shadowRoot: { children: [shadowInput] } } },
    __independentState: { documentId: 'document', revision: 0, syncShadows: () => [password, shadowInput] },
    __independentChanged() {},
    innerWidth: 100, innerHeight: 80, scrollX: 0, scrollY: 0,
  });
  driver.evaluate = async (_frame, expression) => vm.runInContext(expression, context);
  const first = await driver.checkpoint({});
  assert.equal(first.revision, 0);
  assert.equal(JSON.stringify(first).includes('PRIVATE_PASSWORD'), false);
  password.value = 'NEW_PRIVATE_PASSWORD';
  assert.equal((await driver.checkpoint({})).revision, 1);
  shadowInput.value = 'two';
  assert.equal((await driver.checkpoint({})).revision, 2);
  shadowInput.scrollTop = 10;
  assert.equal((await driver.checkpoint({})).revision, 3);
  assert.equal((await driver.checkpoint({})).revision, 3);
});

test('actor cancellation reaches reused CDP termination and keeps actual cleanup fenced; releases bypass aborted actor', async () => {
  const { driver, sent, debuggerAPI } = fixture();
  let finish;
  const actual = new Promise(resolve => { finish = resolve; });
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === 'Runtime.evaluate') return actual;
    return {};
  };
  const controller = new AbortController();
  driver.actorSignal = controller.signal;
  const pending = driver.send('Runtime.evaluate', { expression: 'pending' });
  controller.abort(new Error('actor stopped'));
  await assert.rejects(pending, /actor stopped/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(s => s.method === 'Runtime.terminateExecution').length, 1);
  let idle = false;
  const fence = driver.cdp.waitForIdle(driver.wc).then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);
  await driver.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter' });
  assert.equal(sent.at(-1).params.type, 'keyUp');
  finish({ result: { value: 'late' } });
  await fence;
  assert.equal(idle, true);
});

test('dialog consumer timeout cannot release the actual response fence or authorize input', async () => {
  const { driver, sent, debuggerAPI } = fixture();
  let finish;
  const reply = new Promise(resolve => { finish = resolve; });
  debuggerAPI.sendCommand = (method, params) => {
    sent.push({ method, params });
    return method === 'Page.handleJavaScriptDialog' ? reply : Promise.resolve({});
  };
  const actual = driver.send('Page.handleJavaScriptDialog', { accept: true });
  await assert.rejects(bounded(actual, 5, 'fixture response consumer'), /timed out/);
  await assert.rejects(driver.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }),
    error => error.code === 'DIALOG_CLEANUP_PENDING');
  let idle = false;
  const fence = driver.waitForIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);
  assert.equal(sent.filter(command => command.method === 'Page.handleJavaScriptDialog').length, 1);
  assert.equal(sent.filter(command => command.method === 'Input.dispatchMouseEvent').length, 0);
  finish({});
  await fence;
  assert.equal(idle, true);
  await driver.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
  assert.equal(sent.filter(command => command.method === 'Input.dispatchMouseEvent').length, 1);
});

test('input dispatch rechecks its hiddenness/generation guard AFTER an earlier cleanup fence settles', async () => {
  const { driver, sent, debuggerAPI } = fixture();
  let finish;
  const actual = new Promise(resolve => { finish = resolve; });
  debuggerAPI.sendCommand = async (method, params) => {
    sent.push({ method, params });
    return method === 'Runtime.evaluate' ? actual : {};
  };
  const firstActor = new AbortController();
  driver.actorSignal = firstActor.signal;
  const previous = driver.send('Runtime.evaluate', { expression: 'pending' });
  firstActor.abort(new Error('cancel first'));
  await assert.rejects(previous);
  const currentActor = new AbortController();
  driver.actorSignal = currentActor.signal;
  let hidden = true;
  driver.beforeInputDispatch = () => { if (!hidden) throw new Error('guest exposed or generation changed'); };
  const input = driver.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
  hidden = false;
  finish({ result: { value: null } });
  await assert.rejects(input, /guest exposed/);
  assert.equal(sent.filter(s => s.method === 'Input.dispatchMouseEvent').length, 0);
});

test('redundant resize notifications do not invent revisions; real viewport changes including round trips remain stale', async () => {
  const { driver } = fixture();
  const listeners = new Map(), reasons = [];
  let mutated;
  const context = vm.createContext({
    document: { documentElement: { children: [] } },
    innerWidth: 100, innerHeight: 80, devicePixelRatio: 1, scrollX: 0, scrollY: 0,
    MutationObserver: class {
      constructor(callback) { mutated = callback; }
      observe() {}
    },
    addEventListener(name, handler) { listeners.set(name, handler); },
    __independentChanged(reason) { reasons.push(reason); },
  });
  driver.send = async method => method === 'Page.getFrameTree'
    ? { frameTree: { frame: { id: 'root', url: 'http://fixture.invalid/' } } }
    : { executionContextId: 1 };
  driver.evaluate = async (_frame, expression) => vm.runInContext(expression, context);
  await driver.refresh();
  const initial = await driver.checkpoint(driver.frames.get('root'));
  listeners.get('resize')();
  const duplicate = await driver.checkpoint(driver.frames.get('root'));
  assert.equal(duplicate.revision, initial.revision, 'Unchanged geometry is the same viewport, not a stale observation');
  context.innerWidth = 101;
  listeners.get('resize')();
  context.innerWidth = 100;
  listeners.get('resize')();
  assert.equal((await driver.checkpoint(driver.frames.get('root'))).revision, initial.revision + 2);
  context.devicePixelRatio = 2;
  listeners.get('resize')();
  mutated();
  listeners.get('scroll')();
  assert.equal((await driver.checkpoint(driver.frames.get('root'))).revision, initial.revision + 5);
  assert.deepEqual(reasons, ['resize', 'resize', 'resize', 'mutation', 'scroll']);
});
