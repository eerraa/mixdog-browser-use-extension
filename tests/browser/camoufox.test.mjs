import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JugglerTransport, chunkCamouEnv, defaultCamouConfig, defaultCamouPrefs } from '../../src/browser/camoufox/juggler.mjs';
import { FirefoxRdpTransport, FirefoxRdpClient } from '../../src/browser/camoufox/rdp.mjs';
import { CamoufoxPresentation, ChromeToolbarClient, formatPausedStatus } from '../../src/browser/camoufox/presentation.mjs';
import { CamoufoxHost, pngClipMatchesTile } from '../../src/browser/camoufox/host.mjs';
import { CAMOUFOX_BOOTSTRAP_URL, createCamoufoxRunnerSandboxFactory } from '../../src/browser/camoufox/runner-sandbox.mjs';
import { deflateSync } from 'node:zlib';
import { acquireProfileLock, releaseProfileLock } from '../../src/browser/camoufox/profile-lock.mjs';
import { loadUserPreferences } from '../../src/shared/preferences.mjs';
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
  const defaultPrefs = defaultCamouPrefs({ enableRdp: true });
  assert.equal(defaultPrefs['permissions.default.persistent-storage'], 2);
  const runnerPrefs = defaultCamouPrefs({ enableRdp: true, hardenedRunner: true });
  assert.equal(runnerPrefs['media.peerconnection.enabled'], false);
  assert.equal(runnerPrefs['devtools.debugger.remote-enabled'], false);
  assert.equal(formatPausedStatus('ko-KR', 'unexpected-page-input'), '직접 입력 감지');
  assert.equal(formatPausedStatus('ko-KR', 'explicit-stop'), '사용자 중지');
  assert.equal(formatPausedStatus('en-US', 'unexpected-page-input'), 'Paused: Direct input');
  assert.equal(formatPausedStatus('ko-KR', 'unknown-internal-code'), '일시정지됨');
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

  // FirefoxRdpClient must resolve evaluationResult delivered in the exact same TCP chunk as evaluateJSAsync resultID
  const sock2 = new PassThrough();
  const origWrite2 = sock2.write.bind(sock2);
  sock2.write = chunk => {
    const text = chunk.toString('utf8');
    const json = JSON.parse(text.slice(text.indexOf(':') + 1));
    if (json.type === 'getProcess') {
      origWrite2(frame({ from: 'root', processDescriptor: { actor: 'proc0' } }));
    } else if (json.type === 'getTarget') {
      origWrite2(frame({ from: 'proc0', process: { consoleActor: 'con0' } }));
    } else if (json.type === 'evaluateJSAsync') {
      // Deliver both resultID reply and evaluationResult in ONE single chunk!
      origWrite2(
        frame({ from: 'con0', resultID: 'fast-1' })
        + frame({ from: 'con0', type: 'evaluationResult', resultID: 'fast-1', result: 42 }),
      );
    }
    return true;
  };
  const client = new FirefoxRdpClient(12345, { connectImpl: () => sock2 });
  const connectP = client.ensureConnected(1000);
  origWrite2(frame({ from: 'root', applicationType: 'browser', traits: {} }));
  assert.equal(await connectP, true);
  assert.equal(await client.chromeEval('42', 1000), 42);
  client.close();
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

  // 204 keepalive beacon receiving Network.requestFailed after 204 response must NOT appear as is:failed
  rec.recordJuggler('Network.requestWillBeSent', {
    requestId: 'r-beacon-ok', frameId: 'f-root', method: 'POST', url: 'https://api.test/telemetry', cause: 'TYPE_BEACON',
  });
  rec.recordJuggler('Network.responseReceived', { requestId: 'r-beacon-ok', status: 204, statusText: 'No Content' });
  rec.recordJuggler('Network.requestFailed', { requestId: 'r-beacon-ok', errorCode: 'NS_ERROR_DOM_NETWORK_ERR' });
  // Genuine network-error beacon (no 2xx/3xx status) MUST still appear as is:failed
  rec.recordJuggler('Network.requestWillBeSent', {
    requestId: 'r-beacon-bad', frameId: 'f-root', method: 'POST', url: 'https://api.test/telemetry-fail', cause: 'TYPE_BEACON',
  });
  rec.recordJuggler('Network.requestFailed', { requestId: 'r-beacon-bad', errorCode: 'NS_ERROR_CONNECTION_REFUSED' });
  const failedRows = rec.networkRows({ filter: 'is:failed' }).rows;
  assert.ok(!failedRows.some(r => r.u.includes('/telemetry') && !r.u.includes('-fail')), '204 beacon must not count as failed');
  assert.ok(failedRows.some(r => r.u.includes('/telemetry-fail')), 'real failed beacon must still count as failed');

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
  assert.equal(p.barEntry({ title: 'HubSpot OAuth', url: 'https://app.hubspot.com/oauth' }).label, 't1 · HubSpot OAuth');
  assert.equal(p.barEntry({ title: '', url: 'https://app.hubspot.com/oauth' }).label, 't1 · app.hubspot.com');
  assert.equal(p.barEntry().needsReturn, false);
  const g1 = p.beginDrain('human-handoff');
  assert.throws(() => p.assertObservable(), { code: 'PRIVATE_HANDOFF' });
  assert.equal(p.enterNative('human-handoff', g1), true);
  assert.equal(p.barEntry().primaryAction, 'resume');
  assert.equal(p.barEntry().needsReturn, true);
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
          if (expr.includes('inspectTarget(')) {
            const isBtn = expr.includes('inspectTarget(2)');
            return {
              result: {
                value: {
                  described: isBtn ? { role: 'button', name: 'Ask' } : { role: 'textbox', name: 'Password' },
                  view: { inView: true, proxied: false },
                  info: isBtn
                    ? { connected: true, disabled: false, readOnly: false, tag: 'INPUT', type: 'file', multiple: false, editable: false, sensitive: false }
                    : { connected: true, disabled: false, readOnly: false, tag: 'INPUT', type: 'password', multiple: false, editable: false, sensitive: true },
                },
              },
            };
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
          if (expr.includes('resolve(')) return { result: { objectId: expr.includes('(2,') ? 'obj-file' : 'obj-1' } };
          return { result: { value: 0 } };
        }
        if (method === 'Runtime.callFunction') {
          const fn = String(params.functionDeclaration ?? '');
          if (fn.includes('sensitive(this)')) {
            const isFile = params.args?.[0]?.objectId === 'obj-file';
            return {
              result: {
                value: isFile
                  ? { connected: true, disabled: false, readOnly: false, tag: 'INPUT', type: 'file', multiple: false, editable: false, sensitive: false }
                  : { connected: true, disabled: false, readOnly: false, tag: 'INPUT', type: 'password', multiple: false, editable: false, sensitive: true },
              },
            };
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

test('CamoufoxHost persistentProfileDir acquires atomic lock, falls back to ephemeral-busy on live conflict, recovers stale lock, and supports resume-all', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wb-cfx-persist-'));
  try {
    const persistentDir = path.join(root, 'profiles', 'camoufox-default');
    const lockPath = `${persistentDir}.lock`;
    const makeMockProc = () => {
      const p = new EventEmitter();
      p.closed = false;
      p.rdpPort = 0;
      p.pid = 42424;
      p.profileDir = null;
      p.start = async () => p;
      p.send = async (method, params = {}, sessionId) => {
        if (method === 'Browser.newPage') {
          const sid = `s-${Math.random().toString(36).slice(2, 7)}`;
          const tid = `t-${Math.random().toString(36).slice(2, 7)}`;
          queueMicrotask(() => {
            p.emit('message', 'Browser.attachedToTarget', { sessionId: sid, targetInfo: { targetId: tid } });
            p.emit('message', 'Page.frameAttached', { frameId: 'f-root' }, sid);
          });
          return { targetId: tid };
        }
        if (method === 'Page.setInitScripts') {
          for (const sc of params.scripts) {
            p.emit('message', 'Runtime.executionContextCreated', { executionContextId: `c-${sc.worldName}`, auxData: { frameId: 'f-root', name: sc.worldName } }, sessionId);
          }
          return {};
        }
        if (method === 'Page.navigate') {
          p.emit('message', 'Page.navigationCommitted', { frameId: 'f-root', url: params.url }, sessionId);
          p.emit('message', 'Page.eventFired', { frameId: 'f-root', name: 'DOMContentLoaded' }, sessionId);
          return {};
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression ?? '');
          if (expr.includes('snapshot(')) {
            return {
              result: {
                value: {
                  url: 'https://app.test/', title: 'App', scrollHeight: 800,
                  checkpoint: { documentId: 'doc-1', revision: 1, x: 0, y: 0, w: 1120, h: 820 },
                  nodes: [], texts: [], gone: [], renamed: [],
                },
              },
            };
          }
          if (expr.includes('privatize(')) return { result: { value: { marked: 0 } } };
          if (expr.includes('quiet(')) return { result: { value: { quiet: true } } };
          return { result: { value: 0 } };
        }
        return {};
      };
      p.sendRaw = p.send;
      p.close = async () => { p.closed = true; };
      return p;
    };

    const dataA = path.join(root, 'conn-a');
    const dataB = path.join(root, 'conn-b');
    const dataC = path.join(root, 'conn-c');
    let usedA = null;
    let usedB = null;
    let usedC = null;

    const hostA = new CamoufoxHost({
      dataDir: dataA, persistentProfileDir: persistentDir, executablePath: 'C:\\fake\\camoufox.exe',
      headless: true, enableRdp: false, onRevokeConnection: () => {},
      createProcess: ({ profileDir }) => { usedA = profileDir; return makeMockProc(); },
    });
    const caller = makeCaller('u-persist');
    assert.equal((await hostA.execute({ action: 'status' }, caller)).profilePersistence, 'persistent-pending');
    const t1 = await hostA.execute({ action: 'open', url: 'https://app.test/' }, caller);
    const t2 = await hostA.execute({ action: 'open', url: 'https://app.test/' }, caller);
    assert.equal(usedA, persistentDir);
    assert.equal((await hostA.execute({ action: 'status' }, caller)).profilePersistence, 'persistent');
    assert.equal(existsSync(lockPath), true);

    // Second live host conflicts with lock -> falls back to ephemeral-busy isolated profile
    const hostB = new CamoufoxHost({
      dataDir: dataB, persistentProfileDir: persistentDir, executablePath: 'C:\\fake\\camoufox.exe',
      headless: true, enableRdp: false, onRevokeConnection: () => {},
      createProcess: ({ profileDir }) => { usedB = profileDir; return makeMockProc(); },
    });
    await hostB.execute({ action: 'open', url: 'https://app.test/' }, caller);
    assert.notEqual(usedB, persistentDir);
    assert.equal((await hostB.execute({ action: 'status' }, caller)).profilePersistence, 'ephemeral-busy');

    // Handoff both tabs in hostA and verify resume-all returns both to automation
    await hostA.execute({ action: 'handoff', tabId: t1.tabId }, caller);
    await hostA.execute({ action: 'handoff', tabId: t2.tabId }, caller);
    assert.equal((await hostA.execute({ action: 'status' }, caller)).pausedCount, 2);
    hostA.triggerControlBarAction('resume-all');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await hostA.execute({ action: 'status' }, caller)).pausedCount > 0) {
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal((await hostA.execute({ action: 'status' }, caller)).pausedCount, 0);

    await hostB.close();
    await hostA.close();
    assert.equal(existsSync(lockPath), false, 'clean close releases persistent profile lock');

    // Write a stale lock owned by a non-existent PID -> next host recovers and acquires persistent dir
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, connectionId: 'dead', acquiredAt: 1 }), 'utf8');
    const hostC = new CamoufoxHost({
      dataDir: dataC, persistentProfileDir: persistentDir, executablePath: 'C:\\fake\\camoufox.exe',
      headless: true, enableRdp: false, onRevokeConnection: () => {},
      createProcess: ({ profileDir }) => { usedC = profileDir; return makeMockProc(); },
    });
    await hostC.execute({ action: 'open', url: 'https://app.test/' }, caller);
    assert.equal(usedC, persistentDir);
    assert.equal((await hostC.execute({ action: 'status' }, caller)).profilePersistence, 'persistent');
    await hostC.close();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChromeToolbarClient mounts once via chromeEval, streams state/flash over authenticated SSE without extra chromeEval calls, and retries transient mount failure', async () => {
  const evals = [];
  let port = 0;
  let token = '';
  let failOnce = true;
  const mockRdp = {
    connected: true,
    closed: false,
    async ensureConnected() { return true; },
    async chromeEval(script) {
      evals.push(script);
      if (failOnce) { failOnce = false; throw new Error('transient startup'); }
      const pm = script.match(/const PORT = (\d+);/);
      const tm = script.match(/const TOKEN = ("[^"]+");/);
      if (pm) port = Number(pm[1]);
      if (tm) token = JSON.parse(tm[1]);
      return 1;
    },
  };
  const bar = new ChromeToolbarClient({ getRdp: () => mockRdp, headless: false, locale: 'ko-KR' });
  const actions = [];
  bar.on('action', (action, tabId) => actions.push({ action, tabId }));

  const s1 = { elevated: false, activeId: 't1', visible: true, tabs: [{ id: 't1', status: '에이전트 자동화 중', primaryText: '직접 조작', primaryAction: 'take-control', stopEnabled: true, needsReturn: false }] };
  bar.sync(s1);
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && !port) await new Promise(r => setTimeout(r, 25));
  assert.ok(port > 0 && token.length >= 32, 'bootstrap retries transient failure and embeds loopback port + 32-byte token');
  assert.equal(evals.length, 2, 'only 1 failed attempt + 1 successful bootstrap chromeEval');
  assert.ok(evals[1].includes('wb-agent-nav-bar') && evals[1].includes('/events'));

  // SSE /events MUST refuse missing/wrong token with 403
  const badSse = await fetch(`http://127.0.0.1:${port}/events`, { headers: { 'X-WB-Token': 'wrong-token' } });
  assert.equal(badSse.status, 403);
  assert.equal(badSse.headers.get('access-control-allow-origin'), null);

  // Valid SSE stream receives initial state + live sync + flash with ZERO extra chromeEval calls
  const sseAbort = new AbortController();
  const sseRes = await fetch(`http://127.0.0.1:${port}/events`, { headers: { 'X-WB-Token': token }, signal: sseAbort.signal });
  assert.equal(sseRes.status, 200);
  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  const readChunk = async () => {
    const { value } = await reader.read();
    for (const block of dec.decode(value, { stream: true }).split('\n\n')) {
      const line = block.split('\n').find(l => l.startsWith('data:'));
      if (line) events.push(JSON.parse(line.slice(5).trim()));
    }
  };
  await readChunk(); // initial state
  const s2 = { ...s1, tabs: [{ id: 't1', status: '직접 조작 중', primaryText: '에이전트에게 돌려주기', primaryAction: 'resume', stopEnabled: true, needsReturn: true }] };
  bar.sync(s2);
  bar.flash('t1');
  while (events.length < 3) await readChunk();
  assert.equal(events[0].type, 'state');
  assert.equal(events[0].state.tabs[0].primaryAction, 'take-control');
  assert.equal(events[1].type, 'state');
  assert.equal(events[1].state.tabs[0].primaryAction, 'resume');
  assert.deepEqual(events[2], { type: 'flash', tabId: 't1' });
  assert.equal(evals.length, 2, 'subsequent sync/flash must push over SSE with zero extra chromeEval calls');
  sseAbort.abort();

  // POST /action auth & validation
  const badTok = await fetch(`http://127.0.0.1:${port}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WB-Token': 'wrong-token' },
    body: JSON.stringify({ action: 'resume', tabId: 't1' }),
  });
  assert.equal(badTok.status, 403);
  const badAct = await fetch(`http://127.0.0.1:${port}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WB-Token': token },
    body: JSON.stringify({ action: 'eval-js', tabId: 't1' }),
  });
  assert.equal(badAct.status, 400);
  const okRes = await fetch(`http://127.0.0.1:${port}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WB-Token': token },
    body: JSON.stringify({ action: 'resume', tabId: 't1' }),
  });
  assert.equal(okRes.status, 200);
  assert.deepEqual(actions, [{ action: 'resume', tabId: 't1' }]);

  bar.close();
  assert.ok(evals.some(s => s.includes('__wbNavToolbar?.destroy()')));
});

test('CamoufoxHost named persistent profiles isolate colliding Juggler IDs, enforce PROFILE_IN_USE, coalesce binds, preserve disk storage on close_session, and guard stale-lock recovery', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wb-cfx-multi-'));
  try {
    const profilesRoot = path.join(root, 'profiles');
    const makeCollidingProc = tag => {
      const p = new EventEmitter();
      p.closed = false;
      p.rdpPort = 0;
      p.pid = 51000 + Math.floor(Math.random() * 1000);
      p.tag = tag;
      p.sent = [];
      p.contexts = new Set();
      p.start = async () => p;
      p.send = async (method, params = {}, sessionId) => {
        p.sent.push({ method, params, sessionId });
        if (method === 'Browser.createBrowserContext') {
          const id = `bc-${p.contexts.size + 1}`;
          p.contexts.add(id);
          return { browserContextId: id };
        }
        if (method === 'Browser.newPage') {
          // Deliberately collide Juggler sessionId & targetId across distinct processes!
          const sid = 'sess-colliding-1';
          const tid = 'tgt-colliding-1';
          queueMicrotask(() => {
            p.emit('message', 'Browser.attachedToTarget', { sessionId: sid, targetInfo: { targetId: tid } });
            p.emit('message', 'Page.frameAttached', { frameId: 'f-root' }, sid);
          });
          return { targetId: tid };
        }
        if (method === 'Page.setInitScripts') {
          for (const sc of params.scripts) {
            p.emit('message', 'Runtime.executionContextCreated', { executionContextId: `c-${sc.worldName}`, auxData: { frameId: 'f-root', name: sc.worldName } }, sessionId);
          }
          return {};
        }
        if (method === 'Page.navigate') {
          p.emit('message', 'Page.navigationCommitted', { frameId: 'f-root', url: params.url }, sessionId);
          p.emit('message', 'Page.eventFired', { frameId: 'f-root', name: 'DOMContentLoaded' }, sessionId);
          return {};
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression ?? '');
          if (expr.includes('snapshot(')) {
            return {
              result: {
                value: {
                  url: `https://${tag}.test/`, title: `Page ${tag}`, scrollHeight: 800,
                  checkpoint: { documentId: `doc-${tag}`, revision: 1, x: 0, y: 0, w: 1120, h: 820 },
                  nodes: [{ id: 1, k: 'i', r: 'button', n: `marker:${tag}`, v: '', s: [], b: [10, 10, 120, 30], vp: true, o: 1 }],
                  texts: [], gone: [], renamed: [],
                },
              },
            };
          }
          if (expr.includes('quiet(')) return { result: { value: { quiet: true } } };
          return { result: { value: 0 } };
        }
        return {};
      };
      p.sendRaw = p.send;
      p.close = async () => { p.closed = true; };
      return p;
    };

    const procs = new Map();
    const hostA = new CamoufoxHost({
      dataDir: path.join(root, 'conn-a'),
      dataRoot: root,
      profilesRoot,
      persistentProfilesEnabled: true,
      executablePath: 'C:\\fake\\camoufox.exe',
      headless: true,
      enableRdp: false,
      onRevokeConnection: () => {},
      createProcess: ({ profileSlug }) => {
        const proc = makeCollidingProc(profileSlug || 'ephemeral');
        procs.set(profileSlug || 'ephemeral', proc);
        return proc;
      },
    });
    const caller = makeCaller('u-multi');

    // list_profiles is strictly read-only: lists default/work/personal without creating dirs or locks
    const listed0 = await hostA.execute({ action: 'list_profiles' }, caller);
    assert.equal(listed0.supported, true);
    assert.deepEqual(listed0.profiles.map(p => p.profile), ['default', 'work', 'personal']);
    assert.ok(listed0.profiles.every(p => p.state === 'available' && p.existsOnDisk === false));
    assert.equal(existsSync(profilesRoot), false, 'list_profiles must not create profiles directory');

    // Coalesce concurrent binds for the same profile slug into one session handle
    const [w1, w2] = await Promise.all([
      hostA.execute({ action: 'create_session', profile: 'work', name: 'Work' }, caller),
      hostA.execute({ action: 'create_session', profile: 'work', name: 'Work' }, caller),
    ]);
    assert.equal(w1.sessionId, w2.sessionId);
    assert.equal(w1.profile, 'work');
    assert.equal(w1.persistent, true);
    assert.equal(w1.temporary, false);

    // Concurrently open tabs in default AND work with deliberately colliding Juggler sessionId/targetId
    const [openDefault, openWork] = await Promise.all([
      hostA.execute({ action: 'open', url: 'https://default.test/' }, caller),
      hostA.execute({ action: 'open', url: 'https://work.test/', sessionId: w1.sessionId }, caller),
    ]);
    assert.match(openDefault.text, /Page default/);
    assert.match(openWork.text, /Page work/);
    assert.notEqual(openDefault.tabId, openWork.tabId);

    const tabs = (await hostA.execute({ action: 'list_tabs' }, caller)).tabs;
    assert.equal(tabs.find(t => t.tabId === openDefault.tabId).profile, 'default');
    assert.equal(tabs.find(t => t.tabId === openWork.tabId).profile, 'work');

    // Second live host gets PROFILE_IN_USE for work, while personal remains available
    const hostB = new CamoufoxHost({
      dataDir: path.join(root, 'conn-b'),
      dataRoot: root,
      profilesRoot,
      persistentProfilesEnabled: true,
      executablePath: 'C:\\fake\\camoufox.exe',
      headless: true,
      enableRdp: false,
      onRevokeConnection: () => {},
      createProcess: ({ profileSlug }) => makeCollidingProc(`b-${profileSlug || 'eph'}`),
    });
    const listB = await hostB.execute({ action: 'list_profiles' }, caller);
    assert.equal(listB.profiles.find(p => p.profile === 'work').state, 'in-use-other');
    assert.equal(listB.profiles.find(p => p.profile === 'personal').state, 'available');
    await assert.rejects(
      hostB.execute({ action: 'create_session', profile: 'work' }, caller),
      err => err.code === 'PROFILE_IN_USE' && err.requestedInputDispatched === false,
    );

    // Closing work session closes its process, releases lock after exit, preserves disk dir, and frees it for hostB
    const closedWork = await hostA.execute({ action: 'close_session', sessionId: w1.sessionId }, caller);
    assert.equal(closedWork.cleanupComplete, true);
    assert.equal(closedWork.storagePreserved, true);
    assert.equal(procs.get('work').closed, true);
    assert.equal(existsSync(path.join(profilesRoot, 'camoufox-work.lock')), false);
    assert.equal(existsSync(path.join(profilesRoot, 'camoufox-work')), true, 'on-disk persistent profile survives close_session');
    assert.equal(procs.get('default').closed, false, 'default runtime stays open');

    const reboundB = await hostB.execute({ action: 'create_session', profile: 'work' }, caller);
    assert.equal(reboundB.profile, 'work');
    assert.equal(reboundB.persistent, true);

    await hostB.close();
    await hostA.close();

    // Two simultaneous contenders recovering ONE stale dead-PID lock: exactly one wins, loser never unlinks winner
    const staleLock = path.join(profilesRoot, 'camoufox-race.lock');
    writeFileSync(staleLock, JSON.stringify({ pid: 999999, token: 'dead-token', acquiredAt: 1 }), 'utf8');
    const [r1, r2] = await Promise.all([
      acquireProfileLock(profilesRoot, 'race', { connectionId: 'c1' }),
      acquireProfileLock(profilesRoot, 'race', { connectionId: 'c2' }),
    ]);
    const winners = [r1, r2].filter(r => r.ok);
    const losers = [r1, r2].filter(r => !r.ok);
    assert.equal(winners.length, 1, 'exactly one contender may reclaim a stale lock');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason, 'busy');
    assert.equal(existsSync(staleLock), true, 'winner lock must still exist');
    // Releasing with a forged token must NOT unlink the winner's lock
    assert.equal(await releaseProfileLock({ lockPath: staleLock, token: 'wrong-token' }), false);
    assert.equal(existsSync(staleLock), true);
    assert.equal(await releaseProfileLock(winners[0]), true);
    assert.equal(existsSync(staleLock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CamoufoxHost persisted #nav-bar elevation toggle, pinned-standard ceiling, in-flight Revert race guard, and internal upload block', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wb-cfx-pref-'));
  try {
    let onFocusBeforeInsert = null;
    const makeProc = () => {
      const p = new EventEmitter();
      p.closed = false;
      p.rdpPort = 0;
      p.pid = 61001;
      p.inserted = [];
      p.start = async () => p;
      p.send = async (method, params = {}, sessionId) => {
        if (method === 'Browser.newPage') {
          const sid = 's-1', tid = 't-1';
          queueMicrotask(() => {
            p.emit('message', 'Browser.attachedToTarget', { sessionId: sid, targetInfo: { targetId: tid } });
            p.emit('message', 'Page.frameAttached', { frameId: 'f-root' }, sid);
          });
          return { targetId: tid };
        }
        if (method === 'Page.setInitScripts') {
          for (const sc of params.scripts) {
            p.emit('message', 'Runtime.executionContextCreated', { executionContextId: `c-${sc.worldName}`, auxData: { frameId: 'f-root', name: sc.worldName } }, sessionId);
          }
          return {};
        }
        if (method === 'Page.navigate') {
          p.emit('message', 'Page.navigationCommitted', { frameId: 'f-root', url: params.url }, sessionId);
          p.emit('message', 'Page.eventFired', { frameId: 'f-root', name: 'DOMContentLoaded' }, sessionId);
          return {};
        }
        if (method === 'Page.insertText') {
          p.inserted.push(params.text);
          return {};
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression ?? '');
          if (expr.includes('snapshot(')) {
            return {
              result: {
                value: {
                  url: 'https://login.test/', title: 'Login', scrollHeight: 800,
                  checkpoint: { documentId: 'd1', revision: 1, x: 0, y: 0, w: 1120, h: 820 },
                  nodes: [
                    { id: 1, k: 'i', r: 'textbox', n: 'Password', v: '', s: [], b: [10, 10, 200, 30], vp: true, o: 1, x: 1 },
                    { id: 2, k: 'i', r: 'button', n: 'File', v: '', s: [], b: [10, 50, 100, 30], vp: true, o: 2 },
                  ],
                  texts: [], gone: [], renamed: [],
                },
              },
            };
          }
          if (expr.includes('inspectTarget(')) {
            const isFile = expr.includes('inspectTarget(2)');
            return {
              result: {
                value: {
                  described: isFile ? { role: 'button', name: 'File' } : { role: 'textbox', name: 'Password' },
                  view: { inView: true, proxied: false },
                  info: isFile
                    ? { connected: true, disabled: false, readOnly: false, tag: 'INPUT', type: 'file', multiple: false, editable: false, sensitive: false }
                    : { connected: true, disabled: false, readOnly: false, tag: 'INPUT', type: 'password', multiple: false, editable: false, sensitive: true },
                },
              },
            };
          }
          if (expr.includes('describe(')) {
            const isFile = expr.includes('describe(2)');
            return { result: { value: { described: isFile ? { role: 'button', name: 'File' } : { role: 'textbox', name: 'Password' } } } };
          }
          if (expr.includes('inView(')) return { result: { value: { view: { inView: true, proxied: false } } } };
          if (expr.includes('getBoundingClientRect') || expr.includes('targetPoint')) return { result: { value: { x: 40, y: 25 } } };
          if (expr.includes('armGuard')) return { result: { value: { armed: true } } };
          if (expr.includes('disarmGuard')) return { result: { value: { guard: { fired: true, inside: true } } } };
          if (expr.includes('quiet(')) return { result: { value: { quiet: true } } };
          if (expr.includes('resolve(')) return { result: { objectId: expr.includes('resolve(2)') ? 'obj-file' : 'obj-1' } };
          return { result: { value: 0 } };
        }
        if (method === 'Runtime.callFunction') {
          const fn = String(params.functionDeclaration ?? '');
          if (fn.includes('sensitive(this)')) {
            const isFile = params.args?.[0]?.objectId === 'obj-file';
            return {
              result: {
                value: isFile
                  ? { connected: true, disabled: false, readOnly: false, tag: 'INPUT', type: 'file', multiple: false, editable: false, sensitive: false }
                  : { connected: true, disabled: false, readOnly: false, tag: 'INPUT', type: 'password', multiple: false, editable: false, sensitive: true },
              },
            };
          }
          if (fn.includes('activeElement')) {
            if (onFocusBeforeInsert) { const cb = onFocusBeforeInsert; onFocusBeforeInsert = null; cb(); }
            return { result: { value: true } };
          }
          return { result: { value: null } };
        }
        return {};
      };
      p.sendRaw = p.send;
      p.close = async () => { p.closed = true; };
      return p;
    };

    const proc = makeProc();
    const host = new CamoufoxHost({
      dataDir: path.join(root, 'connections', 'c1'),
      dataRoot: root,
      profilesRoot: path.join(root, 'profiles'),
      persistentProfilesEnabled: true,
      executablePath: 'C:\\fake\\camoufox.exe',
      headless: true,
      enableRdp: false,
      automationMode: 'standard',
      automationModeSource: 'default',
      automationModePinned: false,
      createProcess: () => proc,
      onRevokeConnection: () => {},
    });
    const caller = makeCaller('u-pref');
    const st0 = await host.execute({ action: 'status' }, caller);
    assert.equal(st0.automationMode, 'standard');
    assert.equal(st0.capabilities.automation.canElevate, true);

    // Human clicks [권한 상승] in #nav-bar → saves user-preferences.json and elevates host
    const okElev = await host.triggerControlBarAction('set-automation-mode', null, 'elevated');
    assert.equal(okElev, true);
    assert.equal((await host.execute({ action: 'status' }, caller)).automationMode, 'elevated');
    assert.equal((await loadUserPreferences(root)).automationMode, 'elevated');

    const opened = await host.execute({ action: 'open', url: 'https://login.test/' }, caller);
    // Revert arriving mid-flight right before Page.insertText must refuse SENSITIVE_INPUT_REFUSED with 0 chars sent!
    let revertDone = null;
    onFocusBeforeInsert = () => { revertDone = host.triggerControlBarAction('revert-standard'); };
    await assert.rejects(
      host.execute({ action: 'type', tabId: opened.tabId, ref: 'e1', text: 'MIDFLIGHT_SECRET' }, caller),
      err => err.code === 'SENSITIVE_INPUT_REFUSED' && err.requestedInputDispatched === false,
    );
    assert.deepEqual(proc.inserted, [], 'zero characters may reach Page.insertText after mid-flight Revert');
    assert.equal((await host.execute({ action: 'status' }, caller)).automationMode, 'standard');
    assert.equal((await host.execute({ action: 'status' }, caller)).capabilities.automation.canElevate, false, 'one-way emergency Revert stays latched on this connection');
    assert.equal(await host.triggerControlBarAction('set-automation-mode', null, 'elevated'), false);
    assert.equal(await revertDone, true);
    assert.equal((await loadUserPreferences(root)).automationMode, 'standard');

    // Uploading internal user-preferences.json must be refused before file disclosure
    await assert.rejects(
      host.execute({ action: 'upload', tabId: opened.tabId, ref: 'e2', files: [path.join(root, 'user-preferences.json')] }, caller),
      err => err.code === 'INVALID_UPLOAD_FILE' && err.requestedInputDispatched === false,
    );
    await host.close();

    // Pinned-standard host cannot be elevated even via #nav-bar action
    const pinned = new CamoufoxHost({
      dataDir: path.join(root, 'connections', 'c2'),
      dataRoot: root,
      executablePath: 'C:\\fake\\camoufox.exe',
      headless: true,
      enableRdp: false,
      automationMode: 'standard',
      automationModeSource: 'env',
      automationModePinned: true,
      createProcess: () => makeProc(),
      onRevokeConnection: () => {},
    });
    assert.equal((await pinned.execute({ action: 'status' }, caller)).capabilities.automation.canElevate, false);
    assert.equal(await pinned.triggerControlBarAction('set-automation-mode', null, 'elevated'), false);
    await pinned.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeSolidPng(width, height, rgba, mutate = null) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = buf => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4;
      const col = mutate?.(x, y) ?? rgba;
      raw[p] = col[0]; raw[p + 1] = col[1]; raw[p + 2] = col[2]; raw[p + 3] = col[3];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('Camoufox latency optimizations: in-view click skips resolveObject/disposeObject, scopes pointerdown disarm, matches iframes in parallel, and verifies clipped 32x32 PNG tiles', async () => {
  const basePng = makeSolidPng(100, 100, [10, 20, 30, 255], (x, y) => (x === 45 && y === 45 ? [200, 100, 50, 255] : null));
  const okClip = makeSolidPng(32, 32, [10, 20, 30, 255], (x, y) => (x === 15 && y === 15 ? [200, 100, 50, 255] : null));
  const mutatedClip = makeSolidPng(32, 32, [10, 20, 30, 255], (x, y) => (x === 15 && y === 15 ? [201, 100, 50, 255] : null));
  assert.equal(pngClipMatchesTile(basePng, okClip, 100, 100, 30, 30, 32, 32), true);
  assert.equal(pngClipMatchesTile(basePng, mutatedClip, 100, 100, 30, 30, 32, 32), false);

  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'wb-cfx-opt-unit-'));
  try {
    const sent = [];
    let inflightDescribe = 0;
    let maxConcurrentDescribe = 0;
    const proc = new EventEmitter();
    proc.closed = false;
    proc.rdpPort = 0;
    proc.start = async () => proc;
    proc.send = async (method, params = {}, sessionId) => {
      sent.push({ method, params, sessionId });
      if (method === 'Browser.newPage') {
        queueMicrotask(() => {
          proc.emit('message', 'Browser.attachedToTarget', { sessionId: 's-opt', targetInfo: { targetId: 't-opt' } });
          proc.emit('message', 'Page.frameAttached', { frameId: 'f-root' }, 's-opt');
          proc.emit('message', 'Page.frameAttached', { frameId: 'f-child-1', parentFrameId: 'f-root' }, 's-opt');
          proc.emit('message', 'Page.frameAttached', { frameId: 'f-child-2', parentFrameId: 'f-root' }, 's-opt');
        });
        return { targetId: 't-opt' };
      }
      if (method === 'Page.setInitScripts') {
        for (const fid of ['f-root', 'f-child-1', 'f-child-2']) {
          for (const sc of params.scripts) {
            proc.emit('message', 'Runtime.executionContextCreated', {
              executionContextId: `c-${fid}-${sc.worldName}`, auxData: { frameId: fid, name: sc.worldName },
            }, sessionId);
          }
        }
        return {};
      }
      if (method === 'Page.navigate') {
        proc.emit('message', 'Page.navigationCommitted', { frameId: 'f-root', url: params.url }, sessionId);
        proc.emit('message', 'Page.eventFired', { frameId: 'f-root', name: 'DOMContentLoaded' }, sessionId);
        return {};
      }
      if (method === 'Page.describeNode') {
        inflightDescribe++;
        maxConcurrentDescribe = Math.max(maxConcurrentDescribe, inflightDescribe);
        await new Promise(r => setTimeout(r, 10));
        inflightDescribe--;
        return { contentFrameId: params.objectId === 'obj-f1' ? 'f-child-1' : 'f-child-2' };
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression ?? '');
        const isRoot = String(params.executionContextId ?? '').includes('f-root');
        if (expr.includes('snapshot(')) {
          return {
            result: {
              value: isRoot
                ? {
                  url: 'https://opt.test/', title: 'Opt', scrollHeight: 800,
                  checkpoint: { documentId: 'doc-r', revision: 1, x: 0, y: 0, w: 1120, h: 820 },
                  nodes: [
                    { id: 1, k: 'i', r: 'button', n: 'Fast', v: '', s: [], b: [10, 10, 80, 30], vp: true, o: 1 },
                    { id: 2, k: 'f', r: 'iframe', n: 'One', v: '', s: [], b: [10, 50, 80, 30], vp: true, o: 2 },
                    { id: 3, k: 'f', r: 'iframe', n: 'Two', v: '', s: [], b: [10, 90, 80, 30], vp: true, o: 3 },
                  ],
                  texts: [], gone: [], renamed: [],
                }
                : {
                  url: 'https://opt.test/child', title: 'Child', scrollHeight: 100,
                  checkpoint: { documentId: `doc-${params.executionContextId}`, revision: 1, x: 0, y: 0, w: 80, h: 30 },
                  nodes: [], texts: [], gone: [], renamed: [],
                },
            },
          };
        }
        if (expr.includes('resolve(2)')) return { result: { objectId: 'obj-f1' } };
        if (expr.includes('resolve(3)')) return { result: { objectId: 'obj-f2' } };
        if (expr.includes('inspectTarget(1)')) {
          return {
            result: {
              value: {
                described: { role: 'button', name: 'Fast' },
                view: { inView: true, proxied: false },
                info: { connected: true, disabled: false, readOnly: false, tag: 'BUTTON', type: 'button', multiple: false, editable: false, sensitive: false },
              },
            },
          };
        }
        if (expr.includes('getBoundingClientRect') || expr.includes('targetPoint')) return { result: { value: { x: 40, y: 25 } } };
        if (expr.includes('armGuard')) return { result: { value: { armed: true } } };
        if (expr.includes('disarmGuard')) return { result: { value: { guard: { fired: true, inside: true } } } };
        if (expr.includes('quiet(')) return { result: { value: { quiet: true } } };
        return { result: { value: 0 } };
      }
      return {};
    };
    proc.sendRaw = proc.send;
    proc.close = async () => { proc.closed = true; };

    const host = new CamoufoxHost({
      dataDir, executablePath: 'C:\\fake\\camoufox.exe', headless: true, enableRdp: false,
      createProcess: () => proc, onRevokeConnection: () => {},
    });
    const caller = makeCaller('u-opt');
    const opened = await host.execute({ action: 'open', url: 'https://opt.test/' }, caller);
    assert.equal(maxConcurrentDescribe, 2, 'iframe owners in a parent frame must resolve in parallel');

    sent.length = 0;
    const clicked = await host.execute({ action: 'click', tabId: opened.tabId, ref: 'e1' }, caller);
    assert.equal(clicked.disposition, 'executed');
    // Before snapshot after click, verify the click phase itself never called resolve(1) or separate describe(1)/inView(1)
    const clickPhase = sent.slice(0, sent.findIndex(s => s.method === 'Runtime.evaluate' && String(s.params.expression).includes('snapshot(')));
    assert.equal(clickPhase.some(s => String(s.params?.expression ?? '').includes('resolve(1)')), false, 'in-view click skips resolveObject');
    assert.equal(clickPhase.some(s => String(s.params?.expression ?? '').includes('inView(1)')), false, 'in-view click uses combined inspectTarget');
    assert.equal(clickPhase.filter(s => String(s.params?.expression ?? '').includes('disarmGuard')).length, 1, 'pointerdown click disarms target frame only');

    await host.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('createCamoufoxRunnerSandboxFactory pre-warms at most one unused spare, leases exclusively, isolates concurrent runs, enforces exact bootstrap URL, and expires idle spares', async () => {
  const created = [];
  const makeRunnerProc = () => {
    const id = created.length + 1;
    const p = new EventEmitter();
    p.id = id;
    p.closed = false;
    p.forceClosed = false;
    p.bindings = [];
    p.evals = [];
    p.start = async () => p;
    p.send = async (method, params = {}, sessionId) => {
      if (method === 'Browser.createBrowserContext') return { browserContextId: `bc-${id}` };
      if (method === 'Browser.newPage') {
        queueMicrotask(() => {
          p.emit('message', 'Browser.attachedToTarget', { sessionId: `s-${id}`, targetInfo: { browserContextId: `bc-${id}` } });
          p.emit('message', 'Page.frameAttached', { frameId: `f-${id}` }, `s-${id}`);
        });
        return { targetId: `t-${id}` };
      }
      if (method === 'Page.navigate') {
        queueMicrotask(() => {
          p.emit('message', 'Page.navigationCommitted', { frameId: `f-${id}`, url: params.url }, sessionId);
          p.emit('message', 'Runtime.executionContextCreated', { executionContextId: `c-${id}`, auxData: { frameId: `f-${id}`, name: '' } }, sessionId);
          p.emit('message', 'Page.eventFired', { frameId: `f-${id}`, name: 'load' }, sessionId);
        });
        return {};
      }
      if (method === 'Page.addBinding') { p.bindings.push(params.name); return {}; }
      if (method === 'Runtime.evaluate') { p.evals.push(params.expression); return { result: { value: { status: 'ok', procId: id } } }; }
      return {};
    };
    p.sendRaw = p.send;
    p.close = async (opts = {}) => { p.closed = true; if (opts.force) p.forceClosed = true; return { exited: true }; };
    created.push(p);
    return p;
  };

  const factory = createCamoufoxRunnerSandboxFactory({
    executablePath: 'C:\\fake\\camoufox.exe',
    createProcess: makeRunnerProc,
    enableWarmSpare: true,
    spareIdleMs: 120,
  });

  // Zero process before first run
  assert.equal(created.length, 0);
  assert.equal(factory.hasWarmSpare(), false);

  // First run cold-starts proc #1 and asynchronously replenishes unused blank spare #2
  const run1 = await factory({ onOp: async () => ({ ok: true }) });
  assert.equal(created[0].bindings.length, 1, 'leased proc gets fresh per-run binding');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(created.length, 2, 'one unused spare is pre-warmed in background');
  assert.equal(created[1].bindings.length, 0, 'unused spare holds no binding, nonce, or caller state');
  assert.equal(factory.hasWarmSpare(), true);

  // Concurrent second run takes unused spare #2 and replenishes #3; destroying run1 hard-kills ONLY #1
  const run2 = await factory({ onOp: async () => ({ ok: true }) });
  run1.destroy();
  assert.equal(created[0].forceClosed, true, 'destroyed run force-kills its own process tree');
  assert.equal(created[1].closed, false, 'concurrent run2 process stays completely untouched');

  // Verify run2 never reuses proc #1 and runs on its own exclusive proc #2
  const res2 = await run2.evaluate('1+1');
  assert.equal(res2.procId, 2);

  // Wait for spare #3 to warm, then verify exact bootstrap URL check rejects a spoofed data: URL even with the real nonce
  await new Promise(r => setTimeout(r, 30));
  assert.equal(created.length, 3);
  const opsAfterSpoof = [];
  const run3 = await factory({ onOp: async op => { opsAfterSpoof.push(op); return { ok: true }; } });
  const realNonce = created[2].evals[0]?.match(/nonce: "([^"]+)"/)?.[1];
  assert.ok(realNonce && realNonce.length >= 32);
  assert.equal((await run3.evaluate('2+2')).procId, 3);
  // Simulate navigation away from exact CAMOUFOX_BOOTSTRAP_URL to another data:text/html URL
  created[2].emit('message', 'Page.navigationCommitted', { frameId: 'f-3', url: 'data:text/html,<h1>spoof</h1>' }, 's-3');
  created[2].emit('message', 'Page.bindingCalled', { name: '__wbRunnerOp', payload: JSON.stringify({ id: 1, nonce: realNonce, op: 'tabs' }) }, 's-3');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(opsAfterSpoof.length, 0, 'spoofed data: URL must never reach onOp even with the real nonce');

  run2.destroy();
  run3.destroy();
  assert.equal(created[1].forceClosed, true);
  assert.equal(created[2].forceClosed, true);

  // Unused spare #4 automatically expires after spareIdleMs
  await new Promise(r => setTimeout(r, 200));
  assert.equal(factory.hasWarmSpare(), false, 'idle unused spare shuts down automatically after TTL');
  assert.ok(created.every(p => p.closed), 'all spawned runner processes are cleanly terminated');

  await factory.close();
  assert.ok(CAMOUFOX_BOOTSTRAP_URL.startsWith('data:text/html;charset=utf-8,'));
});

test('CamoufoxHost reclaims idle non-default persistent profiles into dormant state while retaining .lock, wakes transparently on open/grant, prevents cross-caller bind races, and requires exact token + affirmative exit on release', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wb-cfx-idle-'));
  try {
    const profilesRoot = path.join(root, 'profiles');
    const spawned = [];
    let failExitForSlug = null;

    const makeIdleProc = slug => {
      const idx = spawned.length + 1;
      const p = new EventEmitter();
      p.idx = idx;
      p.slug = slug;
      p.closed = false;
      p.exited = false;
      p.rdpPort = 0;
      p.pid = 70000 + idx;
      p.grants = [];
      p.start = async () => {
        // Introduce async delay to expose any cross-caller bind race
        await new Promise(r => setTimeout(r, 15));
        return p;
      };
      p.send = async (method, params = {}, sessionId) => {
        if (method === 'Browser.grantPermissions') { p.grants.push(params); return {}; }
        if (method === 'Browser.newPage') {
          const sid = `s-${idx}-${Math.random().toString(36).slice(2, 6)}`;
          const tid = `t-${idx}-${Math.random().toString(36).slice(2, 6)}`;
          queueMicrotask(() => {
            p.emit('message', 'Browser.attachedToTarget', { sessionId: sid, targetInfo: { targetId: tid } });
            p.emit('message', 'Page.frameAttached', { frameId: 'f-root' }, sid);
          });
          return { targetId: tid };
        }
        if (method === 'Page.setInitScripts') {
          for (const sc of params.scripts) {
            p.emit('message', 'Runtime.executionContextCreated', { executionContextId: `c-${sc.worldName}`, auxData: { frameId: 'f-root', name: sc.worldName } }, sessionId);
          }
          return {};
        }
        if (method === 'Page.navigate') {
          p.emit('message', 'Page.navigationCommitted', { frameId: 'f-root', url: params.url }, sessionId);
          p.emit('message', 'Page.eventFired', { frameId: 'f-root', name: 'DOMContentLoaded' }, sessionId);
          return {};
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression ?? '');
          if (expr.includes('snapshot(')) {
            return {
              result: {
                value: {
                  url: `https://${slug}.test/`, title: `Title ${slug} #${idx}`, scrollHeight: 800,
                  checkpoint: { documentId: `doc-${idx}`, revision: 1, x: 0, y: 0, w: 1120, h: 820 },
                  nodes: [], texts: [], gone: [], renamed: [],
                },
              },
            };
          }
          if (expr.includes('quiet(')) return { result: { value: { quiet: true } } };
          return { result: { value: 0 } };
        }
        return {};
      };
      p.sendRaw = p.send;
      p.close = async () => {
        p.closed = true;
        if (failExitForSlug === slug) {
          p.exited = false;
          return { exited: false };
        }
        p.exited = true;
        return { exited: true };
      };
      spawned.push(p);
      return p;
    };

    const host = new CamoufoxHost({
      dataDir: path.join(root, 'conn-a'),
      dataRoot: root,
      profilesRoot,
      persistentProfilesEnabled: true,
      idleProfileTimeoutMs: 70,
      executablePath: 'C:\\fake\\camoufox.exe',
      headless: true,
      enableRdp: false,
      onRevokeConnection: () => {},
      createProcess: ({ profileSlug }) => makeIdleProc(profileSlug || 'ephemeral'),
    });
    const callerA = makeCaller('caller-a');
    const callerB = makeCaller('caller-b');

    // 1. Default profile stays awake even when idle (0 tabs)
    const defOpen = await host.execute({ action: 'open', url: 'https://default.test/' }, callerA);
    await host.execute({ action: 'close_tab', tabId: defOpen.tabId }, callerA);

    // 2. Named profile `work` stays awake while a tab is open, then retires after close_tab
    const work = await host.execute({ action: 'create_session', profile: 'work', name: 'Work' }, callerA);
    const workTab = await host.execute({ action: 'open', url: 'https://work.test/', sessionId: work.sessionId }, callerA);
    await new Promise(r => setTimeout(r, 120));
    const workProc1 = spawned.find(p => p.slug === 'work');
    assert.equal(workProc1.closed, false, 'profile with open tab must NOT retire');
    const defProc = spawned.find(p => p.slug === 'default');
    assert.equal(defProc.closed, false, 'default profile is excluded from idle reclamation');

    // Close tab → work becomes idle and retires into dormant while retaining .lock
    await host.execute({ action: 'close_tab', tabId: workTab.tabId }, callerA);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(workProc1.closed, true, 'idle zero-tab named profile process is reclaimed');
    const workLock = path.join(profilesRoot, 'camoufox-work.lock');
    assert.equal(existsSync(workLock), true, 'dormant session retains its exclusive .lock on disk');

    const sessDormant = (await host.execute({ action: 'list_sessions' }, callerA)).sessions.find(s => s.sessionId === work.sessionId);
    assert.equal(sessDormant.state, 'open');
    assert.equal(sessDormant.runtimeState, 'dormant');
    const profDormant = (await host.execute({ action: 'list_profiles' }, callerA)).profiles.find(p => p.profile === 'work');
    assert.equal(profDormant.state, 'in-use-here');
    assert.equal(profDormant.runtimeState, 'dormant');

    // Same-owner create_session returns existing dormant session without spawning Firefox
    const countBeforeRebind = spawned.length;
    const rebind = await host.execute({ action: 'create_session', profile: 'work' }, callerA);
    assert.equal(rebind.sessionId, work.sessionId);
    assert.equal(rebind.runtimeState, 'dormant');
    assert.equal(spawned.length, countBeforeRebind, 're-binding dormant own profile does not spawn Firefox');

    // 3. Transparent wake on open { sessionId } spawns a fresh process under the SAME sessionId + lock
    const wokenTab = await host.execute({ action: 'open', url: 'https://work.test/woken', sessionId: work.sessionId }, callerA);
    assert.equal(wokenTab.sessionId, work.sessionId);
    assert.equal(spawned.length, countBeforeRebind + 1);
    const workProc2 = spawned.at(-1);
    assert.equal(workProc2.slug, 'work');
    assert.equal(workProc2.closed, false);

    // Let work go dormant again, then close_session while dormant → releases lock WITHOUT starting Firefox
    await host.execute({ action: 'close_tab', tabId: wokenTab.tabId }, callerA);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(workProc2.closed, true);
    const countBeforeDormantClose = spawned.length;
    const closedDormant = await host.execute({ action: 'close_session', sessionId: work.sessionId }, callerA);
    assert.equal(closedDormant.cleanupComplete, true);
    assert.equal(closedDormant.storagePreserved, true);
    assert.equal(spawned.length, countBeforeDormantClose, 'closing dormant profile never spawns Firefox');
    assert.equal(existsSync(workLock), false, 'closing dormant profile releases its .lock');

    // 4. Synchronous cross-caller race on same slug: exactly one wins, other gets PROFILE_IN_USE
    const [rA, rB] = await Promise.allSettled([
      host.execute({ action: 'create_session', profile: 'shared-race' }, callerA),
      host.execute({ action: 'create_session', profile: 'shared-race' }, callerB),
    ]);
    const fulfilled = [rA, rB].filter(r => r.status === 'fulfilled');
    const rejected = [rA, rB].filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one caller wins concurrent cross-caller bind');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'PROFILE_IN_USE');

    // 5. Strict token verification: lock file missing `token` must NOT be unlinked by releaseProfileLock
    const noTokenLock = path.join(profilesRoot, 'camoufox-notoken.lock');
    writeFileSync(noTokenLock, JSON.stringify({ pid: process.pid }), 'utf8');
    assert.equal(await releaseProfileLock({ lockPath: noTokenLock, token: 'expected-token' }), false, 'missing token in lock file must refuse unlink');
    assert.equal(existsSync(noTokenLock), true);

    // 6. Affirmative process exit required: if close() returns { exited: false }, lock is retained and close_session fails cleanly
    failExitForSlug = 'stuck-exit';
    const stuck = await host.execute({ action: 'create_session', profile: 'stuck-exit' }, callerA);
    const stuckClose = await host.execute({ action: 'close_session', sessionId: stuck.sessionId }, callerA);
    assert.equal(stuckClose.cleanupComplete, false);
    assert.equal(stuckClose.code, 'SESSION_CLEANUP_FAILED');
    assert.equal(existsSync(path.join(profilesRoot, 'camoufox-stuck-exit.lock')), true, 'lock must remain held when process exit is unconfirmed');

    failExitForSlug = null;
    await host.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
