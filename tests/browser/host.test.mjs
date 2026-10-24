import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: new URL('./electron-fixture.mjs', import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { deliverFocus, FixtureContents, ownedViews, ownedWindows, profiles, dialog } = await import('./electron-fixture.mjs');
const { BrowserHost } = await import('../../src/browser/host.mjs');
const { BrowserHostError } = await import('../../src/browser/contract.mjs');
const { FrameDriver } = await import('../../src/browser/frames.mjs');
const { BrowserPolicy } = await import('../../src/browser/policy.mjs');

// Stub ONLY the CDP boundary. Exercise the real host, queue, caller authority
// checks, permission callback policy, registry and trusted native menu routing.
const original = {};
for (const key of ['start', 'capture', 'assertCheckpoints', 'refresh', 'presented', 'evaluateUser', 'reconnect', 'send']) original[key] = FrameDriver.prototype[key];
const drivers = new WeakMap();
FrameDriver.prototype.start = async function() {
  drivers.set(this.page.contents, this);
  this.frames.set('root', { id: 'root', documentId: 'unit-document', contextId: 1 });
};
FrameDriver.prototype.reconnect = async function() {
  this.frames.clear();
  this.frames.set('root', { id: 'root', documentId: 'new-unit-document', contextId: 2 });
};
FrameDriver.prototype.capture = async function(snapshotId) {
  return {
    output: [{ frameId: 'root', documentId: 'unit-document', revision: 0, text: 'Unit fixture', elements: [], snapshotId, viewportWidth: 100, viewportHeight: 80 }],
    checkpoints: new Map([['root', { documentId: 'unit-document', revision: 0 }]]),
  };
};
FrameDriver.prototype.assertCheckpoints = async () => {};
FrameDriver.prototype.presented = async () => {};
FrameDriver.prototype.refresh = async function() { return [...this.frames.values()]; };
let evaluate = async () => 'unit-result';
let send = async () => ({});
FrameDriver.prototype.evaluateUser = async function(_frame, expression) { return evaluate(expression); };
FrameDriver.prototype.send = async function(method, params) { return send(method, params); };
const caller = owner => {
  const controller = new AbortController();
  return { sessionId: owner, callId: 'unit-call', signal: controller.signal, controller,
    assertLive() { controller.signal.throwIfAborted(); } };
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const delegatedPolicy = () => new BrowserPolicy({
  version: 1, mode: 'delegated', permissions: ['hid', 'usb', 'notifications', 'geolocation'],
  origins: 'owned-pages', selection: 'offered-option', lifetime: 'caller-generation', newGrants: true,
});
// Electron parents a page's JS dialog on the window hosting its view.
function nativeDialog(tab, type = 'confirm', message = '') {
  const driver = drivers.get(tab.contents);
  const controller = new AbortController();
  driver.onMessage('Page.javascriptDialogOpening', { type, message });
  const response = dialog.showMessageBox(tab.frame, { signal: controller.signal });
  return { response, controller, close: () => driver.onMessage('Page.javascriptDialogClosed', {}) };
}
const toolbarPreloadPath = fileURLToPath(new URL('../../src/browser/toolbar-preload.cjs', import.meta.url));
const TOOLBAR_ACTION = 'independent-browser:toolbar', TOOLBAR_STATE = 'independent-browser:state';
// One owned page: its view, the window hosting it and the input shield above it.
function tabFor(contents) {
  const view = ownedViews.find(v => v.webContents === contents);
  const frame = ownedWindows.find(w => w.contentView.children.includes(view));
  const shield = frame.contentView.children.find(child => child !== view);
  return {
    view, frame, shield, contents, toolbar: frame.webContents, profile: view.options.webPreferences?.session,
    // A person can reach the live page only while it is uncovered in a shown window.
    exposed: () => frame.isVisible() && !shield.getVisible(),
    toolbarAction: (action, value, senderFrame = frame.webContents.mainFrame) => frame.webContents.ipc.emit(
      TOOLBAR_ACTION, { senderFrame }, value === undefined ? { action } : { action, value }),
    toolbarState: () => frame.webContents.sent.findLast(([channel]) => channel === TOOLBAR_STATE)?.[1],
  };
}
async function setup({ policy = BrowserPolicy.manual() } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'independent-browser-unit-'));
  const revoked = [];
  const host = new BrowserHost({
    dataDir, consentHelperPath: path.join(dataDir, 'not-invoked.exe'), toolbarPreloadPath, policy,
    onRevokeConnection: disposition => { revoked.push(disposition); },
  });
  const authority = caller('one');
  const call = args => host.execute(args, authority);
  const result = await call({ action: 'open', url: 'http://127.0.0.1:8000' });
  const { webContents } = ownedViews.findLast(v => v.webContents.url === 'http://127.0.0.1:8000/');
  return { host, call, authority, tabId: result.tabId, tab: tabFor(webContents), revoked, dataDir };
}

test('cancelling creation during startup closes the owned page and prevents late presentation', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'browser-startup-cancel-'));
  const host = new BrowserHost({
    dataDir, consentHelperPath: path.join(dataDir, 'not-invoked.exe'), toolbarPreloadPath, onRevokeConnection() {},
  });
  const controller = new AbortController();
  const started = deferred(), gate = deferred();
  const start = FrameDriver.prototype.start;
  FrameDriver.prototype.start = async function() {
    await start.call(this);
    started.resolve(this.page);
    await gate.promise;
  };
  try {
    const opening = host.execute({ action: 'open', url: 'http://127.0.0.1:8000/' }, caller('one'), controller.signal);
    const page = await started.promise;
    controller.abort(new Error('startup cancelled'));
    await assert.rejects(opening, /startup cancelled/);
    assert.equal(page.frame.isDestroyed(), true);
    assert.equal(page.contents.isDestroyed(), true, 'A view is not destroyed with its window; cancellation releases it');
    gate.resolve();
    await tick();
    assert.equal(host.status().tabCount, 0);
    assert.equal(page.frame.isVisible(), false, 'A cancelled page never presents its window');
    assert.notEqual(page.contents.getURL(), 'http://127.0.0.1:8000/');
  } finally {
    gate.resolve();
    FrameDriver.prototype.start = start;
    await host.close();
  }
});

test('owned windows/profiles, foreign/late calls and closed IDs are isolated', async () => {
  const { host, call, authority, tabId, tab, dataDir } = await setup();
  try {
    const pagePreferences = tab.view.options.webPreferences;
    assert.equal(pagePreferences.nodeIntegration, false);
    assert.equal(pagePreferences.contextIsolation, true);
    assert.equal(pagePreferences.sandbox, true);
    assert.equal(pagePreferences.webSecurity, true);
    assert.equal(pagePreferences.preload, undefined);
    assert.equal(pagePreferences.focusOnNavigation, false);
    // Plugin chrome never shares the page profile; only the toolbar has a preload.
    const toolbar = tab.frame.options.webPreferences, shield = tab.shield.options.webPreferences;
    for (const chrome of [toolbar, shield]) {
      assert.equal(chrome.session, undefined);
      assert.match(chrome.partition, /^independent-chrome-/);
      assert.deepEqual([chrome.sandbox, chrome.contextIsolation, chrome.nodeIntegration], [true, true, false]);
    }
    assert.equal(toolbar.preload, toolbarPreloadPath);
    assert.equal(shield.preload, undefined);
    await assert.rejects(host.execute({ action: 'observe', tabId }, caller('two')), /owned/);
    await assert.rejects(host.execute({ action: 'evaluate', tabId, expression: 'x' }, {
      ...authority, assertLive() { throw new Error('Late authority'); },
    }), /Late authority/);
    assert.equal((await host.execute({ action: 'list_tabs' }, caller('two'))).tabs.length, 0);
    await host.execute({ action: 'open', url: 'http://127.0.0.1:8000' }, caller('two'));
    const directories = profiles.filter(p => p.directory.startsWith(dataDir)).map(p => p.directory);
    assert.equal(new Set(directories).size, 2);
    await call({ action: 'close_tab', tabId });
    assert.equal(tab.frame.isDestroyed(), true);
    assert.equal(tab.contents.isDestroyed(), true);
    assert.equal(tab.shield.webContents.isDestroyed(), true);
    await assert.rejects(call({ action: 'observe', tabId }), /closed/);
  } finally { await host.close(); }
});

test('request cancellation settles promptly but the next actual dispatch remains fenced exactly once', async () => {
  const { host, call, authority, tabId } = await setup();
  const started = deferred(), release = deferred();
  const dispatched = [];
  evaluate = async expression => {
    dispatched.push(expression);
    if (expression === 'first') { started.resolve(); await release.promise; }
    return expression;
  };
  try {
    const abort = new AbortController();
    const first = host.execute({ action: 'evaluate', tabId, expression: 'first' }, authority, abort.signal);
    await started.promise;
    abort.abort(new Error('unit cancel'));
    assert.deepEqual(await first, {
      tabId, disposition: 'uncertain', replaySafe: false,
      code: 'ABORTED',
      reason: 'Caller cancelled, timed out or automation stopped after dispatch',
    });
    const second = call({ action: 'evaluate', tabId, expression: 'second' });
    await tick();
    assert.deepEqual(dispatched, ['first']);
    release.resolve();
    assert.equal((await second).value, 'second');
    assert.deepEqual(dispatched, ['first', 'second']);
  } finally { release.resolve(); await host.close(); evaluate = async () => 'unit-result'; }
});

