import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { BrowserHost } from '../../src/browser/host.mjs';
import { bounded, pause } from '../../src/shared/async.mjs';
import { frameOf, menu, pageContents, presentationOf, refOf, toolbarPreloadPath } from './presentation.mjs';

const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'electron'));
const setMenu = BrowserWindow.prototype.setMenu;
BrowserWindow.prototype.setMenu = function(value) { this.__independentBrowserTestMenu = value; return setMenu.call(this, value); };
let host, server, cacheRequests = 0;
const until = (predicate, label) => bounded((async () => {
  for (;;) { const value = await predicate(); if (value) return value; await pause(25); }
})(), 8000, label);

// The same origin, database, cache name, URLs and worker scope in every session.
async function storage(marker) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('session-fixture', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('values');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction('values', marker === undefined ? 'readonly' : 'readwrite');
    const store = tx.objectStore('values');
    if (marker !== undefined) store.put(marker, 'marker');
    const read = store.get('marker');
    tx.oncomplete = () => resolve(read.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  if (marker !== undefined) {
    document.cookie = 'fixtureAccount=' + marker + '; Path=/; SameSite=Lax';
    localStorage.setItem('identity', marker);
    const cache = await caches.open('session-fixture');
    await cache.put('/cached-marker', new Response(marker));
    await navigator.serviceWorker.register('/sw.js?label=' + marker);
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    document.querySelector('#identity').textContent = marker;
    window.fixtureValue = marker;
  }
  const cacheNames = await caches.keys();
  const cached = cacheNames.includes('session-fixture') ? await (await caches.open('session-fixture')).match('/cached-marker') : null;
  return { cookie: document.cookie, local: localStorage.getItem('identity'), indexedDB: value,
    cache: cached ? await cached.text() : null, workers: (await navigator.serviceWorker.getRegistrations()).length };
}

async function run() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const account = /(?:^|;\s*)fixtureAccount=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    if (url.pathname === '/sw.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(`const marker=${JSON.stringify(url.searchParams.get('label'))};
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/sw-marker'){
console.log('SW_MARKER '+marker);e.respondWith(Promise.resolve(new Response(marker)));}});`);
    }
    if (url.pathname === '/http-cache') {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ account, sequence: ++cacheRequests }));
    }
    if (url.pathname === '/api/who') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ account })); }
    if (url.pathname === '/frame') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><button>Frame action</button>'); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>Session fixture</title>
<h1>Session fixture</h1><p id="identity"></p>
<button id="record">Record event</button><button id="logout">Log out fixture</button>
<label>Fixture alias <input id="alias"></label><button id="finish">Finish sign in</button>
<iframe title="Child fixture" src="/frame"></iframe><script>
const identity=()=>localStorage.getItem('identity')||'empty';
document.querySelector('#identity').textContent=identity();window.fixtureValue=identity();
document.querySelector('#record').onclick=()=>{console.log('SESSION_EVENT '+identity());fetch('/api/who?event='+identity());};
document.querySelector('#logout').onclick=()=>{document.cookie='fixtureAccount=; Max-Age=0; Path=/';localStorage.removeItem('identity');document.querySelector('#identity').textContent='logged out';};
document.querySelector('#finish').onclick=()=>{const value=document.querySelector('#alias').value;
localStorage.setItem('identity',value);document.cookie='fixtureAccount='+value+'; Path=/';
document.querySelector('#alias').value='';document.querySelector('#identity').textContent=value;};
</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  host = new BrowserHost({ dataDir: directory, consentHelperPath: path.join(directory, 'never-prompt.exe'),
    toolbarPreloadPath, onRevokeConnection: async () => { throw new Error('No connection revoke in session tests'); } });
  const controller = new AbortController();
  const caller = { sessionId: 'fixture-caller', callId: 'session-fixture', signal: controller.signal,
    assertLive() { controller.signal.throwIfAborted(); } };
  const call = args => host.execute(args, caller);
  const evaluate = async (tabId, expression) => {
    // Local fixture errors are safe diagnostics; production still withholds them.
    const diagnostic = `(async()=>{try{return await (${expression})}catch(error){return {fixtureError:String(error),stack:error.stack}}})()`;
    const result = await call({ action: 'evaluate', tabId, expression: diagnostic, snapshot: 'none', world: 'page' });
    assert.equal(result.disposition, 'executed', JSON.stringify(result));
    assert.equal(result.code, undefined, JSON.stringify(result));
    assert.ok(!result.value?.fixtureError, JSON.stringify(result.value));
    return result.value;
  };
  const stored = (tabId, marker) => evaluate(tabId, `(${storage.toString()})(${marker === undefined ? '' : JSON.stringify(marker)})`);
  const open = async (route, sessionId) => {
    const result = await call({ action: 'open', url: origin + route, ...(sessionId ? { sessionId } : {}) });
    assert.equal(result.disposition, 'executed', JSON.stringify(result));
    return { ...result, contents: pageContents(origin + route) };
  };
  const expected = marker => ({ cookie: `fixtureAccount=${marker}`, local: marker, indexedDB: marker, cache: marker, workers: 1 });
  const empty = { cookie: '', local: null, indexedDB: null, cache: null, workers: 0 };
  const a = await open('/a');
  assert.deepEqual(await stored(a.tabId, 'A'), expected('A'));
  const cachedA = await evaluate(a.tabId, 'fetch("/http-cache").then(r=>r.json())');
  assert.deepEqual(cachedA, { account: 'A', sequence: 1 });
  const session = await call({ action: 'create_session', name: 'Reference B' });
  const b = await open('/b', session.sessionId);
  const isolated = b.contents.session;
  assert.equal(isolated.isPersistent(), false);
  assert.notEqual(a.contents.session, isolated);
  assert.deepEqual(await stored(b.tabId), empty, 'B starts with no A cookies/storage/worker/cache');
  assert.deepEqual(await stored(b.tabId, 'B'), expected('B'));
  assert.deepEqual(await stored(a.tabId), expected('A'), 'B writes never change A');
  const cachedB = await evaluate(b.tabId, 'fetch("/http-cache").then(r=>r.json())');
  assert.deepEqual(cachedB, { account: 'B', sequence: 2 });
  assert.deepEqual(await evaluate(a.tabId, 'fetch("/http-cache").then(r=>r.json())'), cachedA);
  assert.equal(cacheRequests, 2, 'HTTP cache is separate, and reused inside each session');
  const a2 = await open('/a2', a.sessionId), b2 = await open('/b2', b.sessionId);
  assert.deepEqual(await stored(a2.tabId), expected('A'));
  assert.deepEqual(await stored(b2.tabId), expected('B'));
  assert.equal(a2.contents.session, a.contents.session);
  assert.equal(b2.contents.session, isolated);
  assert.deepEqual(await evaluate(b2.tabId, 'fetch("/http-cache").then(r=>r.json())'), cachedB);
  console.log('PASS bidirectional cookies/localStorage/IndexedDB/service-worker/CacheStorage/HTTP-cache isolation and same-session sharing');

  for (const [tab, marker] of [[a, 'A'], [b, 'B'], [a2, 'A'], [b2, 'B']]) {
    const observed = await call({ action: 'observe', tabId: tab.tabId, mode: 'full' });
    assert.equal(observed.sessionId, tab.sessionId);
    assert.ok(observed.text.includes(`text "${marker}"`), observed.text);
    await call({ action: 'click', tabId: tab.tabId, ref: refOf(observed, 'button', 'Record event') });
    const logs = await until(async () => {
      const result = await call({ action: 'console', tabId: tab.tabId, filter: 'SESSION_EVENT' });
      return result.rows?.length && result;
    }, 'tab console');
    assert.deepEqual(logs.rows.map(row => row.msg), [`SESSION_EVENT ${marker}`]);
    assert.equal(logs.sessionId, tab.sessionId);
    const network = await until(async () => {
      const result = await call({ action: 'network', tabId: tab.tabId, filter: '/api/who' });
      return result.rows?.some(row => row.s === 200) && result;
    }, 'tab network');
    assert.equal(network.sessionId, tab.sessionId);
    const body = await call({ action: 'network', tabId: tab.tabId, id: network.rows[0].id, body: true });
    assert.deepEqual(JSON.parse(body.body), { account: marker });
    assert.equal(body.sessionId, tab.sessionId);
    assert.equal(await evaluate(tab.tabId, 'window.fixtureValue'), marker);
    const expression = await call({ action: 'console', tabId: tab.tabId, expression: 'window.fixtureValue' });
    assert.ok(JSON.stringify(expression).includes(marker));
    const inspected = await call({ action: 'inspect', tabId: tab.tabId, target: { selector: '#identity' } });
    assert.equal(inspected.sessionId, tab.sessionId);
    const frame = refOf(observed, 'iframe', 'Child fixture');
    assert.equal((await call({ action: 'evaluate', tabId: tab.tabId, frame, expression: 'document.querySelector("button").textContent' })).value, 'Frame action');
    const toolbar = presentationOf(tab.contents).toolbar;
    await until(async () => (await toolbar.executeJavaScript("document.getElementById('session').textContent")) === `${tab.sessionName} (${tab.sessionId})`, 'session toolbar label');
  }
  console.log('PASS alternating DOM/iframe/evaluate/console/network/inspect results and window labels belong to the right sessions');

  await evaluate(b.tabId, '(window.open("/popup", "session-child"), "opened")');
  const popup = await until(async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.url === origin + '/popup'), 'session popup');
  assert.equal(popup.sessionId, b.sessionId);
  assert.deepEqual(await stored(popup.tabId), expected('B'));
  await call({ action: 'handoff', tabId: b.tabId });
  await assert.rejects(call({ action: 'observe', tabId: b.tabId }), { code: 'PRIVATE_HANDOFF' });
  await assert.rejects(call({ action: 'close_session', sessionId: b.sessionId }), { code: 'AUTOMATION_PAUSED' });
  await assert.rejects(call({ action: 'create_session' }), { code: 'AUTOMATION_PAUSED' });
  await b.contents.executeJavaScript('console.log("PRIVATE_B"); fetch("/sw-marker").then(r=>r.text())');
  assert.equal(await evaluate(a.tabId, 'fetch("/sw-marker").then(r=>r.text())'), 'A');
  await until(async () => (await call({ action: 'console', tabId: a.tabId, filter: 'SW_MARKER A' })).rows?.length, 'A worker recording stays independent of B handoff');
  // Synthetic human input on the same live page; real credentials are never used.
  const point = await b.contents.executeJavaScript('(()=>{const r=document.querySelector("#alias").getBoundingClientRect();return {x:Math.round(r.x+10),y:Math.round(r.y+10)}})()');
  b.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  b.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await b.contents.insertText('B-login');
  const finish = await b.contents.executeJavaScript('(()=>{const r=document.querySelector("#finish").getBoundingClientRect();return {x:Math.round(r.x+10),y:Math.round(r.y+10)}})()');
  b.contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...finish });
  b.contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...finish });
  await until(() => b.contents.executeJavaScript('localStorage.getItem("identity")==="B-login"'), 'fixture human sign in');
  await menu(frameOf(b.contents), 'Resume automation');
  await until(async () => (await call({ action: 'list_tabs' })).tabs.find(t => t.tabId === b.tabId).mode === 'automation', 'human return');
  assert.doesNotMatch(JSON.stringify(await call({ action: 'console', tabId: b.tabId })), /PRIVATE_B/);
  assert.equal(await evaluate(b2.tabId, 'localStorage.getItem("identity")'), 'B-login');
  assert.deepEqual(await stored(a.tabId), expected('A'));
  const observedB = await call({ action: 'observe', tabId: b.tabId });
  await call({ action: 'click', tabId: b.tabId, ref: refOf(observedB, 'button', 'Log out fixture') });
  assert.equal(await evaluate(b2.tabId, 'document.cookie'), '');
  assert.deepEqual(await stored(a.tabId), expected('A'));
  console.log('PASS manual sign-in/return/privacy and B logout preserve A; popups inherit B');

  const closed = await call({ action: 'close_session', sessionId: b.sessionId });
  assert.equal(closed.cleanupComplete, true, JSON.stringify(closed));
  assert.deepEqual(new Set(closed.closedTabIds), new Set([b.tabId, b2.tabId, popup.tabId]));
  assert.equal(b.contents.isDestroyed(), true);
  assert.equal(b2.contents.isDestroyed(), true);
  assert.deepEqual(await isolated.cookies.get({ url: origin }), []);
  await until(() => Object.keys(isolated.serviceWorkers.getAllRunning()).length === 0, 'closed session workers stopped');
  assert.deepEqual(await stored(a.tabId), expected('A'));
  assert.deepEqual(await evaluate(a2.tabId, 'fetch("/http-cache").then(r=>r.json())'), cachedA);
  await assert.rejects(call({ action: 'open', sessionId: b.sessionId, url: origin + '/closed' }), { code: 'CLOSED_SESSION' });
  const c = await call({ action: 'create_session', name: 'Reference B' });
  const cTab = await open('/c', c.sessionId);
  assert.notEqual(c.sessionId, b.sessionId);
  assert.notEqual(cTab.contents.session, isolated);
  assert.deepEqual(await stored(cTab.tabId), empty);
  await call({ action: 'close_tab', tabId: cTab.tabId });
  const reopened = await open('/c2', c.sessionId);
  await stored(reopened.tabId, 'C');
  await call({ action: 'close_tab', tabId: reopened.tabId });
  const kept = await open('/c3', c.sessionId);
  assert.deepEqual(await stored(kept.tabId), expected('C'), 'last-tab close keeps temporary session storage');
  const lastSession = kept.contents.session;
  await host.close();
  assert.equal(kept.contents.isDestroyed(), true);
  assert.deepEqual(await lastSession.cookies.get({ url: origin }), []);
  console.log('PASS scoped cleanup, worker shutdown, default preservation, fresh partition reuse and connection teardown');
  console.log('SESSIONS_CONTRACT_PASSED');
}

app.on('window-all-closed', () => {});
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await host?.close();
  server?.closeAllConnections();
  server?.close();
  app.exit(process.exitCode ?? 0);
});
