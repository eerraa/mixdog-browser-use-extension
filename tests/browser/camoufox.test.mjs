import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JugglerTransport, chunkCamouEnv, defaultCamouConfig, defaultCamouPrefs } from '../../src/browser/camoufox/juggler.mjs';
import { FirefoxRdpTransport, FirefoxRdpClient } from '../../src/browser/camoufox/rdp.mjs';
import { CamoufoxPresentation } from '../../src/browser/camoufox/presentation.mjs';
import { CamoufoxHost } from '../../src/browser/camoufox/host.mjs';
import { DevToolsRecorder, PrivacyWindows, responseBody } from '../../src/browser/devtools.mjs';

function makeCaller(sessionId = 'caller-1') {
  const controller = new AbortController();
  return {
    sessionId,
    callId: `call-${Math.random().toString(36).slice(2)}`,
    signal: controller.signal,
    assertLive() { if (controller.signal.aborted) throw new Error('aborted'); },
    abort() { controller.abort(new Error('ended')); },
  };
}

test('JugglerTransport frames NUL-delimited JSON-RPC across split chunks, routes events and rejects on close', async () => {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const transport = new JugglerTransport(toBrowser, fromBrowser);
  const received = [];
  toBrowser.on('data', chunk => received.push(chunk.toString('utf8')));

  const events = [];
  transport.on('message', (method, params, sessionId) => events.push({ method, params, sessionId }));

  const call = transport.send('Browser.getInfo', { x: 1 });
  await new Promise(r => setTimeout(r, 10));
  const raw = received.join('');
  assert.ok(raw.endsWith('\0'));
  const sent = JSON.parse(raw.slice(0, -1));
  assert.equal(sent.method, 'Browser.getInfo');

  // Split JSON response and an event across arbitrary byte boundaries
  const payload = JSON.stringify({ method: 'Page.ready', params: { ok: true }, sessionId: 's-1' }) + '\0'
    + JSON.stringify({ id: sent.id, result: { userAgent: 'Firefox/158.0' } }) + '\0';
  fromBrowser.write(payload.slice(0, 17));
  fromBrowser.write(payload.slice(17, 55));
  fromBrowser.write(payload.slice(55));

  const res = await call;
  assert.equal(res.userAgent, 'Firefox/158.0');
  assert.deepEqual(events, [{ method: 'Page.ready', params: { ok: true }, sessionId: 's-1' }]);

  const pending = transport.send('Page.navigate', { url: 'http://example.invalid' });
  transport.close('eof');
  await assert.rejects(pending, /eof/);
});

test('chunkCamouEnv and defaultCamouConfig/Prefs shape Camoufox environment cleanly', () => {
  const chunks = chunkCamouEnv('CAMOU_CONFIG', { a: 'x'.repeat(2500) });
  assert.ok(chunks.CAMOU_CONFIG_1 && chunks.CAMOU_CONFIG_2);
  assert.equal(JSON.parse(chunks.CAMOU_CONFIG_1 + chunks.CAMOU_CONFIG_2).a.length, 2500);
  const cfg = defaultCamouConfig({ version: '158.0.1-beta.41', locale: 'ko-KR' });
  assert.match(cfg['navigator.userAgent'], /Firefox\/158\.0$/);
  assert.equal(cfg['navigator.userAgent'], cfg['headers.User-Agent']);
  const runnerPrefs = defaultCamouPrefs({ enableRdp: true, hardenedRunner: true });
  assert.equal(runnerPrefs['media.peerconnection.enabled'], false);
  assert.equal(runnerPrefs['devtools.debugger.remote-enabled'], false);
});

test('FirefoxRdpTransport frames length-prefixed UTF-8 packets, matches replies, and emits unsolicited resources', async () => {
  const sock = new PassThrough();
  const written = [];
  const origWrite = sock.write.bind(sock);
  sock.write = (chunk, ...rest) => { written.push(chunk.toString('utf8')); return true; };
  const transport = new FirefoxRdpTransport(sock);

  const frame = obj => {
    const json = JSON.stringify(obj);
    return `${Buffer.byteLength(json, 'utf8')}:${json}`;
  };
  let greeted = null;
  transport.once('greeting', g => { greeted = g; });
  const events = [];
  transport.on('event', e => events.push(e));

  const greeting = frame({ from: 'root', applicationType: 'browser', traits: {} });
  origWrite(greeting.slice(0, 10));
  origWrite(greeting.slice(10));
  assert.equal(greeted?.from, 'root');

  const req = transport.request('root', 'listTabs');
  assert.match(written[0], /^\d+:\{"to":"root","type":"listTabs"\}$/);

  // Interleave an unsolicited resources-available-array event (with multi-byte Korean text!) before the reply
  origWrite(frame({ type: 'resources-available-array', from: 'watcher1', array: [['console-message', [{ text: '한글 로그' }]]] }));
  origWrite(frame({ from: 'root', tabs: [{ actor: 'tab1', url: 'https://example.test/' }] }));

  const reply = await req;
  assert.equal(reply.tabs.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'resources-available-array');
  transport.close();
});

