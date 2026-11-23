import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CamoufoxHost } from '../../src/browser/camoufox/host.mjs';
import { ChromeToolbarClient } from '../../src/browser/camoufox/presentation.mjs';
import { FirefoxRdpClient } from '../../src/browser/camoufox/rdp.mjs';
import { CamoufoxProcess } from '../../src/browser/camoufox/juggler.mjs';
import { camoufoxExecutable } from '../../src/shared/paths.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeCaller(sessionId = 'live-cfx-caller') {
  const controller = new AbortController();
  let seq = 0;
  return {
    next() {
      return {
        sessionId,
        callId: `call-${++seq}`,
        signal: controller.signal,
        assertLive() { if (controller.signal.aborted) throw new Error('aborted'); },
      };
    },
    abort() { controller.abort(new Error('ended')); },
  };
}

function refOf(text, role, name) {
  const esc = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`(e\\d+) ${role} ${esc}`));
  assert.ok(match, `Expected ${role} "${name}" in:\n${text}`);
  return match[1];
}

async function until(predicate, label, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const val = await predicate();
    if (val) return val;
    await delay(50);
  }
  throw new Error(`Timed out: ${typeof label === 'function' ? label() : label}`);
}

// Minimal RFC-6455 WebSocket server helper (text echo + server push, zero deps).
function attachWebSocketEcho(server) {
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    const sendText = text => {
      const payload = Buffer.from(text, 'utf8');
      const header = payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
      try { socket.write(Buffer.concat([header, payload])); } catch { /* closed */ }
    };
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        const data = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
        buf = buf.subarray(off + maskLen + len);
        if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        if (opcode === 8) { socket.end(); return; }
        if (opcode === 1) sendText(`echo:${data.toString('utf8')}`);
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  return {
    closeAll() { for (const s of sockets) try { s.destroy(); } catch {} sockets.clear(); },
  };
}

