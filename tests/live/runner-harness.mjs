import { app, BrowserWindow, session, webContents } from 'electron';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserHost } from '../../src/browser/host.mjs';
import { runScript } from '../../src/browser/runner/run.mjs';
import { BOOTSTRAP_URL, createRunnerSandbox, routeOp, RUNNER_PARTITION } from '../../src/browser/runner/sandbox.mjs';
import { pageContents, presentationOf, toolbarPreloadPath } from './presentation.mjs';

const directory = process.argv[2];
const runnerPreloadPath = fileURLToPath(new URL('../../src/browser/runner/preload.cjs', import.meta.url));
app.setPath('userData', path.join(directory, 'electron'));
app.on('window-all-closed', () => {});
const menus = new WeakMap();
const setMenu = BrowserWindow.prototype.setMenu;
BrowserWindow.prototype.setMenu = function(menu) { menus.set(this, menu); return setMenu.call(this, menu); };
const hits = new Map();
const hit = name => hits.get(name) ?? 0;
let port, host, server, anchor;
const failures = [];
const check = async (name, operation) => {
  try { await operation(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}\n${error.stack}`); }
};
const until = async (predicate, label, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out: ${label}`);
};
const pages = {
  '/form': `<!doctype html><meta charset="utf-8"><title>Runner form</title>
    <form id="form"><label>Task name <input name="name" aria-label="Task name"></label>
    <label>Status <select name="status" aria-label="Status"><option value="draft">Draft</option><option value="ready">Ready</option></select></label>
    <button>Save local task</button></form><output id="saved"></output>
    <script>document.getElementById('form').onsubmit=e=>{e.preventDefault();
      const data=JSON.stringify(Object.fromEntries(new FormData(e.target)));
      navigator.sendBeacon('/submit',data);document.getElementById('saved').textContent=data;};</script>`,
  '/counter': `<!doctype html><meta charset="utf-8"><title>Runner counter</title>
    <button onclick="navigator.sendBeacon('/hit','x');document.querySelector('output').textContent=++window.n">Add</button>
    <button onclick="navigator.sendBeacon('/pay','x')">Pay</button><output>0</output><script>window.n=0</script>`,
  '/confirm': `<!doctype html><meta charset="utf-8"><title>Runner confirm</title>
    <button onclick="if(confirm('Delete the draft?'))navigator.sendBeacon('/confirmed','x')">Delete draft</button>`,
};

