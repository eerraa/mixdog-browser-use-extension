import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserPolicy } from '../../src/browser/policy.mjs';

const delegated = () => ({
  version: 1, mode: 'delegated', permissions: ['hid', 'usb', 'notifications', 'geolocation'],
  origins: 'owned-pages', selection: 'offered-option', lifetime: 'caller-generation', newGrants: true,
});

test('delegation is explicit, strictly bounded and immutable for the connection', () => {
  const input = delegated();
  const policy = new BrowserPolicy(input);
  assert.equal(policy.permits('hid'), true);
  assert.equal(policy.permits('usb'), true);
  assert.equal(policy.permits('notifications'), true);
  assert.equal(policy.permits('geolocation'), true);
  assert.equal(policy.permits('display-capture'), false);
  input.permissions.length = 0;
  input.mode = 'disabled';
  assert.equal(policy.permits('hid'), true);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.permissions), true);
  assert.equal(BrowserPolicy.manual().permits('hid'), false);
});

test('missing, malformed, broadened or fabricated policy never enables new protected grants', () => {
  for (const value of [
    null, {}, { ...delegated(), approved: true }, { ...delegated(), newGrants: false },
    { ...delegated(), permissions: ['hid', 'serial'] }, { ...delegated(), permissions: ['hid', 'hid'] },
    { ...delegated(), origins: '*' }, { ...delegated(), lifetime: 'forever' },
    { ...delegated(), selection: 'first-device' },
  ]) {
    const policy = new BrowserPolicy(value);
    assert.equal(policy.permits('hid'), false);
    assert.equal(policy.describe().mode, 'disabled');
    assert.ok(policy.describe().reason);
  }
});

test('the fixed package policy is loaded once; later file edits do not change its authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-policy-'));
  const missing = await BrowserPolicy.load(root);
  assert.equal(missing.permits('hid'), false);
  assert.match(missing.describe().reason, /could not be read/);
  await writeFile(path.join(root, 'browser-policy.json'), '{');
  const malformed = await BrowserPolicy.load(root);
  assert.equal(malformed.permits('hid'), false);
  assert.match(malformed.describe().reason, /malformed JSON/);
  await writeFile(path.join(root, 'browser-policy.json'), JSON.stringify(delegated()));
  const policy = await BrowserPolicy.load(root);
  await writeFile(path.join(root, 'browser-policy.json'), JSON.stringify({ version: 1, mode: 'disabled' }));
  assert.equal(policy.permits('hid'), true);
  assert.equal((await BrowserPolicy.load(root)).permits('hid'), false);
});
