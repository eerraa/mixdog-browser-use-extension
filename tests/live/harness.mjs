import { app, BrowserWindow, Menu, nativeImage, session } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserHost } from '../../src/browser/host.mjs';
import { BrowserPolicy } from '../../src/browser/policy.mjs';
import { configureBrowserIdentity } from '../../src/browser/user-agent.mjs';
import { runAdditionalScenarios } from './scenarios.mjs';
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
    onRevokeConnection: async () => { throw new Error('Live test must not revoke gateway'); },
  });
  const caller = { sessionId: 'local-test', callId: 'test', signal: new AbortController().signal, assertLive() {} };
  const call = args => host.execute(args, caller);
  let tabId, observation;
  await check('open, isolated security settings, masked observation and screenshot', async () => {
    observation = await call({ action: 'open', url: `http://127.0.0.1:${port}` });
    tabId = observation.tabId;
    assert.ok(observation.snapshotId);
    assert.ok(observation.screenshot.data.length);
    assert.ok(!JSON.stringify(observation).includes('DO_NOT_OBSERVE_PASSWORD'));
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(`http://127.0.0.1:${port}`));
    const prefs = win.webContents.getLastWebPreferences();
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.webSecurity, true);
    assert.equal(win.webContents.getBackgroundThrottling(), false);
    assert.equal(win.isVisible(), false);
    const image = nativeImage.createFromBuffer(Buffer.from(observation.screenshot.data, 'base64')).toBitmap();
    const x = Math.round(820 * observation.screenshot.pixelsPerCssX), y = Math.round(40 * observation.screenshot.pixelsPerCssY);
    const pixel = (y * observation.screenshot.pixelWidth + x) * 4;
    assert.deepEqual([...image.subarray(pixel, pixel + 3)], [0, 0, 220], 'Hidden first capture must contain current red fixture pixels');
  });
  if (identityBaselineMode) {
    const guest = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === `http://127.0.0.1:${port}/`);
    const shell = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('data:text/html'));
    const identity = await guest.webContents.executeJavaScript('({userAgent:navigator.userAgent,brands:navigator.userAgentData.brands,hidAvailable:typeof navigator.hid==="object"})');
    await guest.webContents.executeJavaScript('fetch("/ua-hints-baseline").then(r=>r.text())');
    console.log('UA_BASELINE_RESULT', JSON.stringify({
      ...identity, root: requestHeaders.get('/'), hints: requestHeaders.get('/ua-hints-baseline'),
      authorizePresent: observation.frames[0].elements.some(e => e.name === 'UA authorization fixture'),
      fallback: app.userAgentFallback, presentation: shell.webContents.getUserAgent(),
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
    assert.ok(observation.frames[0].elements.some(e => e.name === 'UA authorization fixture'),
      'Container detection must not hide the browser authorization control');
    const guest = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === `http://127.0.0.1:${port}/`);
    const shell = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('data:text/html'));
    const identity = await guest.webContents.executeJavaScript('({userAgent:navigator.userAgent,brands:navigator.userAgentData.brands})');
    assert.doesNotMatch(identity.userAgent, /Electron\/|IndependentWindowsBrowser\//);
    assert.ok(identity.userAgent.includes(`Chrome/${process.versions.chrome}`));
    assert.ok(identity.userAgent.includes(baseline.userAgent.match(/\([^)]+\)/)[0]));
    assert.equal(guest.webContents.getUserAgent(), identity.userAgent);
    assert.equal(requestHeaders.get('/').userAgent, identity.userAgent);
    assert.equal(baseline.root.userAgent, baseline.userAgent);
    assert.equal(requestHeaders.get('/').language, baseline.root.language);
    assert.deepEqual(identity.brands, baseline.brands, 'Client Hints must not be fabricated or overridden');
    await guest.webContents.executeJavaScript('fetch("/ua-hints-guest").then(r=>r.text())');
    const guestHints = requestHeaders.get('/ua-hints-guest');
    assert.match(guestHints.hints, /Chromium/);
    assert.equal(guestHints.hints, baseline.hints.hints);
    assert.equal(guestHints.platform, baseline.hints.platform);
    // Optional equality is not positive high-entropy coverage when absent.
    assert.equal(guestHints.fullVersion, baseline.hints.fullVersion);
    assert.equal(shell.webContents.getUserAgent(), app.userAgentFallback);
    assert.equal(app.userAgentFallback, identity.userAgent);
    assert.deepEqual((await call({ action: 'permissions', tabId })).pending, []);
    console.log('UA_IDENTITY', JSON.stringify({ guest: identity, baseline, guestHints }));
  });
  await check('actual input, form fill/select and fresh/stale refs', async () => {
    const old = observation.frames.flatMap(f => f.elements).find(e => e.name === 'Add').ref;
    observation = await call({ action: 'click', tabId, ref: old });
    assert.equal(observation.disposition, 'observed', observation.disposition === 'uncertain'
      ? JSON.stringify({ result: observation, tabs: await call({ action: 'list_tabs' }) })
      : 'A fixture click must return a fresh observation');
    assert.match(observation.frames[0].text, /1/);
    const image = nativeImage.createFromBuffer(Buffer.from(observation.screenshot.data, 'base64')).toBitmap();
    const x = Math.round(820 * observation.screenshot.pixelsPerCssX), y = Math.round(40 * observation.screenshot.pixelsPerCssY);
    const pixel = (y * observation.screenshot.pixelWidth + x) * 4;
    assert.deepEqual([...image.subarray(pixel, pixel + 3)], [0, 190, 0], 'Hidden click capture must show new green fixture pixels');
    await assert.rejects(call({ action: 'click', tabId, ref: old }), /stale/i);
    observation = await call({ action: 'fill', tabId, target: { role: 'textbox', name: 'Name', exact: true }, text: 'Local Alice' });
    assert.equal(observation.frames[0].elements.find(e => e.name === 'Name').value, 'Local Alice');
    observation = await call({ action: 'type', tabId, target: { name: 'Name', exact: true }, text: ' typed' });
    assert.equal(observation.frames[0].elements.find(e => e.name === 'Name').value, 'Local Alice typed');
    observation = await call({ action: 'select', tabId, target: { name: 'Choice', exact: true }, values: ['b'] });
    assert.match(observation.frames[0].text, /b/);
  });
  await check('ambiguous targets fail with candidates and ownership/late caller rejected', async () => {
    await assert.rejects(call({ action: 'click', tabId, target: { name: 'Duplicate', exact: true } }), e => e.code === 'AMBIGUOUS_TARGET' && e.candidates.length === 2);
    await assert.rejects(host.execute({ action: 'observe', tabId }, { ...caller, sessionId: 'foreign' }), /owned/i);
    await assert.rejects(host.execute({ action: 'click', tabId, target: { name: 'Add' } }, {
      ...caller, assertLive() { throw new Error('Late caller'); },
    }), /Late caller/);
  });
  await check('same-origin and cross-origin frames have independent isolated refs and actionable geometry', async () => {
    observation = await call({ action: 'observe', tabId });
    const childFrames = observation.frames.filter(f => f.elements.some(e => e.name === 'Frame button'));
    assert.equal(childFrames.length, 2);
    for (const frame of childFrames) {
      observation = await call({ action: 'click', tabId, target: { name: 'Frame button', exact: true, frameId: frame.frameId } });
      assert.ok(observation.frames.find(f => f.frameId === frame.frameId).text.includes('Frame clicked'));
    }
  });
  await check('raw coordinates require current combined snapshot and reject mutation/viewport changes', async () => {
    observation = await call({ action: 'observe', tabId });
    await assert.rejects(call({ action: 'click', tabId, point: { x: 1, y: 1, snapshotId: 'old' } }), /stale/i);
    await call({ action: 'evaluate', tabId, expression: 'document.body.dataset.changed="yes"' });
    await assert.rejects(call({ action: 'click', tabId, point: { x: 1, y: 1, snapshotId: observation.snapshotId } }), /stale/i);
  });
  await check('model evaluate has no Node and cannot mutate the private ref world', async () => {
    const result = await call({ action: 'evaluate', tabId,
      expression: '({node:typeof process,refs:typeof globalThis.__mixdogAgentSnapshot,binding:typeof globalThis.__independentChanged})' });
    assert.deepEqual(result.value, { node: 'undefined', refs: 'undefined', binding: 'undefined' });
  });
  await check('upload restricted to explicit file input and download uses plugin-owned path', async () => {
    const file = path.join(dataDir, 'fixture-upload.txt');
    await writeFile(file, 'test fixture only');
    observation = await call({ action: 'upload', tabId, target: { name: 'File', exact: true }, files: [file] });
    assert.match(observation.frames[0].text, /fixture-upload.txt/);
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
    assert.equal(result.disposition, 'executed');
    assert.equal(result.dialog.type, 'alert');
    observation = await call({ action: 'handle_dialog', tabId, accept: true });
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
    assert.match(popupObserved.frames[0].text, /Owned popup/);
    await call({ action: 'close_tab', tabId: popup.tabId });
    await assert.rejects(call({ action: 'observe', tabId: popup.tabId }), /closed|unknown/i);
  });
  await check('cancelled actual evaluate remains fenced; uncertain input is never replayed', async () => {
    const abort = new AbortController();
    const guest = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(`http://127.0.0.1:${port}`));
    let started;
    const begun = new Promise(resolve => { started = resolve; });
    const listener = (_event, method, params) => {
      if (method === 'Runtime.consoleAPICalled' && params.args?.[0]?.value === 'fixture-effect-started') started();
    };
    guest.webContents.debugger.on('message', listener);
    const first = host.execute({ action: 'evaluate', tabId,
      expression: '(()=>{const o=document.querySelector("#result");o.textContent=Number(o.textContent)+1;console.log("fixture-effect-started");const start=Date.now();while(Date.now()-start<5000){};return o.textContent})()' }, caller, abort.signal);
    await begun;
    abort.abort(new Error('test cancellation'));
    const uncertain = await first;
    guest.webContents.debugger.removeListener('message', listener);
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
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(`http://127.0.0.1:${port}`));
    const menu = Menu.getApplicationMenu();
    assert.ok(menu || win);
    const pageMenu = hostTestMenu(win);
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