test('handoff/Stop persist across hide/show; only a native Resume callback reopens admissions', async () => {
  const { host, call, tabId, tab } = await setup();
  try {
    await call({ action: 'handoff', tabId });
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /paused/);
    await call({ action: 'hide', tabId });
    await call({ action: 'show', tabId });
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /paused/);
    await assert.rejects(call({ action: 'observe', tabId }), /handoff/i);
    assert.equal(tab.exposed(), true);
    await tab.frame.menu.items.find(i => i.label === 'Resume automation').click();
    assert.equal((await call({ action: 'evaluate', tabId, expression: 'x' })).disposition, 'executed');
    tab.frame.menu.items.find(i => i.label === 'Stop automation').click();
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /paused/);
  } finally { await host.close(); }
});

test('shield input during automation drains without forwarding while debugger input to the unfocused page does not self-pause', async () => {
  const { host, call, tabId, tab } = await setup();
  const started = deferred(), release = deferred();
  evaluate = async () => { started.resolve(); await release.promise; return 'late-result'; };
  try {
    const pending = call({ action: 'evaluate', tabId, expression: 'pending' });
    await started.promise;
    tab.contents.emit('before-input-event', { preventDefault() { throw new Error('Hidden CDP must not be blocked'); } }, { type: 'keyDown', key: 'x' });
    assert.equal((await call({ action: 'list_tabs' })).tabs[0].paused, null);
    const shield = tab.shield.webContents;
    shield.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'x' });
    assert.equal((await pending).disposition, 'uncertain');
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'again' }), /shell-keyboard-intervention/);
    assert.equal((await call({ action: 'list_tabs' })).tabs[0].paused, 'shell-keyboard-intervention');
    shield.emit('before-input-event', { preventDefault() {} }, { type: 'keyUp', key: 'x' });
  } finally { release.resolve(); await host.close(); evaluate = async () => 'unit-result'; }
});

test('delegated native requests resolve exact HID/USB offers without dialogs or handoff', async () => {
  const policy = new BrowserPolicy({
    version: 1, mode: 'delegated', permissions: ['hid', 'usb', 'notifications', 'geolocation'],
    origins: 'owned-pages', selection: 'offered-option', lifetime: 'caller-generation', newGrants: true,
  });
  const { host, tab,tabId, call } = await setup({ policy });
  const profile = tab.profile;
  const originalDialog = dialog.showMessageBox;
  let nativeDialogs = 0;
  dialog.showMessageBox = async () => { nativeDialogs++; throw new Error('Routine device selection must remain an agent interaction'); };
  host.permissions.surface.prompt = async () => { throw new Error('Delegated requests must not invoke Windows consent'); };
  try {
    assert.deepEqual((await call({ action: 'requests', tabId })).pending, []);
    for (const kind of ['hid', 'usb']) {
      const device = { deviceId: `delegated-${kind}`, vendorId: 1, productId: 2, productName: 'Fixture keyboard' };
      let selected = 'not-called';
      profile.emit(`select-${kind}-device`, { preventDefault() {} },
        { frame: tab.contents.mainFrame, deviceList: [device] }, id => { selected = id; });
      await tick();
      const state = await call({ action: 'requests', tabId });
      assert.equal(state.pending.length, 1);
      const request = state.pending[0];
      assert.equal(request.kind, kind);
      assert.equal(request.context.origin, 'http://127.0.0.1:8000');
      assert.equal(request.options[0].metadata.deviceId, device.deviceId);
      assert.equal(selected, 'not-called');
      const result = await call({ action: 'respond', tabId, requestRef: request.requestRef,
        response: { optionRef: request.options[0].optionRef } });
      assert.equal(result.request.resolution, 'selected');
      assert.equal(selected, device.deviceId);
      assert.deepEqual((await call({ action: 'requests', tabId })).pending, []);
      assert.equal((await call({ action: 'list_tabs' })).tabs[0].mode, 'automation');
      assert.equal(tab.exposed(), false);
    }
    assert.equal(nativeDialogs, 0);
  } finally { dialog.showMessageBox = originalDialog; await host.close(); }
});

test('permission callback policy rejects unverifiable frames/APIs without prompting or custom device grants', async () => {
  const { host, tab,tabId, call } = await setup();
  try {
    const profile = tab.profile;
    assert.equal(profile.permissionCheck(tab.contents, 'hid', 'http://127.0.0.1:8000', { isMainFrame: true }), true);
    assert.equal(profile.permissionCheck(tab.contents, 'hid', 'http://127.0.0.1:8000', { isMainFrame: false }), false);
    assert.equal(profile.devicePermission, null);
    let outcome;
    profile.permissionRequest(tab.contents, 'notifications', value => { outcome = value; },
      { isMainFrame: false, requestingUrl: tab.contents.mainFrame.url });
    assert.equal(outcome, false);
    profile.permissionRequest(tab.contents, 'serial', value => { outcome = value; },
      { isMainFrame: true, requestingUrl: tab.contents.mainFrame.url });
    assert.equal(outcome, false);
    assert.equal((await call({ action: 'permissions', tabId })).events.length, 3);
    let selected = 'not-called';
    profile.emit('select-hid-device', { preventDefault() {} }, { frame: null, deviceList: [{ deviceId: 'fake' }] }, value => { selected = value; });
    await tick();
    assert.equal(selected, undefined);
  } finally { await host.close(); }
});

test('delegated device requests reject foreign refs, update exact offers, reuse only current-generation grants and preserve terminal cancellation', async () => {
  for (const kind of ['hid', 'usb']) {
    const { host, tab,tabId, call, authority } = await setup({ policy: delegatedPolicy() });
    const profile = tab.profile;
    let callbacks = [];
    const device = { deviceId: `exact-${kind}`, vendorId: 1, productId: 2, serialNumber: 'A' };
    const request = devices => profile.emit(`select-${kind}-device`, { preventDefault() {} },
      { frame: tab.contents.mainFrame, deviceList: devices }, id => { callbacks.push(id); });
    try {
      request([device, { ...device, deviceId: 'second' }]);
      let [pending] = (await call({ action: 'requests', tabId })).pending;
      await assert.rejects(host.execute({ action: 'respond', tabId, requestRef: pending.requestRef,
        response: { optionRef: pending.options[0].optionRef } }, caller('one')), /another page or caller generation/);
      await assert.rejects(call({ action: 'respond', tabId, requestRef: pending.requestRef,
        response: { optionRef: 'invented' } }), /current native request/);
      const removed = pending.options[1].optionRef;
      if (kind === 'hid') profile.emit('hid-device-removed', {}, { frame: tab.contents.mainFrame, device: { deviceId: 'second' } });
      else profile.emit('usb-device-removed', {}, { deviceId: 'second' }, tab.contents);
      const oldOption = pending.options[0].optionRef;
      [pending] = (await call({ action: 'requests', tabId })).pending;
      assert.equal(pending.revision, 2);
      assert.equal(pending.options.length, 1);
      for (const optionRef of [removed, oldOption]) {
        await assert.rejects(call({ action: 'respond', tabId, requestRef: pending.requestRef, response: { optionRef } }), /current native request/);
      }
      assert.equal((await call({ action: 'respond', tabId, requestRef: pending.requestRef,
        response: { optionRef: pending.options[0].optionRef } })).request.resolution, 'selected');
      assert.deepEqual(callbacks, [device.deviceId]);
      request([device]);
      await tick();
      assert.deepEqual(callbacks, [device.deviceId, device.deviceId]);
      assert.equal((await call({ action: 'requests', tabId })).pending.length, 0);
      request([{ ...device, serialNumber: 'B' }]);
      [pending] = (await call({ action: 'requests', tabId })).pending;
      assert.equal(pending.options[0].metadata.serialNumber, 'B');
      authority.controller.abort(new Error('Owner generation ended'));
      assert.deepEqual(callbacks, [device.deviceId, device.deviceId, undefined]);
      const next = caller('one');
      await host.execute({ action: 'observe', tabId }, next);
      request([device]);
      [pending] = (await host.execute({ action: 'requests', tabId }, next)).pending;
      assert.ok(pending, 'A new generation cannot reuse old delegated positive authority');
      await host.execute({ action: 'respond', tabId, requestRef: pending.requestRef, response: { cancel: true } }, next);
      request([device]);
      await tick();
      assert.equal((await host.execute({ action: 'requests', tabId }, next)).pending.length, 0);
      assert.deepEqual(callbacks.slice(-2), [undefined, undefined]);
    } finally { await host.close(); }
  }
});

