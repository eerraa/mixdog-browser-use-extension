import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { FrameDriver, INPUT_BINDING } from '../../src/browser/frames.mjs';
import { DEVTOOLS_LIMITS, DevToolsRecorder } from '../../src/browser/devtools.mjs';
import { bounded } from '../../src/shared/async.mjs';
import { BROWSER_STABLE_RECT } from '../../src/browser/perception/target-point.mjs';

test('page code checks every same-origin frame for a filled secret; a same-origin frame that cannot be checked counts', async () => {
  const { driver, debuggerAPI } = fixture();
  const present = new Map([[7, false], [8, false], [9, true]]);
  debuggerAPI.sendCommand = async (_method, params) => ({ result: { value: { present: present.get(params.contextId) } } });
  driver.frames.set('root', { id: 'root', contextId: 7, origin: 'https://app.test' });
  driver.frames.set('login', { id: 'login', parentId: 'root', contextId: 9, origin: 'https://app.test' });
  driver.frames.set('ads', { id: 'ads', parentId: 'root', contextId: 8, origin: 'https://ads.test' });
  assert.equal(await driver.sensitivePresent('https://app.test', false), true, 'a same-origin login iframe holds a password');
  assert.equal(await driver.sensitivePresent('https://ads.test', false), false, 'cross-origin documents are not reachable');
  driver.frames.set('capped', { id: 'capped', parentId: 'root', origin: 'https://ads.test', capped: true });
  assert.equal(await driver.sensitivePresent('https://ads.test', false), true, 'a same-origin frame without a walker counts');
});

test('trusted page input is the agent\'s only when a dispatched press or key accounts for it, once and briefly', () => {
  const { driver, page } = fixture();
  const tripped = [];
  page.onTrustedInput = type => tripped.push(type);
  const event = type => driver.onMessage('Runtime.bindingCalled', { name: INPUT_BINDING, payload: type }, '');
  driver.expectInput('pointerdown');
  event('pointerdown');
  event('pointerdown');
  assert.deepEqual(tripped, ['pointerdown'], 'one press accounts for one pointerdown, in flight or not');
  driver.settleCredit(driver.expectInput('keydown'));
  event('pointerdown');
  event('keydown');
  assert.deepEqual(tripped, ['pointerdown', 'pointerdown'], 'a key credit never covers a press');
  const late = driver.expectInput('keydown');
  late.until = Date.now() - 1;
  event('keydown');
  assert.deepEqual(tripped, ['pointerdown', 'pointerdown', 'keydown'], 'a credit lapses after its command returned');
});

test('a trusted picker value change is the agent\'s only while one of its commands is in flight or just returned', () => {
  const { driver, page } = fixture();
  const tripped = [];
  page.onTrustedInput = type => tripped.push(type);
  const event = type => driver.onMessage('Runtime.bindingCalled', { name: INPUT_BINDING, payload: type }, '');
  event('value');
  assert.deepEqual(tripped, ['value'], 'a value change with no agent command is the person\'s');
  const command = driver.expectInput('value');
  driver.expectInput('keydown');
  event('value');
  event('value');
  event('keydown');
  assert.deepEqual(tripped, ['value'], 'one command accounts for every value change it causes and keeps its key credit');
  driver.settleCredit(command);
  event('value');
  assert.deepEqual(tripped, ['value'], 'still the agent\'s just after its command returned');
  command.until = Date.now() - 1;
  event('value');
  assert.deepEqual(tripped, ['value', 'value'], 'the value credit lapses like a press or key credit');
});

function fixture() {
  const changes = [], sent = [];
  const debuggerAPI = new EventEmitter();
  debuggerAPI.attach = () => {};
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    return {};
  };
  const page = { contents: { debugger: debuggerAPI }, connected: true };
  const driver = new FrameDriver(page, reason => changes.push(reason));
  // Tests place frames directly; the cached tree is current until an event.
  driver.treeDirty = false;
  return { driver, page, changes, sent, debuggerAPI };
}

test('frame presentation proves two animation frames and settles in the page when frames stop', async () => {
  const { driver, sent, debuggerAPI } = fixture();
  await assert.rejects(driver.presented(), error => error.code === 'STALE_FRAME');
  driver.frames.set('root', { id: 'root', contextId: 7 });
  for (const frames of [true, false]) {
    // Run the exact page expression in a page whose frames flow or stop.
    debuggerAPI.sendCommand = async (method, params, sessionId) => {
      sent.push({ method, params, sessionId });
      return { result: { value: await vm.runInNewContext(params.expression, {
        requestAnimationFrame: callback => { if (frames) queueMicrotask(callback); },
        setTimeout: callback => { if (!frames) queueMicrotask(callback); },
      }) } };
    };
    if (frames) await driver.presented();
    else await assert.rejects(driver.presented(), error => error.code === 'CAPTURE_FAILED');
    const { method, params } = sent.at(-1);
    assert.deepEqual([method, params.contextId, params.awaitPromise], ['Runtime.evaluate', 7, true]);
  }
});

