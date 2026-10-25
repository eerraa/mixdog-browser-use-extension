import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs, pageURL, addressURL, matchesTarget } from '../../src/shared/contract.mjs';

test('strict action shapes exclude model authority and tool approval/resume aliases', () => {
  for (const action of ['approve', 'resume', 'stop', 'new_tab', '__proto__']) {
    assert.throws(() => validateArgs({ action }), /Unknown browser action/);
  }
  for (const field of ['sessionId', 'caller', 'callId', 'userGesture']) {
    assert.throws(() => validateArgs({ action: 'open', url: 'https://example.invalid', [field]: 'forged' }), /Unexpected argument/);
  }
  assert.throws(() => validateArgs({ action: 'click', tabId: 'tab', ref: 'e1', target: { name: 'x' } }), /exactly one/);
  assert.throws(() => validateArgs({ action: 'fill', tabId: 'tab', point: { x: 0, y: 0, snapshotId: 's' }, text: 'x' }), /Unexpected/);
  assert.throws(() => validateArgs({ action: 'permissions', tabId: 'tab', decision: 'approve' }), /Unexpected/);
  assert.throws(() => validateArgs({ action: 'handle_dialog', tabId: 'tab', accept: 'yes' }), /boolean/);
  assert.throws(() => validateArgs({ action: 'respond', tabId: 'tab', requestRef: 'r', response: { approved: true } }), /Invalid native response/);
  assert.throws(() => validateArgs({ action: 'respond', tabId: 'tab', requestRef: 'r', response: { optionRef: 'o', cancel: true } }), /Invalid native response/);
});

