// Real-Chromium check of the perception walker composed from the vendored
// upstream source, driven over CDP the way the frame driver will drive it.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  armGuardExpression, describeExpression, disarmGuardExpression, extractUpstreamSources, quietExpression, snapshotExpression, walkerInstallSource,
} from '../../src/browser/perception/walker.mjs';
import { composeModel } from '../../src/browser/perception/model.mjs';
import { RefRegistry } from '../../src/browser/perception/refs.mjs';
import { estimateTokens, renderDiff, renderSnapshot } from '../../src/browser/perception/render.mjs';

const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'electron'));
const root = fileURLToPath(new URL('../../', import.meta.url));
const WORLD = 'independent-browser-perception-live';

const PAGE = `<!doctype html><meta charset="utf-8"><title>Perception fixture</title>
<style>body{margin:0;font:14px sans-serif}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}#below{margin-top:1500px}</style>
<nav aria-label="Main"><a href="/one"><span>One</span><img alt="logo" width="10" height="10" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a> <a href="/two">Two</a></nav>
<div id="images"><a href="/logo"><img alt="Logo link" width="10" height="10" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
<button type="button"><svg width="10" height="10" aria-label="Search icon"></svg></button>
<a href="/titled"><svg width="10" height="10"><title>Svg title link</title></svg></a>
<a href="/decor"><img alt="Hidden decor" aria-hidden="true" width="10" height="10" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><img alt="Visible alt" width="10" height="10" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
<a href="/faded"><img alt="Faded alt" style="opacity:0" width="10" height="10" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
<span style="cursor:pointer;display:inline-block"><button type="button" aria-label="Close panel"><svg width="10" height="10"></svg></button></span></div>
<main>
<h1>Perception fixture</h1>
<p>Plain paragraph text <b>bold part</b> end.<span class="sr">screen reader only</span></p>
<form aria-label="Login">
 <label for="user">User</label><input id="user" value="alice">
 <label for="pw">Password</label><input id="pw" type="password" value="DO_NOT_EXPORT_PASSWORD">
 <input id="otp" name="otp" value="246810" aria-label="Code">
 <div style="cursor:pointer" id="keep"><input type="checkbox" id="remember"><label for="remember">Remember me</label></div>
 <button type="button" id="go">Sign in</button>
</form>
<div id="card" style="cursor:pointer"><span>Card title</span> <button type="button">Buy</button></div>
<div id="tile" style="cursor:pointer;width:200px">Clickable tile</div>
<div role="status" id="status"></div>
<div id="host"><button>Light slotted</button></div><div id="closed-host"><button>Light unslotted</button></div>
<div style="display:none">Hidden text <button>Hidden button</button></div>
<style>.leak{color:red}</style><script>var LEAK_SCRIPT_TEXT = 1;</script>
<iframe id="frame" src="/frame" style="width:300px;height:120px;border:2px solid #000;padding:3px"></iframe>
<div style="position:relative;width:200px;height:40px"><button style="width:200px;height:40px">Under overlay</button>
<div style="position:absolute;inset:0;background:rgba(0,0,0,.1)"></div></div>
<p>Ticker <span id="ticker">0</span></p>
<div id="below"><button>Far below</button><h2>Lower section</h2></div>
</main>
<script>
document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button><slot></slot>';
document.querySelector('#closed-host').attachShadow({mode:'open'}).innerHTML='<span>No slot here</span>';
</script>`;
const FRAME = `<!doctype html><meta charset="utf-8"><style>.ad{color:blue}</style><body><button>Frame button</button><p>Frame text</p></body>`;