test('first input to a document waits out paint holding of every local root on the target chain, once per document', async () => {
  const { driver, sent, debuggerAPI } = fixture();
  driver.frames.set('root', { id: 'root', contextId: 7, documentId: 'D1' });
  // An out-of-process iframe (its own session) is its own local root.
  driver.frames.set('child', { id: 'child', parentId: 'root', contextId: 8, documentId: 'D2', sessionId: 'S1' });
  driver.frames.set('inner', { id: 'inner', parentId: 'child', contextId: 10, documentId: 'D4', sessionId: 'S1' });
  // Run the exact page expression against a timeline without contentful paint.
  const timeline = { root: { now: 300, start: 50, fcp: false }, child: { now: 300, start: 280, fcp: true } };
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    const t = params.contextId === 7 ? timeline.root : timeline.child;
    return { result: { value: vm.runInNewContext(params.expression, { performance: {
      now: () => t.now,
      // A page mark named like a paint entry cannot satisfy the check.
      getEntriesByName: () => [{ name: 'first-contentful-paint', entryType: 'mark' }],
      getEntriesByType: type => (type === 'paint' ? (t.fcp ? [{ name: 'first-contentful-paint' }] : []) : [{ responseStart: t.start }]),
    } }) } };
  };
  const started = Date.now();
  await driver.inputReady(driver.frames.get('child'));
  const waited = Date.now() - started;
  // Root: no contentful paint, 250 ms after responseStart → wait the remaining 450 ms.
  assert.ok(waited >= 400 && waited < 1000, `waited ${waited} ms`);
  assert.deepEqual(sent.map(entry => entry.params.contextId).sort(), [7, 8]);
  sent.length = 0;
  await driver.inputReady(driver.frames.get('child'));
  assert.equal(sent.length, 0, 'a document past paint holding is not probed again');
  driver.frames.set('child', { id: 'child', parentId: 'root', contextId: 9, documentId: 'D3', sessionId: 'S1' });
  timeline.child.fcp = false; timeline.child.start = 0; timeline.child.now = 5000;
  await driver.inputReady(driver.frames.get('child'));
  assert.deepEqual(sent.map(entry => entry.params.contextId), [9], 'only the new document is probed');
});

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

test('walker ids resolve only in the document that issued them', async () => {
  const { driver, debuggerAPI } = fixture();
  const element = { localName: 'button' };
  const state = { documentId: 'D1', resolve: id => (id === 3 ? element : null), describe: id => (id === 3 ? { role: 'button', name: 'Go' } : null) };
  debuggerAPI.sendCommand = async (_method, params) => {
    // Run the exact page expression against a walker state.
    const value = vm.runInNewContext(params.expression, { __independentState: state });
    return params.returnByValue === false
      ? { result: value ? { type: 'object', objectId: 'node-3' } : { type: 'object', subtype: 'null' } }
      : { result: { value: JSON.parse(JSON.stringify(value)) } };
  };
  const frame = { id: 'root', contextId: 1 };
  assert.equal(await driver.resolveObject(frame, 3, 'D1'), 'node-3');
  await assert.rejects(driver.resolveObject(frame, 3, 'D2'), error => error.code === 'STALE_REF', 'ids restart in every document');
  await assert.rejects(driver.resolveObject(frame, 4, 'D1'), error => error.code === 'STALE_REF');
  assert.deepEqual(await driver.describe(frame, 3, 'D1'), { described: { role: 'button', name: 'Go' } });
  assert.deepEqual(await driver.describe(frame, 3, 'D2'), { stale: 'document' });
});

test('the frame tree is cached until a frame, target or walker-world event; other events change nothing', () => {
  const { driver, changes } = fixture();
  for (const [method, params, dirty] of [
    ['Runtime.consoleAPICalled', { type: 'log', args: [] }, false],
    ['Runtime.executionContextCreated', { context: { id: 5, name: 'page-world', auxData: { frameId: 'root' } } }, false],
    ['Page.navigatedWithinDocument', { frameId: 'root' }, false],
    ['Runtime.executionContextCreated', { context: { id: 6, name: driver.worldName, auxData: { frameId: 'root' } } }, true],
    ['Page.frameAttached', { frameId: 'child', parentFrameId: 'root' }, true],
    ['Page.frameNavigated', { frame: { id: 'root' } }, true],
  ]) {
    driver.treeDirty = false;
    driver.onMessage(method, params, '');
    assert.equal(driver.treeDirty, dirty, method);
  }
  assert.ok(!changes.includes('document-revision'), 'DOM changes never void anything');
});

