import { app, BrowserWindow, dialog } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserHost } from '../../src/browser/host.mjs';
import { BrowserPolicy } from '../../src/browser/policy.mjs';
import { pause } from '../../src/async.mjs';
import { assertNative, assertShielded, pageContents, presentationOf, toolbarPreloadPath } from './presentation.mjs';

const data = process.argv[2];
app.setPath('userData', data);
app.on('window-all-closed', () => {});
const menus = new WeakMap();
const setMenu = BrowserWindow.prototype.setMenu;
BrowserWindow.prototype.setMenu = function(menu) {
  menus.set(this, menu);
  return setMenu.call(this, menu);
};
const page = `<!doctype html><meta charset="utf-8"><title>Local verification app</title>
<style>body{font:18px sans-serif;padding:24px}button,input,select{font:inherit;margin:8px;padding:8px}</style>
<h1>Development verification fixture</h1>
<form id="form">
<label>Task name <input name="name" aria-label="Task name"></label>
<label>Status <select name="status" aria-label="Status"><option value="draft">Draft</option><option value="ready">Ready</option></select></label>
<button>Save local task</button></form><output id="saved"></output>
<button id="pick">Attach fixture</button>
<input id="file" type="file" aria-label="Attachment" hidden><output id="attachment"></output>
<button id="ask">Confirm test action</button><button id="alert">Show test alert</button>
<button id="unsupported">Check native prompt</button><output id="answer"></output>
<button id="notifications">Enable test notifications</button><output id="permission"></output>
<script>
const file=document.getElementById('file');
document.getElementById('form').onsubmit=e=>{
 e.preventDefault();const data=new FormData(e.target);
 document.getElementById('saved').textContent=JSON.stringify(Object.fromEntries(data));
};
document.getElementById('pick').onclick=()=>file.click();
file.onchange=()=>{document.getElementById('attachment').textContent=file.files[0]?.name||''};
document.getElementById('ask').onclick=()=>{document.getElementById('answer').textContent=confirm('Fixture approval')?'approved':'rejected'};
document.getElementById('alert').onclick=()=>{alert('Fixture alert');document.getElementById('answer').textContent='Alert returned once'};
document.getElementById('unsupported').onclick=()=>{try{prompt('Unsupported native prompt')}catch(error){document.getElementById('answer').textContent=error.message}};
document.getElementById('notifications').onclick=async()=>{document.getElementById('permission').textContent=await Notification.requestPermission()};
</script>`;
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page);
});
let host;
let nativeDialogs = 0;
dialog.showMessageBox = async () => { nativeDialogs++; throw new Error('Unexpected routine human consent UI'); };
const controller = new AbortController();
const caller = {
  sessionId: 'autonomous-app-check', callId: 'verification', signal: controller.signal,
  assertLive() { controller.signal.throwIfAborted(); },
};
const call = args => host.execute(args, caller);
const has = (state, text) => state.frames.some(frame => frame.text.includes(text));
async function pending(tabId, kind) {
  const state = await call({ action: 'requests', tabId });
  const requests = state.pending.filter(request => request.kind === kind);
  assert.equal(requests.length, 1, `Exactly one actual ${kind} request must be pending: ${JSON.stringify(state)}`);
  return requests[0];
}
async function assertAutomation(tabId) {
  const state = (await call({ action: 'list_tabs' })).tabs.find(tab => tab.tabId === tabId);
  assert.equal(state.mode, 'automation');
  assert.equal(state.paused, null);
  assertShielded(pageContents(url => url.startsWith('http://127.0.0.1:')));
}
async function run() {
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  host = new BrowserHost({
    dataDir: path.join(data, 'profiles'), consentHelperPath: path.resolve('build/native-consent.exe'), toolbarPreloadPath,
    policy: await BrowserPolicy.load(path.resolve('.')),
    onRevokeConnection() { throw new Error('Fixture must not terminate a registered connection'); },
  });
  const opened = await call({ action: 'open', url: `http://127.0.0.1:${server.address().port}` });
  const tabId = opened.tabId;
  assert.equal(opened.disposition, 'observed');
  await call({ action: 'fill', tabId, target: { name: 'Task name', exact: true }, text: 'Autonomous verification' });
  await call({ action: 'select', tabId, target: { name: 'Status', exact: true }, values: ['ready'] });
  let observed = await call({ action: 'click', tabId, target: { name: 'Save local task', exact: true } });
  assert.ok(has(observed, '{"name":"Autonomous verification","status":"ready"}'));
  console.log('PASS local app form input, selection, save and result verification');

  await call({ action: 'click', tabId, target: { name: 'Attach fixture', exact: true } });
  let request = await pending(tabId, 'file-picker');
  const attachment = path.join(data, 'app-fixture.txt');
  await writeFile(attachment, 'explicit local test fixture');
  let resolved = await call({ action: 'respond', tabId, requestRef: request.requestRef, response: { files: [attachment] } });
  assert.equal(resolved.request.resolution, 'selected', JSON.stringify(resolved));
  observed = await call({ action: 'observe', tabId });
  assert.ok(has(observed, 'app-fixture.txt'));
  await assertAutomation(tabId);
  console.log('PASS actual Chromium file chooser event and explicit upload without handoff');

  for (const scenario of [
    { button: 'Confirm test action', type: 'confirm', decision: 'Accept', expected: 'approved' },
    { button: 'Confirm test action', type: 'confirm', decision: 'Dismiss', expected: 'rejected' },
    { button: 'Show test alert', type: 'alert', decision: 'Accept', expected: 'Alert returned once' },
  ]) {
    await call({ action: 'click', tabId, target: { name: scenario.button, exact: true } });
    request = await pending(tabId, 'javascript-dialog');
    assert.equal(request.context.type, scenario.type);
    resolved = await call({ action: 'respond', tabId, requestRef: request.requestRef,
      response: { optionRef: request.options.find(option => option.label === scenario.decision).optionRef } });
    assert.equal(resolved.request.resolution, 'resolved', JSON.stringify(resolved));
    observed = await call({ action: 'observe', tabId });
    assert.ok(has(observed, scenario.expected));
    await assertAutomation(tabId);
  }
  console.log('PASS actual JS alert and both confirm decisions release their page continuations');

  observed = await call({ action: 'click', tabId, target: { name: 'Check native prompt', exact: true } });
  assert.ok(has(observed, 'prompt() is not supported.'));
  assert.equal((await call({ action: 'requests', tabId })).pending.length, 0);
  assert.match(host.status().capabilities.javascriptDialogs.unsupported.prompt, /Electron 44.9.1/);
  console.log('LIMITATION actual window.prompt throws before creating a native request; reported unsupported');

  await call({ action: 'click', tabId, target: { name: 'Enable test notifications', exact: true } });
  request = await pending(tabId, 'notifications');
  assert.equal(request.context.origin, `http://127.0.0.1:${server.address().port}`);
  resolved = await call({ action: 'respond', tabId, requestRef: request.requestRef,
    response: { optionRef: request.options.find(option => option.label === 'Allow').optionRef } });
  assert.equal(resolved.request.resolution, 'allowed', JSON.stringify(resolved));
  observed = await call({ action: 'observe', tabId });
  assert.ok(has(observed, 'granted'));
  await assertAutomation(tabId);
  console.log('PASS actual Chromium permission callback resolved without Windows consent');

  const second = await call({ action: 'open', url: `http://127.0.0.1:${server.address().port}` });
  const secondId = second.tabId;
  await call({ action: 'click', tabId, target: { name: 'Confirm test action', exact: true } });
  const firstRequest = await pending(tabId, 'javascript-dialog');
  await call({ action: 'click', tabId: secondId, target: { name: 'Confirm test action', exact: true } });
  const secondRequest = await pending(secondId, 'javascript-dialog');
  await assert.rejects(call({ action: 'respond', tabId: secondId, requestRef: firstRequest.requestRef,
    response: { optionRef: firstRequest.options[0].optionRef } }), /another page or caller generation/);
  await call({ action: 'respond', tabId, requestRef: firstRequest.requestRef,
    response: { optionRef: firstRequest.options.find(option => option.label === 'Accept').optionRef } });
  await call({ action: 'respond', tabId: secondId, requestRef: secondRequest.requestRef,
    response: { optionRef: secondRequest.options.find(option => option.label === 'Dismiss').optionRef } });
  assert.ok(has(await call({ action: 'observe', tabId }), 'approved'));
  assert.ok(has(await call({ action: 'observe', tabId: secondId }), 'rejected'));
  await call({ action: 'close_tab', tabId: secondId });
  console.log('PASS real dialogs on two owned pages cannot exchange request decisions');

  const guest = pageContents(url => url.startsWith('http://127.0.0.1:'));
  const { frame } = presentationOf(guest);
  const menu = label => menus.get(frame).items.find(item => item.label === label).click();
  const resume = async () => {
    menu('Resume automation');
    // Electron's native MenuItem wrapper returns before its async handler ends.
    // Wait for that one accepted menu operation; never repeat the gesture.
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const tab = (await call({ action: 'list_tabs' })).tabs.find(item => item.tabId === tabId);
      if (tab.mode === 'automation' && tab.paused === null) return;
      await pause(20);
    }
    throw new Error('Native Resume did not finish');
  };
  await call({ action: 'click', tabId, target: { name: 'Confirm test action', exact: true } });
  request = await pending(tabId, 'javascript-dialog');
  menu('Stop automation');
  observed = await call({ action: 'observe', tabId });
  assert.equal(observed.paused, 'explicit-stop');
  assert.ok(has(observed, 'rejected'));
  await assert.rejects(call({ action: 'respond', tabId, requestRef: request.requestRef,
    response: { optionRef: request.options[0].optionRef } }), /Automation paused/);
  assertShielded(guest, 'stopped page');
  await resume();
  await assertAutomation(tabId);
  console.log('PASS Stop dismisses actual pending confirm, blocks late acceptance and never resumes itself');

  await call({ action: 'click', tabId, target: { name: 'Confirm test action', exact: true } });
  request = await pending(tabId, 'javascript-dialog');
  const handoff = await call({ action: 'handoff', tabId });
  assert.equal(handoff.mode, 'native-handoff');
  assertNative(guest);
  await assert.rejects(call({ action: 'observe', tabId }), error => error.code === 'PRIVATE_HANDOFF');
  await assert.rejects(call({ action: 'respond', tabId, requestRef: request.requestRef,
    response: { optionRef: request.options[0].optionRef } }), /Automation paused/);
  await resume();
  observed = await call({ action: 'observe', tabId });
  assert.ok(has(observed, 'rejected'));
  await assertAutomation(tabId);
  console.log('PASS handoff drains actual dialog cleanup before reveal; return remains native-menu-only');

  assert.equal(nativeDialogs, 0);
  assert.equal((await call({ action: 'requests', tabId })).pending.length, 0);
  console.log('AUTONOMOUS_APP_VERIFICATION_PASSED');
  await host.close();
  await new Promise(resolve => server.close(resolve));
  app.exit(0);
} catch (error) {
  console.error(error.stack);
  await host?.close();
  server.close();
  app.exit(1);
}
}
run();
