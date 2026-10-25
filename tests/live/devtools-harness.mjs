import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { BrowserHost } from '../../src/browser/host.mjs';
import { bounded, pause } from '../../src/shared/async.mjs';
import { assertShielded, frameOf, menu, pageContents, presentationOf, refOf, toolbarPreloadPath } from './presentation.mjs';

const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'electron'));
// Capture only native Menu objects inside this private main-process harness.
const setMenu = BrowserWindow.prototype.setMenu;
BrowserWindow.prototype.setMenu = function(value) {
  this.__independentBrowserTestMenu = value;
  return setMenu.call(this, value);
};
const SECRET = 'LIVE_SECRET_VALUE';
const servers = [];
const seen = new Set();
let host;

function fixture(cross) {
  return `<!doctype html><meta charset="utf-8"><title>DevTools fixture</title>
<style>.card{color:rgb(1,2,3);padding:4px}#ghost{visibility:hidden}</style>
<button id="go" class="card" onclick="window.clicks=(window.clicks||0)+1;document.querySelector('#out').textContent='clicked '+window.clicks">Go</button>
<output id="out"></output>
<div id="hidden-wrap" style="display:none"><span id="hidden-child">hidden</span></div>
<p id="ghost">ghost</p>
<iframe src="${cross}/frame"></iframe>
<script>
window.secretGlobal = { answer: 42, nested: { ok: true } };
console.log('fixture log', 42);
console.error('fixture error');
console.log('callback http://127.0.0.1/cb?code=${SECRET}&next=1');
fetch('/api/redirect');
setTimeout(() => { throw new Error('fixture uncaught'); }, 0);
new Worker('/worker.js');
document.querySelector('#go').addEventListener('click', () => {});
fetch('/api/ok?token=${SECRET}', { headers: { Authorization: 'Bearer ${SECRET}', 'X-Api-Key': '${SECRET}' } });
fetch('/api/missing');
fetch('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'alice', password: '${SECRET}' }) });
</script>`;
}
function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
const until = (predicate, label, ms = 8000) => bounded((async () => {
  for (;;) {
    const value = await predicate();
    if (value) return value;
    await pause(25);
  }
})(), ms, label);
const sizes = {};
const measure = (label, value) => {
  sizes[label] = JSON.stringify(value).length;
  console.log(`SAMPLE ${label} ${JSON.stringify(value)}`);
  return value;
};

async function run() {
  const crossPort = await serve((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><script>console.error("frame error")</script>');
  });
  const cross = `http://localhost:${crossPort}`;
  const port = await serve((req, res) => {
    seen.add(req.url.split('?')[0]);
    if (req.url === '/worker.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('console.log("worker log")'); }
    if (req.url.startsWith('/api/ok')) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', `sid=${SECRET}; Path=/`);
      return res.end(JSON.stringify({ ok: true, value: 'fixture body', access_token: SECRET, refresh_token: SECRET }));
    }
    if (req.url === '/api/redirect') { res.writeHead(302, { Location: `/api/final?code=${SECRET}` }); return res.end(); }
    if (req.url.startsWith('/api/final')) { res.setHeader('Content-Type', 'application/json'); return res.end('{"final":true}'); }
    if (req.url === '/sw.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/sw-')) return;
  console.log('SW_FETCH ' + url.pathname);
  event.respondWith(fetch(event.request));
});`);
    }
    if (req.url.startsWith('/sw-')) { res.setHeader('Content-Type', 'text/plain'); return res.end('sw resource'); }
    if (req.url.startsWith('/swp/')) {
      res.setHeader('Content-Type', 'text/html');
      return res.end(`<!doctype html><title>SW ${req.url}</title><p>service worker page</p>
