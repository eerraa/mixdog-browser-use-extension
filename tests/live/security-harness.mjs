// Live checks of the review fixes in real Electron: handoff privacy of
// signals and downloads, cross-origin frame races before input, sensitive
// fields, transparent frames over points, page-input escape detection, and
// perception bounds (scroll diffs, reinserted nodes, many frames, deep DOM).
import { app, BrowserWindow, dialog } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserHost } from '../../src/browser/host.mjs';
import { frameOf, menu, pageContents, refOf, rendered, toolbarPreloadPath } from './presentation.mjs';

const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'electron'));
app.on('window-all-closed', () => {});
const setMenu = BrowserWindow.prototype.setMenu;
BrowserWindow.prototype.setMenu = function(value) { this.__independentBrowserTestMenu = value; return setMenu.call(this, value); };
// The person answers page dialogs during a handoff; stand in for the OS box.
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
const hits = new Map();
const hit = name => hits.get(name) ?? 0;
const failures = [];
const check = async (name, operation) => {
  try { await operation(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}\n${error.stack}`); }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await pause(25); }
  throw new Error(`Timed out: ${label}`);
};
let port, host, server, anchor;
const beacon = name => `navigator.sendBeacon('/${name}','x')`;
const pages = () => {
  const other = `http://localhost:${port}`;
  return {
    '/signals': '<!doctype html><title>Signals</title><p>Signals fixture</p>',
    '/other': '<!doctype html><title>Other</title><p>Other tab</p>',
    '/inner': `<!doctype html><title>Inner</title><button style="width:180px;height:100px" onclick="${beacon('inner-click')}">Inner</button>`,
    '/nudge': `<!doctype html><title>Nudge</title>
      <button style="position:absolute;left:0;top:0;width:420px;height:300px" onclick="${beacon('decoy')}">Decoy</button>
      <iframe id="f" src="${other}/inner" style="position:absolute;left:100px;top:60px;width:200px;height:120px;border:0"></iframe>
      <script>let d=1;(function move(){d=-d;document.getElementById('f').style.left=(100+40*d)+'px';requestAnimationFrame(move)})()</script>`,
    '/trap-inner': `<!doctype html><button style="width:300px;height:150px" onpointerdown="${beacon('trap-down')}" onclick="${beacon('trap-click')}">Trap</button>`,
    '/trap': `<!doctype html><title>Trap</title>
      <button style="position:absolute;left:20px;top:20px;width:200px;height:80px" onclick="${beacon('real')}">Real</button>
      <iframe id="t" src="${other}/trap-inner" style="position:absolute;left:0;top:0;width:300px;height:150px;border:0;opacity:0;display:none"></iframe>
      <script>setInterval(()=>{const t=document.getElementById('t');t.style.display=t.style.display==='none'?'block':'none'},16)</script>`,
    '/points': `<!doctype html><title>Points</title>
      <button style="position:absolute;left:20px;top:20px;width:200px;height:80px" onclick="${beacon('below')}">Below</button>
      <iframe src="${other}/trap-inner" style="position:absolute;left:0;top:0;width:300px;height:150px;border:0;opacity:0"></iframe>`,
    '/static': `<!doctype html><title>Static frame</title><iframe src="${other}/inner" style="width:300px;height:150px;border:0"></iframe>`,
    '/login': `<!doctype html><meta charset="utf-8"><title>Login</title>
      <label>Password <input id="pw" type="password" value="pw-secret-1"></label>
      <button onclick="pw.type=pw.type==='password'?'text':'password'">Show password</button>
      <div>${[7, 3, 9, 1, 4, 8].map(digit => `<input maxlength="1" inputmode="numeric" value="${digit}" aria-label="digit">`).join('')}</div>
      <label>인증번호 <input id="auth" value="987654"></label>
      <label>메모 <input id="memo"></label>`,
    '/long': `<!doctype html><title>Long</title>${Array.from({ length: 60 }, (_v, i) => `<p><button>Item ${i + 1}</button></p>`).join('')}`,
    '/outer': '<!doctype html><title>Outer</title><p>Outer page</p><iframe src="/login-frame" style="width:300px;height:120px;border:0"></iframe>',
    '/login-frame': '<!doctype html><title>Login frame</title><label>Password <input type="password" value="frame-secret-1"></label>',
    '/opener': '<!doctype html><title>Opener</title><p>Opener page</p>',
    '/popup-login': '<!doctype html><title>Popup login</title><label>Password <input type="password"></label>',
    '/field': `<!doctype html><title>Field</title><input id="f" aria-label="Inner field" style="width:200px">`,
    '/focus-steal': `<!doctype html><title>Focus steal</title>
      <form onsubmit="event.preventDefault();${beacon('decoy-submit')}"><input id="decoy" aria-label="Decoy"></form>
      <iframe id="i" src="${other}/field" style="width:300px;height:80px;border:0"></iframe>
      <script>setInterval(()=>{if(document.activeElement===document.getElementById('i'))document.getElementById('decoy').focus()},2)</script>`,
    '/editable': `<!doctype html><meta charset="utf-8"><title>Editable</title><div id="box" role="status" aria-label="Card details"><p>Card on file</p>
      <div contenteditable="true" aria-label="Card number">4111 1111 1111 1111</div></div>`,
    '/typed': `<!doctype html><meta charset="utf-8"><title>Typed</title><label>Note <input id="note"></label><label>Other <input id="other"></label>`,
    '/hidden-label': `<!doctype html><title>Hidden label</title>
      <label>Email <span style="visibility:hidden">Required</span><span style="opacity:0">faded</span><input></label>`,
    '/reinsert': `<!doctype html><title>Reinsert</title><div id="box"><button id="cached" onclick="${beacon('cached')}">Cached</button></div>
      <button onclick="window.held=document.getElementById('cached');window.held.remove()">Remove</button>
      <button onclick="document.getElementById('box').append(window.held)">Restore</button>`,
    '/pickers': `<!doctype html><title>Pickers</title>
      <label>Fruit <select id="fruit"><option value="apple">apple</option><option value="banana">banana</option><option value="cherry">cherry</option></select></label>
      <label>City <input id="city" list="cities"></label><datalist id="cities"><option value="Seoul"><option value="Busan"></datalist>`,
    '/many': `<!doctype html><title>Many frames</title><button>Top</button>
      <script>for(let i=0;i<1000;i++){const f=document.createElement('iframe');f.srcdoc='<p>frame '+i+'</p>';f.style.cssText='width:12px;height:12px;border:0';document.body.append(f)}</script>`,
    // display:contents: Chromium's own layout overflows its stack on a deep
    // chain of boxes (the page alone crashes the renderer at 5000); a chain
    // without boxes is still a 12000-deep DOM for the walker.
    '/deep': `<!doctype html><title>Deep</title><button>Shallow</button>
      <script>let el=document.body;for(let i=0;i<12000;i++){const d=document.createElement('div');d.style.display='contents';el.append(d);el=d}
      const b=document.createElement('button');b.textContent='Deep';el.append(b);</script>`,
  };
};

async function run() {
  try {
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://fixture.invalid');
      hits.set(url.pathname, hit(url.pathname) + 1);
      if (url.pathname === '/file-private') {
        response.setHeader('Content-Disposition', 'attachment; filename="private-file.txt"');
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end('private');
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(pages()[url.pathname] ?? '<!doctype html><title>Plain</title><p>plain</p>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    await app.whenReady();
    anchor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    host = new BrowserHost({
      dataDir: path.join(directory, 'profiles'),
      consentHelperPath: fileURLToPath(new URL('../../build/native-consent.exe', import.meta.url)),
      toolbarPreloadPath, onRevokeConnection() { throw new Error('No revocation in this fixture'); },
    });
    const caller = { sessionId: 'security-fixture', callId: 'security', signal: new AbortController().signal, assertLive() {} };
    const call = args => host.execute(args, caller);
    const tab = async tabId => (await call({ action: 'list_tabs' })).tabs.find(entry => entry.tabId === tabId);
    const resume = async (tabId, contents) => {
      await menu(frameOf(contents), 'Resume automation');
      await until(async () => { const t = await tab(tabId); return t.mode === 'automation' && !t.paused; }, 'trusted resume');
    };
    const open = async pathname => {
      const opened = await call({ action: 'open', url: `${origin}${pathname}` });
      return { ...opened, contents: pageContents(`${origin}${pathname}`) };
    };

    await check('handoff: navigation, dialog, popup and download stay private, from another tab and after return', async () => {
      const a = await open('/signals');
      const b = await open('/other');
      await call({ action: 'handoff', tabId: a.tabId });
      await until(async () => (await tab(a.tabId)).mode === 'native-handoff', 'native handoff');
      await a.contents.loadURL(`${origin}/private-nav?code=secret123`);
      assert.equal(await a.contents.executeJavaScript("alert('private-dialog-text'); 'answered'", true), 'answered');
      await a.contents.executeJavaScript(`window.open('/popup-private'); 1`, true);
      a.contents.downloadURL(`${origin}/file-private`);
      await until(() => hit('/file-private') === 1 && hit('/popup-private') === 1, 'download and popup requests');
      await pause(300);
      const fromOther = rendered(await call({ action: 'observe', tabId: b.tabId }));
      assert.doesNotMatch(fromOther, /private|secret123|popup|download/, fromOther);
      assert.match(fromOther, new RegExp(`signal ${a.tabId} handoff active`));
      await resume(a.tabId, a.contents);
      const after = rendered(await call({ action: 'observe', tabId: a.tabId }));
      assert.doesNotMatch(after.replace(/^page .*$/m, ''), /private|secret123|popup|download/, after);
      assert.deepEqual((await call({ action: 'downloads', tabId: a.tabId })).items, []);
      for (const t of (await call({ action: 'list_tabs' })).tabs) await call({ action: 'close_tab', tabId: t.tabId });
    });

    await check('a frame moving every animation frame is never clicked through', async () => {
      const page = await open('/nudge');
      await until(async () => /button "Inner"/.test(rendered(await call({ action: 'observe', tabId: page.tabId }))), 'inner frame observed');
      const inner = refOf(await call({ action: 'observe', tabId: page.tabId }), 'button', 'Inner');
      const outcome = await call({ action: 'click', tabId: page.tabId, ref: inner }).catch(error => error);
      await pause(300);
      assert.equal(hit('/decoy'), 0, 'the element under the moving frame was never clicked');
      if (outcome instanceof Error) assert.equal(outcome.requestedInputDispatched, false, outcome.message);
      else assert.equal(outcome.code, 'TARGET_MISMATCH', rendered(outcome));
      assert.equal(hit('/inner-click'), 0);
      console.log('NUDGE', outcome instanceof Error ? `${outcome.code} ${outcome.message}` : rendered(outcome).split('\n')[0]);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('a transparent frame toggled over the target never receives a click', async () => {
      const page = await open('/trap');
      // The flickering trap may cover it at observation time: the full view lists it anyway.
      const real = refOf(await call({ action: 'observe', tabId: page.tabId, mode: 'full' }), 'button', 'Real');
      const outcomes = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const outcome = await call({ action: 'click', tabId: page.tabId, ref: real }).catch(error => error);
        outcomes.push(outcome instanceof Error ? `not-executed ${outcome.code}` : `${outcome.disposition} ${outcome.code ?? ''}`.trim());
      }
      await pause(300);
      assert.equal(hit('/trap-click'), 0, `no click formed in the trap: ${outcomes.join(', ')}`);
      assert.equal(hit('/real'), outcomes.filter(outcome => outcome === 'executed').length, outcomes.join(', '));
      console.log('TRAP', outcomes.join(', '), `trap-down=${hit('/trap-down')}`);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('a point under a transparent cross-origin frame is refused and names the frame', async () => {
      const page = await open('/points');
      const shot = await call({ action: 'observe', tabId: page.tabId, screenshot: true });
      const refused = await call({ action: 'click', tabId: page.tabId, point: { x: 120, y: 60, snapshotId: shot.snapshotId } }).catch(error => error);
      assert.equal(refused.code, 'POINT_HIDDEN_TARGET', refused.message);
      assert.equal(refused.requestedInputDispatched, false);
      assert.match(refused.message, new RegExp(`iframe.* from "localhost:${port}" in "127\\.0\\.0\\.1:${port}"`));
      await pause(200);
      assert.deepEqual([hit('/below'), hit('/trap-click'), hit('/trap-down')], [0, 0, 0]);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('focus emulation reaches an out-of-process iframe while the window stays inactive', async () => {
      const page = await open('/static');
      await until(async () => /button "Inner"/.test(rendered(await call({ action: 'observe', tabId: page.tabId }))), 'inner frame observed');
      const text = rendered(await call({ action: 'observe', tabId: page.tabId }));
      const frame = text.match(/(e\d+) iframe/)[1];
      assert.equal(frameOf(page.contents).isFocused(), false);
      assert.equal((await call({ action: 'evaluate', tabId: page.tabId, expression: 'document.hasFocus()' })).value, true);
      // A child document has focus only while focus is inside it: click into it first.
      await call({ action: 'click', tabId: page.tabId, ref: refOf(await call({ action: 'observe', tabId: page.tabId }), 'button', 'Inner') });
      const inFrame = await call({ action: 'evaluate', tabId: page.tabId, frame, expression: '[document.hasFocus(), document.activeElement.tagName]' });
      console.log('OOPIF_FOCUS', JSON.stringify(inFrame.value));
      assert.deepEqual(inFrame.value, [true, 'BUTTON']);
      assert.equal(frameOf(page.contents).isFocused(), false);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('sensitive fields: sticky after show-password, split OTP, Korean labels, typed during handoff; page code refused', async () => {
      const page = await open('/login');
      const first = rendered(await call({ action: 'observe', tabId: page.tabId, mode: 'full' }));
      for (const secret of ['pw-secret-1', '987654']) assert.ok(!first.includes(secret), first);
      assert.doesNotMatch(first, /textbox[^\n]*=/, `no field value is printed: ${first}`);
      assert.equal((first.match(/textbox[^\n]*sensitive/g) ?? []).length, 8, first);
      await call({ action: 'click', tabId: page.tabId, ref: refOf(await call({ action: 'observe', tabId: page.tabId }), 'button', 'Show password') });
      assert.equal(await page.contents.executeJavaScript('pw.type'), 'text');
      const shown = rendered(await call({ action: 'observe', tabId: page.tabId, mode: 'full' }));
      assert.ok(!shown.includes('pw-secret-1'), shown);
      const password = shown.match(/(e\d+) textbox "Password"[^\n]*sensitive/);
      assert.ok(password, shown);
      const read = rendered(await call({ action: 'read', tabId: page.tabId, ref: password[1] }));
      assert.match(read, /\nsensitive \(value withheld\)$/);
      assert.ok(!read.includes('pw-secret-1'));
      const refused = await call({ action: 'evaluate', tabId: page.tabId, expression: 'document.title' }).catch(error => error);
      assert.deepEqual([refused.code, refused.requestedInputDispatched], ['SENSITIVE_PRESENT', false]);
      // The person types into an ordinary field during a handoff.
      await page.contents.executeJavaScript("for (const id of ['pw','auth']) document.getElementById(id).value=''; document.querySelectorAll('input[maxlength]').forEach(i=>i.value=''); 1");
      await call({ action: 'handoff', tabId: page.tabId });
      await until(async () => (await tab(page.tabId)).mode === 'native-handoff', 'native handoff');
      await page.contents.executeJavaScript("document.getElementById('memo').focus(); 1", true);
      page.contents.focus();
      page.contents.insertText('private memo text');
      await until(() => page.contents.executeJavaScript("document.getElementById('memo').value").then(value => value === 'private memo text'), 'typed');
      await resume(page.tabId, page.contents);
      const back = rendered(await call({ action: 'observe', tabId: page.tabId, mode: 'full' }));
      assert.ok(!back.includes('private memo'), back);
      const memo = back.match(/(e\d+) textbox "메모"[^\n]*sensitive/);
      assert.ok(memo, back);
      assert.match(rendered(await call({ action: 'read', tabId: page.tabId, ref: memo[1] })), /sensitive \(value withheld\)/);
      const stillRefused = await call({ action: 'evaluate', tabId: page.tabId, expression: '1' }).catch(error => error);
      assert.equal(stillRefused.code, 'SENSITIVE_PRESENT');
      assert.equal((await tab(page.tabId)).mode, 'automation', 'agent dispatches never tripped the page-input guard');
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('trusted page input outside an agent dispatch fails closed; agent input never does', async () => {
      const page = await open('/reinsert');
      const cached = refOf(await call({ action: 'observe', tabId: page.tabId }), 'button', 'Cached');
      await call({ action: 'click', tabId: page.tabId, ref: cached });
      await pause(1200);
      assert.equal((await tab(page.tabId)).mode, 'automation');
      page.contents.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 });
      page.contents.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 });
      await until(async () => (await tab(page.tabId)).paused === 'unexpected-page-input', 'fail closed on escaped input');
      await resume(page.tabId, page.contents);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('a picker or dropdown choice outside an agent dispatch fails closed; agent input on those controls never does', async () => {
      const page = await open('/pickers');
      const seen = await call({ action: 'observe', tabId: page.tabId });
      const fruit = refOf(seen, 'combobox', 'Fruit');
      const city = refOf(seen, '(?:combobox|textbox)', 'City');
      const value = id => page.contents.executeJavaScript(`document.getElementById('${id}').value`, true);
      // The agent's own key, select and text input change these values inside its dispatches.
      await call({ action: 'press', tabId: page.tabId, ref: fruit, key: 'ArrowDown' });
      assert.equal(await value('fruit'), 'banana', 'ArrowDown on a closed select changes it');
      await call({ action: 'select', tabId: page.tabId, ref: fruit, values: ['cherry'] });
      await call({ action: 'fill', tabId: page.tabId, ref: city, text: 'Busan' });
      assert.deepEqual([await value('fruit'), await value('city')], ['cherry', 'Busan']);
      await pause(1200);
      assert.equal((await tab(page.tabId)).paused, null, 'agent input on picker controls never trips the guard');
      // A choice in a dropdown or datalist window changes the value with no
      // pointerdown or keydown in the page. Typeahead (a char without a key
      // down) and text the agent never sent stand in for the person.
      await page.contents.executeJavaScript("document.getElementById('fruit').focus(); 1", true);
      await page.contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'a' });
      await until(async () => (await tab(page.tabId)).paused === 'unexpected-page-input', 'fail closed on a dropdown choice');
      assert.equal(await value('fruit'), 'apple');
      await resume(page.tabId, page.contents);
      await page.contents.executeJavaScript("document.getElementById('city').focus(); 1", true);
      await page.contents.debugger.sendCommand('Input.insertText', { text: 'Daegu' });
      await until(async () => (await tab(page.tabId)).paused === 'unexpected-page-input', 'fail closed on a datalist choice');
      await resume(page.tabId, page.contents);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('a reinserted element gets a new ref that clicks; its old ref stays stale', async () => {
      const page = await open('/reinsert');
      const before = hit('/cached');
      const seen = await call({ action: 'observe', tabId: page.tabId });
      const old = refOf(seen, 'button', 'Cached');
      // Removing one of three lines is a large change: the result may be a full view.
      const removed = rendered(await call({ action: 'click', tabId: page.tabId, ref: refOf(seen, 'button', 'Remove') }));
      assert.ok(new RegExp(`\\n- ${old}\\b`).test(removed) || !removed.includes('"Cached"'), removed);
      const restored = await call({ action: 'click', tabId: page.tabId, ref: refOf(seen, 'button', 'Restore') });
      const fresh = refOf(restored, 'button', 'Cached');
      assert.notEqual(fresh, old);
      assert.equal((await call({ action: 'click', tabId: page.tabId, ref: fresh })).disposition, 'executed');
      await until(() => hit('/cached') === before + 1, 'the new ref clicked');
      await assert.rejects(call({ action: 'click', tabId: page.tabId, ref: old }), error => error.code === 'STALE_REF');
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('a scroll result shows the content that scrolled in', async () => {
      const page = await open('/long');
      const seen = rendered(await call({ action: 'observe', tabId: page.tabId }));
      assert.ok(!seen.includes('"Item 40"'), seen);
      const scrolled = rendered(await call({ action: 'scroll', tabId: page.tabId, target: { role: 'button', name: 'Item 1', exact: true }, deltaX: 0, deltaY: 1500 }));
      assert.doesNotMatch(scrolled, /no change/);
      assert.match(scrolled, /button "Item 4\d"/, scrolled);
      assert.match(scrolled, /\nview \d+x\d+ scroll [1-9]\d*\//, scrolled);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('perception stays bounded: 1000 srcdoc frames and a 12000-deep DOM', async () => {
      let started = Date.now();
      const many = await open('/many');
      console.log('MANY_OPEN_MS', Date.now() - started);
      started = Date.now();
      const manyText = rendered(await call({ action: 'observe', tabId: many.tabId }));
      const manyMs = Date.now() - started;
      assert.match(manyText, /button "Top"/);
      const hidden = Number(manyText.match(/hidden frames (\d+)/)?.[1] ?? 0);
      assert.ok(hidden >= 900, manyText.slice(-400));
      assert.ok(manyMs < 20000, `observed in ${manyMs} ms`);
      await call({ action: 'close_tab', tabId: many.tabId });
      const deep = await open('/deep');
      started = Date.now();
      const deepText = rendered(await call({ action: 'observe', tabId: deep.tabId }));
      assert.match(deepText, /button "Shallow"/);
      assert.match(deepText, /partial page: element scan capped/);
      console.log('BOUNDS', JSON.stringify({ manyMs, hidden, deepMs: Date.now() - started, deepPartial: /partial page/.test(deepText) }));
      await call({ action: 'close_tab', tabId: deep.tabId });
    });

    await check('page code is refused beside a same-origin login iframe and while a named popup is in handoff', async () => {
      const outer = await open('/outer');
      await until(async () => /iframe/.test(rendered(await call({ action: 'observe', tabId: outer.tabId }))), 'frame observed');
      // The isolated world of the parent reaches the child document directly.
      for (const args of [{ action: 'evaluate', tabId: outer.tabId, expression: "document.querySelector('iframe').contentDocument.querySelector('input').value" },
        { action: 'console', tabId: outer.tabId, expression: 'document.title' }]) {
        const refused = await call(args).catch(error => error);
        assert.deepEqual([refused.code, refused.requestedInputDispatched], ['SENSITIVE_PRESENT', false], `${args.action} ${refused.message}`);
      }
      await call({ action: 'close_tab', tabId: outer.tabId });
      const opener = await open('/opener');
      await opener.contents.executeJavaScript("window.open('/popup-login', 'login'); 1", true);
      let popupId;
      await until(async () => { popupId = (await call({ action: 'list_tabs' })).tabs.find(t => /popup-login/.test(t.url ?? ''))?.tabId; return !!popupId; }, 'popup tab');
      const reach = "open('', 'login').document.title";
      assert.equal((await call({ action: 'evaluate', tabId: opener.tabId, expression: reach })).value, 'Popup login', 'the popup is reachable by name');
      await call({ action: 'handoff', tabId: popupId });
      await until(async () => (await tab(popupId)).mode === 'native-handoff', 'popup in handoff');
      const refused = await call({ action: 'evaluate', tabId: opener.tabId, expression: reach }).catch(error => error);
      assert.deepEqual([refused.code, refused.requestedInputDispatched], ['SENSITIVE_PRESENT', false], refused.message);
      for (const t of (await call({ action: 'list_tabs' })).tabs) await call({ action: 'close_tab', tabId: t.tabId });
    });

    await check('text and keys never land in the parent when it steals focus from a cross-origin iframe', async () => {
      const page = await open('/focus-steal');
      await until(async () => /textbox "Inner field"/.test(rendered(await call({ action: 'observe', tabId: page.tabId }))), 'inner field observed');
      const field = refOf(await call({ action: 'observe', tabId: page.tabId }), 'textbox', 'Inner field');
      const outcomes = [];
      for (const args of [{ action: 'fill', text: 'meant for the frame' }, { action: 'type', text: 'more' }, { action: 'press', key: 'Enter' }]) {
        const outcome = await call({ tabId: page.tabId, ref: field, ...args }).catch(error => error);
        outcomes.push(outcome instanceof Error ? `not-executed ${outcome.code}` : `${outcome.disposition} ${outcome.code ?? ''}`.trim());
      }
      await pause(300);
      assert.equal(await page.contents.executeJavaScript("document.getElementById('decoy').value"), '', outcomes.join(', '));
      assert.equal(hit('/decoy-submit'), 0, outcomes.join(', '));
      console.log('FOCUS_STEAL', outcomes.join(', '));
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('a container read and text waits never reveal or probe a sensitive contenteditable', async () => {
      const page = await open('/editable');
      // A live region's own value is masked the same way.
      const seen = rendered(await call({ action: 'observe', tabId: page.tabId, mode: 'full' }));
      assert.ok(!seen.includes('4111') && /status "Card details"/.test(seen), seen);
      const text = rendered(await call({ action: 'read', tabId: page.tabId, target: { role: 'status' } }));
      assert.ok(!text.includes('4111'), text);
      assert.match(text, /Card on file/);
      assert.match(text, /\nsensitive \(value withheld\)$/);
      const probe = await call({ action: 'observe', tabId: page.tabId, wait: { text: '4111 1111', timeoutMs: 300 } });
      assert.equal(probe.code, 'WAIT_TIMEOUT', rendered(probe));
      assert.equal((await call({ action: 'observe', tabId: page.tabId, wait: { text: 'Card on file', timeoutMs: 300 } })).code, undefined);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('a field typed during handoff stays private after a flood of input elsewhere', async () => {
      const page = await open('/typed');
      await call({ action: 'handoff', tabId: page.tabId });
      await until(async () => (await tab(page.tabId)).mode === 'native-handoff', 'native handoff');
      page.contents.focus();
      await page.contents.executeJavaScript("document.getElementById('note').focus(); 1", true);
      await page.contents.insertText('private note');
      await page.contents.executeJavaScript("document.getElementById('other').focus(); 1", true);
      for (let i = 0; i < 600; i++) await page.contents.insertText('x');
      await until(() => page.contents.executeJavaScript("document.getElementById('other').value.length").then(length => length === 600), 'flood typed');
      await resume(page.tabId, page.contents);
      const back = rendered(await call({ action: 'observe', tabId: page.tabId, mode: 'full' }));
      assert.ok(!back.includes('private note'), back);
      assert.match(back, /textbox "Note"[^\n]*sensitive/, back);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await check('label names leave out visibility:hidden and opacity:0 text', async () => {
      const page = await open('/hidden-label');
      const text = rendered(await call({ action: 'observe', tabId: page.tabId }));
      assert.match(text, /textbox "Email"/, text);
      assert.doesNotMatch(text, /Required|faded/, text);
      await call({ action: 'close_tab', tabId: page.tabId });
    });

    await host.close(); anchor.destroy(); server.close();
    if (failures.length) { console.error(`FAILED_CASES ${JSON.stringify(failures)}`); app.exit(1); }
    else { console.log('SECURITY_LIVE_PASSED'); app.exit(0); }
  } catch (error) {
    console.error(error.stack); await host?.close(); anchor?.destroy(); server?.close(); app.exit(1);
  }
}
void run();