test('pending delegated choices are withdrawn once at every browser boundary without becoming denial', async () => {
  for (const transition of ['stop', 'navigate', 'disconnect', 'handoff', 'hide', 'close', 'revoke', 'cancel']) {
    const { host, tab,tabId, call, authority } = await setup({ policy: delegatedPolicy() });
    const profile = tab.profile;
    const device = { deviceId: 'device', vendorId: 1, productId: 2 };
    let callbacks = [];
    const emit = () => profile.emit('select-hid-device', { preventDefault() {} },
      { frame: tab.contents.mainFrame, deviceList: [device] }, id => { callbacks.push(id); });
    try {
      const operation = new AbortController();
      await host.execute({ action: 'observe', tabId }, authority, operation.signal);
      emit();
      const [pending] = (await call({ action: 'requests', tabId })).pending;
      if (transition === 'stop') tab.frame.menu.items.find(item => item.label === 'Stop automation').click();
      else if (transition === 'navigate') await call({ action: 'navigate', tabId, url: 'http://127.0.0.1:8000/next' });
      else if (transition === 'disconnect') drivers.get(tab.contents).detached();
      else if (transition === 'handoff') await call({ action: 'handoff', tabId });
      else if (transition === 'hide') await call({ action: 'hide', tabId });
      else if (transition === 'close') await call({ action: 'close_tab', tabId });
      else if (transition === 'revoke') await call({ action: 'revoke' });
      else operation.abort(new Error('Initiating operation cancelled'));
      await tick();
      assert.deepEqual(callbacks, [undefined], transition);
      await assert.rejects(call({ action: 'respond', tabId, requestRef: pending.requestRef,
        response: { optionRef: pending.options[0].optionRef } }));
      assert.equal(host.permissions.deniedChoosers.size, 0, transition);
      if (['navigate', 'disconnect', 'hide', 'cancel'].includes(transition)) {
        if (transition === 'hide') await call({ action: 'show', tabId });
        await call({ action: 'observe', tabId });
        emit();
        assert.equal((await call({ action: 'requests', tabId })).pending.length, 1);
      }
    } finally { await host.close(); }
  }
});

test('file picker capabilities distinguish HTML uploads from unsupported File System Access pickers', async () => {
  const { host, call, tabId } = await setup();
  try {
    const { capabilities } = await call({ action: 'status' });
    assert.ok(capabilities.filePickers, 'File picker capabilities must be explicit');
    assert.deepEqual(new Set(capabilities.filePickers.supported), new Set(['html-file-input']));
    assert.deepEqual(new Set(capabilities.filePickers.unsupported),
      new Set(['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']));
    const result = await call({ action: 'requests', tabId });
    assert.deepEqual(result.capabilities.filePickers, capabilities.filePickers);
    assert.deepEqual(result.pending, []);
  } finally { await host.close(); }
});

test('absent delegation reports capabilities and never creates a grant or routine handoff', async () => {
  const { host, tab,tabId, call } = await setup({ policy: new BrowserPolicy() });
  let selected = 'not-called';
  try {
    tab.profile.emit('select-hid-device', { preventDefault() {} },
      { frame: tab.contents.mainFrame, deviceList: [{ deviceId: 'device' }] }, id => { selected = id; });
    await tick();
    assert.equal(selected, undefined);
    const result = await call({ action: 'requests', tabId });
    assert.equal(result.pending.length, 0);
    assert.equal(result.capabilities.delegation.mode, 'disabled');
    assert.match((await call({ action: 'permissions', tabId })).events.at(-1).reason, /Delegated device selection blocked/);
    assert.equal((await call({ action: 'list_tabs' })).tabs[0].mode, 'automation');
  } finally { await host.close(); }
});

test('delegated generic permissions resolve through the same facade, reuse exact grants and retain denial across generations', async () => {
  const { host, tab,tabId, call, authority } = await setup({ policy: delegatedPolicy() });
  const profile = tab.profile;
  const details = { isMainFrame: true, requestingUrl: tab.contents.mainFrame.url };
  let calls = [];
  const request = kind => profile.permissionRequest(tab.contents, kind, allowed => { calls.push({ kind, allowed }); }, details);
  host.permissions.surface.prompt = async () => { throw new Error('No Windows helper in delegated policy'); };
  try {
    request('notifications');
    let [pending] = (await call({ action: 'requests', tabId })).pending;
    await call({ action: 'respond', tabId, requestRef: pending.requestRef, response: { optionRef: pending.options[0].optionRef } });
    request('notifications');
    await tick();
    assert.deepEqual(calls, [{ kind: 'notifications', allowed: true }, { kind: 'notifications', allowed: true }]);
    assert.equal((await call({ action: 'requests', tabId })).pending.length, 0);
    request('geolocation');
    [pending] = (await call({ action: 'requests', tabId })).pending;
    await call({ action: 'respond', tabId, requestRef: pending.requestRef, response: { optionRef: pending.options[1].optionRef } });
    authority.controller.abort(new Error('End generation'));
    const next = caller('one');
    await host.execute({ action: 'observe', tabId }, next);
    request('geolocation');
    await tick();
    assert.deepEqual(calls.slice(-2), [{ kind: 'geolocation', allowed: false }, { kind: 'geolocation', allowed: false }]);
    assert.equal((await host.execute({ action: 'requests', tabId }, next)).pending.length, 0);
    request('notifications');
    assert.equal((await host.execute({ action: 'requests', tabId }, next)).pending.length, 1);
  } finally { await host.close(); }
});

test('native human permission denial remains terminal after Resume and caller generation replacement', async () => {
  for (const kind of ['notifications', 'geolocation']) {
    const { host, tab,tabId, call, authority } = await setup({ policy: delegatedPolicy() });
    const profile = tab.profile;
    const originalDialog = dialog.showMessageBox;
    const callbacks = [];
    const request = () => profile.permissionRequest(tab.contents, kind, allowed => { callbacks.push(allowed); },
      { isMainFrame: true, requestingUrl: tab.contents.mainFrame.url });
    dialog.showMessageBox = async () => ({ response: 0 });
    try {
      await call({ action: 'handoff', tabId });
      request();
      await tick();
      assert.deepEqual(callbacks, [false]);
      await tab.frame.menu.items.find(item => item.label === 'Resume automation').click();
      await call({ action: 'observe', tabId });
      request();
      await tick();
      assert.equal((await call({ action: 'requests', tabId })).pending.length, 0,
        `${kind}: Resume must not re-offer a genuinely denied permission`);
      assert.deepEqual(callbacks, [false, false]);
      authority.controller.abort(new Error('Generation ended'));
      const next = caller('one');
      await host.execute({ action: 'observe', tabId }, next);
      request();
      await tick();
      assert.equal((await host.execute({ action: 'requests', tabId }, next)).pending.length, 0);
      assert.deepEqual(callbacks, [false, false, false]);
    } finally { dialog.showMessageBox = originalDialog; await host.close(); }
  }
});

test('native human permission denial withdraws concurrent siblings before late Allow can authorize', async () => {
  const { host, tab,tabId, call } = await setup({ policy: delegatedPolicy() });
  const profile = tab.profile;
  const originalDialog = dialog.showMessageBox;
  const first = deferred(), second = deferred(), signals = [], callbacks = [];
  dialog.showMessageBox = async (_window, options) => {
    signals.push(options.signal);
    return signals.length === 1 ? first.promise : second.promise;
  };
  const request = () => profile.permissionRequest(tab.contents, 'notifications', allowed => { callbacks.push(allowed); },
    { isMainFrame: true, requestingUrl: tab.contents.mainFrame.url });
  try {
    await call({ action: 'handoff', tabId });
    request(); request();
    first.resolve({ response: 0 });
    await tick();
    assert.equal(signals[1].aborted, true, 'Native decline must withdraw outstanding same-scope decisions');
    second.resolve({ response: 1 });
    await tick();
    assert.deepEqual(callbacks, [false, false]);
    await tab.frame.menu.items.find(item => item.label === 'Resume automation').click();
    await call({ action: 'observe', tabId });
    request();
    await tick();
    assert.deepEqual(callbacks, [false, false, false]);
    assert.equal((await call({ action: 'requests', tabId })).pending.length, 0);
  } finally {
    first.resolve({ response: 0 }); second.resolve({ response: 0 });
    dialog.showMessageBox = originalDialog;
    await host.close();
  }
});

test('technical native permission withdrawal never becomes a human denial after late Cancel', async () => {
  for (const kind of ['notifications', 'geolocation']) {
    const { host, tab,tabId, call } = await setup({ policy: delegatedPolicy() });
    const profile = tab.profile;
    const originalDialog = dialog.showMessageBox, late = deferred(), callbacks = [];
    dialog.showMessageBox = async () => late.promise;
    const request = () => profile.permissionRequest(tab.contents, kind, allowed => { callbacks.push(allowed); },
      { isMainFrame: true, requestingUrl: tab.contents.mainFrame.url });
    try {
      await call({ action: 'handoff', tabId });
      request();
      tab.frame.menu.items.find(item => item.label === 'Stop automation').click();
      late.resolve({ response: 0 });
      await tick();
      assert.deepEqual(callbacks, [false]);
      await tab.frame.menu.items.find(item => item.label === 'Resume automation').click();
      await call({ action: 'observe', tabId });
      request();
      const [pending] = (await call({ action: 'requests', tabId })).pending;
      assert.equal(pending.kind, kind);
      await call({ action: 'respond', tabId, requestRef: pending.requestRef,
        response: { optionRef: pending.options.find(option => option.label === 'Allow').optionRef } });
      assert.deepEqual(callbacks, [false, true]);
    } finally { late.resolve({ response: 0 }); dialog.showMessageBox = originalDialog; await host.close(); }
  }
});

