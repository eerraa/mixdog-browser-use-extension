import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserHost } from '../../src/browser/host.mjs';
import { FrameDriver } from '../../src/browser/frames.mjs';

const directory = process.argv[2];
const scope = process.argv[3];
app.setPath('userData', path.join(directory, 'electron'));
const drivers = new WeakMap();
const start = FrameDriver.prototype.start;
FrameDriver.prototype.start = async function() {
  drivers.set(this.wc, this);
  return start.call(this);
};
let port, host, server, anchor;
const failures = [];
const check = async (name, operation) => {
  try { await operation(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}\n${error.stack}`); }
};
const content = request => {
  const url = new URL(request.url, 'http://fixture.invalid');
  const mode = url.searchParams.get('mode') || 'local';
  const scaled = mode.includes('scaled');
  const outerOrigin = mode.startsWith('oopif-parent') ? `http://localhost:${port}` : `http://127.0.0.1:${port}`;
  const innerOrigin = mode.startsWith('mixed') || mode.startsWith('oopif-parent') ? `http://localhost:${port}` : outerOrigin;
  if (url.pathname === '/root') return `<!doctype html><body style="margin:0">
    <iframe style="position:absolute;left:100px;top:100px;width:700px;height:500px;border:0;transform-origin:0 0;${scaled ? 'transform:scale(.75)' : ''}"
      src="${outerOrigin}/outer?mode=${mode}"></iframe>`;
  if (url.pathname === '/outer') return `<!doctype html><body style="margin:0">
    <iframe style="position:absolute;left:50px;top:60px;width:400px;height:250px;border:0;transform-origin:0 0;${scaled ? 'transform:scale(.8)' : ''}"
      src="${innerOrigin}/inner?mode=${mode}"></iframe>`;
  if (url.pathname === '/inner') return `<!doctype html><body style="margin:0"><output>0</output>
    <button style="position:absolute;left:20px;top:20px;width:100px;height:40px"
      onclick="document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1)">Nested</button>`;
  return `<!doctype html><body style="margin:0"><p>Shadow fixture</p>
    <div id="shadow" style="position:absolute;left:10px;top:10px"></div>
    <div id="late" style="position:absolute;left:10px;top:150px"></div>
    <script>const root=document.querySelector('#shadow').attachShadow({mode:'open'});
    root.innerHTML='<button onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">Safe</button><input type="password" value="PRIVATE_SHADOW_PASSWORD"><div id="nested"></div>';</script>`;
};

async function run() {
  try {
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(content(request));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    await app.whenReady();
    // Keep the private Electron app alive between closing one isolated case and
    // opening the next. This is not a page/agent target and is never shown.
    anchor = new BrowserWindow({ show: false, webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    } });
    host = new BrowserHost({
      dataDir: path.join(directory, 'profiles'),
      consentHelperPath: fileURLToPath(new URL('../../build/native-consent.exe', import.meta.url)),
      onRevokeConnection() { throw new Error('No revocation in this fixture'); },
    });
    const caller = { sessionId: 'review-fixture', callId: 'review', signal: new AbortController().signal, assertLive() {} };
    const call = args => host.execute(args, caller);
    for (const mode of scope === 'shadow' ? [] : ['local', 'scaled', 'mixed', 'mixed-scaled', 'oopif-parent', 'oopif-parent-scaled']) {
      await check(`exact-one nested click ${mode}`, async () => {
        const url = `http://127.0.0.1:${port}/root?mode=${mode}`;
        const observed = await call({ action: 'open', url });
        try {
          assert.equal(observed.disposition, 'observed', JSON.stringify(observed));
          const guest = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url);
          const driver = drivers.get(guest.webContents);
          const inner = observed.frames.find(frame => new URL(frame.url).pathname === '/inner');
          const outer = observed.frames.find(frame => new URL(frame.url).pathname === '/outer');
          assert.ok(inner && outer);
          if (mode.startsWith('mixed')) assert.ok(driver.frames.get(inner.frameId).sessionId, 'This case must exercise an actual OOPIF');
          if (mode.startsWith('oopif-parent')) {
            assert.ok(driver.frames.get(outer.frameId).sessionId, 'Outer frame must be an actual OOPIF target');
            assert.equal(driver.frames.get(inner.frameId).sessionId, driver.frames.get(outer.frameId).sessionId);
          }
          const ref = inner.elements.find(element => element.name === 'Nested').ref;
          const point = await driver.point(driver.frames.get(inner.frameId), ref);
          const result = await call({ action: 'click', tabId: observed.tabId, ref });
          const frame = guest.webContents.mainFrame.framesInSubtree.find(f => new URL(f.url).pathname === '/inner');
          const effect = await frame.executeJavaScript('document.querySelector("output").textContent');
          const expected = mode.includes('scaled') ? { x: 179.5, y: 169 } : { x: 220, y: 200 };
          assert.equal(effect, '1', JSON.stringify({ point, expected, disposition: result.disposition, effect }));
          assert.equal(result.disposition, 'observed', JSON.stringify(result));
          assert.ok(Math.abs(point.x - expected.x) < .01 && Math.abs(point.y - expected.y) < .01, JSON.stringify({ point, expected }));
          assert.equal(guest.isVisible(), false);
          if (mode === 'local') {
            const outerFrame = guest.webContents.mainFrame.framesInSubtree.find(f => new URL(f.url).pathname === '/outer');
            await outerFrame.executeJavaScript(`(()=>{
              const cover=document.createElement('div');cover.id='cover';
              cover.style='position:absolute;inset:0;z-index:99999;background:rgba(255,0,0,.1)';
              document.body.append(cover);
            })()`);
            let fresh = await call({ action: 'observe', tabId: observed.tabId });
            let nestedRef = fresh.frames.find(f => f.frameId === inner.frameId).elements.find(e => e.name === 'Nested').ref;
            await assert.rejects(call({ action: 'click', tabId: observed.tabId, ref: nestedRef }), error => error.code === 'FRAME_OCCLUDED');
            assert.equal(await frame.executeJavaScript('document.querySelector("output").textContent'), '1');
            await outerFrame.executeJavaScript('document.querySelector("#cover").remove();document.querySelector("iframe").style.transform="rotate(1deg)"');
            fresh = await call({ action: 'observe', tabId: observed.tabId });
            nestedRef = fresh.frames.find(f => f.frameId === inner.frameId).elements.find(e => e.name === 'Nested').ref;
            await assert.rejects(call({ action: 'click', tabId: observed.tabId, ref: nestedRef }), error => error.code === 'UNSUPPORTED_FRAME_GEOMETRY');
            assert.equal(await frame.executeJavaScript('document.querySelector("output").textContent'), '1');
            await outerFrame.executeJavaScript('document.querySelector("iframe").style.transform=""');
            fresh = await call({ action: 'observe', tabId: observed.tabId });
            nestedRef = fresh.frames.find(f => f.frameId === inner.frameId).elements.find(e => e.name === 'Nested').ref;
            await outerFrame.executeJavaScript(`new Promise(resolve=>{
              const old=document.querySelector('iframe'),next=old.cloneNode();next.onload=()=>resolve(true);old.replaceWith(next);
            })`);
            await assert.rejects(call({ action: 'click', tabId: observed.tabId, ref: nestedRef }), error => /^STALE_/.test(error.code));
            const replacement = guest.webContents.mainFrame.framesInSubtree.find(f => new URL(f.url).pathname === '/inner');
            assert.equal(await replacement.executeJavaScript('document.querySelector("output").textContent'), '0');
          }
        } finally { await call({ action: 'close_tab', tabId: observed.tabId }); }
      });
    }
    for (const kind of scope === 'geometry' ? [] : ['text', 'attribute', 'structure', 'attached-root', 'nested-root']) {
      await check(`shadow ${kind} rejects old ref before any effect`, async () => {
        const url = `http://127.0.0.1:${port}/shadow?case=${kind}`;
        const observed = await call({ action: 'open', url });
        try {
          assert.equal(observed.disposition, 'observed', JSON.stringify(observed));
          assert.equal(JSON.stringify(observed).includes('PRIVATE_SHADOW_PASSWORD'), false);
          const guest = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url);
          const ref = observed.frames[0].elements.find(element => element.name === 'Safe').ref;
          const operations = {
            text: 'document.querySelector("#shadow").shadowRoot.querySelector("button").textContent="Dangerous"',
            attribute: 'document.querySelector("#shadow").shadowRoot.querySelector("button").setAttribute("aria-label","Dangerous")',
            structure: '(()=>{const root=document.querySelector("#shadow").shadowRoot;const next=document.createElement("section");next.id="nested";root.querySelector("#nested").replaceWith(next)})()',
            'attached-root': 'document.querySelector("#late").attachShadow({mode:"open"});undefined',
            'nested-root': 'document.querySelector("#shadow").shadowRoot.querySelector("#nested").attachShadow({mode:"open"});undefined',
          };
          await guest.webContents.executeJavaScript(operations[kind]);
          const attempt = await call({ action: 'click', tabId: observed.tabId, ref }).then(value => ({ value }), error => ({ code: error.code }));
          const count = await guest.webContents.executeJavaScript('document.querySelector("#shadow").shadowRoot.querySelector("button").dataset.count||"0"');
          const disposition = { code: attempt.code, disposition: attempt.value?.disposition, count };
          assert.equal(count, '0', JSON.stringify(disposition));
          assert.match(attempt.code || '', /^STALE_/, JSON.stringify(disposition));
          let fresh = await call({ action: 'observe', tabId: observed.tabId });
          let safe = fresh.frames[0].elements.find(element => element.name === (kind === 'text' || kind === 'attribute' ? 'Dangerous' : 'Safe'));
          assert.ok(safe);
          if (kind.endsWith('root')) {
            const root = kind === 'attached-root' ? 'document.querySelector("#late").shadowRoot'
              : 'document.querySelector("#shadow").shadowRoot.querySelector("#nested").shadowRoot';
            await guest.webContents.executeJavaScript(`${root}.innerHTML="<button>New action</button>"`);
            fresh = await call({ action: 'observe', tabId: observed.tabId });
            safe = fresh.frames[0].elements.find(element => element.name === 'Safe');
            await guest.webContents.executeJavaScript(`${root}.querySelector("button").textContent="Changed action"`);
            await assert.rejects(call({ action: 'click', tabId: observed.tabId, ref: safe.ref }), error => /^STALE_/.test(error.code));
            fresh = await call({ action: 'observe', tabId: observed.tabId });
            assert.ok(fresh.frames[0].elements.some(element => element.name === 'Changed action'));
            safe = fresh.frames[0].elements.find(element => element.name === 'Safe');
          }
          await call({ action: 'click', tabId: observed.tabId, ref: safe.ref });
          assert.equal(await guest.webContents.executeJavaScript('document.querySelector("#shadow").shadowRoot.querySelector("button").dataset.count'), '1');
          assert.equal(JSON.stringify(fresh).includes('PRIVATE_SHADOW_PASSWORD'), false);
        } finally { await call({ action: 'close_tab', tabId: observed.tabId }); }
      });
    }
    await host.close(); anchor.destroy(); server.close();
    if (failures.length) { console.error(`FAILED_CASES ${JSON.stringify(failures)}`); app.exit(1); }
    else { console.log('REVIEW_REGRESSIONS_PASSED'); app.exit(0); }
  } catch (error) {
    console.error(error.stack); await host?.close(); anchor?.destroy(); server?.close(); app.exit(1);
  }
}
void run();