test('snapshots run per frame in parallel; a subframe failure is reported in its entry, never thrown', async () => {
  const { driver, debuggerAPI } = fixture();
  const root = { id: 'root', contextId: 1 };
  const ad = { id: 'ad', parentId: 'root', contextId: 2, sessionId: 'oopif', url: 'https://ads.test/' };
  const broken = { id: 'broken', parentId: 'root', contextId: 3 };
  for (const frame of [root, ad, broken]) driver.frames.set(frame.id, frame);
  const checkpoint = { documentId: 'D', revision: 0, w: 100, h: 80, x: 0, y: 0, dpr: 1 };
  let inFlight = 0, overlapped = false;
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    if (method === 'Runtime.evaluate') {
      inFlight++;
      await new Promise(resolve => setImmediate(resolve));
      overlapped ||= inFlight > 1;
      inFlight--;
      if (params.contextId === 3) throw new Error('Cannot find context with specified id');
      const nodes = params.contextId === 1 ? [{ id: 9, k: 'f', r: 'iframe', n: '', b: [0, 0, 10, 10], vp: true, o: 0 }] : [];
      return { result: { value: { checkpoint, nodes, texts: [], gone: [], renamed: [], url: 'u', title: 't', scrollHeight: 80 } } };
    }
    if (method === 'DOM.getFrameOwner') return { backendNodeId: params.frameId === 'ad' ? 70 : 71 };
    if (method === 'DOM.resolveNode') return { object: { objectId: `owner-${params.backendNodeId}` } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: params.objectId === 'owner-70' ? 9 : 0 } };
    return {};
  };
  const frames = await driver.snapshot();
  assert.equal(overlapped, true, 'frames are captured concurrently');
  const byId = Object.fromEntries(frames.map(frame => [frame.frameId, frame]));
  assert.ok(byId.root.snapshot && byId.ad.snapshot);
  assert.deepEqual([byId.broken.snapshot, byId.broken.error], [null, 'FRAME_SNAPSHOT_FAILED']);
  assert.equal(byId.ad.ownerId, 9, 'the owner element is mapped to its walker id');
  assert.equal(byId.broken.ownerId, -1, 'an owner that exists but was not emitted marks its frame hidden');
});

test('user evaluation gets a separate isolated world without universal access or fake user activation', async () => {
  const { driver, sent, debuggerAPI } = fixture();
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 900 };
    return { result: { value: 'no private refs' } };
  };
  const frame = { id: 'child', contextId: 42, sessionId: 'oopif' };
  const contextId = await driver.evaluationContext(frame, 'isolated');
  assert.equal(await driver.evaluateUser(frame, 'typeof __independentState', 'isolated', contextId), 'no private refs');
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
    'Page.addScriptToEvaluateOnNewDocument', 'Runtime.addBinding', 'Emulation.setFocusEmulationEnabled', 'Target.setAutoAttach',
    'Runtime.runIfWaitingForDebugger',
  ]);
  const binding = sent.find(command => command.method === 'Runtime.addBinding');
  assert.deepEqual([binding.params.name, binding.params.executionContextName], [INPUT_BINDING, driver.worldName],
    'the trusted-input binding exists only in the walker world');
  const install = sent.find(command => command.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.deepEqual([install.sessionId, install.params.worldName], ['frame', driver.worldName], 'the walker runs only in its isolated world');
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
  assert.equal(sent.some(command => command.method === 'Runtime.runIfWaitingForDebugger'), false);
  // The failed iframe stays paused and is an unavailable frame; it never
  // blocks observing the page.
  assert.ok(!page.frameFailure);
  assert.ok(driver.targets.get('frame').failure);
  sent.length = 0;
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'root', url: 'http://a.test/' }, childFrames: [{ frame: { id: 'target', parentId: 'root', url: 'http://b.test/' } }] } };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId === 'root' ? 5 : 6 };
    if (method === 'Runtime.evaluate') return { result: { value: true } };
    return {};
  };
  driver.treeDirty = true;
  const frames = await driver.refresh();
  assert.deepEqual(frames.map(frame => [frame.id, !!frame.unavailable]).sort(), [['root', false], ['target', true]]);
  assert.equal(sent.filter(command => command.sessionId === 'frame').length, 0, 'a failed session is never used');
  await assert.rejects(driver.evaluate(frames.find(frame => frame.id === 'target'), '1'), error => error.code === 'FRAME_UNAVAILABLE',
    'an unavailable frame is never evaluated (no context id would mean the page main world)');
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
  driver.viewport = async f => ({ w: f === child ? 200 : 1000, h: f === child ? 100 : 800 });
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
    driver.viewport = async frame => ({ w: sizes[frame.id][0], h: sizes[frame.id][1] });
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
  driver.viewport = async () => ({ w: 100, h: 100 });
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

