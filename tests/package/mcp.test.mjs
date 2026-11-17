import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { BROWSER_TOOL } from '../../src/shared/authority.mjs';
import { WORKER_PROBE_EXPRESSION } from '../fixtures/worker-probe.mjs';

const artifact = process.env.WB_PACKAGE_DIR;
assert.ok(artifact && path.isAbsolute(artifact), 'Set WB_PACKAGE_DIR to the exact packaged plugin folder');
const executable = path.join(artifact, 'bin/bridge.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// JSON actions (status, list_tabs, requests, respond, revoke, DevTools reads).
const dataOf = result => JSON.parse(result.content.find(part => part.type === 'text').text);
// Page actions answer text: a status line with tab=t<n>, then lines with e<n> refs.
const textOf = result => result.content.find(part => part.type === 'text').text;
const tabOf = result => textOf(result).match(/\btab=(t\d+)/)?.[1];
const has = (result, text) => textOf(result).includes(JSON.stringify(text).slice(1, -1));
const valueOf = result => JSON.parse(textOf(result).match(/\nvalue (.*)/)[1]);
function refOf(result, role, name) {
  const match = textOf(result).match(new RegExp(`(e\\d+) ${role} ${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(match, `Expected ${role} "${name}" in:\n${textOf(result)}`);
  return match[1];
}
async function diagnostic(connection, session, result) {
  if (!result.isError) return textOf(result);
  const tabId = tabOf(result);
  const state = tabId
    ? textOf(await connection.call(session, { action: 'observe', tabId }))
    : JSON.stringify(await connection.status());
  return `${textOf(result)}\n--- follow-up ---\n${state}`;
}
async function until(predicate, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}
// Read-only process listing: [{ProcessId, ParentProcessId, CommandLine}] for one image name.
function processes(name) {
  const shell = path.join(process.env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + `@(Get-CimInstance Win32_Process -Filter "Name='${name}'" | Select-Object ProcessId, ParentProcessId, CommandLine) | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve([].concat(JSON.parse(stdout.trim() || '[]')));
    }));
}
async function environment(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-package-한글-'));
  const env = {};
  for (const key of ['SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // The child must use its bundled Node/Chromium/native runtime, not developer
  // tools from PATH. The GUI launcher must remove inherited Node mode.
  env.PATH = path.join(process.env.SYSTEMROOT, 'System32');
  env.ELECTRON_RUN_AS_NODE = '1';
  env.MIXDOG_PLUGIN_DATA = directory;
  env.MIXDOG_PLUGIN_ROOT = artifact;
  const errors = [];
  t.after(async () => {
    await writeFile(path.join(directory, 'test-stderr.log'), errors.join('\n'));
    console.log(`Packaged MCP logs: ${directory}`);
  });
  return { directory, env, errors };
}
// A plain MCP registration (Claude Code `claude mcp add`): no host hooks, no
// Mixdog variables; the registration sets connection authority and the data root.
async function connectionEnvironment(t) {
  const context = await environment(t);
  delete context.env.MIXDOG_PLUGIN_DATA;
  delete context.env.MIXDOG_PLUGIN_ROOT;
  context.env.WB_AUTHORITY = 'connection';
  context.env.WB_DATA_DIR = context.directory;
  return context;
}
async function plainClient(t, context) {
  const client = new Client({ name: 'plain-registration-check', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: executable, args: ['--mcp'], cwd: os.tmpdir(), env: context.env, stderr: 'pipe',
  });
  transport.stderr.on('data', bytes => context.errors.push(bytes.toString('utf8')));
  await client.connect(transport);
  t.after(() => client.close());
  const descriptor = (await client.listTools()).tools.find(tool => tool.name === 'browse');
  assert.ok(descriptor);
  const call = args => client.callTool({ name: 'browse', arguments: args });
  const channel = dataOf(await call({ action: 'status' })).channel;
  return { client, descriptor, channel, call };
}
async function hook(env, payload) {
  const child = spawn(executable, ['--hook'], {
    env, cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  child.stdin.end(JSON.stringify(payload));
  assert.equal(await done, 0, stderr);
  return stdout ? JSON.parse(stdout) : null;
}
let callSequence = 0;
async function authorize(env, channel, sessionId, args) {
  const result = await hook(env, {
    hook_event_name: 'PreToolUse', session_id: sessionId,
    tool_use_id: `fixture-${++callSequence}`, tool_name: BROWSER_TOOL,
    tool_input: { ...args, _channel: channel },
  });
  assert.equal(typeof result.hookSpecificOutput.updatedInput?._lease, 'string', 'Host-contract fixture must receive a ticket');
  return result.hookSpecificOutput.updatedInput;
}
async function sdk(t, context) {
  const client = new Client({ name: 'packaged-browser-check', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: executable, args: ['--mcp'], cwd: os.tmpdir(), env: context.env, stderr: 'pipe',
  });
  transport.stderr.on('data', bytes => context.errors.push(bytes.toString('utf8')));
  await client.connect(transport);
  t.after(() => client.close());
  const descriptor = (await client.listTools()).tools.find(tool => tool.name === 'browse');
  assert.ok(descriptor);
  const channel = descriptor.inputSchema.properties._channel.enum[0];
  const call = async (sessionId, args) => client.callTool({
    name: 'browse', arguments: await authorize(context.env, channel, sessionId, args),
  });
  const status = async () => dataOf(await client.callTool({
    name: 'browse', arguments: { action: 'status', _channel: channel },
  }));
  return { client, channel, call, status };
}
async function fixture(t) {
  const state = { count: 0, started: 0, shadowPhase: '', shadowApplies: 0, userAgents: [], nativeResults: [] };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/session-api')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ account: /(?:^|;\s*)fixtureAccount=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '' }));
      return;
    }
    if (req.url === '/') state.userAgents.push(req.headers['user-agent']);
    if (req.url === '/count') { state.count++; res.end('ok'); return; }
    if (req.url === '/started') { state.started++; res.end('ok'); return; }
    if (req.url === '/shadow-state') { res.end(state.shadowPhase); return; }
    if (req.url === '/shadow-applied') { state.shadowApplies++; res.end('ok'); return; }
    if (req.url.startsWith('/native-result?')) {
      state.nativeResults.push(new URL(req.url, 'http://fixture.invalid').searchParams.get('result'));
      res.end('ok'); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/sessions')) {
      res.end('<!doctype html><title>Browser session fixture</title><p id="identity">empty</p>');
      return;
    }
    if (req.url === '/autonomous') {
      res.end(`<!doctype html><meta charset="utf-8"><title>Packaged app verification</title>
        <button id="attach">Attach local fixture</button><input id="file" type="file" hidden>
        <button id="prompt">App confirmation</button><button id="alert">App alert</button>
        <button id="unsupported">Native prompt limitation</button><button id="permission">Test notifications</button><output></output>
        <script>
        const done=value=>{document.querySelector('output').textContent=value;navigator.sendBeacon('/native-result?result='+encodeURIComponent(value),'x')};
        document.querySelector('#attach').onclick=()=>document.querySelector('#file').click();
        document.querySelector('#file').onchange=e=>done(e.target.files[0].name);
        document.querySelector('#prompt').onclick=()=>done(confirm('Packaged fixture approval')?'agent confirmed':'agent dismissed');
        document.querySelector('#alert').onclick=()=>{alert('Packaged fixture alert');done('alert returned')};
        document.querySelector('#unsupported').onclick=()=>{try{prompt('Native prompt')}catch(error){done(error.message)}};
        document.querySelector('#permission').onclick=async()=>done(await Notification.requestPermission());
        </script>`);
      return;
    }
    if (req.url === '/form') {
      res.end(`<!doctype html><title>Packaged run fixture</title><label>Email <input id="email"></label>
        <label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
        <button onclick="navigator.sendBeacon('/count','x');document.querySelector('[role=status]').textContent='Saved '+email.value+' '+plan.value">Save</button>
        <p role="status"></p>`);
      return;
    }
    if (req.url === '/devtools-api') { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('missing'); return; }
    if (req.url === '/devtools') {
      res.end(`<!doctype html><title>Packaged DevTools fixture</title><p>DevTools</p><script>
        window.devtoolsGlobal = { answer: 42 };
        console.error('packaged devtools error');
        fetch('/devtools-api');
        </script>`);
      return;
    }
    if (req.url === '/nested') {
      res.end('<!doctype html><body style="margin:0"><iframe src="/outer" style="position:absolute;left:100px;top:100px;width:700px;height:500px;border:0"></iframe>');
      return;
    }
    if (req.url === '/outer') {
      res.end('<!doctype html><body style="margin:0"><iframe src="/inner" style="position:absolute;left:50px;top:60px;width:400px;height:250px;border:0"></iframe>');
      return;
    }
    if (req.url === '/inner') {
      res.end(`<!doctype html><body style="margin:0"><button style="position:absolute;left:20px;top:20px;width:100px;height:40px"
        onclick="navigator.sendBeacon('/count','x')">Nested</button>`);
      return;
    }
    if (req.url === '/shadow') {
      res.end(`<!doctype html><button onclick="navigator.sendBeacon('/count','x')">Document action</button>
        <div id="shadow"></div><div id="late"></div><script>
        const root=document.querySelector('#shadow').attachShadow({mode:'open'});
        root.innerHTML='<button>Safe</button>';
        root.querySelector('button').addEventListener('click',()=>navigator.sendBeacon('/count','x'));
        let applied='';
        setInterval(async()=>{
          const phase=await (await fetch('/shadow-state')).text();
          if(!phase||phase===applied)return;
          applied=phase;
          if(phase==='rename')root.querySelector('button').textContent='Dangerous';
          if(phase==='attach')document.querySelector('#late').attachShadow({mode:'open'}).innerHTML='<button>Late root</button>';
          navigator.sendBeacon('/shadow-applied','x');
        },35);
        </script>`);
      return;
    }
    res.end(`<!doctype html><title>Local MCP fixture</title><label>Name <input></label>
      <input type="password" value="DO_NOT_EXPORT_PASSWORD">
      <button onclick="document.querySelector('output').textContent=++window.count;navigator.sendBeacon('/count','x')">Count</button>
      <output>0</output><output id="identity"></output><script>window.count=0;document.querySelector('#identity').textContent=navigator.userAgent</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { state, url: `http://127.0.0.1:${server.address().port}/` };
}

test('packaged folder: standard SDK, hook admission, real page, replay/ownership/end isolation and teardown', { timeout: 120000 }, async t => {
  const context = await environment(t);
  const page = await fixture(t);
  const first = await sdk(t, context);
  assert.equal((await first.status()).tabCount, 0);
  const missing = await first.client.callTool({
    name: 'browse', arguments: { action: 'open', url: page.url, _channel: first.channel },
  });
  assert.equal(missing.isError, true);
  assert.equal((await first.status()).tabCount, 0);
  assert.equal(await hook(context.env, {
    hook_event_name: 'PreToolUse', tool_name: 'functions.read', tool_input: {}, session_id: 'other-tool',
  }), null);

  const issued = await authorize(context.env, first.channel, 'owner-a', { action: 'open', url: page.url });
  const opened = await first.client.callTool({ name: 'browse', arguments: issued });
  assert.equal(opened.isError, false, await diagnostic(first, 'owner-a', opened));
  assert.doesNotMatch(page.state.userAgents[0], /Electron\/|IndependentWindowsBrowser\//);
  assert.deepEqual(opened.content.map(part => part.type), ['text'], 'no image unless requested');
  assert.ok(!textOf(opened).includes('DO_NOT_EXPORT_PASSWORD'));
  const tabId = tabOf(opened);
  const readable = await first.call('owner-a', { action: 'observe', tabId, mode: 'text' });
  assert.ok(has(readable, page.state.userAgents[0]), 'Packaged navigator and first HTTP identity must agree');
  const shot = await first.call('owner-a', { action: 'observe', tabId, screenshot: true });
  assert.ok(shot.content.some(part => part.type === 'image' && part.mimeType === 'image/png'));
  assert.match(textOf(shot), /\nview \d+x\d+ scroll \d+\/\d+ points\n/);
  const reference = refOf(opened, 'button', 'Count');
  assert.equal((await first.client.callTool({ name: 'browse', arguments: issued })).isError, true, 'a used ticket is never replayed');
  const clicked = await first.call('owner-a', { action: 'click', tabId, ref: reference });
  assert.equal(clicked.isError, false, textOf(clicked));
  assert.match(textOf(clicked), /^executed click e\d+ tab=t\d+ snap=s\d+ session=ctx\d+ name="Default"\n/);
  await until(() => page.state.count === 1, 'one local HTTP side effect from one browser click');
  // The ref names the same unchanged button; a second click is a new, deliberate input.
  assert.equal((await first.call('owner-a', { action: 'click', tabId, ref: reference })).isError, false);
  await until(() => page.state.count === 2, 'the persistent ref acts once more');
  const foreign = await first.call('owner-b', { action: 'observe', tabId });
  assert.equal(foreign.isError, true);
  assert.match(textOf(foreign), /code=FOREIGN_TAB/);

  const late = await authorize(context.env, first.channel, 'owner-a', { action: 'observe', tabId });
  await hook(context.env, { hook_event_name: 'SessionEnd', session_id: 'owner-a' });
  assert.equal((await first.client.callTool({ name: 'browse', arguments: late })).isError, true);
  const denied = await hook(context.env, {
    hook_event_name: 'PreToolUse', session_id: 'owner-a', tool_use_id: 'after-end', tool_name: BROWSER_TOOL,
    tool_input: { action: 'observe', tabId, _channel: first.channel },
  });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');

  const second = await sdk(t, context);
  const other = await second.call('owner-c', { action: 'open', url: page.url });
  assert.equal(other.isError, false, textOf(other));
  const otherId = tabOf(other);
  await first.client.close();
  assert.equal((await second.call('owner-c', { action: 'observe', tabId: otherId })).isError, false);
  const revoked = await second.call('owner-c', { action: 'revoke' });
  assert.equal(revoked.isError, false, JSON.stringify(dataOf(revoked)));
  assert.equal(dataOf(revoked).processTeardownConfirmed, true);
  assert.equal(dataOf(revoked).physicalDeviceIo, 'NOT_MEASURED');
  assert.equal((await second.status()).state, 'connection-ended');
});

test('packaged agent tool resolves real file, dialog and permission requests without human steps', { timeout: 60000 }, async t => {
  const context = await environment(t);
  const page = await fixture(t);
  const connection = await sdk(t, context);
  const owner = 'autonomous-app-owner';
  const capabilities = (await connection.status()).capabilities;
  assert.equal(capabilities.delegation.mode, 'delegated');
  assert.deepEqual(capabilities.javascriptDialogs.supported, ['alert', 'confirm']);
  assert.match(capabilities.javascriptDialogs.unsupported.prompt, /Electron 44.9.1/);
  assert.deepEqual(new Set(capabilities.filePickers.supported), new Set(['html-file-input']));
  assert.deepEqual(new Set(capabilities.filePickers.unsupported),
    new Set(['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']));
  const opened = await connection.call(owner, { action: 'open', url: page.url + 'autonomous' });
  assert.equal(opened.isError, false, textOf(opened));
  const tabId = tabOf(opened);
  const fixturePath = path.join(context.directory, 'packaged-attachment.txt');
  const worker = await connection.call(owner, {
    action: 'evaluate', tabId, expression: WORKER_PROBE_EXPRESSION,
  });
  assert.equal(worker.isError, false, textOf(worker));
  assert.deepEqual(valueOf(worker), { kind: 'diagnostic-worker-ready', value: 7 });
  await writeFile(fixturePath, 'explicit package test input');
  for (const scenario of [
    { button: 'Attach local fixture', kind: 'file-picker', response: () => ({ files: [fixturePath] }),
      resolution: 'selected', expected: 'packaged-attachment.txt' },
    { button: 'App confirmation', kind: 'javascript-dialog',
      response: request => ({ optionRef: request.options.find(option => option.label === 'Accept').optionRef }),
      resolution: 'resolved', expected: 'agent confirmed' },
    { button: 'App confirmation', kind: 'javascript-dialog',
      response: request => ({ optionRef: request.options.find(option => option.label === 'Dismiss').optionRef }),
      resolution: 'resolved', expected: 'agent dismissed' },
    { button: 'App alert', kind: 'javascript-dialog',
      response: request => ({ optionRef: request.options.find(option => option.label === 'Accept').optionRef }),
      resolution: 'resolved', expected: 'alert returned' },
    { button: 'Test notifications', kind: 'notifications',
      response: request => ({ optionRef: request.options.find(option => option.label === 'Allow').optionRef }),
      resolution: 'allowed', expected: 'granted' },
  ]) {
    const click = await connection.call(owner, { action: 'click', tabId, target: { name: scenario.button, exact: true } });
    // A JS dialog blocks the renderer before the click is acknowledged: the
    // outcome is unknown (uncertain, never replayed). A file chooser or a
    // permission prompt leaves the renderer running: the click is executed.
    if (scenario.kind === 'javascript-dialog') {
      assert.equal(click.isError, true, textOf(click));
      assert.match(textOf(click), /^uncertain click e\d+ tab=t\d+ code=DIALOG_OPEN replaySafe=false session=ctx\d+ name="Default"\n[\s\S]*\nrequest \S+ javascript-dialog/, textOf(click));
    } else assert.equal(click.isError, false, textOf(click));
    const requests = await connection.call(owner, { action: 'requests', tabId });
    assert.equal(requests.isError, false, JSON.stringify(dataOf(requests)));
    const pending = dataOf(requests).pending.filter(request => request.kind === scenario.kind);
    assert.equal(pending.length, 1);
    const request = pending[0];
    const response = await connection.call(owner, { action: 'respond', tabId, requestRef: request.requestRef,
      response: scenario.response(request) });
    assert.equal(response.isError, false, JSON.stringify(dataOf(response)));
    assert.equal(dataOf(response).request.resolution, scenario.resolution, JSON.stringify(dataOf(response)));
    await until(() => page.state.nativeResults.includes(scenario.expected), 'actual site result: ' + scenario.expected);
    const observed = await connection.call(owner, { action: 'observe', tabId });
    assert.equal(observed.isError, false, textOf(observed));
    assert.ok(has(observed, scenario.expected), textOf(observed));
    assert.equal(dataOf(await connection.call(owner, { action: 'list_tabs' })).tabs[0].mode, 'automation');
    assert.equal((await connection.call(owner, { action: 'respond', tabId, requestRef: request.requestRef,
      response: scenario.response(request) })).isError, true);
  }
  const unsupported = await connection.call(owner, { action: 'click', tabId, target: { name: 'Native prompt limitation', exact: true } });
  assert.equal(unsupported.isError, false, textOf(unsupported));
  await until(() => page.state.nativeResults.includes('prompt() is not supported.'), 'actual unsupported native prompt');
  assert.equal(dataOf(await connection.call(owner, { action: 'requests', tabId })).pending.length, 0);
});

test('packaged browser clicks nested frames exactly once; a renamed shadow control retires its ref, an unrelated new root does not', { timeout: 60000 }, async t => {
  const context = await environment(t);
  const page = await fixture(t);
  const connection = await sdk(t, context);
  const owner = 'nested-shadow-owner';
  let nested = await connection.call(owner, { action: 'open', url: page.url + 'nested' });
  assert.equal(nested.isError, false, await diagnostic(connection, owner, nested));
  const nestedTab = tabOf(nested);
  // open settles on the root document; nested frames may still be loading.
  for (let tries = 0; tries < 40 && !/button "Nested"/.test(textOf(nested)); tries++) {
    await delay(50);
    nested = await connection.call(owner, { action: 'observe', tabId: nestedTab });
  }
  const click = await connection.call(owner, { action: 'click', tabId: nestedTab, ref: refOf(nested, 'button', 'Nested') });
  assert.equal(click.isError, false, textOf(click));
  await until(() => page.state.count === 1, 'exactly one effect from the nested frame target');

  const shadowResult = await connection.call(owner, { action: 'open', url: page.url + 'shadow' });
  assert.equal(shadowResult.isError, false, await diagnostic(connection, owner, shadowResult));
  const shadowTab = tabOf(shadowResult);
  const old = refOf(shadowResult, 'button', 'Safe');
  const lightRef = refOf(shadowResult, 'button', 'Document action');
  page.state.shadowPhase = 'rename';
  await until(() => page.state.shadowApplies === 1, 'page-main shadow label mutation applied');
  const renamed = await connection.call(owner, { action: 'click', tabId: shadowTab, ref: old });
  assert.equal(renamed.isError, true, 'A label changed inside an open shadow tree must retire its old ref');
  assert.match(textOf(renamed), /code=STALE_REF/);
  assert.match(textOf(renamed), /dispatched=false/);
  assert.equal(page.state.count, 1, 'No shadow input may be dispatched with the old ref');

  page.state.shadowPhase = 'attach';
  await until(() => page.state.shadowApplies === 2, 'open shadow root attached to an existing connected host');
  const attached = await connection.call(owner, { action: 'click', tabId: shadowTab, ref: lightRef });
  assert.equal(attached.isError, false, 'An unrelated new shadow root leaves the light-DOM ref valid');
  await until(() => page.state.count === 2, 'the unchanged light-DOM button acts once');
});

test('packaged DevTools reads return compact JSON rows without observations or images', { timeout: 60000 }, async t => {
  const context = await environment(t);
  const page = await fixture(t);
  const connection = await sdk(t, context);
  const owner = 'devtools-owner';
  const descriptor = (await connection.client.listTools()).tools.find(tool => tool.name === 'browse');
  for (const action of ['console', 'network', 'inspect', 'performance']) assert.ok(descriptor.inputSchema.properties.action.enum.includes(action));
  assert.deepEqual(descriptor.inputSchema.properties.world.enum, ['isolated', 'page']);
  const opened = await connection.call(owner, { action: 'open', url: page.url + 'devtools' });
  assert.equal(opened.isError, false, await diagnostic(connection, owner, opened));
  const tabId = tabOf(opened);
  const textOnly = result => {
    assert.equal(result.isError, false, JSON.stringify(dataOf(result)));
    assert.deepEqual(result.content.map(part => part.type), ['text']);
    const body = dataOf(result);
    assert.equal(['frames', 'screenshot', 'observation'].some(key => key in body), false);
    return body;
  };
  const consoleRows = await until(async () => {
    const body = textOnly(await connection.call(owner, { action: 'console', tabId, filter: 'level:error' }));
    return body.rows?.some(row => row.msg === 'packaged devtools error') && body;
  }, 'packaged console error');
  assert.ok(consoleRows.next > 0);
  const network = await until(async () => {
    const body = textOnly(await connection.call(owner, { action: 'network', tabId, filter: 'status:4xx' }));
    return body.rows?.length && body;
  }, 'packaged 404 row');
  assert.deepEqual(network.rows.map(row => [row.u.endsWith('/devtools-api'), row.s]), [[true, 404]]);
  const read = textOnly(await connection.call(owner, { action: 'console', tabId, expression: 'window.devtoolsGlobal.answer' }));
  assert.deepEqual([read.type, read.value], ['number', 42]);
  const refused = await connection.call(owner, { action: 'console', tabId, expression: 'window.devtoolsGlobal.answer = 1' });
  assert.equal(refused.isError, true);
  assert.equal(dataOf(refused).code, 'SIDE_EFFECT');
  const main = await connection.call(owner, { action: 'evaluate', tabId, world: 'page', expression: 'window.devtoolsGlobal.answer + 1' });
  assert.equal(valueOf(main), 43);
  const performance = textOnly(await connection.call(owner, { action: 'performance', tabId }));
  assert.ok(performance.m.nodes > 0);
});

test('packaged run executes a multi-step form flow in one call with exactly one submit', { timeout: 60000 }, async t => {
  const context = await environment(t);
  const page = await fixture(t);
  const connection = await sdk(t, context);
  const owner = 'run-owner';
  const descriptor = (await connection.client.listTools()).tools.find(tool => tool.name === 'browse');
  assert.ok(descriptor.inputSchema.properties.action.enum.includes('run'));
  const opened = await connection.call(owner, { action: 'open', url: page.url + 'form' });
  assert.equal(opened.isError, false, await diagnostic(connection, owner, opened));
  const tabId = tabOf(opened);
  const ran = await connection.call(owner, {
    action: 'run', tabId, script: `
      await page.getByLabel('Email').fill('qa@example.test');
      await page.getByRole('combobox', { name: 'Plan' }).selectOption('pro');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForText('Saved qa@example.test pro');
      return await page.getByRole('status').innerText();`,
  });
  assert.equal(ran.isError, false, textOf(ran));
  assert.deepEqual(ran.content.map(part => part.type), ['text']);
  assert.match(textOf(ran), /^executed run tab=t\d+ .*\nrun ok \d+ steps/);
  assert.match(textOf(ran), /\ne\d+ combobox "Plan" ="Pro"/, 'a label wrapping its select names it without the options');
  assert.match(textOf(ran), /\nreturn "Saved qa@example.test pro"/);
  assert.equal(page.state.count, 1);
  const escape = await connection.call(owner, { action: 'run', tabId, script: `
    let net = 'blocked';
    try { await fetch(${JSON.stringify(page.url + 'count')}); net = 'open'; } catch {}
    return typeof require + ' ' + typeof process + ' ' + net;` });
  assert.match(textOf(escape), /\nreturn "undefined undefined blocked"/, textOf(escape));
  assert.equal(page.state.count, 1);
});

test('closing the last tab keeps the packaged connection: the same channel opens a new page', { timeout: 60000 }, async t => {
  const context = await environment(t);
  const page = await fixture(t);
  const connection = await sdk(t, context);
  const owner = 'last-tab-owner';
  const opened = await connection.call(owner, { action: 'open', url: page.url });
  assert.equal(opened.isError, false, await diagnostic(connection, owner, opened));
  const closed = await connection.call(owner, { action: 'close_tab', tabId: tabOf(opened) });
  assert.equal(closed.isError, false, textOf(closed));
  // Electron would quit an app whose last window closed within this pause.
  await delay(1500);
  assert.equal((await connection.status()).state, 'connected');
  const again = await connection.call(owner, { action: 'open', url: page.url });
  assert.equal(again.isError, false, await diagnostic(connection, owner, again));
});

async function raw(t, context) {
  const child = spawn(executable, ['--mcp'], {
    env: context.env, cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true;
    for (const waiter of pending.values()) waiter.reject(new Error(`Packaged MCP exited (${code ?? signal})`));
    pending.clear();
    resolve({ code, signal });
  }));
  child.once('error', error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
  child.stderr.on('data', bytes => context.errors.push(bytes.toString('utf8')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    const settle = pending.get(response.id);
    if (settle) { pending.delete(response.id); settle.resolve(response); }
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (id, method, params) => new Promise((resolve, reject) => {
    assert.ok(!pending.has(id));
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  t.after(async () => {
    if (!exited) { child.stdin.end(); await Promise.race([exit, delay(1000)]); }
    if (!exited) child.kill(); // Own live launcher; its job owns only this test's descendants.
    await exit;
    lines.close();
  });
  const initialized = await request('initialize', 'initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {},
    clientInfo: { name: 'raw-protocol-check', version: '1.0.0' },
  });
  assert.ok(initialized.result?.protocolVersion, JSON.stringify(initialized));
  send({ method: 'notifications/initialized' });
  return { child, request, send, exit };
}

test('packaged stdio EOF gracefully exits the owned launcher without a parent force-kill', { timeout: 40000 }, async t => {
  const context = await environment(t);
  const connection = await raw(t, context);
  connection.child.stdin.end();
  const result = await Promise.race([connection.exit, delay(5000).then(() => null)]);
  assert.ok(result, 'MCP stdin EOF must close its companion and exit; a parent force-kill is not graceful shutdown');
  assert.equal(result.code, 0, JSON.stringify(result));
});

// A host may terminate the launcher while it is still creating its child. The
// child is created inside the launcher's job, so it ends with the launcher.
// Probabilistic: a launcher that assigned the job after CreateProcess left a
// suspended child after about one termination in twenty.
test('a launcher terminated during child creation leaves no child behind', { timeout: 120000 }, async t => {
  const context = await connectionEnvironment(t);
  const launchers = new Set();
  const leftovers = async () => (await processes('electron.exe')).filter(p => launchers.has(p.ParentProcessId));
  try {
    for (let run = 0; run < 48; run++) {
      const child = spawn(executable, ['--mcp'], { env: context.env, stdio: 'ignore', windowsHide: true });
      const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      launchers.add(child.pid);
      await delay(run % 24);
      child.kill();
      await exited;
    }
    await delay(1000);
    assert.deepEqual(await leftovers(), [], 'Every child of a terminated launcher must end with its job');
  } finally {
    for (const left of await leftovers()) { try { process.kill(left.ProcessId); } catch {} }
  }
});

for (const requestId of [0, 17]) test(`JSON-RPC cancellation id ${requestId} aborts browser execution without a reply or input replay`, { timeout: 45000 }, async t => {
  const context = await environment(t);
  const page = await fixture(t);
  const connection = await raw(t, context);
  const tools = await connection.request('tools', 'tools/list', {});
  const channel = tools.result.tools[0].inputSchema.properties._channel.enum[0];
  const open = await connection.request('open', 'tools/call', {
    // A page without a filled sensitive field: page code is refused beside one.
    name: 'browse', arguments: await authorize(context.env, channel, 'zero-owner', { action: 'open', url: page.url + 'form' }),
  });
  assert.equal(open.result.isError, false, JSON.stringify(open.error ?? textOf(open.result)));
  const tabId = tabOf(open.result);
  let delayedResponse;
  let delayedError;
  const delayed = connection.request(requestId, 'tools/call', {
    name: 'browse', arguments: await authorize(context.env, channel, 'zero-owner', {
      action: 'evaluate', tabId,
      expression: '(()=>{navigator.sendBeacon("/started","x");const end=Date.now()+12000;while(Date.now()<end){};return "finished"})()',
    }),
  });
  void delayed.then(response => { delayedResponse = response; }, error => { delayedError = error; });
  await until(() => page.state.started === 1, 'delayed browser evaluation actually dispatched');
  connection.send({ method: 'notifications/cancelled', params: { requestId, reason: 'fixture cancellation' } });
  const independent = await connection.request('independent', 'tools/list', {});
  assert.ok(independent.result.tools.length, 'Cancellation must not affect an independent request');
  const observed = connection.request('after-cancel', 'tools/call', {
    name: 'browse', arguments: await authorize(context.env, channel, 'zero-owner', { action: 'observe', tabId }),
  });
  const result = await Promise.race([observed, delay(4000).then(() => null)]);
  assert.ok(result && !result.error && !result.result.isError, 'The cancelled browser execution must drain before the next observation');
  assert.equal(delayedResponse, undefined, 'The SDK must suppress a response to a cancelled request');
  assert.equal(delayedError, undefined);
  assert.equal(page.state.started, 1, 'Cancellation must not replay the dispatched browser evaluation');
});

test('connection authority (plain MCP registration): no hooks or key on disk, own tickets, the same refusals, one caller per connection', { timeout: 90000 }, async t => {
  const context = await connectionEnvironment(t);
  const page = await fixture(t);
  const first = await plainClient(t, context);
  const instructions = first.client.getInstructions();
  assert.ok(instructions && instructions.length <= 4096 && !instructions.includes('_channel'), instructions);
  assert.equal(Object.hasOwn(first.descriptor.inputSchema.properties, '_lease'), false);
  assert.equal(Object.hasOwn(first.descriptor.inputSchema.properties, '_channel'), false);
  const status = dataOf(await first.call({ action: 'status' }));
  assert.equal(status.tabCount, 0);
  assert.equal(status.capabilities.delegation.mode, 'delegated');
  const directory = path.join(context.directory, 'connections', first.channel);
  await assert.rejects(stat(path.join(directory, 'endpoint.json')), { code: 'ENOENT' }, 'no hooks, so the key stays in memory');

  const opened = await first.call({ action: 'open', url: page.url });
  assert.equal(opened.isError, false, textOf(opened));
  assert.ok(!textOf(opened).includes('DO_NOT_EXPORT_PASSWORD'));
  const tabId = tabOf(opened);
  const count = refOf(opened, 'button', 'Count');
  const forged = await first.call({ action: 'click', tabId, ref: count, _lease: 'model-supplied' });
  assert.equal(forged.isError, true);
  assert.match(textOf(forged), /^not-executed click e\d+ tab=t\d+ code=INVALID_ARGUMENT dispatched=false\n/);
  // A host that kept the schema of an earlier server process still sends that process's _channel.
  const kept = await first.call({ action: 'list_tabs', _channel: randomUUID() });
  assert.deepEqual(dataOf(kept).tabs.map(tab => tab.tabId), [tabId], 'the connection is the caller, whatever _channel arrives');
  const clicked = await first.call({ action: 'click', tabId, ref: count });
  assert.equal(clicked.isError, false, textOf(clicked));
  await until(() => page.state.count === 1, 'exactly one local HTTP side effect from one click');
  // Concurrent calls each take their own ticket.
  const [observed, listed] = await Promise.all([first.call({ action: 'observe', tabId }), first.call({ action: 'list_tabs' })]);
  assert.equal(observed.isError, false, textOf(observed));
  assert.deepEqual(dataOf(listed).tabs.map(tab => tab.tabId), [tabId]);
  assert.equal((await readdir(path.join(directory, 'profiles'))).length, 1, 'one caller: one profile per connection');

  // Another registration session is another connection: its own companion, tabs and profile.
  const second = await plainClient(t, context);
  assert.notEqual(second.channel, first.channel);
  assert.deepEqual(second.descriptor, first.descriptor, 'the schema names no connection: a host may keep it across a server restart');
  assert.equal(second.client.getInstructions(), instructions);
  assert.deepEqual(dataOf(await second.call({ action: 'list_tabs' })).tabs, []);
  const foreign = await second.call({ action: 'click', tabId, ref: count });
  assert.equal(foreign.isError, true, textOf(foreign));
  assert.equal(page.state.count, 1, 'nothing reached the first connection\'s page');
  const closed = await first.call({ action: 'close_tab', tabId });
  assert.equal(closed.isError, false, textOf(closed));
});

test('packaged connection authority: named temporary sessions preserve the default login and attribute DevTools', { timeout: 90000 }, async t => {
  const context = await connectionEnvironment(t);
  const page = await fixture(t);
  const { call, descriptor } = await plainClient(t, context);
  for (const action of ['create_session', 'list_sessions', 'close_session']) assert.ok(descriptor.inputSchema.properties.action.enum.includes(action));
  assert.equal(descriptor.inputSchema.properties.sessionId.type, 'string');
  const openedA = await call({ action: 'open', url: page.url + 'sessions/a' });
  assert.equal(openedA.isError, false, textOf(openedA));
  const a = tabOf(openedA);
  const initial = dataOf(await call({ action: 'list_sessions' })).sessions;
  const defaultId = initial.find(session => session.isDefault).sessionId;
  const write = async (tabId, marker) => {
    const result = await call({ action: 'evaluate', tabId, world: 'page', expression: `(async()=>{
      document.cookie='fixtureAccount=${marker}; Path=/';localStorage.setItem('identity','${marker}');
      window.fixtureIdentity='${marker}';document.querySelector('#identity').textContent='${marker}';
      console.log('SESSION_EVENT ${marker}');await fetch('/session-api?${marker}');return '${marker}';})()` });
    assert.equal(result.isError, false, textOf(result));
  };
  const read = async tabId => {
    const result = await call({ action: 'evaluate', tabId, expression: '({cookie:document.cookie,local:localStorage.getItem("identity")})' });
    assert.equal(result.isError, false, textOf(result));
    return valueOf(result);
  };
  await write(a, 'A');
  const created = dataOf(await call({ action: 'create_session', name: 'Reference B' }));
  assert.equal(created.temporary, true);
  assert.equal(created.isolated, true);
  const openedB = await call({ action: 'open', sessionId: created.sessionId, url: page.url + 'sessions/b' });
  assert.equal(openedB.isError, false, textOf(openedB));
  assert.match(textOf(openedB), new RegExp(`session=${created.sessionId} name="Reference B"`));
  const b = tabOf(openedB);
  assert.deepEqual(await read(b), { cookie: '', local: null });
  await write(b, 'B');
  assert.deepEqual(await read(a), { cookie: 'fixtureAccount=A', local: 'A' });
  const sibling = await call({ action: 'open', sessionId: created.sessionId, url: page.url + 'sessions/b2' });
  const b2 = tabOf(sibling);
  assert.deepEqual(await read(b2), { cookie: 'fixtureAccount=B', local: 'B' });
  for (const [tabId, sessionId, marker] of [[a, defaultId, 'A'], [b, created.sessionId, 'B']]) {
    const observed = await call({ action: 'observe', tabId });
    assert.ok(has(observed, marker), textOf(observed));
    const console = dataOf(await call({ action: 'console', tabId, filter: 'SESSION_EVENT' }));
    assert.deepEqual(console.rows.map(row => row.msg), [`SESSION_EVENT ${marker}`]);
    assert.equal(console.sessionId, sessionId);
    const network = await until(async () => {
      const result = dataOf(await call({ action: 'network', tabId, filter: '/session-api' }));
      return result.rows?.some(row => row.s === 200) && result;
    }, 'session network recorded');
    assert.equal(network.sessionId, sessionId);
    const body = dataOf(await call({ action: 'network', tabId, id: network.rows[0].id, body: true }));
    assert.deepEqual(JSON.parse(body.body), { account: marker });
    const inspected = dataOf(await call({ action: 'inspect', tabId, target: { selector: '#identity' } }));
    assert.equal(inspected.sessionId, sessionId);
  }
  const listed = dataOf(await call({ action: 'list_tabs' })).tabs;
  assert.deepEqual(listed.map(tab => [tab.tabId, tab.sessionId]), [[a, defaultId], [b, created.sessionId], [b2, created.sessionId]]);
  assert.equal(listed[1].sessionName, 'Reference B');
  assert.ok(listed.every(tab => tab.returnFailure === null), 'MCP tab metadata carries the return diagnostic state');
  const closed = dataOf(await call({ action: 'close_session', sessionId: created.sessionId }));
  assert.equal(closed.cleanupComplete, true, JSON.stringify(closed));
  assert.deepEqual(new Set(closed.closedTabIds), new Set([b, b2]));
  assert.deepEqual(await read(a), { cookie: 'fixtureAccount=A', local: 'A' });
  assert.equal(dataOf(await call({ action: 'close_session', sessionId: defaultId })).code, 'DEFAULT_SESSION');
  assert.equal((await call({ action: 'open', sessionId: created.sessionId, url: page.url })).isError, true);
  const next = dataOf(await call({ action: 'create_session', name: 'Reference B' }));
  assert.notEqual(next.sessionId, created.sessionId);
  const fresh = await call({ action: 'open', sessionId: next.sessionId, url: page.url + 'sessions/fresh' });
  assert.deepEqual(await read(tabOf(fresh)), { cookie: '', local: null });
});

test('packaged hook authority: browser session selectors cannot change caller identity or a ticket digest', { timeout: 60000 }, async t => {
  const context = await environment(t);
  const page = await fixture(t);
  const connection = await sdk(t, context);
  const owner = 'session-owner';
  const created = dataOf(await connection.call(owner, { action: 'create_session', name: 'Owned session' }));
  const defaultId = dataOf(await connection.call(owner, { action: 'list_sessions' })).sessions.find(session => session.isDefault).sessionId;
  const args = { action: 'open', sessionId: created.sessionId, url: page.url + 'sessions/owned' };
  const authorized = await authorize(context.env, connection.channel, owner, args);
  const tampered = await connection.client.callTool({ name: 'browse', arguments: { ...authorized, sessionId: defaultId } });
  assert.equal(tampered.isError, true, textOf(tampered));
  assert.deepEqual(dataOf(await connection.call(owner, { action: 'list_tabs' })).tabs, []);
  const foreign = await connection.call('other-caller', args);
  assert.equal(foreign.isError, true);
  assert.match(textOf(foreign), /FOREIGN_SESSION/);
  const close = dataOf(await connection.call('other-caller', { action: 'close_session', sessionId: created.sessionId }));
  assert.equal(close.code, 'FOREIGN_SESSION');
  const opened = await connection.call(owner, args);
  assert.equal(opened.isError, false, textOf(opened));
  const foreignTab = await connection.call('other-caller', { action: 'observe', tabId: tabOf(opened) });
  assert.equal(foreignTab.isError, true);
  assert.match(textOf(foreignTab), /FOREIGN_TAB/);
  assert.equal(dataOf(await connection.call(owner, { action: 'close_session', sessionId: created.sessionId })).cleanupComplete, true);
});

test('connection authority: stdio EOF exits the owned launcher gracefully', { timeout: 40000 }, async t => {
  const context = await connectionEnvironment(t);
  const connection = await raw(t, context);
  const tools = await connection.request('tools', 'tools/list', {});
  assert.equal(Object.hasOwn(tools.result.tools[0].inputSchema.properties, '_lease'), false);
  connection.child.stdin.end();
  const result = await Promise.race([connection.exit, delay(5000).then(() => null)]);
  assert.ok(result, 'MCP stdin EOF must close its companion and exit');
  assert.equal(result.code, 0, JSON.stringify(result));
});

test('a server without a valid authority and data root refuses to start and spawns no companion', { timeout: 60000 }, async t => {
  const context = await environment(t);
  const base = { ...context.env };
  delete base.MIXDOG_PLUGIN_DATA;
  delete base.MIXDOG_PLUGIN_ROOT;
  const data = path.join(context.directory, 'refused');
  for (const [env, pattern] of [
    [base, /MIXDOG_PLUGIN_DATA is required/],
    [{ ...base, WB_AUTHORITY: 'connection' }, /WB_DATA_DIR must be an absolute directory/],
    [{ ...base, WB_AUTHORITY: 'connection', WB_DATA_DIR: 'relative-data' }, /WB_DATA_DIR must be an absolute directory/],
    [{ ...base, WB_AUTHORITY: 'hooks', WB_DATA_DIR: data, MIXDOG_PLUGIN_DATA: data }, /WB_AUTHORITY must be hook or connection/],
  ]) {
    const child = spawn(executable, ['--mcp'], { env, cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdin.end();
    const code = await Promise.race([
      new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }),
      delay(20000).then(() => { child.kill(); return 'timeout'; }),
    ]);
    assert.notEqual(code, 0, stderr);
    assert.notEqual(code, 'timeout', stderr);
    assert.match(stderr, pattern);
  }
  await assert.rejects(stat(path.join(data, 'connections')), { code: 'ENOENT' }, 'no connection was allocated');
});