test('DevToolsRecorder Juggler HTTP, redirects, timing, TLS, WebSockets, RDP dedup, enrichment and handoff privacy', async () => {
  let mode = 'automation';
  const shared = new PrivacyWindows(() => mode === 'automation');
  const rec = new DevToolsRecorder(
    () => mode,
    sid => (sid?.startsWith('rdp:service_worker') ? 'service_worker' : sid?.startsWith('worker:') ? 'worker' : 'iframe'),
    shared,
  );

  // Page main-world context vs isolated world context
  rec.recordJuggler('Runtime.executionContextCreated', { executionContextId: 'ctx-page', auxData: { frameId: 'f-root', name: '' } });
  rec.recordJuggler('Runtime.executionContextCreated', { executionContextId: 'ctx-iso', auxData: { frameId: 'f-root', name: 'wb-walker-1' } });
  rec.recordJuggler('Runtime.console', { executionContextId: 'ctx-iso', type: 'error', args: [{ value: 'hidden walker noise' }] });
  rec.recordJuggler('Runtime.console', { executionContextId: 'ctx-page', type: 'error', args: [{ value: 'visible page error Bearer secret12345' }] });
  rec.recordJuggler('Page.dispatchMessageFromWorker', {
    workerId: 'w1',
    message: JSON.stringify({ method: 'runtime.runtimeConsole', params: { type: 'log', args: [{ value: 'worker hello' }] } }),
  });

  const con = rec.consoleRows({});
  assert.equal(con.rows.length, 2);
  assert.ok(!con.rows[0].msg.includes('secret12345'));
  assert.equal(con.rows[0].in, undefined, 'main-frame console has no iframe tag');
  assert.equal(con.rows[1].in, 'worker');

  // Redirect chain: hop 1 (302) → hop 2 (200) with timing + TLS + redacted headers/POST body
  rec.recordJuggler('Network.requestWillBeSent', {
    requestId: 'r1', frameId: 'f-root', method: 'POST', url: 'https://api.test/login?token=abc',
    cause: 'TYPE_FETCH',
    headers: [{ name: 'Authorization', value: 'Bearer topsecret' }, { name: 'Content-Type', value: 'application/json' }],
    postData: Buffer.from(JSON.stringify({ user: 'alice', password: 'pw!' })).toString('base64'),
  });
  rec.recordJuggler('Network.responseReceived', {
    requestId: 'r1', status: 302, statusText: 'Found',
    headers: [{ name: 'Location', value: '/final' }, { name: 'Set-Cookie', value: 'sid=xyz' }],
    timing: { startTime: 1000, domainLookupStart: 1000, domainLookupEnd: 6000, connectStart: 6000, connectEnd: 16000, secureConnectionStart: 10000, requestStart: 16000, responseStart: 36000 },
    securityDetails: { protocol: 'TLSv1.3', subjectName: 'api.test', issuer: 'Test CA' },
  });
  rec.recordJuggler('Network.requestWillBeSent', {
    requestId: 'r2', redirectedFrom: 'r1', frameId: 'f-root', method: 'GET', url: 'https://api.test/final', cause: 'TYPE_FETCH',
  });
  rec.recordJuggler('Network.requestFinished', { requestId: 'r1', transferSize: 200, encodedBodySize: 0, responseEndTime: 41000, protocolVersion: 'HTTP/2' });
  rec.recordJuggler('Network.responseReceived', {
    requestId: 'r2', status: 200, statusText: 'OK',
    headers: [{ name: 'Content-Type', value: 'application/json' }], fromServiceWorker: true,
  });
  rec.recordJuggler('Network.requestFinished', { requestId: 'r2', transferSize: 512, encodedBodySize: 120, protocolVersion: 'HTTP/2' });

  const list = rec.networkRows({});
  assert.equal(list.rows.length, 2);
  const d1 = rec.detail(list.rows[0].id);
  const d2 = rec.detail(list.rows[1].id);
  assert.equal(d1.redirectTo, d2.id);
  assert.equal(d2.redirectFrom, d1.id);
  assert.equal(d1.st, 'redirected');
  assert.equal(d1.ms, 40);
  assert.equal(d1.timing.dnsMs, 5);
  assert.equal(d1.timing.ttfbMs, 20);
  assert.equal(d1.tls.protocol, 'TLSv1.3');
  assert.equal(d1.reqHeaders.Authorization, '[redacted]');
  assert.equal(d1.resHeaders['Set-Cookie'], '[redacted]');
  assert.ok(!d1.reqBody.includes('pw!'));
  assert.equal(d2.c, 'sw');
  assert.throws(() => rec.bodyTarget(d1.id), /redirect/);

  // Response body via Juggler driver
  const body = await responseBody({
    jugglerResponseBody: async reqId => {
      assert.equal(reqId, 'r2');
      return { base64body: Buffer.from(JSON.stringify({ ok: true, api_key: 'SECRET_KEY' })).toString('base64') };
    },
  }, rec.bodyTarget(d2.id), 4000);
  assert.ok(body.body.includes('"ok":true') && !body.body.includes('SECRET_KEY'));

  // WebSocket frames + redaction
  rec.recordJuggler('Page.webSocketCreated', { wsid: 'ws1', frameId: 'f-root', requestURL: 'wss://api.test/ws?token=wssecret' });
  rec.recordJuggler('Page.webSocketOpened', { wsid: 'ws1', effectiveURL: 'wss://api.test/ws?token=wssecret', requestId: 'r2' });
  rec.recordJuggler('Page.webSocketFrameSent', { wsid: 'ws1', opcode: 1, data: '{"token":"my-ws-token","msg":"ping"}' });
  rec.recordJuggler('Page.webSocketFrameReceived', { wsid: 'ws1', opcode: 1, data: '{"msg":"pong"}' });
  rec.recordJuggler('Page.webSocketClosed', { wsid: 'ws1' });
  const wsRow = rec.networkRows({ filter: 'type:websocket' }).rows[0];
  assert.ok(wsRow);
  assert.ok(!wsRow.u.includes('wssecret'));
  const wsFrames = rec.wsFrames(wsRow.id, 4000);
  assert.equal(wsFrames.sent, 1);
  assert.equal(wsFrames.recv, 1);
  assert.ok(!wsFrames.frames[0].data.includes('my-ws-token'));
  assert.ok(wsFrames.frames[1].data.includes('pong'));

  // RDP worker network dedup & lazy enrichment
  rec.recordRdp('available', 'network-event', { actor: 'net-dup', url: 'https://api.test/final', method: 'GET', timeStamp: Date.now() }, 'frame');
  rec.recordRdp('available', 'network-event', { actor: 'net-worker', url: 'https://api.test/worker-data', method: 'POST', cause: { type: 'fetch' }, timeStamp: Date.now() }, 'worker');
  rec.recordRdp('updated', 'network-event', { actor: 'net-worker', resourceUpdates: { status: 201, statusText: 'Created', mimeType: 'application/json', eventTimingsAvailable: true, totalTime: 18 } }, 'worker');
  const workerRow = rec.networkRows({}).rows.find(r => r.u.includes('/worker-data'));
  assert.ok(workerRow);
  assert.equal(workerRow.in, 'worker');
  assert.equal(rec.rdpActorForEnrichment(workerRow.id), 'net-worker');
  rec.enrichRdp(workerRow.id, {
    reqHeaders: { Authorization: 'Bearer worker-secret', Accept: '*/*' },
    resHeaders: { 'Content-Type': 'application/json' },
    reqBody: '{"password":"wpw","count":3}',
  });
  assert.equal(rec.rdpActorForEnrichment(workerRow.id), null, 'enriched once');
  const wd = rec.detail(workerRow.id);
  assert.equal(wd.reqHeaders.Authorization, '[redacted]');
  assert.ok(!wd.reqBody.includes('wpw') && wd.reqBody.includes('"count":3'));

  // Handoff privacy: drop all Juggler HTTP, WebSocket, and RDP events during native-handoff
  mode = 'native-handoff';
  rec.boundary();
  rec.recordJuggler('Network.requestWillBeSent', { requestId: 'r-priv', frameId: 'f-root', method: 'POST', url: 'https://bank.test/otp' });
  rec.recordJuggler('Page.webSocketCreated', { wsid: 'ws-priv', frameId: 'f-root', requestURL: 'wss://bank.test/ws' });
  rec.recordRdp('available', 'network-event', { actor: 'net-priv', url: 'https://bank.test/sw', method: 'GET', timeStamp: Date.now() }, 'service_worker');
  mode = 'automation';
  rec.boundary();
  const after = rec.networkRows({});
  assert.ok(!after.rows.some(r => r.u.includes('bank.test')));
  assert.ok(after.withheld >= 3);
});