test('a native request can be answered while its originating evaluation still owns the action lane', async () => {
  const { host, tab,tabId, call } = await setup({ policy: delegatedPolicy() });
  const released = deferred();
  let responses = 0;
  evaluate = async () => {
    const native = nativeDialog(tab, 'confirm', 'App fixture approval');
    native.response.then(choice => {
      responses++;
      assert.equal(choice.response, 0);
      native.close();
      released.resolve();
    });
    await released.promise;
    return 'done';
  };
  send = async method => { assert.notEqual(method, 'Page.handleJavaScriptDialog', 'Only Electron native callback completes an associated dialog'); return {}; };
  try {
    const initiated = await call({ action: 'evaluate', tabId, expression: 'app verification dialog' });
    assert.equal(initiated.operationPending, true);
    const [pending] = initiated.pendingRequests;
    assert.equal(pending.kind, 'javascript-dialog');
    assert.equal(pending.context.message, 'App fixture approval');
    const result = await call({ action: 'respond', tabId, requestRef: pending.requestRef,
      response: { optionRef: pending.options[0].optionRef } });
    assert.equal(result.request.resolution, 'resolved');
    assert.equal(responses, 1);
    assert.equal((await call({ action: 'observe', tabId })).disposition, 'observed');
  } finally { released.resolve(); evaluate = async () => 'unit-result'; send = async () => ({}); await host.close(); }
});

test('file-picker responses preserve the exact input, multiplicity and existing files on cancel', async () => {
  const { host, tab,tabId, call, dataDir } = await setup({ policy: delegatedPolicy() });
  const driver = drivers.get(tab.contents);
  const file = path.join(dataDir, 'fixture.txt');
  await writeFile(file, 'fixture');
  let connected = true, applied = [];
  tab.contents.debugger.sendCommand = async (method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'original-file-input' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: connected } };
    if (method === 'DOM.setFileInputFiles') applied.push(params.files);
    return {};
  };
  const picker = () => driver.onMessage('Page.fileChooserOpened', { frameId: 'root', backendNodeId: 3, mode: 'selectSingle' });
  try {
    picker();
    let [request] = (await call({ action: 'requests', tabId })).pending;
    await assert.rejects(call({ action: 'respond', tabId, requestRef: request.requestRef, response: { files: ['relative.txt'] } }));
    await assert.rejects(call({ action: 'respond', tabId, requestRef: request.requestRef, response: { files: [file, file] } }));
    assert.equal((await call({ action: 'requests', tabId })).pending.length, 1);
    assert.equal((await call({ action: 'respond', tabId, requestRef: request.requestRef, response: { files: [file] } })).request.resolution, 'selected');
    assert.deepEqual(applied, [[file]]);
    picker();
    [request] = (await call({ action: 'requests', tabId })).pending;
    assert.equal((await call({ action: 'respond', tabId, requestRef: request.requestRef, response: { cancel: true } })).request.resolution, 'cancelled');
    assert.deepEqual(applied, [[file]], 'Cancel does not clear or replace a previously selected file');
    picker();
    [request] = (await call({ action: 'requests', tabId })).pending;
    connected = false;
    const replaced = await call({ action: 'respond', tabId, requestRef: request.requestRef, response: { files: [file] } });
    assert.equal(replaced.disposition, 'uncertain');
    assert.deepEqual(applied, [[file]], 'An identical replacement cannot receive files for the original input');
  } finally { await host.close(); }
});

test('file response bypasses a waiting initiating command but its actual reply still fences input and native reveal', async () => {
  const { host, tab,tabId, call, authority, dataDir } = await setup({ policy: delegatedPolicy() });
  const driver = drivers.get(tab.contents), actualReply = deferred(), nativeStarted = deferred(), appReady = deferred();
  const responseAbort = new AbortController();
  const file = path.join(dataDir, 'fixture.txt');
  await writeFile(file, 'fixture');
  let effects = 0, handoff;
  evaluate = async () => {
    driver.onMessage('Page.fileChooserOpened', { frameId: 'root', backendNodeId: 3, mode: 'selectSingle' });
    await appReady.promise;
    return 'app processed attachment';
  };
  tab.contents.debugger.sendCommand = async (method) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'input' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    if (method === 'DOM.setFileInputFiles') {
      effects++; nativeStarted.resolve(); await actualReply.promise; appReady.resolve();
    }
    return {};
  };
  try {
    const initiated = await call({ action: 'evaluate', tabId, expression: 'await app attachment' });
    const [request] = initiated.pendingRequests;
    const response = host.execute({ action: 'respond', tabId, requestRef: request.requestRef,
      response: { files: [file] } }, authority, responseAbort.signal);
    await nativeStarted.promise;
    responseAbort.abort(new Error('Response caller cancelled'));
    assert.equal((await response).disposition, 'uncertain');
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'must not dispatch' }), /still settling/);
    handoff = call({ action: 'handoff', tabId });
    await tick();
    assert.equal(tab.exposed(), false);
    actualReply.resolve();
    await handoff;
    assert.equal(effects, 1);
    assert.equal(tab.exposed(), true);
  } finally { actualReply.resolve(); appReady.resolve(); await handoff; evaluate = async () => 'unit-result'; await host.close(); }
});

test('revoke blocks synchronously, emits terminating disposition and never confirms its own process exit', async () => {
  const { host, call, tabId, revoked } = await setup();
  try {
    const revocation = call({ action: 'revoke' });
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /terminating/);
    const result = await revocation;
    assert.equal(result.confirmed, false);
    assert.equal(result.disposition, 'terminating-revocation');
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].closesConnection, true);
    assert.equal(host.status().state, 'terminating-revocation');
  } finally { await host.close(); }
});

test('disconnect blocks old input, but a new observation can reconnect without replay or clearing Stop', async () => {
  const { host, call, tabId, tab } = await setup();
  try {
    tab.contents.emit('render-process-gone');
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'old-input' }), /disconnect/i);
    const observation = await call({ action: 'observe', tabId });
    assert.equal(observation.tabId, tabId);
    assert.equal((await call({ action: 'list_tabs' })).tabs[0].connected, true);
    tab.frame.menu.items.find(i => i.label === 'Stop automation').click();
    tab.contents.emit('render-process-gone');
    await call({ action: 'observe', tabId });
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'still-stopped' }), /paused/i);
  } finally { await host.close(); }
});

test('an asynchronously created popup cannot navigate after its source tab closes', async () => {
  const { host, call, tabId, tab } = await setup();
  try {
    const before = { windows: ownedWindows.length, views: ownedViews.length };
    const response = tab.contents.windowOpenHandler({ url: 'http://127.0.0.1:8000/popup' });
    assert.equal(response.action, 'allow');
    await call({ action: 'close_tab', tabId });
    await tick();
    assert.throws(() => response.createWindow({ webContents: new FixtureContents(), width: 400, height: 300, webPreferences: {} }), /owner closed/);
    assert.deepEqual({ windows: ownedWindows.length, views: ownedViews.length }, before);
  } finally { await host.close(); }
});

test('a popup adopts its Chromium-created contents into its own shielded window', async () => {
  const { host, call, tab } = await setup();
  try {
    const response = tab.contents.windowOpenHandler({ url: 'http://127.0.0.1:8000/popup' });
    const adopted = new FixtureContents();
    assert.equal(response.createWindow({ webContents: adopted, width: 400, height: 300, webPreferences: {} }), adopted);
    await tick();
    const popup = tabFor(adopted);
    assert.notEqual(popup.frame, tab.frame);
    // The requested size is the page's; the window adds its own toolbar.
    assert.deepEqual([popup.frame.options.width, popup.frame.options.height, popup.frame.options.useContentSize], [400, 344, true]);
    assert.equal(adopted.backgroundThrottling, false, 'Adopted contents match owned page preferences');
    assert.equal(popup.frame.isVisible(), true);
    assert.equal(popup.exposed(), false);
    const tabs = (await call({ action: 'list_tabs' })).tabs;
    assert.equal(tabs.length, 2);
    assert.ok(tabs.every(t => t.mode === 'automation'));
  } finally { await host.close(); }
});