test('refresh rebuilds the tree once per change, installs the walker in each frame and reuses the cache', async () => {
  const { driver } = fixture();
  const commands = [];
  driver.send = async (method, params, sessionId) => {
    commands.push(method);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: 'http://fixture.invalid/' }, childFrames: [{ frame: { id: 'child', parentId: 'root', url: 'about:blank' } }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId === 'root' ? 1 : 2 };
    return { result: { value: true } };
  };
  driver.treeDirty = true;
  const [first, second] = await Promise.all([driver.refresh(), driver.refresh()]);
  assert.deepEqual([first.length, second.length], [2, 2]);
  assert.equal(commands.filter(method => method === 'Page.getFrameTree').length, 1, 'concurrent refreshes share one rebuild');
  assert.equal(commands.filter(method => method === 'Runtime.evaluate').length, 2, 'walker installed once per frame');
  commands.length = 0;
  await driver.refresh();
  assert.deepEqual(commands, [], 'a current tree costs no commands');
  driver.onMessage('Page.frameDetached', { frameId: 'child' }, '');
  await driver.refresh();
  assert.equal(commands.filter(method => method === 'Page.getFrameTree').length, 1);
});

test('focus emulation is on in automation and off while the person controls the page', async () => {
  const { driver, sent } = fixture();
  await driver.setNativeMode(true);
  await driver.setNativeMode(false);
  assert.deepEqual(sent.filter(command => command.method === 'Emulation.setFocusEmulationEnabled')
    .map(command => [command.params.enabled, command.sessionId]), [[false, undefined], [true, undefined]]);
});

test('DevTools recording starts on main, iframe and worker sessions before they run and never fails their setup', async () => {
  const { driver, page, sent, debuggerAPI, changes } = fixture();
  page.devtools = new DevToolsRecorder(() => 'automation', sessionId => driver.targets.get(sessionId)?.type);
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === 'Log.enable') throw new Error('Log is unavailable on this target');
    return {};
  };
  await driver.start();
  // Recording (and its replay cutoff) precedes Runtime.enable on page and iframe sessions.
  assert.deepEqual(sent.map(command => command.method), [
    'Network.enable', 'Log.enable', 'Performance.enable', 'Page.enable', 'Runtime.enable', 'DOM.enable',
    'Page.setInterceptFileChooserDialog', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.addBinding', 'Emulation.setFocusEmulationEnabled', 'Target.setAutoAttach',
  ]);
  assert.equal(sent[0].params.maxTotalBufferSize, 6 * 1024 * 1024);
  sent.length = 0;
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'frame', targetInfo: { type: 'iframe', targetId: 'child-frame' }, waitingForDebugger: true,
  });
  await driver.waitForIdle();
  assert.deepEqual(sent.map(command => command.method), [
    'Network.enable', 'Log.enable', 'Page.enable', 'Runtime.enable', 'DOM.enable', 'Page.setInterceptFileChooserDialog',
    'Page.addScriptToEvaluateOnNewDocument', 'Runtime.addBinding', 'Emulation.setFocusEmulationEnabled', 'Target.setAutoAttach',
    'Runtime.runIfWaitingForDebugger',
  ]);
  assert.equal(sent[0].params.maxTotalBufferSize, 1024 * 1024);
  sent.length = 0;
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'w' }, waitingForDebugger: true,
  });
  await driver.waitForIdle();
  // Worker recording starts after the startup release, outside the startup fence.
  assert.deepEqual(sent.map(command => [command.method, command.sessionId]), [
    ['Target.setAutoAttach', 'worker'], ['Runtime.runIfWaitingForDebugger', 'worker'],
    ['Runtime.enable', 'worker'], ['Network.enable', 'worker'], ['Log.enable', 'worker'],
  ]);
  assert.equal(page.frameFailure ?? null, null, 'A missing diagnostic domain is not a target failure');
  assert.equal(driver.sessions.has('worker'), false);
  // Worker Runtime events are DevTools records only, never observation changes.
  const before = changes.length;
  driver.onMessage('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'from worker' }], timestamp: Date.now() }, 'worker');
  driver.onMessage('Runtime.executionContextsCleared', {}, 'worker');
  assert.equal(changes.length, before);
  assert.deepEqual(page.devtools.consoleRows({}).rows, [{ i: 1, msg: 'from worker', in: 'worker' }]);
});

