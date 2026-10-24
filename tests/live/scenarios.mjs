import assert from 'node:assert/strict';
import { BrowserWindow, nativeImage } from 'electron';
import { bounded, pause } from '../../src/async.mjs';

async function until(predicate, label) {
  return bounded((async () => {
    for (;;) {
      const value = await predicate();
      if (value) return value;
      await pause(20);
    }
  })(), 8000, label);
}
function menu(window, label) {
  return window.__independentBrowserTestMenu.items.find(item => item.label === label).click();
}
export async function runAdditionalScenarios({ host, caller, tabId, port, check, permissionChecks, requestHeaders }) {
  const call = args => host.execute(args, caller);
  const guest = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === `http://127.0.0.1:${port}/`);
  const shell = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('data:text/html'));
  const state = async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === tabId);
  const resume = async () => {
    await menu(guest, 'Resume automation');
    await until(async () => (await state()).mode === 'automation' && !(await state()).paused, 'trusted resume');
    assert.equal(guest.isVisible(), false);
  };
  await resume();
  await check('actual hidden scroll updates DOM and screenshot; old viewport refs are rejected', async () => {
    const before = await call({ action: 'observe', tabId });
    const old = before.frames[0].elements.find(e => e.name === 'Add').ref;
    const after = await call({ action: 'scroll', tabId,
      point: { x: 700, y: 600, snapshotId: before.snapshotId }, deltaX: 0, deltaY: 320 });
    assert.equal(after.disposition, 'observed', JSON.stringify(after));
    assert.ok(after.frames[0].scrollY > before.frames[0].scrollY);
    assert.notEqual(after.screenshot.data, before.screenshot.data);
    await assert.rejects(call({ action: 'click', tabId, ref: old }), /stale/i);
    await call({ action: 'evaluate', tabId, expression: 'scrollTo(0,0)' });
  });
  await check('frame replacement invalidates authoritative refs', async () => {
    const before = await call({ action: 'observe', tabId });
    const frame = before.frames.find(f => f.elements.some(e => e.name === 'Frame clicked'));
    assert.ok(frame);
    const ref = frame.elements.find(e => e.name === 'Frame clicked').ref;
    const replacement = await call({ action: 'evaluate', tabId, expression: `new Promise(resolve=>{
      const next=document.createElement('iframe');
      next.onload=()=>resolve('replacement loaded');
      next.src='/frame?replacement';
      document.querySelector('iframe').replaceWith(next);
    })` });
    assert.equal(replacement.disposition, 'executed', JSON.stringify(replacement));
    await assert.rejects(call({ action: 'click', tabId, ref }), /stale/i);
  });
  await check('native viewport resize invalidates old combined-snapshot coordinates', async () => {
    // Isolate native resize from the preceding asynchronous iframe replacement.
    const opened = await call({ action: 'open', url: `http://127.0.0.1:${port}/permissions` });
    const resizedGuest = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === `http://127.0.0.1:${port}/permissions`);
    const before = await call({ action: 'observe', tabId: opened.tabId });
    const size = resizedGuest.getContentSize();
    const resize = async (width, height) => {
      await resizedGuest.webContents.executeJavaScript('globalThis.__fixtureResize=new Promise(resolve=>addEventListener("resize",()=>resolve(true),{once:true}));true');
      resizedGuest.setContentSize(width, height);
      await bounded(resizedGuest.webContents.executeJavaScript('globalThis.__fixtureResize'), 3000, 'native viewport resize delivered');
    };
    try {
      await resize(size[0] - 80, size[1] - 40);
      await assert.rejects(call({ action: 'click', tabId: opened.tabId, point: { x: 100, y: 100, snapshotId: before.snapshotId } }), /stale/i);
      await resize(...size);
      const fresh = await call({ action: 'observe', tabId: opened.tabId });
      assert.equal(fresh.disposition, 'observed');
      assert.equal(resizedGuest.isVisible(), false);
    } finally { await call({ action: 'close_tab', tabId: opened.tabId }); }
  });
  await check('actual parent-frame occlusion rejects child input before dispatch', async () => {
    const current = await call({ action: 'observe', tabId });
    const frame = current.frames.find(f => f.url.startsWith('http://localhost:'));
    const button = frame.elements.find(e => e.name === 'Frame clicked');
    assert.ok(button);
    await call({ action: 'evaluate', tabId, expression: `(()=>{
      const cover=document.createElement('div');cover.id='parent-cover';
      cover.style='position:fixed;inset:0;z-index:999999;background:rgba(255,0,0,.1)';
      document.body.append(cover);
    })()` });
    await assert.rejects(call({ action: 'click', tabId, target: {
      name: 'Frame clicked', exact: true, frameId: frame.frameId,
    } }), error => error.code === 'FRAME_OCCLUDED');
    await call({ action: 'evaluate', tabId, expression: 'document.querySelector("#parent-cover").remove()' });
  });
  await check('offscreen actions prepare fresh state, retain target identity and dispatch exactly once', async () => {
    for (const replace of [false, true]) {
      const opened = await call({ action: 'open', url: `http://127.0.0.1:${port}/preparation${replace ? '?replace=1' : ''}` });
      const oldRef = opened.frames[0].elements.find(e => e.name === 'Prepare target').ref;
      try {
        if (replace) {
          await assert.rejects(call({ action: 'click', tabId: opened.tabId,
            target: { role: 'button', name: 'Prepare target', exact: true } }), error =>
            error.requestedInputDispatched === false && ['attempted', 'completed'].includes(error.preparation));
        } else {
          const result = await call({ action: 'click', tabId: opened.tabId,
            target: { role: 'button', name: 'Prepare target', exact: true } });
          assert.equal(result.disposition, 'observed');
          await assert.rejects(call({ action: 'click', tabId: opened.tabId, ref: oldRef }), /stale/i);
          await assert.rejects(call({ action: 'click', tabId: opened.tabId,
            point: { x: 100, y: 100, snapshotId: opened.snapshotId } }), /stale/i);
        }
        const state = await call({ action: 'evaluate', tabId: opened.tabId,
          expression: '({count:Number(document.querySelector("#prepared").dataset.clicks),scroll:scrollY})' });
        assert.equal(state.value.count, replace ? 0 : 1, 'A replacement must never receive the pinned target action');
        assert.ok(state.value.scroll > 0, 'Preparation must actually bring the offscreen control into view');
      } finally { await call({ action: 'close_tab', tabId: opened.tabId }); }
    }
  });
  await check('native HID/USB chooser admission reaches exact main frame; test deny sink cancels before any selection/UI/grant', async () => {
    const isolated = await call({ action: 'open', url: `http://127.0.0.1:${port}/permissions` });
    const before = permissionChecks.length;
    const target = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === `http://127.0.0.1:${port}/permissions`);
    const productionChooser = host.permissions.choose;
    const admissions = [];
    // Main-process TEST-ONLY deny sink. Production select-* listeners still
    // prevent native default UI and run their real permission-check policy.
    // Never select an offered device, call the broker or invoke Windows Hello.
    host.permissions.choose = async (kind, _session, details, callback) => {
      admissions.push({ kind, exactMainFrame: details.frame === target.webContents.mainFrame,
        offeredList: Array.isArray(details.deviceList) });
      callback();
    };
    try {
      for (const kind of ['hid', 'usb']) {
        await call({ action: 'click', tabId: isolated.tabId, target: { name: `Request ${kind.toUpperCase()}`, exact: true } });
        await until(() => admissions.some(a => a.kind === kind), `native ${kind} chooser admission`);
      }
      assert.deepEqual(admissions, [
        { kind: 'hid', exactMainFrame: true, offeredList: true },
        { kind: 'usb', exactMainFrame: true, offeredList: true },
      ]);
      const result = await call({ action: 'evaluate', tabId: isolated.tabId, expression: `(async()=>{
        const count=async(p)=>p.then(d=>d.length,e=>({error:e.name,message:e.message}));
        return {hid:await count(navigator.hid.getDevices()),usb:await count(navigator.usb.getDevices())};
      })()` });
      assert.equal(result.disposition, 'executed', JSON.stringify({ result, checks: permissionChecks.slice(before) }));
      assert.deepEqual(result.value, { hid: 0, usb: 0 }, JSON.stringify({ result, checks: permissionChecks.slice(before) }));
      const native = permissionChecks.slice(before);
      assert.ok(native.some(c => c.kind === 'hid' && c.allowed && c.isMainFrame), JSON.stringify(native));
      assert.ok(native.some(c => c.kind === 'usb' && c.allowed && c.isMainFrame), JSON.stringify(native));
      assert.equal((await call({ action: 'permissions', tabId: isolated.tabId })).pending.length, 0);
      await call({ action: 'handoff', tabId: isolated.tabId });
      await assert.rejects(call({ action: 'evaluate', tabId: isolated.tabId, expression: 'must-stay-blocked' }), /paused/);
      const manualStart = permissionChecks.length;
      // TEST-ONLY native renderer input exercises permission admission during
      // handoff. The deny sink above still prevents selection, UI, Windows
      // approval and physical device I/O; no user-activation flag is injected.
      for (const kind of ['hid', 'usb']) {
        const point = await target.webContents.executeJavaScript(`(()=>{
          const button=Array.from(document.querySelectorAll('button'))
            .find(b=>b.textContent===${JSON.stringify(`Request ${kind.toUpperCase()}`)});
          const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
        })()`);
        target.focus();
        target.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        target.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
        await until(() => permissionChecks.slice(manualStart).some(c => c.kind === kind), `native handoff ${kind} check`);
        assert.ok(permissionChecks.slice(manualStart).some(c => c.kind === kind && c.allowed && c.isMainFrame),
          JSON.stringify(permissionChecks.slice(manualStart)));
        await until(() => admissions.filter(a => a.kind === kind).length === 2, `native handoff ${kind} deny sink`);
      }
      const manual = await target.webContents.executeJavaScript(`(async()=>{
        const count=async(p)=>p.then(d=>d.length,e=>({error:e.name,message:e.message}));
        return {hid:await count(navigator.hid.getDevices()),usb:await count(navigator.usb.getDevices())};
      })()`);
      assert.deepEqual(manual, { hid: 0, usb: 0 });
      const manualChecks = permissionChecks.slice(manualStart);
      assert.ok(manualChecks.some(c => c.kind === 'hid' && c.allowed && c.isMainFrame), JSON.stringify(manualChecks));
      assert.ok(manualChecks.some(c => c.kind === 'usb' && c.allowed && c.isMainFrame), JSON.stringify(manualChecks));
    } finally {
      host.permissions.choose = productionChooser;
      await call({ action: 'close_tab', tabId: isolated.tabId });
    }
  });
  await check('Chromium popup opener/postMessage, POST body, and about:blank document continuity', async () => {
    for (const [button, expected, opener] of [
      ['Popup', /Owned popup/, /popup-ready/],
      ['Post popup', /POST fixture POST proof=local-post/, /post:POST:proof=local-post/],
      ['Redirect popup', /Redirected popup/, /redirect-ready/],
      ['Blank popup', /Preserved blank popup/, /blank-ready/],
    ]) {
      const previous = new Set((await call({ action: 'list_tabs' })).tabs.map(t => t.tabId));
      const previousWindows = new Set(BrowserWindow.getAllWindows().map(w => w.id));
      const beforeCounts = new Map([...requestHeaders].map(([url, value]) => [url, value.count]));
      await call({ action: 'click', tabId, target: { name: button, exact: true } });
      const popup = await until(async () => (await call({ action: 'list_tabs' })).tabs.find(t => !previous.has(t.tabId)), 'owned native popup');
      const snapshot = await call({ action: 'observe', tabId: popup.tabId });
      assert.match(snapshot.frames[0].text, expected);
      const png = snapshot.screenshot;
      const bitmap = nativeImage.createFromBuffer(Buffer.from(png.data, 'base64')).toBitmap();
      assert.ok(png.viewportWidth > 220 && png.viewportHeight > 140, 'Fixture pixel must lie inside the popup viewport');
      const pixel = (Math.round(140 * png.pixelsPerCssY) * png.pixelWidth + Math.round(220 * png.pixelsPerCssX)) * 4;
      assert.deepEqual([...bitmap.subarray(pixel, pixel + 3)], [0, 190, 0],
        `Popup fixture pixel: ${JSON.stringify({ button, viewport: [png.viewportWidth, png.viewportHeight], image: [png.pixelWidth, png.pixelHeight] })}`);
      assert.equal(popup.mode, 'automation');
      const returned = await call({ action: 'observe', tabId });
      assert.match(returned.frames[0].text, opener);
      // document.write can inherit the opener's document URL while its native
      // WebContents remains about:blank. Identify the new native window itself.
      const nativeWindows = BrowserWindow.getAllWindows().filter(w =>
        !previousWindows.has(w.id) && !w.webContents.getURL().startsWith('data:'));
      assert.equal(nativeWindows.length, 1, `Expected one new native window for ${button}`);
      const popupWindow = nativeWindows[0];
      assert.equal(popupWindow.isVisible(), false);
      assert.equal(popupWindow.webContents.getUserAgent(), guest.webContents.getUserAgent());
      if (button !== 'Blank popup') {
        const route = new URL(popupWindow.webContents.getURL()).pathname;
        assert.equal(requestHeaders.get(route).userAgent, guest.webContents.getUserAgent());
        assert.equal(requestHeaders.get(route).count, (beforeCounts.get(route) ?? 0) + 1, 'Popup navigation must not be replayed');
      }
      if (button === 'Redirect popup') {
        assert.equal(requestHeaders.get('/popup-redirect').userAgent, guest.webContents.getUserAgent());
        assert.equal(requestHeaders.get('/popup-redirect').count, (beforeCounts.get('/popup-redirect') ?? 0) + 1);
        assert.equal(requestHeaders.get('/popup-redirect-target').count, (beforeCounts.get('/popup-redirect-target') ?? 0) + 1);
      }
      if (button === 'Popup') {
        const beforeNested = new Set((await call({ action: 'list_tabs' })).tabs.map(t => t.tabId));
        await call({ action: 'click', tabId: popup.tabId, target: { name: 'Nested child popup', exact: true } });
        const nested = await until(async () => (await call({ action: 'list_tabs' })).tabs.find(t => !beforeNested.has(t.tabId)), 'nested popup');
        const nestedObservation = await call({ action: 'observe', tabId: nested.tabId });
        assert.match(nestedObservation.frames[0].text, /Nested popup/);
        assert.equal(requestHeaders.get('/popup-nested').userAgent, guest.webContents.getUserAgent());
        assert.equal(requestHeaders.get('/popup-nested').count, (beforeCounts.get('/popup-nested') ?? 0) + 1);
        const forwarded = await call({ action: 'observe', tabId });
        assert.match(forwarded.frames[0].text, /nested-ready/);
        await call({ action: 'close_tab', tabId: nested.tabId });
      }
      if (button === 'Blank popup') {
        await pause(16000); // Past the top-level first-render timeout; popup has no such latch.
        assert.equal(popupWindow.isDestroyed(), false);
        await call({ action: 'handoff', tabId: popup.tabId });
        assert.equal(popupWindow.isVisible(), true, 'Native popup handoff must not require a first-render event');
        await assert.rejects(call({ action: 'observe', tabId: popup.tabId }), /handoff|paused/i);
      }
      await call({ action: 'close_tab', tabId: popup.tabId });
    }
  });
  await check('shell takeover drains actual dispatch, discards held gesture, and preserves native form and popup mode', async () => {
    const observed = await call({ action: 'observe', tabId });
    const oldRef = observed.frames[0].elements.find(e => e.name === 'Name').ref;
    const value = observed.frames[0].elements.find(e => e.name === 'Name').value;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const listener = (_event, method, params) => {
      if (method === 'Runtime.consoleAPICalled' && params.args?.[0]?.value === 'takeover-started') began();
    };
    guest.webContents.debugger.on('message', listener);
    const pending = call({ action: 'evaluate', tabId, expression: `(()=>{
      const o=document.querySelector('#result');o.dataset.once=String(Number(o.dataset.once||0)+1);
      console.log('takeover-started');const start=Date.now();while(Date.now()-start<5000){};return true;
    })()` });
    await bounded(started, 8000, 'actual slow dispatch started');
    shell.focus();
    shell.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
    await until(async () => (await state()).mode === 'draining', 'manual route drains immediately');
    assert.equal(guest.isVisible(), false, 'Guest must remain hidden while initiating mouse button is held');
    assert.equal((await pending).disposition, 'uncertain');
    await assert.rejects(call({ action: 'observe', tabId }), /handoff|paused/i);
    shell.webContents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
    await until(async () => (await state()).mode === 'native-handoff', 'actual fence and release drain');
    guest.webContents.debugger.removeListener('message', listener);
    assert.equal(guest.isVisible(), true);
    assert.equal(shell.isVisible(), false);
    assert.equal(await guest.webContents.executeJavaScript('document.querySelector("#name").value'), value);
    assert.equal(await guest.webContents.executeJavaScript('document.querySelector("#result").dataset.once'), '1');
    await guest.webContents.executeJavaScript('document.querySelector("#name").value="Native route fixture"');
    assert.equal(await shell.webContents.executeJavaScript('document.querySelector("#page").hasAttribute("src")'), false);
    await assert.rejects(call({ action: 'read', tabId }), /handoff|paused/i);
    assert.equal((await state()).url, null);
    const previous = new Set((await call({ action: 'list_tabs' })).tabs.map(t => t.tabId));
    await guest.webContents.executeJavaScript('window.open("/popup");true');
    const manualPopup = await until(async () => (await call({ action: 'list_tabs' })).tabs.find(t =>
      !previous.has(t.tabId) && t.mode === 'native-handoff' && t.visible), 'native popup inherits manual mode');
    const nativePopup = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === `http://127.0.0.1:${port}/popup`);
    assert.equal(nativePopup.isVisible(), true);
    await assert.rejects(call({ action: 'observe', tabId: manualPopup.tabId }), /handoff|paused/i);
    await call({ action: 'close_tab', tabId: manualPopup.tabId });
    assert.equal((await state()).mode, 'native-handoff');
    await resume();
    await assert.rejects(call({ action: 'click', tabId, ref: oldRef }), /stale/i);
    const returned = await call({ action: 'observe', tabId });
    assert.equal(returned.frames[0].elements.find(e => e.name === 'Name').value, 'Native route fixture');
  });
  await check('unexpected native exposure and shell minimization fail closed; show never clears Stop', async () => {
    guest.show();
    await until(async () => (await state()).paused === 'unexpected-native-exposure', 'unexpected exposure pause');
    assert.equal(guest.isVisible(), false);
    await assert.rejects(call({ action: 'click', tabId, target: { name: 'Add', exact: true } }), /paused/i);
    await resume();
    shell.minimize();
    await until(async () => (await state()).paused === 'presentation-minimized', 'minimized shell pause');
    assert.equal(guest.isVisible(), false);
    await call({ action: 'show', tabId });
    await assert.rejects(call({ action: 'evaluate', tabId, expression: '1' }), /paused/i);
    await resume();
    menu(guest, 'Stop automation');
    await call({ action: 'hide', tabId });
    await call({ action: 'show', tabId });
    await assert.rejects(call({ action: 'evaluate', tabId, expression: '1' }), /paused/i);
    await resume();
  });
  await check('pending page dialog is resolved only by explicit trusted human menu during handoff', async () => {
    await call({ action: 'click', tabId, target: { name: 'Dialog', exact: true } });
    const handoff = menu(guest, 'Human handoff');
    await menu(guest, 'Dismiss pending page dialog');
    await handoff;
    await resume();
    assert.ok((await call({ action: 'observe', tabId })).snapshotId);
  });
  await check('shell navigation and loss fail closed without affecting a different owned tab', async () => {
    const windows = new Set(BrowserWindow.getAllWindows());
    const extra = await call({ action: 'open', url: `http://127.0.0.1:${port}/permissions` });
    const extraGuest = BrowserWindow.getAllWindows().find(w => !windows.has(w) && w.webContents.getURL().startsWith('http:'));
    const extraShell = BrowserWindow.getAllWindows().find(w => !windows.has(w) && w.webContents.getURL().startsWith('data:'));
    await extraShell.webContents.executeJavaScript(`location.href=${JSON.stringify(`http://127.0.0.1:${port}/shell-escape`)}`);
    await until(async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === extra.tabId)?.paused === 'presentation-navigation-blocked', 'shell navigation admission stop');
    assert.ok(extraShell.webContents.getURL().startsWith('data:'));
    assert.equal(extraGuest.isVisible(), false);
    await assert.rejects(call({ action: 'evaluate', tabId: extra.tabId, expression: '1' }), /paused/i);
    extraShell.destroy();
    await assert.rejects(call({ action: 'observe', tabId: extra.tabId }), /closed/i);
    assert.ok((await call({ action: 'observe', tabId })).snapshotId);
  });
}