test('missing native dialog-close confirmation returns uncertainty and cannot be replayed', async t => {
  const { host, call, tabId, tab } = await setup();
  const native = nativeDialog(tab, 'alert');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const result = call({ action: 'handle_dialog', tabId, accept: true });
    assert.equal((await native.response).response, 0);
    t.mock.timers.tick(15000);
    assert.equal((await result).disposition, 'uncertain');
    await assert.rejects(call({ action: 'handle_dialog', tabId, accept: true }), /never replay/);
  } finally { native.close(); t.mock.timers.reset(); await host.close(); }
});

test('recoverable post-navigation checkpoint failure exposes only a safe code and recovers by observe without navigation replay', async () => {
  const { host, call, tabId, tab } = await setup();
  const driver = drivers.get(tab.contents), capture = driver.capture;
  const loadURL = tab.contents.loadURL.bind(tab.contents);
  let navigations = 0;
  tab.contents.loadURL = async url => { navigations++; return loadURL(url); };
  driver.capture = async () => { throw new BrowserHostError('OBSERVATION_CHANGED', 'DO_NOT_EXPORT_PRIVATE_ERROR_DETAILS'); };
  try {
    const result = await call({ action: 'navigate', tabId, url: 'http://127.0.0.1:8000/next' });
    assert.equal(result.disposition, 'uncertain');
    assert.equal(result.code, 'OBSERVATION_CHANGED');
    assert.equal(result.replaySafe, false);
    assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT_PRIVATE_ERROR_DETAILS'), false);
    assert.equal(navigations, 1);
    driver.capture = capture;
    assert.equal((await call({ action: 'observe', tabId })).disposition, 'observed');
    assert.equal(navigations, 1);
  } finally { driver.capture = capture; await host.close(); }
});

test('native image failures expose only a safe code and preserve the strict checkpoint', async () => {
  const { host, call, tabId, tab } = await setup();
  const driver = drivers.get(tab.contents), capture = driver.capture, check = driver.assertCheckpoints;
  const capturePage = tab.contents.capturePage;
  const order = [];
  tab.contents.capturePage = async (...args) => { order.push('image'); return capturePage(...args); };
  driver.capture = async (...args) => { order.push('dom'); return capture.apply(driver, args); };
  driver.assertCheckpoints = async (...args) => { order.push('check'); return check.apply(driver, args); };
  try {
    assert.equal((await call({ action: 'observe', tabId })).disposition, 'observed');
    assert.deepEqual(order, ['dom', 'image', 'check']);
    tab.contents.capturePage = async () => { throw new Error('DO_NOT_EXPORT_NATIVE_CAPTURE_DETAILS'); };
    const result = await call({ action: 'evaluate', tabId, expression: 'one-dispatch' });
    assert.equal(result.disposition, 'uncertain');
    assert.equal(result.code, 'CAPTURE_FAILED');
    assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT_NATIVE_CAPTURE_DETAILS'), false);
  } finally {
    tab.contents.capturePage = capturePage; driver.capture = capture; driver.assertCheckpoints = check;
    await host.close();
  }
});

test('cancellation of dialog cleanup settles caller without authorizing a second response', async () => {
  const { host, authority, tabId, tab } = await setup();
  const native = nativeDialog(tab), abort = new AbortController();
  try {
    const result = host.execute({ action: 'handle_dialog', tabId, accept: false }, authority, abort.signal);
    assert.equal((await native.response).response, 1);
    abort.abort(new Error('cancelled dialog reply'));
    assert.equal((await result).disposition, 'uncertain');
    await assert.rejects(host.execute({ action: 'handle_dialog', tabId, accept: false }, authority), /never replay/);
  } finally { native.close(); await host.close(); }
});

test('cancelled dialog response fences its actual reply against native reveal and new input', async () => {
  const { host, call, authority, tabId, tab } = await setup();
  const native = nativeDialog(tab), abort = new AbortController();
  let effects = 0;
  evaluate = async () => { effects++; return 'input'; };
  let handoff;
  try {
    const response = host.execute({ action: 'handle_dialog', tabId, accept: true }, authority, abort.signal);
    assert.equal((await native.response).response, 0);
    abort.abort(new Error('caller cancelled'));
    assert.equal((await response).disposition, 'uncertain');
    const input = await call({ action: 'evaluate', tabId, expression: 'new input' }).then(value => ({ value }), error => ({ error }));
    handoff = call({ action: 'handoff', tabId });
    await tick();
    const before = { visible: tab.exposed(), effects, code: input.error?.code };
    native.close();
    await handoff;
    assert.deepEqual(before, { visible: false, effects: 0, code: 'DIALOG_CLEANUP_PENDING' });
    assert.equal(tab.exposed(), true);
  } finally {
    native.close(); await handoff; evaluate = async () => 'unit-result'; await host.close();
  }
});

test('trusted native dialog response shares the actual cleanup fence with manual handoff', async () => {
  const { host, call, tabId, tab } = await setup();
  const native = nativeDialog(tab);
  let handoff, nativeResponse;
  try {
    nativeResponse = tab.frame.menu.items.find(item => item.label === 'Accept pending page dialog').click();
    assert.equal((await native.response).response, 0);
    handoff = call({ action: 'handoff', tabId });
    await tick();
    const before = { visible: tab.exposed() };
    native.close();
    await nativeResponse; await handoff;
    assert.deepEqual(before, { visible: false });
    assert.equal(tab.exposed(), true);
  } finally { native.close(); await nativeResponse; await handoff; await host.close(); }
});

test('native keyboard and mouse stay fenced during an existing handoff after dialog consumer timeout', async t => {
  const { host, call, tabId, tab } = await setup();
  const driver = drivers.get(tab.contents), reply = deferred(), started = deferred();
  let nativeResponse, responses = 0;
  driver.send = original.send.bind(driver);
  tab.contents.debugger.sendCommand = method => {
    if (method === 'Page.handleJavaScriptDialog') {
      responses++; started.resolve(); return reply.promise;
    }
    return Promise.resolve({});
  };
  const blocked = (channel, input) => {
    let prevented = false;
    tab.contents.emit(channel, { preventDefault() { prevented = true; } }, input);
    return prevented;
  };
  const key = (type, code = 'KeyA') => blocked('before-input-event', { type, code, key: code });
  const mouse = type => blocked('before-mouse-event', { type, button: 'left' });
  try {
    await call({ action: 'handoff', tabId });
    assert.equal(tab.exposed(), true);
    assert.equal(key('keyDown', 'ShiftLeft'), false);
    assert.equal(mouse('mouseDown'), false);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    driver.onMessage('Page.javascriptDialogOpening', { type: 'confirm' });
    nativeResponse = tab.frame.menu.items.find(item => item.label === 'Accept pending page dialog').click();
    await started.promise;
    driver.onMessage('Page.javascriptDialogClosed', {});
    assert.equal(key('keyDown'), true, 'A closed dialog event is not a settled actual response');
    assert.equal(mouse('mouseWheel'), true);
    assert.equal(key('keyUp', 'ShiftLeft'), true);
    assert.equal(mouse('mouseUp'), true);
    t.mock.timers.tick(15000);
    await nativeResponse;
    assert.equal(key('keyDown'), true, 'Consumer timeout cannot release native input');
    assert.equal(mouse('mouseDown'), true);
    assert.equal(responses, 1);
    reply.resolve({});
    await tick();
    assert.equal(key('keyUp', 'ShiftLeft'), true, 'Blocked releases must clear held-control bookkeeping');
    assert.equal(mouse('mouseUp'), true);
    assert.equal(key('keyDown'), false);
    assert.equal(key('keyUp'), false);
    assert.equal(mouse('mouseDown'), false);
    assert.equal(mouse('mouseUp'), false);
  } finally {
    reply.resolve({});
    await nativeResponse;
    t.mock.timers.reset();
    await host.close();
  }
});

test('manual-route release alone cannot uncover the page before actual lane AND CDP cleanup settle', async () => {
  const { host, call, tabId, tab } = await setup();
  const started = deferred(), actual = deferred(), cleanup = deferred(), draining = deferred();
  const driver = drivers.get(tab.contents);
  let waits = 0;
  driver.cdp.waitForIdle = async () => {
    if (++waits > 1) { draining.resolve(); await cleanup.promise; }
  };
  evaluate = async () => { started.resolve(); await actual.promise; return 'late'; };
  const shield = tab.shield.webContents;
  try {
    const operation = call({ action: 'evaluate', tabId, expression: 'slow' });
    await started.promise;
    shield.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown', button: 'left' });
    assert.equal((await operation).disposition, 'uncertain');
    shield.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseUp', button: 'left' });
    await tick();
    assert.equal(tab.exposed(), false);
    actual.resolve();
    await draining.promise;
    assert.equal(tab.exposed(), false);
    cleanup.resolve();
    await tick();
    assert.equal(tab.exposed(), true);
    assert.equal((await call({ action: 'list_tabs' })).tabs[0].mode, 'native-handoff');
    await assert.rejects(call({ action: 'read', tabId }), /handoff/i);
  } finally {
    actual.resolve(); cleanup.resolve(); evaluate = async () => 'unit-result'; await host.close();
  }
});