test('worker recording never holds the startup fence; replays, console stores and flushes are bounded per session', async () => {
  const { driver, page, sent, debuggerAPI } = fixture();
  page.devtools = new DevToolsRecorder(() => 'automation', sessionId => driver.targets.get(sessionId)?.type);
  const hung = [];
  debuggerAPI.sendCommand = (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    // A worker whose recording domains never answer.
    if (sessionId === 'worker' && ['Runtime.enable', 'Network.enable', 'Log.enable'].includes(method)) return new Promise(resolve => hung.push(resolve));
    return Promise.resolve({});
  };
  await driver.start();
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'w' }, waitingForDebugger: true,
  });
  await driver.waitForIdle();
  driver.assertNoDialogCleanup();
  assert.equal(hung.length, 3, 'Recording was requested but is not part of startup');
  // An already-running iframe replays stored console entries on Runtime.enable: they are cut off.
  driver.onMessage('Target.attachedToTarget', {
    sessionId: 'frame', targetInfo: { type: 'iframe', targetId: 'f' }, waitingForDebugger: false,
  });
  await driver.waitForIdle();
  const log = (value, timestamp, sessionId) => driver.onMessage('Runtime.consoleAPICalled', {
    type: 'log', args: [{ type: 'string', value }], timestamp,
  }, sessionId);
  log('replayed', Date.now() - 1000, 'frame');
  await new Promise(resolve => setTimeout(resolve, 2));
  log('fresh', Date.now(), 'frame');
  assert.deepEqual(page.devtools.consoleRows({}).rows.map(row => row.msg), ['fresh']);
  sent.length = 0;
  for (let i = 0; i < DEVTOOLS_LIMITS.discardEvery; i++) log(`m${i}`, Date.now(), 'frame');
  assert.deepEqual(sent.map(command => [command.method, command.sessionId]), [['Runtime.discardConsoleEntries', 'frame']]);
  sent.length = 0;
  await driver.devtoolsFlush();
  assert.deepEqual(sent.map(command => [command.method, command.sessionId]).sort(),
    [['Runtime.getIsolateId', 'frame'], ['Runtime.getIsolateId', 'worker'], ['Runtime.getIsolateId', undefined]].sort());
  for (const resolve of hung) resolve({});
});

test('page-world evaluation is an explicit opt-in bound to the frame main world of its own session', async () => {
  const { driver, sent, debuggerAPI } = fixture();
  debuggerAPI.sendCommand = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    return { result: { value: 'page global' } };
  };
  driver.onMessage('Runtime.executionContextCreated', { context: { id: 5, auxData: { isDefault: true, frameId: 'root' } } }, '');
  driver.onMessage('Runtime.executionContextCreated', { context: { id: 6, auxData: { isDefault: false, frameId: 'root' } } }, '');
  driver.onMessage('Runtime.executionContextCreated', { context: { id: 9, auxData: { isDefault: true, frameId: 'child' } } }, 'oopif');
  const root = { id: 'root', contextId: 1 };
  assert.equal(await driver.evaluateUser(root, 'window.app', 'page', await driver.evaluationContext(root, 'page')), 'page global');
  assert.deepEqual(sent.map(command => [command.method, command.params.contextId, command.params.userGesture]), [['Runtime.evaluate', 5, undefined]]);
  assert.deepEqual(driver.pageContext('child'), { contextId: 9, sessionId: 'oopif' });
  // The context is resolved before dispatch: a missing page world sends nothing.
  await assert.rejects(driver.evaluationContext({ id: 'child' }, 'page'), error => error.code === 'STALE_FRAME');
  driver.onMessage('Runtime.executionContextDestroyed', { executionContextId: 9 }, 'oopif');
  assert.equal(driver.pageContext('child'), undefined);
  driver.onMessage('Runtime.executionContextsCleared', {}, '');
  await assert.rejects(driver.evaluationContext({ id: 'root' }, 'page'), error => error.code === 'STALE_FRAME');
  assert.equal(sent.length, 1);
});