async function run() {
  try {
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://fixture.invalid');
      hits.set(url.pathname, hit(url.pathname) + 1);
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(pages[url.pathname] ?? 'ok');
    });
    server.on('upgrade', (request, socket) => { hits.set('upgrade', hit('upgrade') + 1); socket.destroy(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    await app.whenReady();
    anchor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    host = new BrowserHost({
      dataDir: path.join(directory, 'profiles'),
      consentHelperPath: fileURLToPath(new URL('../../build/native-consent.exe', import.meta.url)),
      toolbarPreloadPath, runnerPreloadPath,
      onRevokeConnection() { throw new Error('No revocation in this fixture'); },
    });
    const caller = { sessionId: 'runner-fixture', callId: 'run', signal: new AbortController().signal, assertLive() {} };
    const call = args => host.execute(args, caller);
    // The integrated path: one browse call { action: 'run' } through the host.
    const runIt = (script, { tabId, timeoutMs } = {}) => call({ action: 'run', script,
      ...(tabId === undefined ? {} : { tabId }), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    // Only for a step outcome a real page cannot produce on demand.
    const runWith = (script, options) => runScript({
      script, caller, createSandbox: sandboxOptions => createRunnerSandbox({ ...sandboxOptions, preloadPath: runnerPreloadPath }),
      finalView: async tabId => (await call({ action: 'observe', tabId })).text, ...options,
    });
    const sandboxes = () => webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.getURL() === BOOTSTRAP_URL);

    await check('sandbox: no Node, no network, no navigation, no string evaluation, one bridge function', async () => {
      const before = new Map(hits);
      const report = await runIt(`
        const out = { require: typeof require, process: typeof process, module: typeof module, electron: typeof ipcRenderer,
          bridge: Object.keys(window.__wbBridge), nonce: Object.getOwnPropertyNames(window).some(name => /nonce/i.test(name)) };
        try { await fetch('${origin}/probe-fetch'); out.fetch = 'reached'; } catch (error) { out.fetch = error.name; }
        out.xhr = await new Promise(resolve => { try { const x = new XMLHttpRequest(); x.onload = () => resolve('reached');
          x.onerror = () => resolve('error'); x.open('GET', '${origin}/probe-xhr'); x.send(); } catch (error) { resolve(error.name); } });
        out.ws = await new Promise(resolve => { try { const w = new WebSocket('ws://127.0.0.1:${port}/ws'); w.onopen = () => resolve('open');
          w.onerror = () => resolve('error'); } catch (error) { resolve(error.name); } });
        try { out.eval = eval('1'); } catch (error) { out.eval = error.name; }
        try { out.fn = new Function('return 1')(); } catch (error) { out.fn = error.name; }
        out.popup = String(window.open('${origin}/probe-popup'));
        out.beacon = navigator.sendBeacon('${origin}/probe-beacon', 'x');
        const image = new Image(); image.src = '${origin}/probe-image';
        try { location.href = '${origin}/probe-navigation'; } catch (error) { out.navigation = error.name; }
        await sleep(500);
        out.href = location.href.slice(0, 5);
        return out;`);
      assert.equal(report.status, 'ok', report.text);
      const out = JSON.parse(report.text.split('\n').find(line => line.startsWith('return ')).slice(7));
      assert.deepEqual([out.require, out.process, out.module, out.electron, out.nonce], ['undefined', 'undefined', 'undefined', 'undefined', false]);
      assert.deepEqual(out.bridge, ['call']);
      assert.notEqual(out.fetch, 'reached');
      assert.notEqual(out.xhr, 'reached');
      assert.notEqual(out.ws, 'open');
      assert.equal(out.eval, 'EvalError');
      assert.equal(out.fn, 'EvalError');
      assert.equal(out.popup, 'null');
      assert.equal(out.href, 'data:', 'the sandbox stays on its bootstrap document');
      assert.deepEqual(new Map(hits), before, `no request reached the network: ${JSON.stringify([...hits])}`);
      await until(() => sandboxes().length === 0, 'the sandbox is destroyed after the run', 3000);
    });

    await check('bridge: forged ops, forged arguments, a forged nonce and a foreign sender are refused', async () => {
      const opened = await call({ action: 'open', url: `${origin}/counter` });
      const report = await runIt(`
        const call = window.__wbBridge.call;
        const codes = [];
        for (const [op, args] of [['revoke', {}], ['handoff', { tabId: page.tabId }], ['respond', { tabId: page.tabId }],
          ['click', { tabId: page.tabId, loc: { target: { name: 'Add' } }, point: { x: 1, y: 1 } }],
          ['evaluate', { tabId: page.tabId, expression: '1', world: 'page' }], ['constructor', {}]]) {
          codes.push((await call(op, args)).error?.code);
        }
        return codes;`, { tabId: opened.tabId });
      assert.equal(report.status, 'ok', report.text);
      assert.match(report.text, /\nreturn \["INVALID_RUNNER_OP","INVALID_RUNNER_OP","INVALID_RUNNER_OP","INVALID_RUNNER_OP","INVALID_RUNNER_OP","INVALID_RUNNER_OP"\]/);
      assert.equal(hit('/hit'), 0);
      let reached = 0;
      const sandbox = await createRunnerSandbox({ onOp: async () => { reached++; return { ok: true, value: null }; }, preloadPath: runnerPreloadPath });
      try {
        const forged = await routeOp({ sender: sandbox.contents, senderFrame: sandbox.contents.mainFrame }, 'forged-nonce', 'tabs', {});
        assert.equal(forged.error.code, 'RUNNER_REFUSED');
        const guest = pageContents(`${origin}/counter`);
        const foreign = await routeOp({ sender: guest, senderFrame: guest.mainFrame }, 'forged-nonce', 'tabs', {});
        assert.equal(foreign.error.code, 'RUNNER_REFUSED');
        // The real preload reaches the bridge with its own nonce.
        assert.equal((await sandbox.evaluate('window.__wbBridge.call("tabs", {})')).ok, true);
        assert.equal(reached, 1);
      } finally { sandbox.destroy(); }
      await call({ action: 'close_tab', tabId: opened.tabId });
    });

    await check('one call runs a multi-step form flow with exactly one submit', async () => {
      const report = await runIt(`
        const form = await open('${origin}/form');
        await form.getByLabel('Task name').fill('Runner task');
        await form.getByLabel('Status').selectOption('ready');
        await form.getByRole('button', { name: 'Save local task' }).click();
        await form.waitForText('Runner task');
        return JSON.parse(await form.getByRole('status').innerText());`);
      assert.equal(report.status, 'ok', report.text);
      assert.equal(report.disposition, 'executed');
      assert.equal(hit('/submit'), 1, report.text);
      assert.match(report.text, /\nreturn \{"name":"Runner task","status":"ready"\}/);
      assert.match(report.text, /\n1 executed open http:\/\/127\.0\.0\.1:\d+\/form \d+ms\n2 executed fill t\d+ "Task name" text\(11\) \d+ms/);
      assert.match(report.text, /\n-- t\d+\n/, 'the final view of the touched tab follows');
      console.log('RUN_REPORT', JSON.stringify(report.text.slice(0, 600)));
    });

    await check('a caught uncertain step seals the bridge; the retry inside the catch never reaches the page', async () => {
      const opened = await call({ action: 'open', url: `${origin}/counter` });
      const before = hit('/pay');
      // The real click is dispatched; its outcome is then reported as unknown.
      const execute = async (args, runCaller) => {
        const result = await host.execute(args, runCaller);
        return args.action === 'click' ? { ...result, disposition: 'uncertain', replaySafe: false, code: 'DISPATCH_UNCONFIRMED' } : result;
      };
      const report = await runWith(`
        try { await page.getByRole('button', { name: 'Pay' }).click(); }
        catch (error) { await page.getByRole('button', { name: 'Pay' }).click(); }
        return 'unreachable';`, { tabId: opened.tabId, execute });
      await until(() => hit('/pay') === before + 1, 'the first click reached the page');
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(hit('/pay'), before + 1, 'exactly one click');
      assert.deepEqual([report.status, report.disposition, report.replaySafe], ['uncertain', 'uncertain', false], report.text);
      assert.ok(!report.text.includes('unreachable'));
      await call({ action: 'close_tab', tabId: opened.tabId });
    });

    for (const how of ['Stop', 'handoff']) {
      await check(`${how} mid-run ends the run and no input follows`, async () => {
        const url = `${origin}/counter?case=${how}`;
        const opened = await call({ action: 'open', url });
        const guest = pageContents(url);
        const before = hit('/hit');
        const running = runIt(`for (;;) { await page.getByRole('button', { name: 'Add' }).click(); await sleep(100); }`, { tabId: opened.tabId });
        await until(() => hit('/hit') >= before + 2, 'the loop is clicking');
        if (how === 'Stop') menus.get(presentationOf(guest).frame).items.find(item => item.label === 'Stop automation').click();
        else await host.execute({ action: 'handoff', tabId: opened.tabId }, { ...caller, callId: 'handoff' });
        const report = await running;
        const after = hit('/hit');
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(hit('/hit'), after, 'no click after the run ended');
        assert.equal(report.status, how === 'Stop' ? 'stopped' : 'handoff', report.text);
        assert.equal(report.code, how === 'Stop' ? 'AUTOMATION_PAUSED' : 'PRIVATE_HANDOFF');
        assert.equal(report.replaySafe, false);
        await until(() => sandboxes().length === 0, 'the sandbox is destroyed', 3000);
      });
    }

    await check('the deadline terminates a CPU-bound script; the host stays responsive', async () => {
      const started = Date.now();
      const report = await runIt('for (;;) {}', { timeoutMs: 1500 });
      const elapsed = Date.now() - started;
      assert.deepEqual([report.status, report.code, report.disposition], ['deadline', 'RUN_DEADLINE', 'not-executed'], report.text);
      assert.ok(elapsed >= 1400 && elapsed < 6000, `ended after ${elapsed} ms`);
      assert.ok(Array.isArray((await call({ action: 'list_tabs' })).tabs));
      await until(() => sandboxes().length === 0, 'the looping sandbox is gone', 3000);
    });

    await check('egress: WebRTC ICE, preconnect and dns-prefetch reach no listener, loopback included', async () => {
      let tcp = 0, udp = 0;
      const listener = net.createServer(socket => { tcp++; socket.destroy(); });
      await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
      const stun = dgram.createSocket('udp4');
      stun.on('message', () => { udp++; });
      await new Promise(resolve => stun.bind(0, '127.0.0.1', resolve));
      const [tcpPort, udpPort] = [listener.address().port, stun.address().port];
      const hints = `for (const [rel, href] of [['preconnect', 'http://127.0.0.1:${tcpPort}/a'], ['preconnect', 'http://localhost:${tcpPort}/b'],
          ['dns-prefetch', 'http://wb-probe.localhost:${tcpPort}/'], ['preload', 'http://127.0.0.1:${tcpPort}/c']]) {
          const link = document.createElement('link'); link.rel = rel; link.href = href; if (rel === 'preload') link.as = 'fetch'; document.head.append(link); }`;
      try {
        // Through the run wrapper: the WebRTC constructors are gone.
        const report = await runIt(`${hints}
          const out = [typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof RTCDataChannel];
          await sleep(1500);
          return out;`);
        assert.equal(report.status, 'ok', report.text);
        assert.match(report.text, /\nreturn \["undefined","undefined","undefined"\]/);
        // Even with the API present (raw sandbox, no wrapper), ICE and hints go nowhere.
        const sandbox = await createRunnerSandbox({ onOp: async () => ({ ok: false }), preloadPath: runnerPreloadPath });
        try {
          const state = await sandbox.evaluate(`(async () => { ${hints}
            const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }, { urls: 'turn:127.0.0.1:${udpPort}', username: 'u', credential: 'c' }] });
            pc.createDataChannel('probe');
            await pc.setLocalDescription(await pc.createOffer());
            await new Promise(resolve => setTimeout(resolve, 2500));
            const state = pc.iceGatheringState; pc.close(); return state; })()`);
          assert.ok(['complete', 'gathering', 'new'].includes(state), state);
        } finally { sandbox.destroy(); }
        assert.deepEqual({ tcp, udp }, { tcp: 0, udp: 0 }, 'no connection or datagram reached the local listeners');
      } finally { listener.close(); stun.close(); }
    });

    await check('every run shares one runner partition behind the dead proxy; no session per run', async () => {
      const shared = session.fromPartition(RUNNER_PARTITION, { cache: false });
      const sessions = [];
      for (let i = 0; i < 2; i++) {
        const sandbox = await createRunnerSandbox({ onOp: async () => ({ ok: false }), preloadPath: runnerPreloadPath });
        sessions.push(sandbox.contents.session);
        sandbox.destroy();
      }
      assert.ok(sessions.every(value => value === shared), 'both runs used the shared partition');
      assert.equal(await shared.resolveProxy('http://127.0.0.1:1/'), 'PROXY 127.0.0.1:9', 'loopback goes to the dead proxy too');
    });

    await check('a syntax error or a wrapper breakout is reported before any sandbox exists', async () => {
      let created = 0;
      const watcher = (_event, contents) => { if (contents.getType() === 'window') created++; };
      app.on('web-contents-created', watcher);
      try {
        for (const script of ['return (', "}); return { status: 'ok', value: 'x'.repeat(100000) }; (async () => {"]) {
          const report = await runIt(script);
          assert.deepEqual([report.status, report.code, report.disposition], ['syntax', 'SCRIPT_SYNTAX', 'not-executed'], report.text);
        }
        assert.equal(created, 0, 'compiled in main, never run');
      } finally { app.off('web-contents-created', watcher); }
    });

    await check('a confirm() opened by a run step makes the run uncertain; the agent answers it after the run', async () => {
      const opened = await call({ action: 'open', url: `${origin}/confirm` });
      const report = await runIt("await page.getByRole('button', { name: 'Delete draft' }).click(); return 'unreachable';", { tabId: opened.tabId });
      assert.deepEqual([report.status, report.disposition, report.replaySafe], ['uncertain', 'uncertain', false], report.text);
      assert.match(report.text, /\n1 uncertain click t\d+ button "Delete draft" code=DIALOG_OPEN \d+ms/);
      // The dialog outlives the run: it belongs to the run's own caller.
      const pending = (await call({ action: 'requests', tabId: opened.tabId })).pending;
      assert.deepEqual(pending.map(request => request.kind), ['javascript-dialog']);
      assert.equal(hit('/confirmed'), 0);
      const answered = await call({ action: 'handle_dialog', tabId: opened.tabId, accept: true });
      assert.equal(answered.disposition, 'executed', answered.text);
      await until(() => hit('/confirmed') === 1, 'the page saw the accepted confirm');
      await call({ action: 'close_tab', tabId: opened.tabId });
    });

    await check('trusted input between fast scripted clicks fails closed; the clicks alone never do', async () => {
      const url = `${origin}/counter?case=escape`;
      const opened = await call({ action: 'open', url });
      const guest = pageContents(url);
      const before = hit('/hit');
      const clean = await runIt("for (let i = 0; i < 8; i++) { await page.getByRole('button', { name: 'Add' }).click(); await sleep(60); } return 1;", { tabId: opened.tabId });
      assert.deepEqual([clean.status, hit('/hit') - before], ['ok', 8], clean.text);
      const running = runIt("for (;;) { await page.getByRole('button', { name: 'Add' }).click(); await sleep(150); }", { tabId: opened.tabId });
      const seen = hit('/hit');
      await until(() => hit('/hit') >= seen + 2, 'the loop is clicking');
      // A person's press reaching the page outside the shield (e.g. a native
      // picker): no agent dispatch accounts for it.
      guest.sendInputEvent({ type: 'mouseDown', x: 5, y: 60, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x: 5, y: 60, button: 'left', clickCount: 1 });
      const report = await running;
      // Failing closed pauses the tab and drains it toward the person.
      assert.ok(['paused', 'handoff'].includes(report.status), report.text);
      const tab = (await call({ action: 'list_tabs' })).tabs.find(entry => entry.tabId === opened.tabId);
      assert.equal(tab.paused, 'unexpected-page-input');
      await call({ action: 'close_tab', tabId: opened.tabId });
    });

    await host.close(); anchor.destroy(); server.close();
    if (failures.length) { console.error(`FAILED_CASES ${JSON.stringify(failures)}`); app.exit(1); }
    else { console.log('RUNNER_LIVE_PASSED'); app.exit(0); }
  } catch (error) {
    console.error(error.stack); await host?.close(); anchor?.destroy(); server?.close(); app.exit(1);
  }
}
void run();