async function startFixtureServer() {
  const state = { clicks: 0, uploaded: '', workerHits: 0, privHits: 0, ua: '', privWaiters: [] };
  const releasePrivate = () => { for (const fn of state.privWaiters.splice(0)) fn(); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/private-wait') {
      state.privWaiters.push(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('go'); });
      return;
    }
    if (u.pathname === '/app.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('/* app.css */\n#actionBtn {\n  color: rgb(10, 20, 30);\n  padding: 6px 12px;\n}\n');
      return;
    }
    if (u.pathname === '/redir-start') {
      res.writeHead(302, { Location: '/redir-final', 'Set-Cookie': 'secret_session=DROP_ME; Path=/' });
      res.end('redirecting');
      return;
    }
    if (u.pathname === '/redir-final') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ redirected: true, access_token: 'SECRET_TOKEN_VALUE', ok: 1 }));
      return;
    }
    if (u.pathname === '/missing-api') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (u.pathname === '/worker.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`
        console.log('dedicated-worker-hello');
        fetch('/worker-api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer WORKER_SECRET_BEARER' },
          body: JSON.stringify({ password: 'WORKER_PASSWORD', ping: 'ok' })
        }).then(r => r.json()).then(d => postMessage(d));
      `);
      return;
    }
    if (u.pathname === '/worker-api') {
      state.workerHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workerReply: 'pong', secret: 'WORKER_RESP_SECRET' }));
      return;
    }
    if (u.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`
        self.addEventListener('install', e => self.skipWaiting());
        self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', e => {
          if (new URL(e.request.url).pathname === '/sw-synth') {
            e.respondWith(new Response(JSON.stringify({ fromSw: true, api_key: 'SW_SECRET_KEY' }), {
              status: 200, headers: { 'Content-Type': 'application/json' }
            }));
          }
        });
      `);
      return;
    }
    if (u.pathname === '/private-hit') {
      state.privHits++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('private-ok');
      return;
    }
    if (u.pathname === '/download') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="report.txt"',
      });
      res.end('downloaded-file-payload');
      return;
    }
    if (u.pathname === '/iframe-child') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><body style="margin:0"><button id="inFrame" onclick="document.querySelector('output').textContent='frame-clicked'">Inside Frame</button><output></output></body>`);
      return;
    }
    if (u.pathname === '/session-cookie') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
      return;
    }
    if (u.pathname === '/click-hit') {
      state.clicks++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (u.pathname === '/privacy-link') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Privacy Policy Trap</title><p>Should not have navigated here</p>');
      return;
    }
    if (u.pathname === '/form') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Runner Form</title>
        <style>
          .consent-wrap { position: relative; display: inline-flex; align-items: center; width: 420px; padding-left: 28px; height: 28px; cursor: pointer; }
          .consent-wrap input { position: absolute; opacity: 0; width: 1px; height: 1px; left: 0; top: 0; }
          .consent-box { position: absolute; left: 4px; top: 6px; width: 16px; height: 16px; border: 1px solid #333; }
        </style>
        <label>Email <input id="email"></label>
        <label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
        <label class="consent-wrap">
          <input id="agreeBox" type="checkbox">
          <span class="consent-box"></span>
          <span>I agree to the <a id="privacyLink" href="/privacy-link">HubSpot Terms and Privacy Policy</a></span>
        </label>
        <button onclick="fetch('/click-hit');document.querySelector('[role=status]').textContent='Saved '+email.value+' '+plan.value+' '+agreeBox.checked">Save</button>
        <p role="status"></p>
        <div style="height:1800px">Tall spacer</div>
        <p id="bottomMarker">Bottom reached</p>`);
      return;
    }
    state.ua = req.headers['user-agent'] || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Camoufox Live Fixture</title>
        <link rel="stylesheet" href="/app.css">
      </head>
      <body>
        <h1>Camoufox Live Test</h1>
        <label>Username <input id="user" type="text"></label>
        <label>Password <input id="pw" type="password" value="INITIAL_SECRET_PW"></label>
        <button id="actionBtn">Run Action</button>
        <button id="promptBtn">Open Prompt</button>
        <button id="confirmBtn">Open Confirm</button>
        <input id="fileIn" type="file">
        <a id="dlLink" href="/download">Download File</a>
        <div id="shadowHost"></div>
        <iframe src="/iframe-child" style="width:260px;height:80px;border:1px solid #999"></iframe>
        <output id="out">ready</output>
        <output id="wsOut">ws-idle</output>
        <output id="workerOut">worker-idle</output>
        <output id="swOut">sw-idle</output>
        <script>
          window.appState = { answer: 42, ua: navigator.userAgent, webdriver: navigator.webdriver };
          document.getElementById('actionBtn').addEventListener('click', () => {
            fetch('/click-hit');
            document.getElementById('out').textContent = 'clicked:' + document.getElementById('user').value;
          });
          document.getElementById('promptBtn').addEventListener('click', () => {
            const val = prompt('Enter OTP label', 'default-otp');
            document.getElementById('out').textContent = 'prompt:' + val;
          });
          document.getElementById('confirmBtn').addEventListener('click', () => {
            const ok = confirm('Confirm live?');
            document.getElementById('out').textContent = 'confirm:' + ok;
          });
          document.getElementById('fileIn').addEventListener('change', e => {
            document.getElementById('out').textContent = 'file:' + (e.target.files[0]?.name || '');
          });
          const sr = document.getElementById('shadowHost').attachShadow({ mode: 'open' });
          sr.innerHTML = '<button id="shadowBtn">Shadow Click</button>';
          sr.getElementById('shadowBtn').addEventListener('click', () => {
            document.getElementById('out').textContent = 'shadow-ok';
          });

          // Trigger console, redirect chain, 404, WebSocket, dedicated worker, and Service Worker
          console.error('live-console-error token=CONSOLE_SECRET');
          fetch('/redir-start?token=QUERY_SECRET', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer REQ_HEADER_SECRET', 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'BODY_PASSWORD', action: 'test' }),
          });
          fetch('/missing-api');

          const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(wsProto + '//' + location.host + '/live-ws?token=WS_URL_SECRET');
          window.__ws = ws;
          ws.onopen = () => ws.send(JSON.stringify({ token: 'WS_FRAME_SECRET', ping: 1 }));
          ws.onmessage = ev => { document.getElementById('wsOut').textContent = ev.data; };

          const w = new Worker('/worker.js');
          w.onerror = e => { document.getElementById('workerOut').textContent = 'worker-err:' + (e.message || e.type); };
          w.onmessage = ev => { document.getElementById('workerOut').textContent = ev.data.workerReply; };

          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').then(async () => {
              await navigator.serviceWorker.ready;
              if (!navigator.serviceWorker.controller) {
                await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
              }
              const r = await fetch('/sw-synth');
              const d = await r.json();
              document.getElementById('swOut').textContent = d.fromSw ? 'sw-ok' : 'sw-miss';
            }).catch(() => {});
          }
        </script>
      </body>
      </html>`);
  });
  const ws = attachWebSocketEcho(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    state,
    releasePrivate,
    url: `http://127.0.0.1:${port}/`,
    async close() {
      ws.closeAll();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('live Camoufox 158: token-saving perception, complete network/WebSocket/worker/SW/RDP debugging, dialogs, sessions, elevated mode and runner', { timeout: 120000 }, async t => {
  const cfx = camoufoxExecutable(process.cwd());
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'wb-cfx-live-'));
  const srv = await startFixtureServer();
  const host = new CamoufoxHost({
    dataDir,
    executablePath: cfx.executablePath,
    camoufoxVersion: cfx.version,
    headless: true,
    enableRdp: true,
    automationMode: 'standard',
    onRevokeConnection: () => {},
  });
  t.after(async () => {
    await host.close().catch(() => {});
    await srv.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  const caller = makeCaller('live-owner');

  // 1. Open page, verify token-saving perception, iframes, shadow DOM, sensitive masking, navigator.webdriver === false
  const opened = await host.execute({ action: 'open', url: srv.url }, caller.next());
  assert.equal(opened.disposition, 'executed');
  const tabId = opened.tabId;
  assert.ok(!opened.text.includes('INITIAL_SECRET_PW'), 'sensitive password value must never leak into observation');
  assert.match(opened.text, /textbox "Username"/);
  assert.match(opened.text, /textbox "Password"/);
  assert.match(opened.text, /button "Run Action"/);
  assert.match(opened.text, /button "Shadow Click"/);

  // Wait for iframe + WS + worker + SW to finish bootstrapping
  let obs;
  try {
    await until(async () => {
      obs = await host.execute({ action: 'observe', tabId, mode: 'full' }, caller.next());
      return obs.text.includes('echo:') && obs.text.includes('pong') && obs.text.includes('Inside Frame');
    }, () => `iframe + WebSocket echo + dedicated worker completion (got:\n${obs?.text})`, 8000);
  } catch (err) {
    const dbgCon = await host.execute({ action: 'console', tabId, limit: 50 }, caller.next()).catch(e => ({ err: e.message }));
    const dbgNet = await host.execute({ action: 'network', tabId, limit: 50 }, caller.next()).catch(e => ({ err: e.message }));
    throw new Error(`${err.message}\nCONSOLE=${JSON.stringify(dbgCon)}\nNETWORK=${JSON.stringify(dbgNet)}`);
  }

  // Verify diff, find, and persistent refs
  const found = await host.execute({ action: 'observe', tabId, find: 'Shadow Click' }, caller.next());
  const shadowRef = refOf(found.text, 'button', 'Shadow Click');
  const shadowClicked = await host.execute({ action: 'click', tabId, ref: shadowRef }, caller.next());
  assert.equal(shadowClicked.disposition, 'executed');
  assert.match(shadowClicked.text, /shadow-ok/);

  // Click button inside iframe
  const fullObs = await host.execute({ action: 'observe', tabId, mode: 'full' }, caller.next());
  const frameBtnRef = refOf(fullObs.text, 'button', 'Inside Frame');
  const frameClick = await host.execute({ action: 'click', tabId, ref: frameBtnRef }, caller.next());
  assert.equal(frameClick.disposition, 'executed');
  assert.match(frameClick.text, /frame-clicked/);

  // 2. Complete network debugging: redirect chain, redacted headers/POST body, response body, 404, WebSocket frames, SW & worker
  const netList = await until(async () => {
    const res = await host.execute({ action: 'network', tabId, limit: 100 }, caller.next());
    const hasRedir = res.rows.some(r => r.u.includes('/redir-start')) && res.rows.some(r => r.u.includes('/redir-final'));
    const has404 = res.rows.some(r => r.u.includes('/missing-api') && r.s === 404);
    const hasWs = res.rows.some(r => r.ty === 'websocket');
    const hasWorker = res.rows.some(r => r.u.includes('/worker-api'));
    return hasRedir && has404 && hasWs && hasWorker ? res : null;
  }, 'network rows (redirect, 404, websocket, worker-api)', 12000);

  const redirStart = netList.rows.find(r => r.u.includes('/redir-start'));
  const redirFinal = netList.rows.find(r => r.u.includes('/redir-final'));
  assert.ok(!redirStart.u.includes('QUERY_SECRET'), 'URL query secrets must be redacted');
  const dStart = await host.execute({ action: 'network', tabId, id: redirStart.id }, caller.next());
  const dFinal = await host.execute({ action: 'network', tabId, id: redirFinal.id }, caller.next());
  assert.equal(dStart.s, 302);
  assert.equal(dStart.redirectTo, redirFinal.id);
  assert.equal(dFinal.redirectFrom, redirStart.id);
  assert.equal(dStart.reqHeaders.Authorization, '[redacted]');
  assert.equal(dStart.resHeaders['Set-Cookie'], '[redacted]');
  assert.ok(dStart.reqBody && !dStart.reqBody.includes('BODY_PASSWORD'), 'request POST body password must be redacted');

  const finalBody = await host.execute({ action: 'network', tabId, id: redirFinal.id, body: true }, caller.next());
  assert.ok(finalBody.body.includes('"redirected":true') && !finalBody.body.includes('SECRET_TOKEN_VALUE'), 'response body redacted');

  // WebSocket detail & frames
  const wsRow = netList.rows.find(r => r.ty === 'websocket');
  assert.ok(!wsRow.u.includes('WS_URL_SECRET'));
  const wsDetail = await host.execute({ action: 'network', tabId, id: wsRow.id }, caller.next());
  assert.equal(wsDetail.s, 101);
  assert.ok(wsDetail.ws.sent >= 1 && wsDetail.ws.recv >= 1);
  const wsFrames = await host.execute({ action: 'network', tabId, id: wsRow.id, body: true }, caller.next());
  assert.ok(wsFrames.frames.some(f => f.dir === 'out' && !f.data.includes('WS_FRAME_SECRET')));
  assert.ok(wsFrames.frames.some(f => f.dir === 'in' && f.data.includes('echo:')));

  // Dedicated Worker request & console
  const workerNet = netList.rows.find(r => r.u.includes('/worker-api'));
  assert.ok(workerNet, `Expected /worker-api in network rows:\n${JSON.stringify(netList.rows, null, 2)}`);
  const workerDetail = await host.execute({ action: 'network', tabId, id: workerNet.id }, caller.next());
  assert.equal(workerDetail.s, 200);
  if (workerDetail.reqHeaders?.Authorization) assert.equal(workerDetail.reqHeaders.Authorization, '[redacted]');

  // Service Worker synthesized response (if SW activated on loopback HTTP)
  const swRow = netList.rows.find(r => r.u.includes('/sw-synth'));
  if (swRow) {
    const swBody = await host.execute({ action: 'network', tabId, id: swRow.id, body: true }, caller.next());
    assert.ok(swBody.body.includes('"fromSw":true') && !swBody.body.includes('SW_SECRET_KEY'));
  }

  // Console logs (main + worker, redacted)
  const con = await host.execute({ action: 'console', tabId, limit: 50 }, caller.next());
  assert.ok(con.rows.some(r => r.msg.includes('live-console-error') && !r.msg.includes('CONSOLE_SECRET')));
  assert.ok(con.rows.some(r => r.msg.includes('dedicated-worker-hello') && r.in === 'worker'), `Expected worker console:\n${JSON.stringify(con.rows)}`);

  // 3. SENSITIVE_PRESENT blocks page code beside filled password; clear password with fill "" then verify console(expression) + inspect + performance!
  const pwRef = refOf(fullObs.text, 'textbox', 'Password');
  // Standard mode refuses non-empty fill into password!
  await assert.rejects(
    host.execute({ action: 'fill', tabId, ref: pwRef, text: 'NEW_SECRET' }, caller.next()),
    err => err.code === 'SENSITIVE_INPUT_REFUSED' && err.requestedInputDispatched === false,
  );
  // Page code refused while INITIAL_SECRET_PW is in password field
  await assert.rejects(
    host.execute({ action: 'console', tabId, expression: 'window.appState.answer' }, caller.next()),
    err => err.code === 'SENSITIVE_PRESENT',
  );
  // Clear password with text: ""
  const cleared = await host.execute({ action: 'fill', tabId, ref: pwRef, text: '' }, caller.next());
  assert.equal(cleared.disposition, 'executed');

  // Eager side-effect-free console(expression) via Firefox RDP
  const eagerOk = await host.execute({ action: 'console', tabId, expression: 'window.appState.answer' }, caller.next());
  assert.deepEqual([eagerOk.type, eagerOk.value], ['number', 42]);
  const wdFlag = await host.execute({ action: 'console', tabId, expression: 'window.appState.webdriver' }, caller.next());
  assert.equal(wdFlag.value, false, 'Camoufox must not expose navigator.webdriver=true');
  await assert.rejects(
    host.execute({ action: 'console', tabId, expression: 'window.appState.answer = 999' }, caller.next()),
    err => err.code === 'SIDE_EFFECT',
  );
  // Prove mutation was genuinely aborted
  const afterSideEffect = await host.execute({ action: 'console', tabId, expression: 'window.appState.answer' }, caller.next());
  assert.equal(afterSideEffect.value, 42);

  // Inspect element: computed style + Firefox RDP matched CSS rules (/app.css) + native DOM event listeners!
  const actionBtnRef = refOf(fullObs.text, 'button', 'Run Action');
  const inspected = await host.execute({ action: 'inspect', tabId, ref: actionBtnRef, values: ['color'] }, caller.next());
  assert.equal(inspected.visible, true);
  assert.equal(inspected.style.color, 'rgb(10, 20, 30)');
  assert.ok(Array.isArray(inspected.rules) && inspected.rules.some(r => r.s.includes('#actionBtn') && String(r.src).includes('/app.css')),
    `Expected matched CSS rule from /app.css, got:\n${JSON.stringify(inspected)}`);
  assert.ok(inspected.listeners && inspected.listeners.click >= 1,
    `Expected native click listener via RDP, got:\n${JSON.stringify(inspected)}`);

  // Performance metrics
  const perf = await host.execute({ action: 'performance', tabId }, caller.next());
  assert.ok(perf.m.nodes > 5 && perf.nav);

  // 4. Fill username + click Run Action + upload local file + refuse UNC upload
  const userRef = refOf(fullObs.text, 'textbox', 'Username');
  await host.execute({ action: 'fill', tabId, ref: userRef, text: 'camou-user' }, caller.next());
  const runClick = await host.execute({ action: 'click', tabId, ref: actionBtnRef }, caller.next());
  assert.match(runClick.text, /clicked:camou-user/);

  const uploadFile = path.join(dataDir, 'sample.txt');
  writeFileSync(uploadFile, 'hello-upload');
  await assert.rejects(
    host.execute({ action: 'upload', tabId, target: { selector: '#fileIn' }, files: ['\\\\server\\share\\x.txt'] }, caller.next()),
    err => err.code === 'INVALID_UPLOAD_FILE',
  );
  const uploaded = await host.execute({ action: 'upload', tabId, target: { selector: '#fileIn' }, files: [uploadFile] }, caller.next());
  assert.equal(uploaded.disposition, 'executed');
  assert.match(uploaded.text, /file:sample\.txt/);

  // 5. Native JS prompt() with promptText AND confirm() via respond
  const promptBtnRef = refOf(fullObs.text, 'button', 'Open Prompt');
  const promptHit = await host.execute({ action: 'click', tabId, ref: promptBtnRef }, caller.next());
  assert.equal(promptHit.code, 'DIALOG_OPEN');
  assert.ok(promptHit.pendingRequests.length === 1 && promptHit.pendingRequests[0].context.type === 'prompt');
  const promptHandled = await host.execute({ action: 'handle_dialog', tabId, accept: true, promptText: 'CUSTOM_42' }, caller.next());
  assert.equal(promptHandled.disposition, 'executed');
  assert.match(promptHandled.text, /prompt:CUSTOM_42/);

  const confirmBtnRef = refOf(fullObs.text, 'button', 'Open Confirm');
  const confirmHit = await host.execute({ action: 'click', tabId, ref: confirmBtnRef }, caller.next());
  assert.equal(confirmHit.code, 'DIALOG_OPEN');
  const reqs = await host.execute({ action: 'requests', tabId }, caller.next());
  const dismissOpt = reqs.pending[0].options.find(o => o.label === 'Dismiss');
  const responded = await host.execute({ action: 'respond', tabId, requestRef: reqs.pending[0].requestRef, response: { optionRef: dismissOpt.optionRef } }, caller.next());
  assert.equal(responded.request.resolution, 'resolved');
  const afterConfirm = await host.execute({ action: 'observe', tabId, mode: 'text' }, caller.next());
  assert.match(afterConfirm.text, /confirm:false/);

  // 6. Handoff privacy: freeze in-flight request and drop mid-handoff HTTP + WS events, then resume via Control Bar
  await host.execute({
    action: 'evaluate', tabId, world: 'page',
    expression: 'fetch("/private-wait").then(() => { fetch("/private-hit"); window.__ws?.send("PRIVATE_WS_SECRET"); }); "armed"',
  }, caller.next());
  await until(() => srv.state.privWaiters.length >= 1, 'private-wait in flight');
  const handoffRes = await host.execute({ action: 'handoff', tabId }, caller.next());
  assert.equal(handoffRes.disposition, 'executed');
  await assert.rejects(host.execute({ action: 'observe', tabId }, caller.next()), err => err.code === 'PRIVATE_HANDOFF');
  await assert.rejects(host.execute({ action: 'network', tabId }, caller.next()), err => err.code === 'PRIVATE_HANDOFF');
  srv.releasePrivate();
  await until(() => srv.state.privHits >= 1, 'private fetch fired during handoff');
  await delay(120);
  // Simulate human return via Control Bar
  host.triggerControlBarAction('resume', tabId);
  await until(async () => {
    const tabs = await host.execute({ action: 'list_tabs' }, caller.next());
    return tabs.tabs.find(x => x.tabId === tabId)?.mode === 'automation';
  }, 'Control Bar human return', 8000);
  const resumedObs = await host.execute({ action: 'observe', tabId }, caller.next());
  assert.equal(resumedObs.disposition, 'observed');
  const netAfterHandoff = await host.execute({ action: 'network', tabId, limit: 100 }, caller.next());
  const waitRow = netAfterHandoff.rows.find(r => r.u.includes('/private-wait'));
  assert.equal(waitRow?.st, 'incomplete', 'in-flight request at handoff must freeze as incomplete');
  assert.ok(!netAfterHandoff.rows.some(r => r.u.includes('/private-hit')), 'fetch during handoff must never be recorded');
  assert.ok(netAfterHandoff.withheld >= 1, `expected withheld >= 1 after handoff, got ${JSON.stringify(netAfterHandoff)}`);

  // 7. Isolated sessions via Firefox BrowserContexts (cookie + localStorage separation)
  const sesB = await host.execute({ action: 'create_session', name: 'Secondary' }, caller.next());
  assert.equal(sesB.temporary, true);
  const tabB = (await host.execute({ action: 'open', url: srv.url + 'form', sessionId: sesB.sessionId }, caller.next())).tabId;
  await host.execute({ action: 'evaluate', tabId, world: 'page', expression: 'document.cookie="who=alpha; Path=/"; localStorage.setItem("k","alpha"); "ok"' }, caller.next());
  await host.execute({ action: 'evaluate', tabId: tabB, world: 'page', expression: 'document.cookie="who=beta; Path=/"; localStorage.setItem("k","beta"); "ok"' }, caller.next());
  const readA = await host.execute({ action: 'evaluate', tabId, world: 'page', expression: 'document.cookie + "|" + localStorage.getItem("k")' }, caller.next());
  const readB = await host.execute({ action: 'evaluate', tabId: tabB, world: 'page', expression: 'document.cookie + "|" + localStorage.getItem("k")' }, caller.next());
  assert.ok(readA.value.includes('who=alpha') && readA.value.includes('|alpha') && !readA.value.includes('beta'));
  assert.ok(readB.value.includes('who=beta') && readB.value.includes('|beta') && !readB.value.includes('alpha'));
  const closedSes = await host.execute({ action: 'close_session', sessionId: sesB.sessionId }, caller.next());
  assert.equal(closedSes.cleanupComplete, true);

  // 8. Checkbox label with nested link avoids clicking link, page-level scroll works without ref/target/point, and hardened Camoufox `run` script runner
  const formOpened = await host.execute({ action: 'open', url: srv.url + 'form' }, caller.next());
  const formTab = formOpened.tabId;
  const agreeMatch = formOpened.text.match(/(e\d+) checkbox "I agree to the HubSpot Terms and Privacy Policy"/);
  assert.ok(agreeMatch, `Expected hidden consent checkbox proxy in:\n${formOpened.text}`);
  const agreeClick = await host.execute({ action: 'click', tabId: formTab, ref: agreeMatch[1] }, caller.next());
  assert.equal(agreeClick.disposition, 'executed');
  const agreeState = await host.execute({ action: 'evaluate', tabId: formTab, expression: '({ url: location.pathname, checked: document.getElementById("agreeBox").checked })' }, caller.next());
  assert.deepEqual(agreeState.value, { url: '/form', checked: true }, 'clicking checkbox label with nested link must check checkbox without navigating to link');

  const scrolled = await host.execute({ action: 'scroll', tabId: formTab, deltaY: 450 }, caller.next());
  assert.equal(scrolled.disposition, 'executed');
  const scrollY = await host.execute({ action: 'evaluate', tabId: formTab, expression: 'window.scrollY' }, caller.next());
  assert.ok(scrollY.value >= 300, `Expected page-level scroll to move window.scrollY >= 300, got ${scrollY.value}`);

  const clicksBefore = srv.state.clicks;
  const ran = await host.execute({
    action: 'run', tabId: formTab,
    script: `
      await page.getByLabel('Email').fill('cfx@example.test');
      await page.getByRole('combobox', { name: 'Plan' }).selectOption('pro');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForText('Saved cfx@example.test pro true');
      let net = 'blocked';
      try { await fetch(${JSON.stringify(srv.url + 'click-hit')}); net = 'open'; } catch {}
      return { text: await page.getByRole('status').innerText(), net };
    `,
  }, caller.next());
  assert.equal(ran.status, 'ok', ran.text);
  assert.match(ran.text, /Saved cfx@example\.test pro true/);
  assert.match(ran.text, /"net":"blocked"/);
  assert.equal(srv.state.clicks, clicksBefore + 1, 'run script must execute Save click once and block direct fetch');

  // 9. Hardened Camoufox `run` deadline kills a CPU-bound loop cleanly
  const deadlineRun = await host.execute({
    action: 'run', tabId: formTab, timeoutMs: 1200,
    script: 'for (;;) {}',
  }, caller.next());
  assert.equal(deadlineRun.status, 'deadline', deadlineRun.text);
  assert.equal(deadlineRun.code, 'RUN_DEADLINE');
});

test('live Camoufox 158: elevated mode permits sensitive input with masking, one-way Control Bar revert blocks it, and downloads track cleanly', { timeout: 60000 }, async t => {
  const cfx = camoufoxExecutable(process.cwd());
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'wb-cfx-elev-'));
  const srv = await startFixtureServer();
  const host = new CamoufoxHost({
    dataDir,
    executablePath: cfx.executablePath,
    camoufoxVersion: cfx.version,
    headless: true,
    enableRdp: true,
    automationMode: 'elevated',
    automationModeSource: 'env',
    onRevokeConnection: () => {},
  });
  t.after(async () => {
    await host.close().catch(() => {});
    await srv.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  const caller = makeCaller('elev-owner');
  const st = await host.execute({ action: 'status' }, caller.next());
  assert.equal(st.automationMode, 'elevated');
  assert.equal(st.capabilities.automation.sensitiveInputAllowed, true);

  const opened = await host.execute({ action: 'open', url: srv.url }, caller.next());
  const tabId = opened.tabId;
  const pwRef = refOf(opened.text, 'textbox', 'Password');

  // Elevated mode allows filling sensitive password field while keeping value masked
  const filled = await host.execute({ action: 'fill', tabId, ref: pwRef, text: 'ELEVATED_SECRET_99' }, caller.next());
  assert.equal(filled.disposition, 'executed');
  assert.ok(!filled.text.includes('ELEVATED_SECRET_99'), 'sensitive value must remain masked in elevated mode');
  const readBack = await host.execute({ action: 'read', tabId, ref: pwRef }, caller.next());
  assert.ok(!readBack.text.includes('ELEVATED_SECRET_99') && readBack.text.includes('sensitive (value withheld)'));

  // SENSITIVE_PRESENT still blocks evaluate/console(expression) even in elevated mode
  await assert.rejects(
    host.execute({ action: 'evaluate', tabId, expression: '1+1' }, caller.next()),
    err => err.code === 'SENSITIVE_PRESENT',
  );

  // One-way Control Bar revert drops connection back to standard mode immediately
  host.triggerControlBarAction('revert-standard');
  assert.equal((await host.execute({ action: 'status' }, caller.next())).automationMode, 'standard');
  await assert.rejects(
    host.execute({ action: 'fill', tabId, ref: pwRef, text: 'BLOCKED_AFTER_REVERT' }, caller.next()),
    err => err.code === 'SENSITIVE_INPUT_REFUSED' && err.requestedInputDispatched === false,
  );

  // Download tracking
  const dlLink = refOf(opened.text, 'link', 'Download File');
  await host.execute({ action: 'click', tabId, ref: dlLink }, caller.next());
  const dls = await until(async () => {
    const res = await host.execute({ action: 'downloads', tabId }, caller.next());
    return res.items.some(d => d.filename === 'report.txt' && d.state === 'completed') ? res : null;
  }, 'completed download report.txt', 8000);
  assert.ok(dls.items.some(d => d.filename === 'report.txt'));
});

test('live Camoufox 158: native #nav-bar ChromeToolbarClient mounts with 0px height delta and delivers authenticated click actions', { timeout: 45000 }, async t => {
  const cfx = camoufoxExecutable(process.cwd());
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'wb-cfx-navbar-'));
  const proc = new CamoufoxProcess({
    executablePath: cfx.executablePath, profileDir, headless: true, enableRdp: true, locale: 'ko-KR',
  });
  let rdp = null;
  let toolbar = null;
  t.after(async () => {
    toolbar?.close();
    rdp?.close();
    await proc.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  });

  await proc.start();
  await proc.send('Browser.newPage');
  rdp = new FirefoxRdpClient(proc.rdpPort);
  assert.equal(await rdp.ensureConnected(), true);

  const heightBefore = await rdp.chromeEval('(() => { const w = Services.wm.getMostRecentWindow("navigator:browser"); return w.outerHeight - w.innerHeight; })()');
  let chromeEvalCount = 0;
  const origChromeEval = rdp.chromeEval.bind(rdp);
  const countingRdp = {
    get connected() { return rdp.connected; },
    get closed() { return rdp.closed; },
    ensureConnected: (...a) => rdp.ensureConnected(...a),
    chromeEval: (...a) => { chromeEvalCount++; return origChromeEval(...a); },
  };
  // Verify wrong launch nonce refuses toolbar mount before testing real matching launchNonce
  const wrongBar = new ChromeToolbarClient({ getRdp: () => countingRdp, getExpectedNonce: () => 'forged-wrong-nonce', headless: false, locale: 'ko-KR' });
  wrongBar.sync({ elevated: false, activeId: 't1', visible: true, tabs: [{ id: 't1', label: 't1', status: 'x', primaryText: 'x', primaryAction: 'take-control', stopEnabled: true, needsReturn: false }] });
  await until(() => chromeEvalCount >= 1, 'wrong-nonce toolbar probe', 3000);
  await delay(100);
  assert.equal(await origChromeEval('Boolean(Services.wm.getMostRecentWindow("navigator:browser")?.document?.getElementById("wb-agent-nav-bar"))'), false, 'wrong launch nonce must refuse mount');
  wrongBar.close();
  chromeEvalCount = 0;

  toolbar = new ChromeToolbarClient({ getRdp: () => countingRdp, getExpectedNonce: () => proc.launchNonce, headless: false, locale: 'ko-KR' });
  const received = [];
  toolbar.on('action', (action, tabId) => received.push({ action, tabId }));

  toolbar.sync({
    elevated: false,
    canElevate: true,
    profileLabel: 'default',
    profilePersistent: true,
    activeId: 't1',
    visible: true,
    tabs: [{
      id: 't1',
      label: 't1 · ChatGPT',
      url: 'about:blank',
      browsingContextId: null,
      mode: 'automation',
      paused: false,
      status: '에이전트 자동화 중',
      primaryText: '직접 조작',
      primaryAction: 'take-control',
      stopEnabled: true,
      needsReturn: false,
    }],
  });

  const mounted = await until(async () => {
    const raw = await origChromeEval(`JSON.stringify((() => {
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const bar = w?.document?.getElementById("wb-agent-nav-bar");
      if (!bar || bar.style.display === "none") return null;
      return {
        heightDelta: (w.outerHeight - w.innerHeight) - ${Number(heightBefore)},
        profileText: bar._wbProfile?.textContent || "",
        elevateVisible: bar._wbElevate?.style?.display !== "none",
        primaryText: bar._wbPrimary?.textContent || "",
        statusText: bar._wbStatus?.textContent || "",
        parentId: bar.parentElement?.id || "",
      };
    })())`).catch(() => null);
    return raw && raw !== 'null' ? JSON.parse(raw) : null;
  }, '#nav-bar ChromeToolbarClient mount', 8000);

  assert.equal(mounted.parentId, 'nav-bar');
  assert.equal(mounted.heightDelta, 0, 'mounting inside #nav-bar must not change outerHeight - innerHeight');
  assert.equal(mounted.profileText, 'default');
  assert.equal(mounted.elevateVisible, true);
  assert.equal(mounted.statusText, '에이전트 자동화 중');
  assert.equal(mounted.primaryText, '직접 조작');
  assert.equal(chromeEvalCount, 1, 'initial mount uses exactly one chromeEval');

  // Untrusted synthetic .click() on the Elevate button must be ignored (requireTrusted: true)
  await origChromeEval('(() => { const w = Services.wm.getMostRecentWindow("navigator:browser"); w.document.getElementById("wb-agent-nav-bar")._wbElevate.click(); return true; })()');
  await delay(150);
  assert.equal(received.length, 0, 'untrusted synthetic .click() on Elevate button must never trigger elevation');

  // Push handoff state update over SSE stream (must update #nav-bar WITHOUT another chromeEval!)
  toolbar.sync({
    elevated: false,
    activeId: 't1',
    visible: true,
    tabs: [{
      id: 't1',
      label: 't1 · ChatGPT',
      url: 'about:blank',
      browsingContextId: null,
      mode: 'native-handoff',
      paused: true,
      status: '직접 조작 중',
      primaryText: '에이전트에게 돌려주기',
      primaryAction: 'resume',
      stopEnabled: true,
      needsReturn: true,
    }],
  });

  const updated = await until(async () => {
    const raw = await origChromeEval(`JSON.stringify((() => {
      const w = Services.wm.getMostRecentWindow("navigator:browser");
      const bar = w?.document?.getElementById("wb-agent-nav-bar");
      if (!bar) return null;
      return { primaryText: bar._wbPrimary?.textContent || "", statusText: bar._wbStatus?.textContent || "" };
    })())`).catch(() => null);
    const parsed = raw && raw !== 'null' ? JSON.parse(raw) : null;
    return parsed?.primaryText === '에이전트에게 돌려주기' ? parsed : null;
  }, '#nav-bar SSE live state update', 6000);
  assert.equal(updated.statusText, '직접 조작 중');
  assert.equal(chromeEvalCount, 1, 'SSE state sync must require zero additional chromeEval calls');

  // Click the actual button inside Firefox #nav-bar and verify authenticated loopback callback arrives
  await origChromeEval('(() => { const w = Services.wm.getMostRecentWindow("navigator:browser"); w.document.getElementById("wb-agent-nav-bar")._wbPrimary.click(); return true; })()');
  await until(() => received.length === 1, 'authenticated loopback action from #nav-bar button click', 5000);
  assert.deepEqual(received, [{ action: 'resume', tabId: 't1' }]);

  toolbar.close();
  const removed = await until(async () => {
    return await origChromeEval('(() => { const w = Services.wm.getMostRecentWindow("navigator:browser"); return !w?.document?.getElementById("wb-agent-nav-bar"); })()').catch(() => false);
  }, '#nav-bar cleanup on close', 4000);
  assert.equal(removed, true);
});