test('Stop during a pending manual drain prevents its late native reveal', async () => {
  const { host, call, tabId, tab } = await setup();
  const started = deferred(), actual = deferred(), draining = deferred(), cleanup = deferred();
  let waits = 0;
  drivers.get(tab.contents).cdp.waitForIdle = async () => {
    if (++waits > 1) { draining.resolve(); await cleanup.promise; }
  };
  evaluate = async () => { started.resolve(); await actual.promise; return 'late'; };
  const shield = tab.shield.webContents;
  try {
    const operation = call({ action: 'evaluate', tabId, expression: 'slow' });
    await started.promise;
    shield.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown', button: 'left' });
    assert.equal((await operation).disposition, 'uncertain');
    shield.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseUp', button: 'left' });
    actual.resolve();
    await draining.promise;
    tab.frame.menu.items.find(i => i.label === 'Stop automation').click();
    cleanup.resolve();
    await tick();
    assert.equal(tab.exposed(), false);
    assert.equal((await call({ action: 'list_tabs' })).tabs[0].paused, 'explicit-stop');
  } finally { actual.resolve(); cleanup.resolve(); evaluate = async () => 'unit-result'; await host.close(); }
});

test('shield wheel route stays covered/paused until explicit native-menu handoff confirms the route', async () => {
  const { host, call, tabId, tab } = await setup();
  const shield = tab.shield.webContents;
  try {
    shield.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseWheel' });
    await tick();
    assert.equal(tab.exposed(), false);
    assert.equal((await call({ action: 'list_tabs' })).tabs[0].mode, 'draining');
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /paused/);
    await tab.frame.menu.items.find(i => i.label === 'Human handoff').click();
    assert.equal(tab.exposed(), true);
    assert.equal((await call({ action: 'list_tabs' })).tabs[0].mode, 'native-handoff');
  } finally { await host.close(); }
});

test('page focus and an uncovered page during automation fail closed and never authorize input', async () => {
  const { host, call, tabId, tab } = await setup();
  const state = async () => (await call({ action: 'list_tabs' })).tabs[0];
  try {
    tab.contents.focus();
    assert.equal(tab.contents.isFocused(), false, 'Page focus during automation returns to plugin chrome');
    assert.equal(tab.toolbar.isFocused(), true);
    tab.shield.webContents.focus();
    assert.equal(tab.toolbar.isFocused(), true, 'The shield never keeps keyboard focus');
    assert.equal((await state()).paused, null);
    deliverFocus(tab.contents);
    let prevented = false;
    tab.contents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', code: 'KeyA', key: 'a' });
    assert.equal(prevented, true, 'A keystroke reaching the focused page during automation is a person');
    assert.equal((await state()).paused, 'unexpected-page-input');
    assert.equal(tab.contents.isFocused(), false);
    assert.equal(tab.exposed(), false);
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /paused/);
    await tab.frame.menu.items.find(i => i.label === 'Resume automation').click();
    assert.equal((await state()).paused, null);
    tab.shield.setVisible(false);
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /shielded/);
    assert.equal((await state()).paused, 'page-not-shielded');
    assert.equal(tab.shield.getVisible(), true, 'Failing closed covers the page again');
  } finally { await host.close(); }
});

test('minimizing or hiding the window during automation fails closed; native handoff may minimize', async () => {
  const { host, call, tabId, tab } = await setup();
  const state = async () => (await call({ action: 'list_tabs' })).tabs[0];
  try {
    tab.frame.minimize();
    assert.equal((await state()).paused, 'presentation-minimized');
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /paused/);
    await tab.frame.menu.items.find(i => i.label === 'Human handoff').click();
    assert.equal(tab.frame.isMinimized(), false, 'Handoff restores the window to show the live page');
    assert.equal(tab.exposed(), true);
    tab.frame.minimize();
    assert.equal((await state()).mode, 'native-handoff');
    tab.frame.restore();
    await tab.frame.menu.items.find(i => i.label === 'Resume automation').click();
    assert.equal((await state()).mode, 'automation');
    tab.frame.hide();
    assert.equal((await state()).paused, 'presentation-hidden');
  } finally { await host.close(); }
});

test('toolbar or shield navigation and loss never authorize input; either side closing closes the tab', async () => {
  const { host, call, tabId, tab } = await setup();
  const state = async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === tabId);
  const resume = () => tab.frame.menu.items.find(i => i.label === 'Resume automation').click();
  try {
    for (const chrome of [tab.shield.webContents, tab.toolbar]) {
      let prevented = false;
      chrome.emit('will-navigate', { preventDefault() { prevented = true; }, url: 'https://untrusted.invalid' });
      assert.equal(prevented, true);
      assert.equal((await state()).paused, 'presentation-navigation-blocked');
      await call({ action: 'show', tabId });
      await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /paused/);
      await resume();
      assert.equal((await state()).paused, null);
    }
    tab.toolbarAction('ready');
    tab.toolbar.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal((await state()).paused, 'presentation-renderer-lost');
    const sends = tab.toolbar.sent.length;
    tab.frame.menu.items.find(i => i.label === 'Stop automation').click();
    assert.equal(tab.toolbar.sent.length, sends, 'A gone toolbar renderer receives no further state');
    tab.shield.webContents.close();
    assert.equal((await state()).paused, 'presentation-lost');
    await resume();
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /paused/, 'A lost shield can never be resumed');
    tab.frame.destroy();
    assert.equal(tab.contents.isDestroyed(), true);
    await assert.rejects(call({ action: 'observe', tabId }), /closed/);
    const second = await call({ action: 'open', url: 'http://127.0.0.1:8000/second' });
    const other = tabFor(ownedViews.findLast(v => v.webContents.url === 'http://127.0.0.1:8000/second').webContents);
    other.contents.close();
    assert.equal(other.frame.isDestroyed(), true, 'A page closed by script closes its window');
    await assert.rejects(call({ action: 'observe', tabId: second.tabId }), /closed/);
  } finally { await host.close(); }
});

test('toolbar controls drive only the person-controlled live page and resume only by its own trusted document', async () => {
  const { host, call, tabId, tab } = await setup();
  const state = async () => (await call({ action: 'list_tabs' })).tabs[0];
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  try {
    assert.equal(tab.frame.title, 'Unit fixture - Independent Browser');
    tab.toolbarAction('ready');
    let shown = tab.toolbarState();
    assert.equal(shown.url, 'http://127.0.0.1:8000/');
    assert.deepEqual([shown.editable, shown.navigable, shown.canGoBack, shown.chip.tone, shown.primary.action, shown.secondary.action],
      [false, false, false, 'agent', 'take-control', 'stop-automation']);
    for (const [action, value] of [['navigate', 'http://127.0.0.1:8000/agent-owned'], ['reload'], ['back']]) tab.toolbarAction(action, value);
    assert.equal(tab.contents.getURL(), 'http://127.0.0.1:8000/', 'Navigation controls are inert while the agent controls the page');
    assert.equal(tab.contents.reloads, 0);
    tab.toolbarAction('take-control', undefined, { url: 'forged-subframe' });
    await settle();
    assert.equal((await state()).mode, 'automation', 'Only the toolbar document itself can request handoff');
    tab.toolbarAction('take-control');
    await settle();
    assert.equal((await state()).mode, 'native-handoff');
    assert.equal(tab.exposed(), true);
    assert.equal(tab.contents.isFocused(), true);
    await assert.rejects(call({ action: 'observe', tabId }), /handoff/i);
    shown = tab.toolbarState();
    assert.deepEqual([shown.editable, shown.navigable, shown.chip.tone, shown.primary.action, shown.secondary],
      [true, true, 'user', 'resume', null]);
    tab.toolbarAction('navigate', 'localhost:5173/next');
    assert.equal(tab.contents.getURL(), 'http://localhost:5173/next');
    for (const typed of ['javascript:alert(1)', 'two words', 'file:///C:/private']) {
      tab.toolbarAction('navigate', typed);
      assert.equal(tab.toolbarState().invalid, true, typed);
      assert.equal(tab.contents.getURL(), 'http://localhost:5173/next', typed);
    }
    tab.toolbarAction('reload');
    assert.equal(tab.contents.reloads, 1);
    tab.toolbarAction('resume');
    await settle();
    assert.equal((await state()).mode, 'automation');
    assert.equal(tab.exposed(), false);
    assert.equal(tab.contents.isFocused(), false);
    assert.equal((await call({ action: 'observe', tabId })).disposition, 'observed');
    tab.toolbarAction('stop-automation');
    assert.equal((await state()).paused, 'explicit-stop');
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'x' }), /paused/);
    shown = tab.toolbarState();
    assert.deepEqual([shown.chip.tone, shown.primary.action, shown.secondary.action], ['stop', 'take-control', 'resume']);
    tab.toolbarAction('resume');
    await settle();
    assert.equal((await state()).paused, null);
    assert.equal((await call({ action: 'evaluate', tabId, expression: 'x' })).disposition, 'executed');
  } finally { await host.close(); }
});