let server, window;
async function run() {
  await app.whenReady();
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(request.url === '/frame' ? FRAME : PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  window = new BrowserWindow({ show: false, useContentSize: true, width: 1000, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(url);
  const wc = window.webContents;
  wc.debugger.attach('1.3');
  const send = (method, params = {}) => wc.debugger.sendCommand(method, params);
  await send('Page.enable');
  await send('DOM.enable');
  await send('Runtime.enable');
  const upstream = extractUpstreamSources(await readFile(path.join(root, 'vendor/mixdog/apps/desktop/src/main/browser/snapshot-scripts.ts'), 'utf8'));
  const install = walkerInstallSource(upstream);
  const evaluate = async (contextId, expression) => {
    const result = await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Walker evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  const main = code => wc.executeJavaScript(code);
  let frames;
  const capture = async () => {
    const { frameTree } = await send('Page.getFrameTree');
    frames = [];
    const walk = (tree, parentId) => {
      frames.push({ frameId: tree.frame.id, parentId, url: tree.frame.url });
      for (const child of tree.childFrames ?? []) walk(child, tree.frame.id);
    };
    walk(frameTree, null);
    const started = performance.now();
    await Promise.all(frames.map(async frame => {
      frame.contextId = (await send('Page.createIsolatedWorld', { frameId: frame.frameId, worldName: WORLD })).executionContextId;
      await evaluate(frame.contextId, install);
      frame.snapshot = await evaluate(frame.contextId, snapshotExpression());
    }));
    const ms = performance.now() - started;
    for (const frame of frames.filter(value => value.parentId)) {
      const parent = frames.find(value => value.frameId === frame.parentId);
      const { backendNodeId } = await send('DOM.getFrameOwner', { frameId: frame.frameId });
      const { object } = await send('DOM.resolveNode', { backendNodeId, executionContextId: parent.contextId });
      const owner = await send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true,
        functionDeclaration: 'function(){return globalThis.__independentState.idOf(this)}' });
      frame.ownerId = owner.result.value || null;
    }
    return { model: composeModel(frames), ms };
  };

  const registry = new RefRegistry();
  const refFor = item => registry.ref({ tabId: 't1', generation: 1, ...item });
  const { model, ms } = await capture();
  const first = renderSnapshot(model, { refFor });
  const text = first.text;
  console.log('PERCEPTION_SNAPSHOT\n' + text);
  console.log('PERCEPTION_SIZE', JSON.stringify({ chars: text.length, tokens: estimateTokens(text), captureMs: Math.round(ms) }));
  const lines = text.split('\n');
  const line = pattern => lines.find(value => pattern.test(value));

  for (const leak of ['DO_NOT_EXPORT_PASSWORD', '246810', 'LEAK_SCRIPT_TEXT', 'color:red', 'color:blue', 'Hidden text',
    'Hidden button', 'screen reader only', 'Light unslotted', 'Hidden decor', 'Faded alt']) assert.ok(!text.includes(leak), `must not contain ${leak}`);
  assert.ok(line(/^\s*e\d+ textbox "User" ="alice"$/), 'labelled textbox with its value');
  assert.ok(!line(/text "User|text "Remember/), 'label text is the control name, not a text line');
  assert.ok(line(/e\d+ textbox "Password" sensitive$/), 'password marked sensitive without value');
  assert.ok(line(/e\d+ textbox "Code" sensitive$/), 'OTP-like field is sensitive');
  assert.ok(line(/e\d+ checkbox "Remember me" unchecked$/));
  assert.equal(lines.filter(value => value.includes('Remember me')).length, 1, 'wrapper and label are not separate lines');
  assert.ok(line(/e\d+ link "One logo"|e\d+ link "One"/), 'link content (span, img) is part of the link');
  // An image-only control is named by its rendered embedded content; hidden
  // and aria-hidden content never names it, and a wrapper never takes a
  // nested control's name.
  assert.ok(line(/^\s*e\d+ link "Logo link"$/), 'image-only link named by its alt');
  assert.ok(line(/^\s*e\d+ button "Search icon"$/), 'icon button named by its svg aria-label');
  assert.ok(line(/^\s*e\d+ link "Svg title link"$/), 'svg title names a link');
  assert.ok(line(/^\s*e\d+ link "Visible alt"$/), 'aria-hidden image left out of the name');
  assert.ok(line(/^\s*e\d+ link \/faded$/), 'a link whose only image is transparent stays unnamed');
  assert.equal(lines.filter(value => value.includes('Close panel')).length, 1, 'a wrapper does not take a nested control name');
  assert.ok(!line(/img "logo"|span/), 'no content wrappers');
  assert.ok(line(/e\d+ button "Buy"$/) && line(/^\s*text "Card title"$/) && !line(/generic "Card title/), 'card wrapper dropped, its text kept');
  assert.ok(line(/e\d+ generic "Clickable tile" clickable$/), 'outermost cursor:pointer element is one clickable');
  assert.ok(!line(/^ *text "Clickable tile"/), 'a clickable carries its text as its name');
  assert.ok(line(/e\d+ button "Shadow action"$/) && line(/e\d+ button "Light slotted"$/), 'open shadow DOM in flat-tree order');
  assert.ok(line(/^\s*text "Plain paragraph text bold part end\."$/), 'rendered text runs, inline content joined');
  const frameLine = lines.findIndex(value => /^\s*e\d+ iframe 127\.0\.0\.1:\d+$/.test(value));
  assert.ok(frameLine >= 0 && /^\s+e\d+ button "Frame button"$/.test(lines[frameLine + 1])
    && /^\s+text "Frame text"$/.test(lines[frameLine + 2]), 'iframe content inlined below its iframe');
  assert.ok(line(/^\+1 covered$/), 'occluded control is collapsed');
  assert.ok(line(/^\+1 offscreen \(1 below\): button "Far below"$/) && line(/^outline: h2 "Lower section"$/));
  assert.ok(line(/^\s*e\d+ form "Login"$/) && line(/^e\d+ navigation "Main"$/), 'named landmarks are kept ancestors');

  // Identity survives unrelated updates; renames and removals retire ids.
  const rootFrame = frames.find(frame => !frame.parentId);
  const idOf = name => model.items.find(item => item.name === name && item.kind === 'i').id;
  const signIn = idOf('Sign in'), tile = idOf('Clickable tile');
  await main(`document.querySelector('h1').after(Object.assign(document.createElement('p'),{textContent:'Unrelated update'}));
    document.querySelector('#ticker').textContent='1';`);
  const second = await capture();
  assert.equal(second.model.items.find(item => item.name === 'Sign in').id, signIn, 'same node keeps its id');
  assert.equal(second.model.frames.get(rootFrame.frameId).documentId, model.frames.get(rootFrame.frameId).documentId);
  const quietDiff = renderDiff(second.model, first.view, { from: 's1', to: 's2', refFor });
  assert.match(quietDiff.text, /\+ text "Unrelated update"/, `diff: ${quietDiff.text}`);
  assert.match(quietDiff.text, /\+ text "Ticker 1"/, 'text-only change shows as new text');

  await main(`document.querySelector('#go').textContent='Log in'; document.querySelector('#tile').remove();
    document.querySelector('#status').textContent='Saved';
    document.body.append(Object.assign(document.createElement('div'),{textContent:'Profile updated',style:'position:fixed;right:10px;bottom:10px;width:200px'}));`);
  const third = await capture();
  const thirdRoot = frames.find(frame => !frame.parentId).snapshot;
  const logIn = third.model.items.find(item => item.name === 'Log in');
  assert.notEqual(logIn.id, signIn, 'a renamed control gets a new identity');
  assert.deepEqual(thirdRoot.renamed, [[signIn, logIn.id]]);
  assert.ok(thirdRoot.gone.includes(tile), 'removed node is reported gone');
  assert.deepEqual(await evaluate(rootFrame.contextId, describeExpression(logIn.id)), { described: { role: 'button', name: 'Log in' } });
  assert.equal(await evaluate(rootFrame.contextId, `globalThis.__independentState.resolve(${tile})`), null);
  const base = renderDiff(second.model, first.view, { from: 's1', to: 's2', refFor }).view;
  const change = renderDiff(third.model, base, { from: 's2', to: 's3', refFor, isGone: () => true });
  console.log('PERCEPTION_DIFF\n' + change.text);
  // The region was empty (no box) before, so it arrives as a new line.
  assert.match(change.text, /\+ e\d+ status ="Saved"/, 'live region content is in the action diff');
  assert.match(change.text, /\+ e\d+ toast ="Profile updated"/, 'toast-like content is in the action diff');
  assert.match(change.text, /\+ e\d+ button "Log in"/);
  assert.match(change.text, /\n- (e\d+ ?)+$/m, 'removed refs listed');

  // Quiet ignores text churn but is capped under structural churn.
  await main(`window.__tick=setInterval(()=>{document.querySelector('#ticker').textContent=String(Date.now())},20)`);
  const churn = await evaluate(rootFrame.contextId, quietExpression(100, 800));
  assert.equal(churn.quiet, true, `text-only ticker does not delay a settle: ${JSON.stringify(churn)}`);
  await main(`clearInterval(window.__tick);window.__tick=setInterval(()=>{document.querySelector('main').append(document.createElement('i'))},20)`);
  const structural = await evaluate(rootFrame.contextId, quietExpression(100, 500));
  assert.equal(structural.quiet, false);
  assert.ok(structural.waited >= 480 && structural.waited < 800, `capped: ${structural.waited}`);
  await main('clearInterval(window.__tick)');
  const snapshotDuringChurn = await capture();
  assert.ok(snapshotDuringChurn.model.items.length > 0, 'capture needs no quiet page');

  // The one-shot dispatch guard (H1): a real press under a cover reports a
  // mismatch; a beforeinput on another element is cancelled in the same turn.
  await main(`document.body.insertAdjacentHTML('beforeend','<div style="position:fixed;left:0;top:0;width:400px;height:120px;z-index:9;background:#fff">'
    + '<button style="width:200px;height:60px">Guarded</button><input aria-label="Guard A"><input id="gb" aria-label="Guard B"></div>'
    + '<div id="cover" style="position:fixed;left:0;top:0;width:220px;height:70px;z-index:10;background:rgba(0,0,0,0.02)"></div>'); 1`);
  const guarded = await capture();
  const guardRoot = frames.find(frame => !frame.parentId);
  const idByName = name => guarded.model.items.find(item => item.name === name && item.kind === 'i').id;
  const press = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 30, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 30, button: 'left', clickCount: 1 });
  };
  assert.deepEqual(await evaluate(guardRoot.contextId, armGuardExpression(idByName('Guarded'), 'pointerdown')), { armed: true });
  await press();
  assert.deepEqual(await evaluate(guardRoot.contextId, disarmGuardExpression()), { guard: { fired: true, inside: false } }, 'covered press');
  await main("document.getElementById('cover').remove(); 1");
  await evaluate(guardRoot.contextId, armGuardExpression(idByName('Guarded'), 'pointerdown'));
  await press();
  assert.deepEqual(await evaluate(guardRoot.contextId, disarmGuardExpression()), { guard: { fired: true, inside: true } }, 'uncovered press');
  await evaluate(guardRoot.contextId, armGuardExpression(idByName('Guard A'), 'beforeinput'));
  await main("document.getElementById('gb').focus(); 1");
  await send('Input.insertText', { text: 'misdirected' });
  assert.deepEqual(await evaluate(guardRoot.contextId, disarmGuardExpression()), { guard: { fired: true, inside: false } });
  assert.equal(await main("document.getElementById('gb').value"), '', 'text never reached the other field');

  console.log('PERCEPTION_CONTRACT_PASSED');
}

run().then(() => { window?.destroy(); server?.close(); app.exit(0); }, error => {
  console.error(error.stack);
  window?.destroy();
  server?.close();
  app.exit(1);
});