test('every public action has a bounded explicit accepted argument shape', () => {
  const target = { role: 'button', name: 'Continue', exact: true, frame: 'e3' };
  const actions = [
    { action: 'status' }, { action: 'open', url: 'http://127.0.0.1:9000' },
    { action: 'open', url: 'http://127.0.0.1:9000', screenshot: true, snapshot: 'none' },
    { action: 'navigate', tabId: 't1', url: 'https://example.invalid', snapshot: 'full' },
    ...['observe', 'close_tab', 'hide', 'show', 'downloads', 'handoff', 'permissions', 'requests'].map(action => ({ action, tabId: 't1' })),
    { action: 'observe', tabId: 't1', mode: 'full', depth: 3, screenshot: true },
    { action: 'observe', tabId: 't1', mode: 'text' }, { action: 'observe', tabId: 't1', find: 'Sign in' },
    { action: 'observe', tabId: 't1', scope: 'e12', depth: 0 },
    { action: 'observe', tabId: 't1', wait: { text: 'Saved', timeoutMs: 10000 } },
    { action: 'observe', tabId: 't1', wait: { gone: 'Loading' } }, { action: 'observe', tabId: 't1', wait: { url: '/done' } },
    { action: 'list_tabs' }, { action: 'revoke' },
    { action: 'click', tabId: 't1', target },
    { action: 'click', tabId: 't1', point: { x: 10, y: 10, snapshotId: 's4' }, screenshot: true },
    { action: 'click', tabId: 't1', ref: 'e7', snapshot: 'diff' },
    { action: 'fill', tabId: 't1', ref: 'e1', text: '' },
    { action: 'type', tabId: 't1', target: { selector: '#field' }, text: 'a' },
    { action: 'press', tabId: 't1', ref: 'e1', key: 'Enter' },
    { action: 'select', tabId: 't1', ref: 'e1', values: ['one'] },
    { action: 'scroll', tabId: 't1', ref: 'e1', deltaX: 0, deltaY: 200 },
    { action: 'read', tabId: 't1' }, { action: 'read', tabId: 't1', ref: 'e1' },
    { action: 'evaluate', tabId: 't1', expression: 'document.title', frame: 'e3' },
    { action: 'upload', tabId: 'tab', target: { selector: 'input[type=file]' }, files: ['C:\\fixture.txt'] },
    { action: 'handle_dialog', tabId: 'tab', accept: false, promptText: '' },
    { action: 'respond', tabId: 'tab', requestRef: 'r', response: { optionRef: 'o', text: 'fixture' } },
    { action: 'respond', tabId: 'tab', requestRef: 'r', response: { files: ['C:\\fixture.txt'] } },
    { action: 'respond', tabId: 'tab', requestRef: 'r', response: { cancel: true } },
    { action: 'evaluate', tabId: 'tab', expression: 'window.app', world: 'page' },
    { action: 'console', tabId: 'tab' }, { action: 'console', tabId: 'tab', since: 4, filter: 'level:error boom', limit: 100 },
    { action: 'console', tabId: 'tab', expression: 'window.app.state', frame: 'e3', limit: 65536 },
    { action: 'network', tabId: 'tab', since: 0, filter: 'is:failed', limit: 5 },
    { action: 'network', tabId: 'tab', id: 'n1' }, { action: 'network', tabId: 'tab', id: 'n1', body: true, limit: 20000 },
    { action: 'inspect', tabId: 'tab', ref: 'e1' }, { action: 'inspect', tabId: 'tab', ref: 'e1', values: ['color', '--accent'] },
    { action: 'inspect', tabId: 'tab', target: { selector: '#hidden', frame: 'e3' } },
    { action: 'performance', tabId: 'tab' },
    { action: 'run', script: 'return 1;' }, { action: 'run', tabId: 't1', script: 'await page.find("x");', timeoutMs: 100000 },
  ];
  for (const args of actions) assert.equal(validateArgs(args), args);
  for (const args of [
    { action: 'click', tabId: 't', ref: 'r' }, { action: 'click', tabId: 't', ref: 'e0' },
    { action: 'click', tabId: 't', target: { name: 'x', frameId: 'frame' } }, { action: 'click', tabId: 't', target: { name: 'x', frame: 'f' } },
    { action: 'evaluate', tabId: 't', expression: 'x', frameId: 'e3' }, { action: 'evaluate', tabId: 't', expression: 'x', frame: 'frame' },
    { action: 'click', tabId: 't', ref: 'e1', screenshot: 'yes' }, { action: 'click', tabId: 't', ref: 'e1', snapshot: 'all' },
    { action: 'read', tabId: 't', screenshot: true }, { action: 'observe', tabId: 't', snapshot: 'diff' },
    { action: 'observe', tabId: 't', mode: 'html' }, { action: 'observe', tabId: 't', depth: 21 }, { action: 'observe', tabId: 't', find: '' },
    { action: 'observe', tabId: 't', scope: 'body' }, { action: 'observe', tabId: 't', find: 'x', scope: 'e1' },
    { action: 'observe', tabId: 't', mode: 'text', find: 'x' },
    { action: 'observe', tabId: 't', wait: {} }, { action: 'observe', tabId: 't', wait: { text: 'a', gone: 'b' } },
    { action: 'observe', tabId: 't', wait: { text: 'a', timeoutMs: 10001 } }, { action: 'observe', tabId: 't', wait: { selector: '#x' } },
    { action: 'evaluate', tabId: 't', expression: 'x', world: 'main' },
    { action: 'console', tabId: 't', frame: 'e1' }, { action: 'console', tabId: 't', expression: 'x', since: 1 },
    { action: 'console', tabId: 't', limit: 101 }, { action: 'console', tabId: 't', since: -1 },
    { action: 'network', tabId: 't', body: true }, { action: 'network', tabId: 't', id: 'n1', filter: 'x' },
    { action: 'network', tabId: 't', id: 'n1', limit: 5 }, { action: 'network', tabId: 't', id: 'n1', body: true, limit: 70000 },
    { action: 'network', tabId: 't', expression: 'x' }, { action: 'performance', tabId: 't', limit: 5 },
    { action: 'inspect', tabId: 't' }, { action: 'inspect', tabId: 't', target: { name: 'x' } },
    { action: 'inspect', tabId: 't', target: { selector: '#x', role: 'button' } },
    { action: 'inspect', tabId: 't', ref: 'e1', target: { selector: '#x' } },
    { action: 'inspect', tabId: 't', ref: 'e1', values: ['color;x'] }, { action: 'inspect', tabId: 't', ref: 'e1', values: [] },
    // find takes words: whitespace and /regex/ forms are refused before any matching.
    { action: 'observe', tabId: 't', find: '   ' }, { action: 'observe', tabId: 't', find: '/(a+)+$/' }, { action: 'observe', tabId: 't', find: '/x/i' },
    { action: 'run', script: '' }, { action: 'run', script: '  ' }, { action: 'run', script: 'x'.repeat(100001) },
    { action: 'run', script: '1', timeoutMs: 999 }, { action: 'run', script: '1', timeoutMs: 100001 }, { action: 'run', script: '1', tabId: '' },
    { action: 'run', script: '1', url: 'http://x.test/' },
  ]) assert.throws(() => validateArgs(args), error => error.code === 'INVALID_ARGUMENT', JSON.stringify(args));
  assert.throws(() => validateArgs({ action: 'scroll', tabId: 't', ref: 'e1', deltaX: 0, deltaY: Infinity }), /Bounded/);
  assert.throws(() => validateArgs({ action: 'press', tabId: 't', ref: 'e1', key: 'Control+A' }), /Unsupported key/);
});

