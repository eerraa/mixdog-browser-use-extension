import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs, pageURL, matchesTarget, sameCheckpoint } from '../../src/browser/contract.mjs';

test('strict action shapes exclude model authority and tool approval/resume aliases', () => {
  for (const action of ['approve', 'resume', 'stop', 'new_tab', '__proto__']) {
    assert.throws(() => validateArgs({ action }), /Unknown browser action/);
  }
  for (const field of ['sessionId', 'caller', 'callId', 'userGesture']) {
    assert.throws(() => validateArgs({ action: 'open', url: 'https://example.invalid', [field]: 'forged' }), /Unexpected argument/);
  }
  assert.throws(() => validateArgs({ action: 'click', tabId: 'tab', ref: 'r', target: { name: 'x' } }), /exactly one/);
  assert.throws(() => validateArgs({ action: 'fill', tabId: 'tab', point: { x: 0, y: 0, snapshotId: 's' }, text: 'x' }), /Unexpected/);
  assert.throws(() => validateArgs({ action: 'permissions', tabId: 'tab', decision: 'approve' }), /Unexpected/);
  assert.throws(() => validateArgs({ action: 'handle_dialog', tabId: 'tab', accept: 'yes' }), /boolean/);
  assert.throws(() => validateArgs({ action: 'respond', tabId: 'tab', requestRef: 'r', response: { approved: true } }), /Invalid native response/);
  assert.throws(() => validateArgs({ action: 'respond', tabId: 'tab', requestRef: 'r', response: { optionRef: 'o', cancel: true } }), /Invalid native response/);
});

test('every public action has a bounded explicit accepted argument shape', () => {
  const target = { role: 'button', name: 'Continue', exact: true, frameId: 'frame' };
  const actions = [
    { action: 'status' }, { action: 'open', url: 'http://127.0.0.1:9000' },
    { action: 'navigate', tabId: 'tab', url: 'https://example.invalid' },
    ...['observe', 'close_tab', 'hide', 'show', 'downloads', 'handoff', 'permissions', 'requests'].map(action => ({ action, tabId: 'tab' })),
    { action: 'list_tabs' }, { action: 'revoke' },
    { action: 'click', tabId: 'tab', target },
    { action: 'click', tabId: 'tab', point: { x: 10, y: 10, snapshotId: 'combined' } },
    { action: 'fill', tabId: 'tab', ref: 'r', text: '' },
    { action: 'type', tabId: 'tab', target: { selector: '#field' }, text: 'a' },
    { action: 'press', tabId: 'tab', ref: 'r', key: 'Enter' },
    { action: 'select', tabId: 'tab', ref: 'r', values: ['one'] },
    { action: 'scroll', tabId: 'tab', ref: 'r', deltaX: 0, deltaY: 200 },
    { action: 'read', tabId: 'tab' }, { action: 'read', tabId: 'tab', ref: 'r' },
    { action: 'evaluate', tabId: 'tab', expression: 'document.title', frameId: 'frame' },
    { action: 'upload', tabId: 'tab', target: { selector: 'input[type=file]' }, files: ['C:\\fixture.txt'] },
    { action: 'handle_dialog', tabId: 'tab', accept: false, promptText: '' },
    { action: 'respond', tabId: 'tab', requestRef: 'r', response: { optionRef: 'o', text: 'fixture' } },
    { action: 'respond', tabId: 'tab', requestRef: 'r', response: { files: ['C:\\fixture.txt'] } },
    { action: 'respond', tabId: 'tab', requestRef: 'r', response: { cancel: true } },
  ];
  for (const args of actions) assert.equal(validateArgs(args), args);
  assert.throws(() => validateArgs({ action: 'scroll', tabId: 't', ref: 'r', deltaX: 0, deltaY: Infinity }), /Bounded/);
  assert.throws(() => validateArgs({ action: 'press', tabId: 't', ref: 'r', key: 'Control+A' }), /Unsupported key/);
});

test('unsafe schemes, credential URLs and non-finite coordinates fail closed', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/private', 'data:text/html,x', 'https://u:p@example.invalid']) {
    assert.throws(() => pageURL(url), /HTTP/);
  }
  assert.equal(pageURL('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.throws(() => validateArgs({ action: 'click', tabId: 't', point: { x: NaN, y: 0, snapshotId: 's' } }), /finite/);
  assert.throws(() => validateArgs({ action: 'click', tabId: 't', point: { x: 0, y: 0 } }), /snapshotId/);
});

test('semantic filtering is explicit, frame-scoped, and does not resolve ambiguity by ranking', () => {
  const entries = [{ role: 'button', name: 'Save changes', frameId: 'one' }, { role: 'button', name: 'Save changes', frameId: 'two' }];
  assert.equal(entries.filter(e => matchesTarget(e, { name: 'save' })).length, 2);
  assert.deepEqual(entries.filter(e => matchesTarget(e, { role: 'button', name: 'Save changes', exact: true, frameId: 'two' })), [entries[1]]);
  assert.equal(entries.filter(e => matchesTarget(e, { name: 'save changes', exact: true })).length, 0);
});

test('document/revision/viewport/scroll checkpoint invariants reject every stale dimension', () => {
  const base = { documentId: 'doc', revision: 4, width: 100, height: 80, x: 1, y: 2 };
  assert.equal(sameCheckpoint(base, { ...base }), true);
  for (const key of Object.keys(base)) assert.equal(sameCheckpoint(base, { ...base, [key]: key === 'documentId' ? 'next' : base[key] + 1 }), false);
  assert.equal(sameCheckpoint(null, base), false);
});