test('CamoufoxPresentation transitions fail closed and reflect elevated/return-failed bar entries', () => {
  let elevated = true;
  let syncs = 0;
  const p = new CamoufoxPresentation({ id: 't1', locale: 'en-US', isElevated: () => elevated, onSync: () => { syncs++; } });
  assert.equal(p.mode, 'automation');
  assert.equal(p.barEntry().status, 'Elevated active');
  const g1 = p.beginDrain('human-handoff');
  assert.throws(() => p.assertObservable(), { code: 'PRIVATE_HANDOFF' });
  assert.equal(p.enterNative('human-handoff', g1), true);
  assert.equal(p.barEntry().primaryAction, 'resume');
  p.failReturn({ stage: 'privacy', code: 'RETURN_FAILED' });
  assert.equal(p.mode, 'draining');
  assert.match(p.barEntry().status, /Return failed \(privacy\)/);
  const g2 = p.beginReturn();
  assert.equal(p.finishReturn(g2), true);
  assert.equal(p.mode, 'automation');
  elevated = false;
  assert.equal(p.barEntry().status, 'Agent active');
  assert.ok(syncs >= 4);
});

test('CamoufoxHost with mock Juggler+RDP enforces standard vs elevated mode, one-way revert, prompt dialogs, and isolated sessions', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'wb-cfx-host-unit-'));
  try {
    class MockProc extends EventEmitter {
      closed = false;
      rdpPort = 0;
      contexts = new Set();
      sent = [];
      async start() { return this; }
      async send(method, params = {}, sessionId) { return this.sendRaw(method, params, sessionId); }
      async sendRaw(method, params = {}, sessionId) {
        this.sent.push({ method, params, sessionId });
        if (method === 'Browser.createBrowserContext') {
          const id = `bc-${this.contexts.size + 1}`;
          this.contexts.add(id);
          return { browserContextId: id };
        }
        if (method === 'Browser.removeBrowserContext') {
          this.contexts.delete(params.browserContextId);
          return {};
        }
        if (method === 'Browser.newPage') {
          const sid = `sess-${this.sent.length}`;
          const tid = `tgt-${this.sent.length}`;
          queueMicrotask(() => {
            this.emit('message', 'Browser.attachedToTarget', { sessionId: sid, targetInfo: { targetId: tid, browserContextId: params.browserContextId } });
            this.emit('message', 'Page.frameAttached', { frameId: 'f-root' }, sid);
            this.emit('message', 'Runtime.executionContextCreated', { executionContextId: 'ctx-walker', auxData: { frameId: 'f-root', name: '' } }, sid);
          });
          return { targetId: tid };
        }
        if (method === 'Page.setInitScripts') {
          const walkerWorld = params.scripts[0].worldName;
          const evalWorld = params.scripts[1].worldName;
          const dtWorld = params.scripts[2].worldName;
          this.emit('message', 'Runtime.executionContextCreated', { executionContextId: 'ctx-w', auxData: { frameId: 'f-root', name: walkerWorld } }, sessionId);
          this.emit('message', 'Runtime.executionContextCreated', { executionContextId: 'ctx-e', auxData: { frameId: 'f-root', name: evalWorld } }, sessionId);
          this.emit('message', 'Runtime.executionContextCreated', { executionContextId: 'ctx-d', auxData: { frameId: 'f-root', name: dtWorld } }, sessionId);
          return {};
        }
        if (method === 'Page.navigate') {
          this.emit('message', 'Page.navigationCommitted', { frameId: 'f-root', url: params.url }, sessionId);
          this.emit('message', 'Page.eventFired', { frameId: 'f-root', name: 'DOMContentLoaded' }, sessionId);
          return {};
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression ?? '');
          if (expr.includes('snapshot(')) {
            return {
              result: {
                value: {
                  url: 'https://app.test/login', title: 'Login', scrollHeight: 800,
                  checkpoint: { documentId: 'doc-1', revision: 1, x: 0, y: 0, w: 1120, h: 820 },
                  nodes: [
                    { id: 1, k: 'i', r: 'textbox', n: 'Password', v: '', s: [], b: [10, 10, 200, 30], vp: true, o: 1, x: 1 },
                    { id: 2, k: 'i', r: 'button', n: 'Ask', v: '', s: [], b: [10, 60, 100, 30], vp: true, o: 2 },
                  ],
                  texts: [], gone: [], renamed: [],
                },
              },
            };
          }
          if (expr.includes('getBoundingClientRect') || expr.includes('targetPoint')) {
            return { result: { value: { x: 50, y: 25 } } };
          }
          if (expr.includes('describe(')) {
            const isBtn = expr.includes('(2,');
            return { result: { value: { described: isBtn ? { role: 'button', name: 'Ask' } : { role: 'textbox', name: 'Password' } } } };
          }
          if (expr.includes('inView(')) return { result: { value: { view: { inView: true, proxied: false } } } };
          if (expr.includes('armGuard')) return { result: { value: { armed: true } } };
          if (expr.includes('disarmGuard')) return { result: { value: { guard: { fired: true, inside: true } } } };
          if (expr.includes('quiet(')) return { result: { value: { quiet: true } } };
          if (expr.includes('privatize(')) return { result: { value: { marked: 0 } } };
          if (expr.includes('resolve(')) return { result: { objectId: 'obj-1' } };
          return { result: { value: 0 } };
        }
        if (method === 'Runtime.callFunction') {
          const fn = String(params.functionDeclaration ?? '');
          if (fn.includes('sensitive(this)')) {
            return { result: { value: { connected: true, disabled: false, readOnly: false, tag: 'INPUT', type: 'password', multiple: false, editable: false, sensitive: true } } };
          }
          if (fn.includes('activeElement')) return { result: { value: true } };
          return { result: { value: null } };
        }
        return {};
      }
      async close() { this.closed = true; }
    }

    const proc = new MockProc();
    const host = new CamoufoxHost({
      dataDir,
      executablePath: 'C:\\fake\\camoufox.exe',
      headless: true,
      enableRdp: false,
      automationMode: 'elevated',
      automationModeSource: 'env',
      createProcess: () => proc,
      onRevokeConnection: () => {},
    });
    const caller = makeCaller('u1');

    // Status exposes Camoufox engine, prompt support, and elevated mode
    const st = await host.execute({ action: 'status' }, caller);
    assert.equal(st.engine, 'camoufox');
    assert.equal(st.automationMode, 'elevated');
    assert.deepEqual(st.capabilities.javascriptDialogs.supported, ['alert', 'confirm', 'prompt']);

    // Open page & verify elevated fill into password succeeds
    const opened = await host.execute({ action: 'open', url: 'https://app.test/login' }, caller);
    assert.equal(opened.disposition, 'executed');
    assert.match(opened.text, /e1 textbox "Password"/);
    const fillElevated = await host.execute({ action: 'fill', tabId: opened.tabId, ref: 'e1', text: 'hunter2' }, caller);
    assert.equal(fillElevated.disposition, 'executed');

    // One-way Control Bar revert to standard mode blocks subsequent sensitive fill
    host.triggerControlBarAction('revert-standard');
    assert.equal((await host.execute({ action: 'status' }, caller)).automationMode, 'standard');
    await assert.rejects(
      host.execute({ action: 'fill', tabId: opened.tabId, ref: 'e1', text: 'hunter2' }, caller),
      err => err.code === 'SENSITIVE_INPUT_REFUSED' && err.requestedInputDispatched === false,
    );
    // Clearing sensitive field with text:"" stays allowed in standard mode
    const cleared = await host.execute({ action: 'fill', tabId: opened.tabId, ref: 'e1', text: '' }, caller);
    assert.equal(cleared.disposition, 'executed');

    // Native prompt dialog via Page.dialogOpened + handle_dialog with promptText
    const tabSession = proc.sent.find(s => s.method === 'Page.navigate').sessionId;
    proc.emit('message', 'Page.dialogOpened', { dialogId: 'dlg-1', type: 'prompt', message: 'Enter code', defaultValue: '000' }, tabSession);
    const reqs = await host.execute({ action: 'requests', tabId: opened.tabId }, caller);
    assert.equal(reqs.pending.length, 1);
    assert.equal(reqs.pending[0].context.type, 'prompt');
    await host.execute({ action: 'handle_dialog', tabId: opened.tabId, accept: true, promptText: '9876' }, caller);
    const handled = proc.sent.find(s => s.method === 'Page.handleDialog');
    assert.deepEqual(handled.params, { dialogId: 'dlg-1', accept: true, promptText: '9876' });

    // Temporary session lifecycle (create / list / close)
    const ses = await host.execute({ action: 'create_session', name: 'Work' }, caller);
    assert.equal(ses.temporary, true);
    assert.equal(proc.contexts.size, 1);
    const listed = await host.execute({ action: 'list_sessions' }, caller);
    assert.equal(listed.sessions.length, 2);
    const closedSes = await host.execute({ action: 'close_session', sessionId: ses.sessionId }, caller);
    assert.equal(closedSes.cleanupComplete, true);
    assert.equal(proc.contexts.size, 0);

    await host.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
