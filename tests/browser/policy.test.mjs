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

test('browser-policy.json supports optional explicit automationMode while keeping shipped JSON standard by default', () => {
  const shipped = new BrowserPolicy(delegated());
  assert.equal(shipped.valid, true);
  assert.equal(shipped.automationMode, 'standard');
  assert.equal(shipped.explicitAutomationMode, false);
  assert.equal(shipped.describe().automationMode, 'standard');

  for (const base of [delegated(), { version: 1, mode: 'manual' }, { version: 1, mode: 'disabled' }]) {
    const elevated = new BrowserPolicy({ ...base, automationMode: 'elevated' });
    assert.equal(elevated.mode, base.mode);
    assert.equal(elevated.automationMode, 'elevated');
    assert.equal(elevated.explicitAutomationMode, true);
    assert.equal(elevated.describe().automationMode, 'elevated');

    const standard = new BrowserPolicy({ ...base, automationMode: 'standard' });
    assert.equal(standard.mode, base.mode);
    assert.equal(standard.automationMode, 'standard');
    assert.equal(standard.explicitAutomationMode, true);

    for (const bad of ['Elevated', 'full', true, null, '']) {
      const rejected = new BrowserPolicy({ ...base, automationMode: bad });
      assert.equal(rejected.valid, false);
      assert.equal(rejected.mode, 'disabled');
      assert.equal(rejected.automationMode, 'standard');
      assert.equal(rejected.explicitAutomationMode, false);
    }
  }
});

test('browser-policy.json supports optional explicit engine while defaulting to camoufox and failing closed on unknown engines', () => {
  const shipped = new BrowserPolicy(delegated());
  assert.equal(shipped.engine, 'camoufox');
  assert.equal(shipped.explicitEngine, false);
  assert.equal(shipped.describe().engine, 'camoufox');

  for (const base of [delegated(), { version: 1, mode: 'manual' }, { version: 1, mode: 'disabled' }]) {
    const elec = new BrowserPolicy({ ...base, engine: 'electron' });
    assert.equal(elec.mode, base.mode);
    assert.equal(elec.engine, 'electron');
    assert.equal(elec.explicitEngine, true);
    assert.equal(elec.describe().engine, 'electron');

    const cfx = new BrowserPolicy({ ...base, engine: 'camoufox' });
    assert.equal(cfx.mode, base.mode);
    assert.equal(cfx.engine, 'camoufox');
    assert.equal(cfx.explicitEngine, true);

    for (const bad of ['Camoufox', 'firefox', true, null, '']) {
      const rejected = new BrowserPolicy({ ...base, engine: bad });
      assert.equal(rejected.mode, 'disabled');
      assert.equal(rejected.engine, 'camoufox');
      assert.equal(rejected.explicitEngine, false);
    }
  }

  // Effective engine override and immutable snapshot round-trip.
  const descOverride = shipped.describe('electron');
  assert.equal(descOverride.engine, 'electron');
  assert.equal(descOverride.configuredEngine, 'camoufox');
  const roundTrip = BrowserPolicy.fromSnapshot(shipped.toSnapshot());
  assert.equal(roundTrip.valid, true);
  assert.equal(roundTrip.mode, 'delegated');
  assert.deepEqual(roundTrip.permissions, shipped.permissions);
  const invalidSnap = BrowserPolicy.fromSnapshot(new BrowserPolicy(null, 'malformed').toSnapshot());
  assert.equal(invalidSnap.valid, false);
  assert.equal(invalidSnap.reason, 'malformed');
});
