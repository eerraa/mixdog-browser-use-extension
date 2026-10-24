import assert from 'node:assert/strict';
import { BrowserWindow, screen } from 'electron';
import { bounded, pause } from '../../src/async.mjs';
import { TOOLBAR_HEIGHT } from '../../src/browser/presentation.mjs';
import {
  assertNative, assertShielded, clickToolbar, menu, pageContents, pixelAt, presentationOf, pressToolbar, refOf, rendered, toolbarState,
} from './presentation.mjs';

async function until(predicate, label) {
  return bounded((async () => {
    for (;;) {
      const value = await predicate();
      if (value) return value;
      await pause(20);
    }
  })(), 8000, label);
}
export async function runAdditionalScenarios({ host, caller, tabId, port, check, permissionChecks, requestHeaders }) {
  const call = args => host.execute(args, caller);
  const guest = pageContents(`http://127.0.0.1:${port}/`);
  const { frame, shield } = presentationOf(guest);
  const state = async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === tabId);
  const resume = async () => {
    await menu(frame, 'Resume automation');
    await until(async () => (await state()).mode === 'automation' && !(await state()).paused, 'trusted resume');
    assertShielded(guest);
  };
  await resume();
  await check('a point from the latest screenshot scrolls once; refs survive scrolling; old screenshots cannot ground points', async () => {
    const before = await call({ action: 'observe', tabId, screenshot: true });
    const add = refOf(before, 'button', 'Add');
    const after = await call({ action: 'scroll', tabId,
      point: { x: 700, y: 600, snapshotId: before.snapshotId }, deltaX: 0, deltaY: 320, screenshot: true });
    assert.equal(after.disposition, 'executed', rendered(after));
    assert.ok(await guest.executeJavaScript('scrollY') > 0);
    assert.notEqual(after.screenshot.data, before.screenshot.data);
    await assert.rejects(call({ action: 'click', tabId, point: { x: 700, y: 600, snapshotId: before.snapshotId } }),
      error => error.code === 'STALE_COORDINATES');
    await call({ action: 'evaluate', tabId, expression: 'scrollTo(0,0)' });
    assert.equal((await call({ action: 'read', tabId, ref: add })).disposition, 'observed', 'a ref survives scrolling');
  });
  await check('frame replacement invalidates refs into the replaced document', async () => {
    const before = await call({ action: 'observe', tabId });
    const ref = refOf(before, 'button', 'Frame clicked');
    const replacement = await call({ action: 'evaluate', tabId, expression: `new Promise(resolve=>{
      const next=document.createElement('iframe');
      next.onload=()=>resolve('replacement loaded');
      next.src='/frame?replacement';
      document.querySelector('iframe').replaceWith(next);
    })` });
    assert.equal(replacement.disposition, 'executed', rendered(replacement));
    await assert.rejects(call({ action: 'click', tabId, ref }), error => error.code === 'STALE_REF' && error.requestedInputDispatched === false);
  });
  await check('native viewport resize invalidates points of the earlier screenshot', async () => {
    // Isolate native resize from the preceding asynchronous iframe replacement.
    const opened = await call({ action: 'open', url: `http://127.0.0.1:${port}/permissions` });
    const resizedPage = pageContents(`http://127.0.0.1:${port}/permissions`);
    const { frame: resizedFrame, view } = presentationOf(resizedPage);
    const before = await call({ action: 'observe', tabId: opened.tabId, screenshot: true });
    const size = resizedFrame.getContentSize();
    const resize = async (width, height) => {
      await resizedPage.executeJavaScript('globalThis.__fixtureResize=new Promise(resolve=>addEventListener("resize",()=>resolve(true),{once:true}));true');
      resizedFrame.setContentSize(width, height);
      await bounded(resizedPage.executeJavaScript('globalThis.__fixtureResize'), 3000, 'native viewport resize delivered');
    };
    try {
      await resize(size[0] - 80, size[1] - 40);
      const content = resizedFrame.contentView.getBounds();
      assert.deepEqual(view.getBounds(), { x: 0, y: TOOLBAR_HEIGHT, width: content.width, height: content.height - TOOLBAR_HEIGHT },
        'The page view must follow the resized frame below the toolbar');
      assertShielded(resizedPage, 'resized page');
      await assert.rejects(call({ action: 'click', tabId: opened.tabId, point: { x: 100, y: 100, snapshotId: before.snapshotId } }),
        error => error.code === 'STALE_COORDINATES');
      await resize(...size);
      const fresh = await call({ action: 'observe', tabId: opened.tabId });
      assert.equal(fresh.disposition, 'observed');
      assertShielded(resizedPage, 'restored page');
    } finally { await call({ action: 'close_tab', tabId: opened.tabId }); }
  });
  await check('actual parent-frame occlusion rejects child input before dispatch', async () => {
    const current = rendered(await call({ action: 'observe', tabId }));
    const frame = current.match(/(e\d+) iframe localhost:\d+/)?.[1];
    assert.ok(frame && /button "Frame clicked"/.test(current), current);
    await call({ action: 'evaluate', tabId, expression: `(()=>{
      const cover=document.createElement('div');cover.id='parent-cover';
      cover.style='position:fixed;inset:0;z-index:999999;background:rgba(255,0,0,.1)';
      document.body.append(cover);
    })()` });
    await assert.rejects(call({ action: 'click', tabId, target: {
      name: 'Frame clicked', exact: true, frame,
    } }), error => error.code === 'FRAME_OCCLUDED' && error.requestedInputDispatched === false);
    await call({ action: 'evaluate', tabId, expression: 'document.querySelector("#parent-cover").remove()' });
  });
  await check('offscreen actions scroll their own target into view and dispatch exactly once; a replacement never receives input', async () => {
    for (const replace of [false, true]) {
      const opened = await call({ action: 'open', url: `http://127.0.0.1:${port}/preparation${replace ? '?replace=1' : ''}` });
      assert.match(rendered(opened), /\n\+1 offscreen \(1 below\): button "Prepare target"/, rendered(opened));
      const found = await call({ action: 'observe', tabId: opened.tabId, find: 'Prepare target' });
      const ref = refOf(found, 'button', 'Prepare target');
      try {
        if (replace) {
          await assert.rejects(call({ action: 'click', tabId: opened.tabId, ref }), error =>
            error.requestedInputDispatched === false && error.preparation === 'scrolled');
        } else {
          const result = await call({ action: 'click', tabId: opened.tabId, ref });
          assert.equal(result.disposition, 'executed', rendered(result));
          await assert.rejects(call({ action: 'click', tabId: opened.tabId,
            point: { x: 100, y: 100, snapshotId: opened.snapshotId } }), error => error.code === 'POINTS_UNAVAILABLE');
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
    const target = pageContents(`http://127.0.0.1:${port}/permissions`);
    const productionChooser = host.permissions.choose;
    const admissions = [];
    // Main-process TEST-ONLY deny sink. Production select-* listeners still
    // prevent native default UI and run their real permission-check policy.
    // Never select an offered device, call the broker or invoke Windows Hello.
    host.permissions.choose = async (kind, _session, details, callback) => {
      admissions.push({ kind, exactMainFrame: details.frame === target.mainFrame,
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
      assertNative(target);
      await assert.rejects(call({ action: 'evaluate', tabId: isolated.tabId, expression: 'must-stay-blocked' }), /paused/);
      const manualStart = permissionChecks.length;
      // TEST-ONLY native renderer input exercises permission admission during
      // handoff, when the shield is removed from the live page. The deny sink
      // above still prevents selection, UI, Windows approval and physical
      // device I/O; no user-activation flag is injected.
      for (const kind of ['hid', 'usb']) {
        const point = await target.executeJavaScript(`(()=>{
          const button=Array.from(document.querySelectorAll('button'))
            .find(b=>b.textContent===${JSON.stringify(`Request ${kind.toUpperCase()}`)});
          const r=button.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
        })()`);
        target.focus();
        target.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        target.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
        await until(() => permissionChecks.slice(manualStart).some(c => c.kind === kind), `native handoff ${kind} check`);
        assert.ok(permissionChecks.slice(manualStart).some(c => c.kind === kind && c.allowed && c.isMainFrame),
          JSON.stringify(permissionChecks.slice(manualStart)));
        await until(() => admissions.filter(a => a.kind === kind).length === 2, `native handoff ${kind} deny sink`);
      }
      const manual = await target.executeJavaScript(`(async()=>{
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
      const snapshot = await call({ action: 'observe', tabId: popup.tabId, screenshot: true });
      assert.match(rendered(snapshot), expected);
      const png = snapshot.screenshot;
      assert.ok(png.width > 220 && png.height > 140, 'Fixture pixel must lie inside the popup viewport');
      assert.deepEqual(pixelAt(png, 220, 140), [0, 190, 0], `Popup fixture pixel: ${JSON.stringify({ button, size: [png.width, png.height] })}`);
      assert.equal(popup.mode, 'automation');
      const returned = await call({ action: 'observe', tabId, mode: 'text' });
      assert.match(rendered(returned), opener);
      // document.write can inherit the opener's document URL while its native
      // WebContents remains about:blank. Identify the new frame window itself;
      // its page is the adopted view below the shield.
      const popupFrames = BrowserWindow.getAllWindows().filter(w => !previousWindows.has(w.id));
      assert.equal(popupFrames.length, 1, `Expected one new frame window for ${button}`);
      const popupPage = popupFrames[0].contentView.children[0].webContents;
      assert.equal(presentationOf(popupPage).frame, popupFrames[0]);
      assertShielded(popupPage, `${button} popup`);
      assert.equal(popupPage.getUserAgent(), guest.getUserAgent());
      if (button !== 'Blank popup') {
        const route = new URL(popupPage.getURL()).pathname;
        assert.equal(requestHeaders.get(route).userAgent, guest.getUserAgent());
        assert.equal(requestHeaders.get(route).count, (beforeCounts.get(route) ?? 0) + 1, 'Popup navigation must not be replayed');
      }
      if (button === 'Redirect popup') {
        assert.equal(requestHeaders.get('/popup-redirect').userAgent, guest.getUserAgent());
        assert.equal(requestHeaders.get('/popup-redirect').count, (beforeCounts.get('/popup-redirect') ?? 0) + 1);
        assert.equal(requestHeaders.get('/popup-redirect-target').count, (beforeCounts.get('/popup-redirect-target') ?? 0) + 1);
      }
      if (button === 'Popup') {
        const beforeNested = new Set((await call({ action: 'list_tabs' })).tabs.map(t => t.tabId));
        await call({ action: 'click', tabId: popup.tabId, target: { name: 'Nested child popup', exact: true } });
        const nested = await until(async () => (await call({ action: 'list_tabs' })).tabs.find(t => !beforeNested.has(t.tabId)), 'nested popup');
        const nestedObservation = await call({ action: 'observe', tabId: nested.tabId });
        assert.match(rendered(nestedObservation), /Nested popup/);
        assert.equal(requestHeaders.get('/popup-nested').userAgent, guest.getUserAgent());
        assert.equal(requestHeaders.get('/popup-nested').count, (beforeCounts.get('/popup-nested') ?? 0) + 1);
        const forwarded = await call({ action: 'observe', tabId, mode: 'text' });
        assert.match(rendered(forwarded), /nested-ready/);
        await call({ action: 'close_tab', tabId: nested.tabId });
      }
      if (button === 'Blank popup') {
        // The document.write popup never commits its own navigation; handoff
        // must still reveal that same live page and keep observations private.
        await call({ action: 'handoff', tabId: popup.tabId });
        assertNative(popupPage, 'about:blank popup handoff');
        assert.equal(presentationOf(popupPage).frame, popupFrames[0]);
        await assert.rejects(call({ action: 'observe', tabId: popup.tabId }), error => error.code === 'PRIVATE_HANDOFF');
      }
      await call({ action: 'close_tab', tabId: popup.tabId });
    }
  });
  await check('shield takeover drains actual dispatch, discards held gesture, and preserves native form and popup mode', async () => {
    const observed = await call({ action: 'observe', tabId });
    const oldRef = refOf(observed, 'textbox', 'Name');
    const value = await guest.executeJavaScript('document.querySelector("#name").value');
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const listener = (_event, method, params) => {
      if (method === 'Runtime.consoleAPICalled' && params.args?.[0]?.value === 'takeover-started') began();
    };
    guest.debugger.on('message', listener);
    const pending = call({ action: 'evaluate', tabId, expression: `(()=>{
      const o=document.querySelector('#result');o.dataset.once=String(Number(o.dataset.once||0)+1);
      console.log('takeover-started');const start=Date.now();while(Date.now()-start<5000){};return true;
    })()` });
    await bounded(started, 8000, 'actual slow dispatch started');
    frame.focus();
    shield.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
    await until(async () => (await state()).mode === 'draining', 'manual route drains immediately');
    assert.equal((await state()).paused, 'shell-pointer-intervention');
    assertShielded(guest, 'page while initiating mouse button is held');
    assert.equal((await pending).disposition, 'uncertain');
    await assert.rejects(call({ action: 'observe', tabId }), error => error.code === 'PRIVATE_HANDOFF');
    shield.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
    await until(async () => (await state()).mode === 'native-handoff', 'actual fence and release drain');
    guest.debugger.removeListener('message', listener);
    assertNative(guest);
    assert.equal(guest.isFocused(), true, 'Native handoff focuses the same live page');
    assert.equal(await guest.executeJavaScript('document.querySelector("#name").value'), value);
    assert.equal(await guest.executeJavaScript('document.querySelector("#result").dataset.once'), '1');
    await guest.executeJavaScript('document.querySelector("#name").value="Native route fixture"');
    // No bitmap exists any more; privacy is that no observation/read crosses the handoff.
    await assert.rejects(call({ action: 'observe', tabId }), error => error.code === 'PRIVATE_HANDOFF');
    await assert.rejects(call({ action: 'read', tabId }), error => error.code === 'PRIVATE_HANDOFF');
    assert.equal((await state()).url, null);
    const previous = new Set((await call({ action: 'list_tabs' })).tabs.map(t => t.tabId));
    await guest.executeJavaScript('window.open("/popup");true');
    const manualPopup = await until(async () => (await call({ action: 'list_tabs' })).tabs.find(t =>
      !previous.has(t.tabId) && t.mode === 'native-handoff' && t.visible), 'native popup inherits manual mode');
    assertNative(pageContents(`http://127.0.0.1:${port}/popup`), 'inherited native popup');
    await assert.rejects(call({ action: 'observe', tabId: manualPopup.tabId }), error => error.code === 'PRIVATE_HANDOFF');
    await call({ action: 'close_tab', tabId: manualPopup.tabId });
    assert.equal((await state()).mode, 'native-handoff');
    await resume();
    await assert.rejects(call({ action: 'click', tabId, ref: oldRef }), error => error.code === 'STALE_REF'
      && /earlier presentation/.test(error.message), 'refs from before a handoff never act after it');
    const returned = await call({ action: 'observe', tabId });
    assert.match(rendered(returned), /textbox "Name"[^\n]*="Native route fixture"/);
  });
  await check('shield removal before admission, frame minimize and unintended hide fail closed; show never clears Stop', async () => {
    // Replaces the old guest.show() exposure: the page becomes reachable by OS
    // input only if its shield is removed. The next admission must fail closed
    // before any dispatch, and the fail-closed path re-covers the page.
    const count = () => guest.executeJavaScript('document.querySelector("#result").textContent');
    const before = await count();
    presentationOf(guest).shieldView.setVisible(false);
    await assert.rejects(call({ action: 'click', tabId, target: { name: 'Add', exact: true } }),
      error => error.code === 'UNSAFE_PRESENTATION');
    assert.equal((await state()).paused, 'page-not-shielded');
    assertShielded(guest, 'page after shield removal fail-closed');
    assert.equal(await count(), before, 'An unshielded admission must never dispatch');
    await assert.rejects(call({ action: 'click', tabId, target: { name: 'Add', exact: true } }), /paused/i);
    await resume();
    frame.minimize();
    await until(async () => (await state()).paused === 'presentation-minimized', 'minimized frame pause');
    assert.equal(presentationOf(guest).shieldView.getVisible(), true);
    assert.equal(guest.isFocused(), false);
    await call({ action: 'show', tabId });
    await assert.rejects(call({ action: 'evaluate', tabId, expression: '1' }), /paused/i);
    await resume();
    frame.hide();
    await until(async () => (await state()).paused === 'presentation-hidden', 'unintended frame hide pause');
    assert.equal(presentationOf(guest).shieldView.getVisible(), true);
    await assert.rejects(call({ action: 'evaluate', tabId, expression: '1' }), /paused/i);
    await resume();
    menu(frame, 'Stop automation');
    await call({ action: 'hide', tabId });
    await call({ action: 'show', tabId });
    await assert.rejects(call({ action: 'evaluate', tabId, expression: '1' }), /paused/i);
    assert.equal((await state()).paused, 'explicit-stop');
    await resume();
  });
  await check('pending page dialog is resolved only by explicit trusted human menu during handoff', async () => {
    await call({ action: 'click', tabId, target: { name: 'Dialog', exact: true } });
    const handoff = menu(frame, 'Human handoff');
    await menu(frame, 'Dismiss pending page dialog');
    await handoff;
    await resume();
    assert.ok((await call({ action: 'observe', tabId })).snapshotId);
  });
  await check('frame born under an always-on-top cover still presents: open, observe and input succeed', async () => {
    // Production case: the companion's new frame can appear fully occluded
    // (always-on-top or foreground windows). Windows native occlusion must not
    // stop its first frame, or observation never captures it.
    // Cover every display, so the frame is occluded wherever Windows places it.
    const displays = screen.getAllDisplays().map(display => display.bounds);
    const covers = displays.map(bounds => new BrowserWindow({ ...bounds, show: false, frame: false, alwaysOnTop: true,
      focusable: false, skipTaskbar: true, backgroundColor: '#202020',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } }));
    const url = `http://127.0.0.1:${port}/?covered=1`;
    let coveredTab;
    const pixel = (observation, expected, label) => assert.deepEqual(pixelAt(observation.screenshot, 820, 40), expected, label);
    try {
      for (const cover of covers) {
        cover.setAlwaysOnTop(true, 'screen-saver');
        await cover.loadURL('data:text/html,<body style="margin:0;background:#202020">');
        cover.showInactive();
      }
      await pause(500);
      assert.ok(covers.every(cover => cover.isVisible()));
      const opened = await call({ action: 'open', url, screenshot: true });
      coveredTab = opened.tabId;
      assert.deepEqual([opened.disposition, opened.observed], ['executed', undefined], rendered(opened));
      const page = pageContents(url);
      const { frame: coveredFrame } = presentationOf(page);
      const content = coveredFrame.getContentBounds();
      const inside = bounds => content.x >= bounds.x && content.y >= bounds.y && content.x + content.width <= bounds.x + bounds.width
        && content.y + content.height <= bounds.y + bounds.height;
      assert.ok(displays.some(inside), `The new frame must be born under a cover: ${JSON.stringify({ content, displays })}`);
      assert.ok(covers.every(cover => cover.isVisible()), 'The covers must still be on top while the frame presents');
      assertShielded(page, 'covered page');
      pixel(opened, [0, 0, 220], 'Covered first capture must contain current red fixture pixels');
      const observed = await call({ action: 'observe', tabId: coveredTab });
      assert.equal(observed.disposition, 'observed');
      const clicked = await call({ action: 'click', tabId: coveredTab, target: { name: 'Add', exact: true }, screenshot: true });
      assert.deepEqual([clicked.disposition, clicked.observed], ['executed', undefined], rendered(clicked));
      assert.match(rendered(clicked), /status ="1"/);
      pixel(clicked, [0, 190, 0], 'Covered click capture must show new green fixture pixels');
      assert.equal(await page.executeJavaScript('document.querySelector("#result").textContent'), '1');
    } finally {
      for (const cover of covers) cover.destroy();
      if (coveredTab) await call({ action: 'close_tab', tabId: coveredTab });
    }
  });
  await check('toolbar: read-only in automation; take-control, address Enter, back, reload, resume and stop-automation', async () => {
    const first = `http://127.0.0.1:${port}/toolbar-a`, second = `http://127.0.0.1:${port}/toolbar-b`;
    const opened = await call({ action: 'open', url: first });
    const id = opened.tabId;
    const tab = async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === id);
    const page = pageContents(first);
    const { frame: toolbarFrame, toolbar } = presentationOf(page);
    const ui = predicate => until(async () => { const value = await toolbarState(toolbar); return predicate(value) && value; }, 'toolbar state');
    const requests = route => requestHeaders.get(route)?.count ?? 0;
    try {
      // 1. Automation: no human navigation controls, agent chip, page title.
      let current = await ui(s => s.tone === 'agent' && s.address === first);
      assert.deepEqual(current, { address: first, readOnly: true, back: true, forward: true, reload: true,
        tone: 'agent', primary: 'take-control', secondary: 'stop-automation' });
      assert.equal(toolbarFrame.getTitle(), 'Toolbar fixture A - Independent Browser');
      assertShielded(page, 'toolbar fixture page');
      // 2. Take control from the toolbar: native handoff on the same page.
      toolbarFrame.focus();
      await clickToolbar(toolbar, '#primary[data-action="take-control"]');
      await until(async () => (await tab()).mode === 'native-handoff', 'toolbar take-control');
      assert.equal((await tab()).paused, 'human-handoff');
      assertNative(page, 'toolbar take-control');
      assert.equal(page.isFocused(), true, 'Take control focuses the live page');
      await assert.rejects(call({ action: 'observe', tabId: id }), error => error.code === 'PRIVATE_HANDOFF');
      current = await ui(s => s.tone === 'user' && !s.readOnly);
      assert.equal(current.reload, false);
      assert.equal(current.primary, 'resume');
      assert.equal(current.secondary, null);
      // 3. Native address entry navigates that same page; back returns; reload reloads.
      toolbar.focus();
      await clickToolbar(toolbar, '#address');
      pressToolbar(toolbar, 'A', ['control']);
      await toolbar.insertText(second);
      await until(() => toolbar.executeJavaScript('document.activeElement.id==="address"&&document.activeElement.value')
        .then(value => value === second), 'typed address');
      const secondBefore = requests('/toolbar-b');
      pressToolbar(toolbar, 'Enter');
      await until(() => page.getURL() === second && !page.isLoading()
        && toolbarFrame.getTitle() === 'Toolbar fixture B - Independent Browser', 'address navigation');
      assert.equal(presentationOf(page).frame, toolbarFrame, 'Address navigation must keep the same page and frame');
      assert.equal(requests('/toolbar-b'), secondBefore + 1);
      assert.equal((await tab()).mode, 'native-handoff');
      assertNative(page, 'after address navigation');
      await ui(s => s.address === second && !s.back);
      await clickToolbar(toolbar, '#back');
      await until(() => page.getURL() === first && !page.isLoading()
        && toolbarFrame.getTitle() === 'Toolbar fixture A - Independent Browser', 'toolbar back');
      await ui(s => s.address === first && !s.forward && !s.reload);
      await page.executeJavaScript('window.__toolbarReloadMarker=true');
      const firstBefore = requests('/toolbar-a');
      await clickToolbar(toolbar, '#reload');
      await until(async () => requests('/toolbar-a') === firstBefore + 1 && !page.isLoading()
        && await page.executeJavaScript('window.__toolbarReloadMarker!==true'), 'toolbar reload');
      assert.equal(toolbarFrame.getTitle(), 'Toolbar fixture A - Independent Browser');
      assert.equal(presentationOf(page).frame, toolbarFrame);
      // 4. Toolbar resume returns to automation and a fresh observe succeeds.
      await ui(s => s.primary === 'resume');
      await clickToolbar(toolbar, '#primary[data-action="resume"]');
      await until(async () => { const t = await tab(); return t.mode === 'automation' && !t.paused; }, 'toolbar resume');
      assertShielded(page, 'after toolbar resume');
      const fresh = await call({ action: 'observe', tabId: id });
      assert.match(rendered(fresh), /h1 "Toolbar page A"/);
      current = await ui(s => s.tone === 'agent');
      assert.equal(current.readOnly, true);
      assert.equal(current.back, true);
      // 5. Toolbar stop-automation pauses; a later toolbar resume clears it.
      await clickToolbar(toolbar, '#secondary[data-action="stop-automation"]');
      await until(async () => (await tab()).paused === 'explicit-stop', 'toolbar stop-automation');
      assert.equal((await tab()).mode, 'automation');
      await assert.rejects(call({ action: 'evaluate', tabId: id, expression: '1' }), /paused/i);
      assertShielded(page, 'stopped page');
      await ui(s => s.tone === 'stop' && s.readOnly);
      await clickToolbar(toolbar, 'button[data-action="resume"]');
      await until(async () => { const t = await tab(); return t.mode === 'automation' && !t.paused; }, 'toolbar resume after stop');
      assert.equal((await call({ action: 'evaluate', tabId: id, expression: '1+1' })).value, 2);
      await ui(s => s.tone === 'agent');
    } finally { await call({ action: 'close_tab', tabId: id }); }
  });
  await check('toolbar/shield navigation, renderer and shield loss fail closed without affecting a different owned tab', async () => {
    const extra = await call({ action: 'open', url: `http://127.0.0.1:${port}/permissions` });
    const extraPage = pageContents(`http://127.0.0.1:${port}/permissions`);
    const { frame: extraFrame, toolbar, shield: extraShield } = presentationOf(extraPage);
    const paused = async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === extra.tabId)?.paused;
    const otherTabUnaffected = async () => {
      assert.equal((await state()).paused, null);
      assert.ok((await call({ action: 'observe', tabId })).snapshotId);
    };
    for (const [name, contents] of [['toolbar', toolbar], ['shield', extraShield]]) {
      await contents.executeJavaScript(`location.href=${JSON.stringify(`http://127.0.0.1:${port}/${name}-escape`)}`);
      await until(async () => await paused() === 'presentation-navigation-blocked', `${name} navigation admission stop`);
      assert.ok(contents.getURL().startsWith('data:'));
      assertShielded(extraPage, `page after ${name} navigation`);
      await assert.rejects(call({ action: 'evaluate', tabId: extra.tabId, expression: '1' }), /paused/i);
      await otherTabUnaffected();
      await menu(extraFrame, 'Resume automation');
      await until(async () => await paused() === null, `resume after ${name} navigation`);
    }
    toolbar.forcefullyCrashRenderer();
    await until(async () => await paused() === 'presentation-renderer-lost', 'toolbar renderer loss stop');
    await assert.rejects(call({ action: 'evaluate', tabId: extra.tabId, expression: '1' }), /paused/i);
    await otherTabUnaffected();
    extraShield.close();
    await until(async () => await paused() === 'presentation-lost', 'shield loss stop');
    await assert.rejects(call({ action: 'evaluate', tabId: extra.tabId, expression: '1' }), /paused/i);
    await otherTabUnaffected();
    extraFrame.destroy();
    await until(() => extraPage.isDestroyed(), 'closing the frame closes its page');
    await assert.rejects(call({ action: 'observe', tabId: extra.tabId }), /closed/i);
    await otherTabUnaffected();
  });
}