test('unsafe schemes, credential URLs and non-finite coordinates fail closed', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/private', 'data:text/html,x', 'https://u:p@example.invalid']) {
    assert.throws(() => pageURL(url), /HTTP/);
  }
  assert.equal(pageURL('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.throws(() => validateArgs({ action: 'click', tabId: 't', point: { x: NaN, y: 0, snapshotId: 's' } }), /finite/);
  assert.throws(() => validateArgs({ action: 'click', tabId: 't', point: { x: 0, y: 0 } }), /snapshotId/);
});

test('address bar text navigates only to credential-free HTTP(S); bare hosts default to HTTPS except loopback', () => {
  for (const [typed, url] of [
    ['example.com', 'https://example.com/'], ['  example.com/path?q=1  ', 'https://example.com/path?q=1'],
    ['http://example.com', 'http://example.com/'], ['HTTPS://Example.com/A', 'https://example.com/A'],
    ['localhost:5173/app', 'http://localhost:5173/app'], ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['[::1]:3000', 'http://[::1]:3000/'], ['localhost.example.com', 'https://localhost.example.com/'],
  ]) assert.equal(addressURL(typed), url, typed);
  for (const typed of ['', '   ', 'two words', 'javascript:alert(1)', 'file:///C:/private', 'ftp://example.com',
    'data:text/html,x', 'https://u:p@example.com', 'u:p@example.com', null, 42]) assert.equal(addressURL(typed), null, String(typed));
});

test('semantic filtering is explicit, frame-scoped, and does not resolve ambiguity by ranking', () => {
  const entries = [{ role: 'button', name: 'Save changes', frameId: 'one' }, { role: 'button', name: 'Save changes', frameId: 'two' }];
  assert.equal(entries.filter(e => matchesTarget(e, { name: 'save' })).length, 2);
  assert.deepEqual(entries.filter(e => matchesTarget(e, { role: 'button', name: 'Save changes', exact: true, frameId: 'two' })), [entries[1]]);
  assert.equal(entries.filter(e => matchesTarget(e, { name: 'save changes', exact: true })).length, 0);
});

test('text results carry the status line and isError follows the disposition; JSON actions stay JSON', async () => {
  const { toolResult, errorResult } = await import('../../src/mcp/tool.mjs');
  const page = toolResult({ action: 'click', disposition: 'executed', tabId: 't1', ref: 'e7', snapshotId: 's3', text: 'diff s2→s3 +0 ~1 -0\n~ e7 button "Saved"' }, 'click');
  assert.deepEqual(page, { isError: false, content: [{ type: 'text', text: 'executed click e7 tab=t1 snap=s3\ndiff s2→s3 +0 ~1 -0\n~ e7 button "Saved"' }] });
  assert.equal(toolResult({ action: 'click', disposition: 'executed', tabId: 't1', observed: false, cause: 'ROOT_UNAVAILABLE', replaySafe: false }, 'click').isError, false);
  assert.equal(toolResult({ action: 'evaluate', disposition: 'executed', tabId: 't1', code: 'PAGE_SCRIPT_ERROR' }, 'evaluate').isError, true);
  assert.equal(toolResult({ action: 'click', disposition: 'uncertain', tabId: 't1', replaySafe: false }, 'click').isError, true);
  const image = toolResult({ action: 'observe', disposition: 'observed', tabId: 't1', screenshot: { mimeType: 'image/png', data: 'AAAA' } }, 'observe');
  assert.deepEqual(image.content[1], { type: 'image', mimeType: 'image/png', data: 'AAAA' });
  for (const action of ['status', 'list_tabs', 'requests', 'permissions', 'console', 'network', 'inspect', 'performance']) {
    const result = toolResult({ tabId: 't1', rows: [] }, action);
    assert.deepEqual(JSON.parse(result.content[0].text), { tabId: 't1', rows: [] }, action);
    assert.equal(result.isError, false);
  }
  const stale = Object.assign(new Error('e4 link "Help" was removed; observe again'), {
    code: 'STALE_REF', requestedInputDispatched: false, preparation: 'none', tabId: 't1',
  });
  assert.deepEqual(errorResult(stale, { action: 'click', tabId: 't1', ref: 'e4' }), { isError: true, content: [{ type: 'text',
    text: 'not-executed click e4 tab=t1 code=STALE_REF dispatched=false\nreason e4 link "Help" was removed; observe again' }] });
  const read = JSON.parse(errorResult(Object.assign(new Error('refused'), { code: 'SIDE_EFFECT' }), { action: 'console', tabId: 't1' }).content[0].text);
  assert.deepEqual([read.disposition, read.code], ['failed-or-unknown', 'SIDE_EFFECT']);
  assert.match(errorResult(Object.assign(new Error('paused'), { code: 'PRIVATE_HANDOFF' }), { action: 'observe', tabId: 't1' }).content[0].text,
    /^failed observe tab=t1 code=PRIVATE_HANDOFF\nreason paused$/);
});