test('native human handoff admits verified device requests without reopening automation or bypassing Stop', async () => {
  const { host, tab,tabId, call } = await setup();
  const adapter = host.permissions, profile = tab.profile;
  const page = drivers.get(tab.contents).page, frame = tab.contents.mainFrame;
  const origin = 'http://127.0.0.1:8000';
  const details = { isMainFrame: true, requestingUrl: frame.url };
  try {
    await call({ action: 'handoff', tabId });
    await assert.rejects(call({ action: 'evaluate', tabId, expression: 'must-stay-blocked' }), /paused/);
    const entries = [];
    for (const kind of ['hid', 'usb']) {
      assert.equal(profile.permissionCheck(tab.contents, kind, origin, details), true);
      assert.equal(profile.permissionCheck(tab.contents, kind, origin, { ...details, isMainFrame: false }), false);
      const deviceId = `native-${kind}`;
      const entry = adapter.makeRequest(page, frame, kind, { deviceId }, new Map([[deviceId, {}]]));
      assert.ok(entry, 'The human native window must be able to request scoped device authorization');
      assert.equal(adapter.live(entry), true);
      entries.push(entry);
    }
    assert.equal(profile.devicePermission, null);
    tab.frame.menu.items.find(i => i.label === 'Stop automation').click();
    for (const entry of entries) {
      assert.equal(entry.controller.signal.aborted, true);
      assert.equal(adapter.live(entry), false);
      assert.equal(profile.permissionCheck(tab.contents, entry.request.kind, origin, details), false);
      assert.equal(adapter.makeRequest(page, frame, entry.request.kind, entry.request.scope), null);
    }
  } finally { await host.close(); }
});

test('native exact-device selection alone authorizes HID/USB and exact positive reuse needs no extra dialog', async () => {
  const { host, tab,tabId, call } = await setup();
  const adapter = host.permissions, profile = tab.profile;
  const originalDialog = dialog.showMessageBox;
  let selections = 0, extraConsent = 0;
  dialog.showMessageBox = async () => { selections++; return { response: 1 }; };
  adapter.surface.prompt = async () => { extraConsent++; throw new Error('No additional HID/USB consent is requested'); };
  try {
    await call({ action: 'handoff', tabId });
    for (const kind of ['hid', 'usb']) {
      const device = { deviceId: `single-selection-${kind}`, vendorId: 1, productId: 2 };
      for (let attempt = 0; attempt < 2; attempt++) {
        let selected = 'not-called';
        await adapter.choose(kind, profile, { frame: tab.contents.mainFrame, deviceList: [device] }, id => { selected = id; });
        assert.equal(selected, device.deviceId);
      }
    }
    assert.equal(selections, 2, 'One initial selection for each exact HID/USB scope');
    assert.equal(extraConsent, 0, 'No second Allow dialog or Windows verification for devices');
    assert.equal(profile.devicePermission, null);
  } finally { dialog.showMessageBox = originalDialog; await host.close(); }
});

test('a genuine cancellation withdraws concurrent native choosers before any sibling can authorize', async () => {
  const { host, tab,tabId, call } = await setup();
  const adapter = host.permissions, profile = tab.profile;
  const originalDialog = dialog.showMessageBox;
  const releases = [deferred(), deferred()], options = [], selected = ['not-called', 'not-called'];
  dialog.showMessageBox = async (_window, value) => {
    const index = options.push(value) - 1;
    return releases[index].promise;
  };
  const pending = [];
  try {
    await call({ action: 'handoff', tabId });
    for (let index = 0; index < 2; index++) pending.push(adapter.choose('hid', profile, {
      frame: tab.contents.mainFrame,
      deviceList: [{ deviceId: 'concurrent-device', vendorId: 1, productId: 2 }],
    }, id => { selected[index] = id; }));
    assert.equal(options.length, 2);
    releases[0].resolve({ response: 0 });
    await tick();
    assert.deepEqual(selected, [undefined, undefined]);
    assert.equal(options[1].signal.aborted, true);
    releases[1].resolve({ response: 1 });
    await Promise.all(pending);
    assert.equal(adapter.choices.size, 0);
    assert.equal(adapter.deniedChoosers.size, 1);
  } finally {
    for (const release of releases) release.resolve({ response: 0 });
    await Promise.all(pending);
    dialog.showMessageBox = originalDialog;
    await host.close();
  }
});

test('device authorization rejects fabricated selection flags and mismatched displayed scopes', async () => {
  const { host, tab,tabId, call } = await setup();
  const adapter = host.permissions, profile = tab.profile;
  const device = { deviceId: 'native-exact-device', vendorId: 1, productId: 2 };
  const originalDialog = dialog.showMessageBox;
  dialog.showMessageBox = async () => ({ response: 1 });
  adapter.surface.prompt = async () => { throw new Error('Devices must not reach the generic consent surface'); };
  let selected = 'not-called';
  try {
    await call({ action: 'handoff', tabId });
    const entry = adapter.makeRequest(drivers.get(tab.contents).page, tab.contents.mainFrame, 'hid',
      device, new Map([[device.deviceId, device]]));
    entry.approved = true;
    entry.selection = { approved: true };
    assert.equal(await adapter.authorize(entry), null);
    assert.equal(entry.controller.signal.aborted, true);
    const authorize = adapter.authorize.bind(adapter);
    adapter.authorize = request => {
      request.request.scope = { ...request.request.scope, productId: 99 };
      return authorize(request);
    };
    await adapter.choose('hid', profile, { frame: tab.contents.mainFrame, deviceList: [device] }, id => { selected = id; });
    assert.equal(selected, undefined);
    assert.equal(adapter.choices.size, 0);
    await assert.rejects(call({ action: 'observe', tabId }), /handoff/i);
  } finally { dialog.showMessageBox = originalDialog; await host.close(); }
});

test('device reuse compares complete displayed metadata and accepts equivalent JSON representations', async () => {
  const { host, tab,tabId, call } = await setup();
  const adapter = host.permissions, profile = tab.profile;
  const originalDialog = dialog.showMessageBox;
  let selections = 0;
  dialog.showMessageBox = async () => { selections++; return { response: 1 }; };
  adapter.surface.prompt = async () => { throw new Error('No additional device confirmation'); };
  try {
    await call({ action: 'handoff', tabId });
    for (const [index, kind] of ['hid', 'usb'].entries()) {
      const device = {
        deviceId: `metadata-${kind}`, vendorId: 1, productId: 2,
        serialNumber: 'A', productName: 'Original',
        collections: [{ usagePage: 1, usage: 6 }],
      };
      const choose = async value => {
        let selected;
        await adapter.choose(kind, profile, { frame: tab.contents.mainFrame, deviceList: [value] }, id => { selected = id; });
        assert.equal(selected, device.deviceId);
      };
      await choose(device);
      assert.equal(selections, index * 4 + 1);
      await choose({
        collections: [{ usage: 6, usagePage: 1 }], productName: 'Original',
        serialNumber: 'A', productId: 2, vendorId: 1, deviceId: device.deviceId,
        absentDisplayField: undefined,
      });
      assert.equal(selections, index * 4 + 1, 'Equivalent displayed data must reuse the same consent');
      await choose({ ...device, serialNumber: 'B' });
      assert.equal(selections, index * 4 + 2, 'A changed serial requires a new selection');
      await choose({ ...device, serialNumber: 'B', productName: 'Renamed' });
      assert.equal(selections, index * 4 + 3, 'A changed display name requires a new selection');
      await choose({ ...device, serialNumber: 'B', productName: 'Renamed',
        collections: [{ usagePage: 1, usage: 7 }] });
      assert.equal(selections, index * 4 + 4, 'Changed nested metadata requires a new selection');
    }
  } finally { dialog.showMessageBox = originalDialog; await host.close(); }
});

test('device preference reuse requires the same successful scope, origin and connection', async () => {
  const { host, tab,tabId, call } = await setup();
  const adapter = host.permissions, profile = tab.profile;
  const originalDialog = dialog.showMessageBox;
  let selections = 0;
  dialog.showMessageBox = async () => { selections++; return { response: 1 }; };
  const choose = async device => {
    let selected;
    await adapter.choose('hid', profile, { frame: tab.contents.mainFrame, deviceList: [device] }, id => { selected = id; });
    assert.equal(selected, device.deviceId);
  };
  try {
    await call({ action: 'handoff', tabId });
    const device = { deviceId: 'scope-device', vendorId: 1, productId: 2 };
    await choose(device);
    await choose(device);
    assert.equal(selections, 1);
    await choose({ ...device, productId: 3 });
    assert.equal(selections, 2);
    await choose({ ...device, deviceId: 'different-exact-device' });
    assert.equal(selections, 3);
    await tab.contents.loadURL('https://different-origin.invalid/');
    await choose(device);
    assert.equal(selections, 4);
    const other = await setup();
    try {
      await other.call({ action: 'handoff', tabId: other.tabId });
      let selected;
      await other.host.permissions.choose('hid', other.tab.profile,
        { frame: other.tab.contents.mainFrame, deviceList: [device] }, id => { selected = id; });
      assert.equal(selected, device.deviceId);
      assert.equal(selections, 5);
    } finally { await other.host.close(); }
  } finally { dialog.showMessageBox = originalDialog; await host.close(); }
});

