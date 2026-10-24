import { app, BrowserWindow, Menu, session } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserHost } from '../../src/browser/host.mjs';
import { BrowserPolicy } from '../../src/browser/policy.mjs';
import { configureBrowserIdentity } from '../../src/browser/user-agent.mjs';
import { runAdditionalScenarios } from './scenarios.mjs';
import { assertShielded, pageContents, pixelAt, presentationOf, refOf, rendered, toolbarPreloadPath } from './presentation.mjs';
import { bounded, pause } from '../../src/async.mjs';

const dataDir = process.argv[2];
const identityBaselineMode = process.argv[3] === 'baseline';
app.setName('Independent Windows Browser');
if (!identityBaselineMode) configureBrowserIdentity(app);
app.setPath('userData', path.join(dataDir, 'electron'));
// Capture only native Menu objects inside this private main-process harness.
// Production host exposes no automation API for these trusted callbacks.
const setMenu = BrowserWindow.prototype.setMenu;
BrowserWindow.prototype.setMenu = function(menu) {
  this.__independentBrowserTestMenu = menu;
  return setMenu.call(this, menu);
};
const popupPaint = '<div style="position:absolute;left:200px;top:120px;width:80px;height:60px;background:rgb(0,190,0)"></div>';
const fixture = `<!doctype html><html><body>
<label>Name <input id="name"></label><input type="password" value="DO_NOT_OBSERVE_PASSWORD">
<button id="add" onclick="document.querySelector('#result').textContent=++window.count;document.querySelector('#paint').style.background='rgb(0,190,0)'">Add</button>
<div id="paint" style="position:absolute;left:800px;top:20px;width:80px;height:60px;background:rgb(220,0,0)"></div>
<button onclick="alert('fixture dialog')">Dialog</button>
<button onclick="window.open('/popup')">Popup</button>
<button onclick="window.open('/popup-redirect')">Redirect popup</button>
<button onclick="const w=window.open('about:blank');w.document.write('<h1>Preserved blank popup</h1>${popupPaint.replaceAll('"', '&quot;')}');w.opener.postMessage('blank-ready',location.origin)">Blank popup</button>
<form method="post" action="/popup-post" target="post-window"><input type="hidden" name="proof" value="local-post"><button>Post popup</button></form>
<output id="popup-result"></output>
<button>Duplicate</button><button>Duplicate</button>
<select aria-label="Choice" onchange="document.querySelector('#choice').textContent=this.value"><option>a</option><option>b</option></select>
<input type="file" aria-label="File" onchange="document.querySelector('#file').textContent=this.files[0]?.name">
<a download href="/download">Download fixture</a>
<output id="result">0</output><output id="choice"></output><output id="file"></output>
<iframe src="/frame"></iframe><iframe src="CROSS/frame"></iframe>
<script>window.count=0;addEventListener('message',e=>{if(e.origin===location.origin)document.querySelector('#popup-result').textContent=e.data});
if(!/Electron/.test(navigator.userAgent))document.body.append(Object.assign(document.createElement('button'),{id:'ua-authorize',textContent:'UA authorization fixture'}));
</script>
<div style="height:1800px">Scroll fixture</div></body></html>`;
const servers = [];
const requestHeaders = new Map();
function serve() {
  const server = http.createServer((req, res) => {
    requestHeaders.set(req.url, {
      userAgent: req.headers['user-agent'], language: req.headers['accept-language'],
      hints: req.headers['sec-ch-ua'], platform: req.headers['sec-ch-ua-platform'],
      fullVersion: req.headers['sec-ch-ua-full-version-list'],
      count: (requestHeaders.get(req.url)?.count ?? 0) + 1,
    });
    res.setHeader('Accept-CH', 'Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Full-Version-List');
    if (req.url === '/popup-redirect') {
      res.writeHead(302, { Location: '/popup-redirect-target' }); res.end(); return;
    }
    if (req.url === '/popup-redirect-target') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<h1>Redirected popup</h1>${popupPaint}<script>opener.postMessage('redirect-ready',location.origin)</script>`); return;
    }
    if (req.url === '/popup-nested') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<h1>Nested popup</h1>${popupPaint}<script>opener.postMessage('nested-ready',location.origin)</script>`); return;
    }
    if (req.url === '/popup-post') {
      let body = '';
      req.on('data', data => { body += data; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<h1>POST fixture ${req.method} ${body}</h1>${popupPaint}<script>opener.postMessage('post:${req.method}:${body}',location.origin)</script>`);
      });
      return;
    }
    if (req.url === '/download') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="fixture.txt"' });
      return res.end('local fixture download');
    }
    res.setHeader('Content-Type', 'text/html');
    if (['/preparation', '/preparation?replace=1'].includes(req.url)) return res.end(`<!doctype html>
      <title>Long-form preparation fixture</title><h1>Long-form application fixture</h1>
      <div style="height:1800px">The next control is below the initial viewport.</div>
      <button id="prepared" data-clicks="0"
        onclick="this.dataset.clicks=String(Number(this.dataset.clicks)+1)">Prepare target</button>
      <script>${req.url.endsWith('?replace=1') ? `
        addEventListener('scroll',()=>{const old=document.querySelector('#prepared');old.replaceWith(old.cloneNode(true));},{once:true});
      ` : ''}</script>`);
    if (['/toolbar-a', '/toolbar-b'].includes(req.url)) {
      const name = req.url.endsWith('a') ? 'A' : 'B';
      return res.end(`<!doctype html><title>Toolbar fixture ${name}</title><h1>Toolbar page ${name}</h1>`);
    }
    if (req.url === '/permissions') return res.end(`<!doctype html><h1>Local native permission admission fixture</h1>
      <button onclick="navigator.hid.requestDevice({filters:[]}).catch(()=>{})">Request HID</button>
      <button onclick="navigator.usb.requestDevice({filters:[]}).catch(()=>{})">Request USB</button>`);
    res.end(req.url.split('?')[0] === '/frame' ? '<button onclick="this.textContent=\'Frame clicked\'">Frame button</button>'
      : req.url === '/popup' ? '<h1>Owned popup</h1>' + popupPaint
        + '<button onclick="window.open(\'/popup-nested\')">Nested child popup</button>'
        + '<script>opener.postMessage("popup-ready",location.origin);addEventListener("message",e=>{if(e.origin===location.origin&&e.data==="nested-ready")opener.postMessage(e.data,location.origin)})</script>'
        : fixture.replace('CROSS', cross));
  });
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
let cross = '';
let host;
const cases = [];
const check = async (name, fn) => {
  await fn();
  cases.push(name);
  console.log(`PASS ${name}`);
};
async function run() {
try {
  console.log('BROWSER_HARNESS_STARTED');
  const otherPort = await serve();
  cross = `http://localhost:${otherPort}`;
  const port = await serve();
  await app.whenReady();
  const permissionChecks = [];
  const sessionPrototype = Object.getPrototypeOf(session.defaultSession);
  const originalCheck = sessionPrototype.setPermissionCheckHandler;
  sessionPrototype.setPermissionCheckHandler = function(handler) {
    return originalCheck.call(this, handler && ((...args) => {
      const allowed = handler(...args);
      permissionChecks.push({ kind: args[1], allowed, isMainFrame: args[3].isMainFrame,
        requestingOrigin: args[2], requestingUrl: args[3].requestingUrl, securityOrigin: args[3].securityOrigin });
      return allowed;
    }));
  };
  host = new BrowserHost({
    dataDir: path.join(dataDir, 'profiles'),
    policy: BrowserPolicy.manual(),
    consentHelperPath: path.resolve('build/native-consent.exe'),
    toolbarPreloadPath,
    onRevokeConnection: async () => { throw new Error('Live test must not revoke gateway'); },
  });
  const caller = { sessionId: 'local-test', callId: 'test', signal: new AbortController().signal, assertLive() {} };
  const call = args => host.execute(args, caller);
  let tabId, observation;
  await check('open, isolated security settings, masked observation and screenshot', async () => {
    observation = await call({ action: 'open', url: `http://127.0.0.1:${port}`, screenshot: true });
    tabId = observation.tabId;
    assert.equal(observation.disposition, 'executed', rendered(observation));
    assert.ok(observation.snapshotId);
    assert.ok(observation.screenshot.data.length);
    assert.match(rendered(observation), /\ne\d+ textbox "Name"\n/);
    assert.match(rendered(observation), /textbox sensitive\n|textbox "[^"]*" sensitive\n/, 'the password field is marked, never valued');
    assert.ok(!JSON.stringify(observation).includes('DO_NOT_OBSERVE_PASSWORD'));
    // Page code never runs beside a filled sensitive field; the agent clears
    // it with an ordinary fill, and page code runs again.
    const refused = await call({ action: 'evaluate', tabId, expression: 'document.title' }).catch(error => error);
    assert.deepEqual([refused.code, refused.requestedInputDispatched], ['SENSITIVE_PRESENT', false]);
    const password = rendered(observation).match(/(e\d+) textbox(?: "[^"]*")? sensitive(?=\n|$)/m)[1];
    assert.equal((await call({ action: 'fill', tabId, ref: password, text: '', snapshot: 'none' })).disposition, 'executed');
    assert.equal((await call({ action: 'evaluate', tabId, expression: '1+1', snapshot: 'none' })).value, 2);
    const page = pageContents(`http://127.0.0.1:${port}/`);
    const prefs = page.getLastWebPreferences();
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.webSecurity, true);
    assert.equal(page.getBackgroundThrottling(), false);
    assertShielded(page);
    const { toolbar, shield } = presentationOf(page);
    for (const chrome of [toolbar, shield]) {
      const chromePrefs = chrome.getLastWebPreferences();
      assert.equal(chromePrefs.nodeIntegration, false);
      assert.equal(chromePrefs.contextIsolation, true);
      assert.equal(chromePrefs.sandbox, true);
      assert.ok(chrome.getURL().startsWith('data:text/html'));
      assert.notEqual(chrome.session, page.session, 'Plugin chrome must never share the page profile');
    }
    assert.deepEqual(pixelAt(observation.screenshot, 820, 40), [0, 0, 220], 'Shielded first capture must contain current red fixture pixels');
  });
  const authorizationFound = async () => /: 1 match\n/.test(rendered(await call({ action: 'observe', tabId, find: 'UA authorization fixture' })));
  if (identityBaselineMode) {
    const guest = pageContents(`http://127.0.0.1:${port}/`);
    const { toolbar } = presentationOf(guest);
    const identity = await guest.executeJavaScript('({userAgent:navigator.userAgent,brands:navigator.userAgentData.brands,hidAvailable:typeof navigator.hid==="object"})');
    await guest.executeJavaScript('fetch("/ua-hints-baseline").then(r=>r.text())');
    console.log('UA_BASELINE_RESULT', JSON.stringify({
      ...identity, root: requestHeaders.get('/'), hints: requestHeaders.get('/ua-hints-baseline'),
      authorizePresent: await authorizationFound(),
      fallback: app.userAgentFallback, presentation: toolbar.getUserAgent(),
    }));
    await host.close();
    for (const server of servers) server.close();
    app.exit(0);
    return;
  }
  const baseline = JSON.parse(await readFile(process.argv[3], 'utf8'));
  await check('companion Chromium identity enables browser UI and preserves headers, locale and observable hints', async () => {
    assert.match(baseline.userAgent, /Electron\//, 'The separate untouched process must reproduce the desktop-client branch');
    assert.equal(baseline.hidAvailable, true);
    assert.equal(baseline.authorizePresent, false);
    assert.ok(await authorizationFound(), 'Container detection must not hide the browser authorization control');
    const guest = pageContents(`http://127.0.0.1:${port}/`);
    const { toolbar, shield } = presentationOf(guest);
    const identity = await guest.executeJavaScript('({userAgent:navigator.userAgent,brands:navigator.userAgentData.brands})');
    assert.doesNotMatch(identity.userAgent, /Electron\/|IndependentWindowsBrowser\//);
    assert.ok(identity.userAgent.includes(`Chrome/${process.versions.chrome}`));
    assert.ok(identity.userAgent.includes(baseline.userAgent.match(/\([^)]+\)/)[0]));
    assert.equal(guest.getUserAgent(), identity.userAgent);
    assert.equal(requestHeaders.get('/').userAgent, identity.userAgent);
    assert.equal(baseline.root.userAgent, baseline.userAgent);
    assert.equal(requestHeaders.get('/').language, baseline.root.language);
    assert.deepEqual(identity.brands, baseline.brands, 'Client Hints must not be fabricated or overridden');
    await guest.executeJavaScript('fetch("/ua-hints-guest").then(r=>r.text())');
    const guestHints = requestHeaders.get('/ua-hints-guest');
    assert.match(guestHints.hints, /Chromium/);
    assert.equal(guestHints.hints, baseline.hints.hints);
    assert.equal(guestHints.platform, baseline.hints.platform);
    // Optional equality is not positive high-entropy coverage when absent.
    assert.equal(guestHints.fullVersion, baseline.hints.fullVersion);
    assert.equal(toolbar.getUserAgent(), app.userAgentFallback);
    assert.equal(shield.getUserAgent(), app.userAgentFallback);
    assert.equal(app.userAgentFallback, identity.userAgent);
    assert.deepEqual((await call({ action: 'permissions', tabId })).pending, []);
    console.log('UA_IDENTITY', JSON.stringify({ guest: identity, baseline, guestHints }));
  });
  await check('actual input returns its diff; refs survive the change; form fill/type/select', async () => {
    const add = refOf(observation, 'button', 'Add');
    observation = await call({ action: 'click', tabId, ref: add, screenshot: true });
    assert.equal(observation.disposition, 'executed', rendered(observation));
    assert.equal(observation.observed, undefined, rendered(observation));
    assert.match(rendered(observation), /\n~ e\d+ status ="1"/, 'the counter change is in the click diff');
    assert.deepEqual(pixelAt(observation.screenshot, 820, 40), [0, 190, 0], 'Shielded click capture must show new green fixture pixels');
    assert.equal((await call({ action: 'read', tabId, ref: add })).disposition, 'observed', 'the ref still names the same button');
    observation = await call({ action: 'fill', tabId, target: { role: 'textbox', name: 'Name', exact: true }, text: 'Local Alice' });
    assert.match(rendered(observation), /textbox "Name"[^\n]*="Local Alice"/, rendered(observation));
    observation = await call({ action: 'type', tabId, target: { name: 'Name', exact: true }, text: ' typed' });
    assert.match(rendered(observation), /textbox "Name"[^\n]*="Local Alice typed"/, rendered(observation));
    observation = await call({ action: 'select', tabId, target: { name: 'Choice', exact: true }, values: ['b'] });
    assert.match(rendered(observation), /"Choice"[^\n]*="b"/, rendered(observation));
  });
  await check('ambiguous targets fail with candidates and ownership/late caller rejected', async () => {
    await assert.rejects(call({ action: 'click', tabId, target: { name: 'Duplicate', exact: true } }), e => e.code === 'AMBIGUOUS_TARGET' && e.candidates.length === 2);
    await assert.rejects(host.execute({ action: 'observe', tabId }, { ...caller, sessionId: 'foreign' }), /owned/i);
    await assert.rejects(host.execute({ action: 'click', tabId, target: { name: 'Add' } }, {
      ...caller, assertLive() { throw new Error('Late caller'); },
    }), /Late caller/);
  });
  await check('same-origin and cross-origin frames are inlined with their own refs and actionable geometry', async () => {
    observation = await call({ action: 'observe', tabId });
    const text = rendered(observation);
    const frames = [...text.matchAll(/(e\d+) iframe/g)].map(match => match[1]);
    assert.equal(frames.length, 2, text);
    assert.equal(text.match(/button "Frame button"/g)?.length, 2, text);
    for (const frame of frames) {
      observation = await call({ action: 'click', tabId, target: { name: 'Frame button', exact: true, frame } });
      assert.match(rendered(observation), /button "Frame clicked"/, rendered(observation));
    }
  });
  await check('points require the latest screenshot and an unchanged tile around them', async () => {
    observation = await call({ action: 'observe', tabId, screenshot: true });
    assert.match(rendered(observation), /\nview \d+x\d+ scroll \d+\/\d+ points\n/);
    await assert.rejects(call({ action: 'click', tabId, point: { x: 1, y: 1, snapshotId: 's0' } }), error => error.code === 'STALE_COORDINATES');
    // Repaint inside the 24×24 tile around the point.
    await call({ action: 'evaluate', tabId, expression: 'document.querySelector("#paint").style.boxShadow="inset 0 0 0 40px rgb(0,0,255)"' });
    await assert.rejects(call({ action: 'click', tabId, point: { x: 820, y: 40, snapshotId: observation.snapshotId } }),
      error => error.code === 'STALE_COORDINATES' && error.requestedInputDispatched === false);
    await call({ action: 'evaluate', tabId, expression: 'document.querySelector("#paint").style.boxShadow=""' });
  });
  await check('model evaluate has no Node and cannot reach the private walker world', async () => {
    const result = await call({ action: 'evaluate', tabId,
      expression: '({node:typeof process,walker:typeof globalThis.__independentState,refs:typeof globalThis.__mixdogAgentSnapshot})' });
    assert.deepEqual(result.value, { node: 'undefined', walker: 'undefined', refs: 'undefined' });
  });
  await check('upload restricted to explicit file input and download uses plugin-owned path', async () => {
    const file = path.join(dataDir, 'fixture-upload.txt');
    await writeFile(file, 'test fixture only');
    observation = await call({ action: 'upload', tabId, target: { name: 'File', exact: true }, files: [file] });
    assert.match(rendered(observation), /fixture-upload\.txt/);
    await call({ action: 'click', tabId, target: { name: 'Download fixture', exact: true } });
    const until = Date.now() + 5000;
    let downloads;
    do {
      downloads = await call({ action: 'downloads', tabId });
      if (downloads.items.some(i => i.state === 'completed')) break;
      await new Promise(r => setTimeout(r, 30));
    } while (Date.now() < until);
    assert.ok(downloads.items.some(i => i.state === 'completed' && i.path.startsWith(path.join(dataDir, 'profiles'))));
  });
  await check('dialog input is not replayed, explicit handle_dialog unblocks it', async () => {
    const result = await call({ action: 'click', tabId, target: { name: 'Dialog', exact: true } });
    // The alert opens inside the press: the release is not acknowledged until
    // the dialog is answered, so the click's outcome is still pending.
    assert.deepEqual([result.disposition, result.code, result.operationPending, result.replaySafe], ['uncertain', 'DIALOG_OPEN', true, false], rendered(result));
    assert.match(rendered(result), /\ndialog alert "fixture dialog"/);
    observation = await call({ action: 'handle_dialog', tabId, accept: true });
    assert.equal(observation.disposition, 'executed', rendered(observation));
    assert.ok(observation.snapshotId);
  });
  await check('popup is independently registered under same owner', async () => {
    await call({ action: 'click', tabId, target: { name: 'Popup', exact: true } });
    const until = Date.now() + 5000;
    let tabs;
    do {
      tabs = await call({ action: 'list_tabs' });
      if (tabs.tabs.length > 1) break;
      await new Promise(r => setTimeout(r, 30));
    } while (Date.now() < until);
    assert.equal(tabs.tabs.length, 2);
    const popup = tabs.tabs.find(t => t.tabId !== tabId);
    const popupObserved = await call({ action: 'observe', tabId: popup.tabId }).catch(async error => {
      error.message += JSON.stringify(await call({ action: 'list_tabs' }));
      throw error;
    });
    assert.match(rendered(popupObserved), /h1 "Owned popup"/);
    await call({ action: 'close_tab', tabId: popup.tabId });
    await assert.rejects(call({ action: 'observe', tabId: popup.tabId }), /closed|unknown/i);
  });
  await check('cancelled actual evaluate remains fenced; uncertain input is never replayed', async () => {
    const abort = new AbortController();
    const guest = pageContents(`http://127.0.0.1:${port}/`);
    let started;
    const begun = new Promise(resolve => { started = resolve; });
    const listener = (_event, method, params) => {
      if (method === 'Runtime.consoleAPICalled' && params.args?.[0]?.value === 'fixture-effect-started') started();
    };
    guest.debugger.on('message', listener);
    const first = host.execute({ action: 'evaluate', tabId,
      expression: '(()=>{const o=document.querySelector("#result");o.textContent=Number(o.textContent)+1;console.log("fixture-effect-started");const start=Date.now();while(Date.now()-start<5000){};return o.textContent})()' }, caller, abort.signal);
    await begun;
    abort.abort(new Error('test cancellation'));
    const uncertain = await first;
    guest.debugger.removeListener('message', listener);
    assert.equal(uncertain.disposition, 'uncertain');
    const result = await call({ action: 'evaluate', tabId, expression: 'Number(document.querySelector("#result").textContent)' });
    assert.equal(result.value, 2);
  });
  await check('handoff and Stop persist until native trusted Resume; hide/show does not resume', async () => {
    await call({ action: 'handoff', tabId });
    await assert.rejects(call({ action: 'click', tabId, target: { name: 'Add' } }), /paused/i);
    await call({ action: 'hide', tabId });
    await call({ action: 'show', tabId });
    await assert.rejects(call({ action: 'click', tabId, target: { name: 'Add' } }), /paused/i);
    // Native menu callback invoked by the test harness only, never exposed as an action/IPC.
    const { frame } = presentationOf(pageContents(`http://127.0.0.1:${port}/`));
    const menu = Menu.getApplicationMenu();
    assert.ok(menu || frame);
    const pageMenu = hostTestMenu(frame);
    pageMenu.items.find(i => i.label === 'Resume automation').click();
    await bounded((async () => {
      for (;;) {
        const tab = (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === tabId);
        if (tab.mode === 'automation' && !tab.paused) return;
        await pause(20);
      }
    })(), 8000, 'native Resume obtains a fresh observation');
    await call({ action: 'click', tabId, target: { name: 'Add' } });
    pageMenu.items.find(i => i.label === 'Stop automation').click();
    await assert.rejects(call({ action: 'fill', tabId, target: { name: 'Name' }, text: 'no' }), /paused/i);
  });
  await runAdditionalScenarios({ host, caller, tabId, port, check, permissionChecks, requestHeaders });
  console.log(`BROWSER_CONTRACT_PASSED ${JSON.stringify(cases)}`);
  await host.close();
  for (const server of servers) server.close();
  app.exit(0);
} catch (error) {
  console.error(error.stack);
  await host?.close();
  for (const server of servers) server.close();
  app.exit(1);
}
}
void run();

function hostTestMenu(win) {
  // Electron's native Menu is not visible to the untrusted renderer or CDP.
  return win.__independentBrowserTestMenu;
}