<script>navigator.serviceWorker.register('/sw.js');</script>`);
    }
    if (req.url === '/api/missing') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('missing'); }
    if (req.url === '/api/echo') {
      let body = '';
      req.on('data', data => { body += data; });
      req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ received: body.length })); });
      return;
    }
    if (req.url === '/api/slow') {
      setTimeout(() => { seen.add('/api/slow-done'); res.setHeader('Content-Type', 'text/plain'); res.end('slow body'); }, 1500);
      return;
    }
    if (req.url.startsWith('/api/private')) { res.setHeader('Content-Type', 'text/plain'); return res.end('private'); }
    res.setHeader('Content-Type', 'text/html');
    res.end(fixture(cross));
  });
  await app.whenReady();
  host = new BrowserHost({
    dataDir: path.join(directory, 'profiles'), consentHelperPath: path.resolve('build/not-invoked.exe'), toolbarPreloadPath,
    onRevokeConnection: async () => { throw new Error('Live test must not revoke'); },
  });
  const caller = { sessionId: 'devtools-live', callId: 'test', signal: new AbortController().signal, assertLive() {} };
  const call = args => host.execute(args, caller);
  const url = `http://127.0.0.1:${port}/`;
  const opened = await call({ action: 'open', url });
  const tabId = opened.tabId;
  const page = pageContents(url);
  const { frame } = presentationOf(page);

  // 1. Console, uncaught exception, browser log, worker and cross-origin frame entries from load time.
  const consoleRows = await until(async () => {
    const result = await call({ action: 'console', tabId });
    const text = JSON.stringify(result.rows ?? []);
    return ['fixture log 42', 'fixture error', 'fixture uncaught', 'worker log', 'frame error'].every(part => text.includes(part)) && result;
  }, 'load-time console entries');
  measure('console', consoleRows);
  const rows = consoleRows.rows;
  assert.ok(rows.some(row => row.msg === 'fixture log 42' && !row.lv));
  assert.ok(rows.some(row => row.msg === 'fixture error' && row.lv === 'error'));
  const exception = rows.find(row => row.k === 'exception');
  assert.match(exception.msg, /Uncaught Error: fixture uncaught/);
  assert.match(exception.at, /127\.0\.0\.1:\d+\/:\d+:\d+$/);
  assert.equal(rows.find(row => row.msg === 'worker log').in, 'worker');
  assert.ok(rows.find(row => row.msg === 'frame error'), 'cross-origin frame console is recorded');
  assert.deepEqual((await call({ action: 'console', tabId, filter: 'level:error' })).rows.every(row => row.lv === 'error'), true);
  assert.ok(rows.some(row => row.msg === 'callback http://127.0.0.1/cb?code=%5Bredacted%5D&next=1'), JSON.stringify(rows));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(SECRET));
  console.log('PASS console, exceptions, worker and frame entries, URL redaction in messages');

  // 2. Network rows, status, redaction, detail and body.
  const network = await until(async () => {
    const result = await call({ action: 'network', tabId });
    const done = path => result.rows?.find(row => row.u.includes(path) && row.s);
    return done('/api/ok') && done('/api/missing') && done('/api/echo') && done('/api/final')
      && !result.rows.some(row => row.st === 'run') && result;
  }, 'fixture fetches');
  measure('network', network);
  const ok = network.rows.find(row => row.u.includes('/api/ok'));
  assert.equal(ok.s, 200);
  assert.equal(network.rows.find(row => row.u.includes('/api/missing')).s, 404);
  assert.deepEqual((await call({ action: 'network', tabId, filter: 'status:4xx' })).rows.map(row => row.s), [404]);
  const detail = measure('network-detail', await call({ action: 'network', tabId, id: ok.id }));
  assert.equal(detail.reqHeaders.Authorization, '[redacted]');
  assert.equal(detail.reqHeaders['X-Api-Key'], '[redacted]');
  // Chromium omits Set-Cookie from responseReceived; when present it must be redacted.
  for (const name of ['Set-Cookie', 'set-cookie']) assert.ok([undefined, '[redacted]'].includes(detail.resHeaders[name]));
  assert.ok(!network.rows.some(row => row.st === 'run'), 'Cross-target requests (frame document, worker script) complete');
  assert.ok(!rows.some(row => row.at?.startsWith('node:electron')), 'Electron runtime warnings are not page output');
  assert.equal(rows.filter(row => row.msg === 'worker log').length, 1, 'Worker console calls are recorded once');
  const echo = await call({ action: 'network', tabId, id: network.rows.find(row => row.u.includes('/api/echo')).id });
  assert.deepEqual(JSON.parse(echo.reqBody), { user: 'alice', password: '[redacted]' });
  assert.doesNotMatch(JSON.stringify([network, detail, echo]), new RegExp(SECRET));
  const body = measure('network-body', await call({ action: 'network', tabId, id: ok.id, body: true }));
  assert.deepEqual(JSON.parse(body.body), { ok: true, value: 'fixture body', access_token: '[redacted]', refresh_token: '[redacted]' });
  // Chromium keeps one requestId per redirect chain: the 302 hop is its own
  // row, never serves the final hop's body, and its Location is redacted.
  const hop = network.rows.find(row => row.u.endsWith('/api/redirect'));
  const final = network.rows.find(row => row.u.includes('/api/final'));
  assert.deepEqual([hop.s, final.s], [302, 200]);
  const hopDetail = await call({ action: 'network', tabId, id: hop.id });
  assert.equal(hopDetail.st, 'redirected', JSON.stringify(hopDetail));
  assert.equal(hopDetail.resHeaders.Location ?? hopDetail.resHeaders.location, '/api/final?code=%5Bredacted%5D');
  await assert.rejects(call({ action: 'network', tabId, id: hop.id, body: true }), error => error.code === 'BODY_UNAVAILABLE');
  assert.equal(JSON.parse((await call({ action: 'network', tabId, id: final.id, body: true })).body).final, true);
  assert.doesNotMatch(JSON.stringify([network, body, hopDetail]), new RegExp(SECRET));
  // An out-of-process frame document is one row, never a phantom incomplete
  // one, at load and on a later navigation of that frame.
  await call({ action: 'evaluate', tabId, expression: `new Promise(resolve => { const f = document.querySelector('iframe'); f.onload = () => resolve(true); f.src = ${JSON.stringify(`${cross}/frame?again`)}; })` });
  const frameRows = await until(async () => {
    const rows = (await call({ action: 'network', tabId, filter: '/frame' })).rows ?? [];
    return rows.some(row => row.u.endsWith('/frame?again') && row.s) && rows;
  }, 'out-of-process frame navigation');
  for (const suffix of ['/frame', '/frame?again']) {
    const rows = frameRows.filter(row => row.u === `${cross}${suffix}`);
    assert.equal(rows.length, 1, JSON.stringify(frameRows));
    assert.deepEqual([rows[0].s, rows[0].st, rows[0].in], [200, undefined, 'iframe'], JSON.stringify(frameRows));
  }
  console.log('PASS network status, redaction, details, body redaction, redirect hops and out-of-process frame documents');

  // 3. Incremental console reads.
  const cursor = (await call({ action: 'console', tabId })).next;
  assert.equal((await call({ action: 'console', tabId, since: cursor })).rows, undefined);
  // The agent's own isolated world is not page output; the page world is.
  await call({ action: 'evaluate', tabId, expression: 'console.warn("isolated agent output"); 1' });
  await call({ action: 'evaluate', tabId, world: 'page', expression: 'console.warn("after cursor"); 1' });
  assert.deepEqual((await call({ action: 'console', tabId, since: cursor })).rows.map(row => [row.lv, row.msg]), [['warn', 'after cursor']]);
  console.log('PASS incremental console cursor, isolated-world output excluded');

  // 4. Page world: side-effect-free read, refusal, isolated contrast and explicit opt-in.
  assert.deepEqual(measure('console-expression', await call({ action: 'console', tabId, expression: 'window.secretGlobal.answer' })),
    { tabId, type: 'number', value: 42 });
  assert.match((await call({ action: 'console', tabId, expression: 'window.secretGlobal' })).preview, /answer: 42/);
  assert.equal((await call({ action: 'evaluate', tabId, expression: 'typeof window.secretGlobal' })).value, 'undefined');
  await assert.rejects(call({ action: 'console', tabId, expression: 'window.secretGlobal.answer = 1' }), error => error.code === 'SIDE_EFFECT');
  assert.equal((await call({ action: 'console', tabId, expression: 'window.secretGlobal.answer' })).value, 42, 'A refused read changed nothing');
  const main = await call({ action: 'evaluate', tabId, world: 'page', expression: 'window.secretGlobal.answer = 7; window.secretGlobal.answer' });
  assert.deepEqual([main.disposition, main.value], ['executed', 7]);
  assert.equal((await call({ action: 'console', tabId, expression: 'window.secretGlobal.answer' })).value, 7);
  // A read that never ends is terminated at its timeout; the page keeps working.
  const timeoutStarted = Date.now();
  await assert.rejects(call({ action: 'console', tabId, expression: 'for(;;){}' }), error => error.code === 'SCRIPT_TIMEOUT');
  const timeoutMs = Date.now() - timeoutStarted;
  assert.ok(timeoutMs >= 1500 && timeoutMs < 4500, `terminated near the 2 s bound: ${timeoutMs} ms`);
  assert.equal((await call({ action: 'console', tabId, expression: 'window.secretGlobal.answer' })).value, 7);
  console.log('PASS page-world read, side-effect refusal, timeout and page-world evaluate');

  // 5. Inspect by ref (refs stay valid) and by selector for hidden elements.
  const observed = await call({ action: 'observe', tabId });
  const ref = refOf(observed, 'button', 'Go');
  const inspected = measure('inspect', await call({ action: 'inspect', tabId, ref, values: ['color'] }));
  assert.equal(inspected.visible, true);
  assert.equal(inspected.style.display, 'inline-block');
  assert.equal(inspected.style.color, 'rgb(1, 2, 3)');
  assert.ok(inspected.rules.some(rule => rule.s === '.card' && /127\.0\.0\.1:\d+\/:\d+$/.test(rule.src)), JSON.stringify(inspected.rules));
  assert.ok(inspected.listeners.click >= 1);
  const clicked = await call({ action: 'click', tabId, ref });
  assert.equal(clicked.disposition, 'executed', 'Inspect never invalidates refs');
  assert.equal(await page.executeJavaScript('window.clicks'), 1);
  const hidden = await call({ action: 'inspect', tabId, target: { selector: '#hidden-wrap' } });
  assert.deepEqual([hidden.style.display, hidden.visible], ['none', false]);
  const child = await call({ action: 'inspect', tabId, target: { selector: '#hidden-child' } });
  assert.deepEqual([child.visible, child.hiddenBy], [false, 'div#hidden-wrap display:none']);
  const ghost = await call({ action: 'inspect', tabId, target: { selector: '#ghost' } });
  assert.deepEqual([ghost.style.visibility, ghost.visible], ['hidden', false]);
  console.log('PASS inspect by ref and selector');

  // 6. Performance snapshot.
  const performance = measure('performance', await call({ action: 'performance', tabId }));
  assert.ok(performance.m.nodes > 0 && performance.m.heapMB > 0);
  assert.equal(performance.nav.type, 'navigate');
  console.log('PASS performance snapshot');

  // 7. Handoff privacy and human DevTools.
  const consoleCursor = (await call({ action: 'console', tabId })).next;
  await call({ action: 'evaluate', tabId, expression: 'fetch("/api/slow").then(() => console.log("slow done")); 1' });
  const slow = await until(async () => (await call({ action: 'network', tabId, filter: '/api/slow' })).rows?.[0], 'slow request in flight');
  assert.equal(slow.st, 'run');
  const devtoolsItem = frame.__independentBrowserTestMenu.items.find(item => item.id === 'open-devtools');
  assert.equal(devtoolsItem.enabled, false);
  menu(frame, 'Open DevTools (while you have control)');
  await pause(500);
  assert.equal(page.isDevToolsOpened(), false, 'DevTools never opens while the agent controls the page');
  await call({ action: 'handoff', tabId });
  const state = async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === tabId);
  assert.equal((await state()).mode, 'native-handoff');
  assert.equal(devtoolsItem.enabled, true);
  const devtoolsOpened = new Promise(resolve => page.once('devtools-opened', resolve));
  menu(frame, 'Open DevTools (while you have control)');
  await bounded(devtoolsOpened, 8000, 'human DevTools open');
  assert.equal(page.isDevToolsOpened(), true);
  await page.executeJavaScript('console.log("PRIVATE_HANDOFF_LOG"); fetch("/api/private?x=PRIVATE_HANDOFF_FETCH").then(r => r.text())');
  await until(() => seen.has('/api/private') && seen.has('/api/slow-done'), 'activity during handoff', 8000);
  await pause(300);
  await menu(frame, 'Resume automation');
  await until(async () => { const t = await state(); return t.mode === 'automation' && !t.paused; }, 'trusted resume')
    .catch(async error => {
      error.message += ` ${JSON.stringify({ tab: await state(), devtools: page.isDevToolsOpened() })}`;
      throw error;
    });
  assert.equal(page.isDevToolsOpened(), false, 'Human DevTools close before the return to automation');
  assert.equal(devtoolsItem.enabled, false);
  assertShielded(page);
  const afterConsole = await call({ action: 'console', tabId, since: consoleCursor });
  const afterNetwork = await call({ action: 'network', tabId });
  assert.doesNotMatch(JSON.stringify([afterConsole, afterNetwork]), /PRIVATE_HANDOFF|slow done|\/api\/private/);
  assert.ok(afterConsole.withheld >= 1, JSON.stringify(afterConsole));
  assert.equal(afterNetwork.rows.find(row => row.id === slow.id).st, 'incomplete');
  await assert.rejects(call({ action: 'network', tabId, id: slow.id, body: true }), error => error.code === 'BODY_UNAVAILABLE');
  console.log('PASS handoff entries withheld, in-flight request incomplete, human DevTools handoff-only');

  // 8. The agent's CDP session keeps working after human DevTools attached and closed.
  const nextCursor = (await call({ action: 'console', tabId })).next;
  await call({ action: 'evaluate', tabId, world: 'page', expression: 'console.error("after devtools"); 1' });
  assert.deepEqual((await call({ action: 'console', tabId, since: nextCursor })).rows.map(row => row.msg), ['after devtools']);
  const fresh = await call({ action: 'observe', tabId });
  const goRef = refOf(fresh, 'button', 'Go');
  assert.equal((await call({ action: 'click', tabId, ref: goRef })).disposition, 'executed');
  assert.equal(await page.executeJavaScript('window.clicks'), 2);
  assert.equal((await call({ action: 'console', tabId, expression: 'window.clicks' })).value, 2);
  assert.ok((await call({ action: 'performance', tabId })).m.nodes > 0);
  console.log('PASS agent CDP session after human DevTools');

  // 9. Two windows of one profile: tab A stays in automation while the person
  // uses tab B; the profile's service worker serves both, so its activity
  // during B's handoff never reaches A's records.
  const swA = await call({ action: 'open', url: `${url}swp/a` });
  const pageA = pageContents(`${url}swp/a`);
  await until(() => pageA.executeJavaScript('navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller)'), 'service worker controls tab A');
  const swRows = filter => call({ action: 'console', tabId: swA.tabId, filter });
  await pageA.executeJavaScript('fetch("/sw-public").then(r => r.text())');
  const publicRow = await until(async () => (await swRows('SW_FETCH')).rows?.find(row => row.msg === 'SW_FETCH /sw-public'),
    'service worker console recorded in tab A');
  assert.equal(publicRow.in, 'service_worker');
  const swB = await call({ action: 'open', url: `${url}swp/b` });
  const pageB = pageContents(`${url}swp/b`);
  await until(() => pageB.executeJavaScript('!!navigator.serviceWorker.controller'), 'service worker controls tab B');
  const swCursor = (await call({ action: 'console', tabId: swA.tabId })).next;
  await call({ action: 'handoff', tabId: swB.tabId });
  await until(async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === swB.tabId).mode === 'native-handoff', 'tab B handoff');
  assert.equal((await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === swA.tabId).mode, 'automation');
  await pageB.executeJavaScript(`fetch("/sw-private?code=${SECRET}").then(r => r.text())`);
  await until(() => seen.has('/sw-private'), 'service worker fetch during tab B handoff');
  await pause(300);
  await menu(frameOf(pageB), 'Resume automation');
  await until(async () => { const t = (await call({ action: 'list_tabs' })).tabs.find(x => x.tabId === swB.tabId); return t.mode === 'automation' && !t.paused; }, 'tab B resume');
  await pageA.executeJavaScript('fetch("/sw-after").then(r => r.text())');
  await until(async () => (await swRows('SW_FETCH')).rows?.some(row => row.msg === 'SW_FETCH /sw-after'), 'service worker recording resumes');
  const swConsole = await call({ action: 'console', tabId: swA.tabId, since: swCursor });
  const swNetwork = await call({ action: 'network', tabId: swA.tabId });
  assert.deepEqual(swConsole.rows.filter(row => row.msg.startsWith('SW_FETCH')).map(row => row.msg), ['SW_FETCH /sw-after']);
  assert.ok(swConsole.withheld >= 1, JSON.stringify(swConsole));
  assert.doesNotMatch(JSON.stringify([swConsole, swNetwork]), new RegExp(`sw-private|${SECRET}`));
  assert.ok(swNetwork.rows.some(row => row.u.endsWith('/sw-after') && row.in === 'service_worker'), JSON.stringify(swNetwork));
  console.log('PASS profile-shared service worker activity during another window\'s handoff stays private');
  console.log(`DEVTOOLS_SIZES ${JSON.stringify(sizes)}`);
  console.log('DEVTOOLS_CONTRACT_PASSED');
}

app.on('window-all-closed', () => {});
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await host?.close();
  for (const server of servers) server.close();
  app.exit(process.exitCode ?? 0);
});