test('a genuine native device-selection cancellation stays final for its connection scope', async () => {
  const { host, tab,tabId, call } = await setup();
  const adapter = host.permissions, profile = tab.profile;
  const originalDialog = dialog.showMessageBox;
  let shown = 0;
  dialog.showMessageBox = async () => { shown++; return { response: 0 }; };
  try {
    await call({ action: 'handoff', tabId });
    for (let attempt = 0; attempt < 2; attempt++) {
      let selected = 'not-called';
      await adapter.choose('hid', profile, {
        frame: tab.contents.mainFrame,
        deviceList: [{ deviceId: 'declined-device', vendorId: 1, productId: 2 }],
      }, id => { selected = id; });
      assert.equal(selected, undefined);
    }
    assert.equal(shown, 1);
    assert.equal(adapter.deniedChoosers.size, 1);
    assert.equal(adapter.choices.size, 0);
  } finally { dialog.showMessageBox = originalDialog; await host.close(); }
});

test('native selection and authorization are irreversibly withdrawn at browser transitions', async t => {
  for (const stage of ['selection', 'authorization']) {
    for (const transition of ['resume', 'queued-resume', 'failed-resume', 'stop', 'navigation', 'disconnect', 'hide', 'close', 'revoke']) {
      await t.test(`${stage}: ${transition}`, async () => {
        const { host, tab,tabId, call } = await setup();
        const adapter = host.permissions, profile = tab.profile;
        const driver = drivers.get(tab.contents), page = driver.page, frame = tab.contents.mainFrame;
        const origin = 'http://127.0.0.1:8000';
        const key = JSON.stringify([origin, origin, 'hid']);
        const device = { deviceId: 'withdrawn-device', vendorId: 1, productId: 2 };
        const release = deferred();
        const originalDialog = dialog.showMessageBox;
        let options, pending, authorization, selected = 'not-called';
        dialog.showMessageBox = async (_window, value) => {
          options = value;
          return stage === 'selection' ? release.promise : { response: 1 };
        };
        adapter.surface.prompt = async () => { throw new Error('No second device confirmation'); };
        const authorize = adapter.authorize.bind(adapter);
        if (stage === 'authorization') adapter.authorize = async entry => {
          authorization = await authorize(entry);
          await release.promise;
          return authorization;
        };
        try {
          await call({ action: 'handoff', tabId });
          pending = adapter.choose('hid', profile, { frame, deviceList: [device] }, id => { selected = id; });
          await tick();
          assert.equal(selected, 'not-called');
          if (stage === 'selection') assert.ok(options?.signal, 'The native chooser must be abortable');
          else assert.ok(authorization, 'The broker grant is held before the final Chromium callback');
          if (transition === 'resume') await tab.frame.menu.items.find(i => i.label === 'Resume automation').click();
          else if (transition === 'queued-resume') {
            const idle = deferred();
            driver.waitForIdle = () => idle.promise;
            const returning = tab.frame.menu.items.find(i => i.label === 'Resume automation').click();
            try {
              assert.equal(selected, undefined, 'Withdrawal precedes the first queued return await');
              assert.equal(profile.permissionCheck(tab.contents, 'hid', origin, { isMainFrame: true }), false);
              await tick();
              assert.equal(adapter.makeRequest(page, frame, 'hid', { deviceId: 'new-request' }), null);
            } finally { idle.resolve(); await returning; }
          } else if (transition === 'failed-resume') {
            driver.capture = async () => { throw new Error('Fixture return failure'); };
            await tab.frame.menu.items.find(i => i.label === 'Resume automation').click();
            assert.equal((await call({ action: 'list_tabs' })).tabs[0].mode, 'draining');
            await call({ action: 'handoff', tabId });
          } else if (transition === 'stop') tab.frame.menu.items.find(i => i.label === 'Stop automation').click();
          else if (transition === 'navigation') tab.contents.emit('did-start-navigation',
            { url: frame.url, isSameDocument: false, isMainFrame: true, frame });
          else if (transition === 'disconnect') driver.detached();
          else if (transition === 'hide') {
            await call({ action: 'hide', tabId });
            await call({ action: 'show', tabId });
          } else if (transition === 'revoke') await call({ action: 'revoke' });
          else await call({ action: 'close_tab', tabId });
          assert.equal(selected, undefined, 'Withdrawal must settle Chromium without waiting for the old UI');
          assert.equal(options.signal.aborted, true);
          if (stage === 'authorization') {
            assert.equal(adapter.prompts.size, 0);
            // The broker already settled; the chooser fences its unpublished
            // result. Only connection revocation destroys the positive grant.
            assert.equal(authorization.aborted, transition === 'revoke');
          }
          release.resolve({ response: transition === 'failed-resume' ? 0 : 1 });
          await pending;
          assert.equal(selected, undefined);
          assert.equal(adapter.deniedChoosers.has(key), false, 'Technical withdrawal is not human refusal');
          assert.equal(adapter.choices.has(key), false, 'Only a completed live selection may populate the chooser cache');
        } finally {
          release.resolve({ response: 1 });
          await pending;
          dialog.showMessageBox = originalDialog;
          await host.close();
        }
      });
    }
  }
});

test('generic permissions retain their separate trusted consent path', async () => {
  const { host, tab } = await setup();
  const profile = tab.profile;
  const prompts = [];
  host.permissions.surface.prompt = async (descriptor, revalidate, decide) => {
    prompts.push({ descriptor, revalidate, decide });
  };
  try {
    let outcome = 'not-called';
    profile.permissionRequest(tab.contents, 'notifications', value => { outcome = value; },
      { isMainFrame: true, requestingUrl: tab.contents.mainFrame.url });
    await tick();
    assert.equal(outcome, 'not-called');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].descriptor.kind, 'notifications');
    assert.equal(prompts[0].revalidate(), true);
    prompts[0].decide(prompts[0].descriptor.id, 'approve');
    await tick();
    assert.equal(outcome, true);
  } finally { await host.close(); }
});

test('generic permission checks mirror only broker positive signals and chooser scopes use top-level origin', async () => {
  const { host, tab } = await setup();
  const adapter = host.permissions;
  const profile = tab.profile;
  const grant = new AbortController();
  adapter.broker.request = async () => ({ status: 'granted', signal: grant.signal });
  try {
    const origin = 'http://127.0.0.1:8000';
    const details = { isMainFrame: true, requestingUrl: tab.contents.mainFrame.url };
    assert.equal(profile.permissionCheck(tab.contents, 'geolocation', origin, details), false);
    assert.equal(await new Promise(resolve => profile.permissionRequest(tab.contents, 'geolocation', resolve, details)), true);
    assert.equal(profile.permissionCheck(tab.contents, 'geolocation', origin, details), true);
    assert.equal(profile.permissionCheck(tab.contents, 'geolocation', origin, { ...details, isMainFrame: false }), false);
    grant.abort();
    assert.equal(profile.permissionCheck(tab.contents, 'geolocation', origin, details), false);
    const page = drivers.get(tab.contents).page;
    const frame = { ...tab.contents.mainFrame, processId: 2, routingId: 77,
      url: 'https://requester.invalid/path', parent: { url: 'https://immediate-parent.invalid/' } };
    const entry = adapter.makeRequest(page, frame, 'usb', { deviceId: 'exact-device' }, new Map([['exact-device', {}]]));
    assert.equal(entry.request.embeddingOrigin, origin);
    assert.equal(entry.request.origin, 'https://requester.invalid');
  } finally { await host.close(); }
});

test('USB and HID native removal payloads withdraw exact offered devices before selection callback', async () => {
  const { host, tab } = await setup();
  const adapter = host.permissions, profile = tab.profile;
  const originalDialog = dialog.showMessageBox;
  dialog.showMessageBox = async () => ({ response: 1 });
  try {
    for (const kind of ['usb', 'hid']) {
      const device = { deviceId: `exact-${kind}`, vendorId: 1, productId: 2 };
      const started = deferred(), release = deferred();
      adapter.authorize = async entry => { started.resolve(entry); await release.promise; return adapter.live(entry) ? new AbortController().signal : null; };
      let chosen = 'not-called';
      const selection = adapter.choose(kind, profile, { frame: tab.contents.mainFrame, deviceList: [device] }, id => { chosen = id; });
      const entry = await started.promise;
      if (kind === 'usb') profile.emit('usb-device-removed', {}, device, tab.contents);
      else profile.emit('hid-device-removed', {}, { frame: tab.contents.mainFrame, device });
      assert.equal(entry.controller.signal.aborted, true);
      release.resolve();
      await selection;
      assert.equal(chosen, undefined);
    }
  } finally { dialog.showMessageBox = originalDialog; await host.close(); }
});

test.after(() => {
  for (const [key, value] of Object.entries(original)) FrameDriver.prototype[key] = value;
});
