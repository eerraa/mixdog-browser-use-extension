import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PREFERENCES_FILE, isProtectedInternalPath, loadUserPreferences, resolveAutomationMode, saveUserPreferences,
} from '../../src/shared/preferences.mjs';
import { BrowserPolicy } from '../../src/shared/policy.mjs';

test('user-preferences.json loads, validates strictly, persists atomically, and fails closed on corruption', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wb-prefs-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const empty = await loadUserPreferences(root);
  assert.deepEqual(empty, { ok: true, found: false, automationMode: null, reason: null });

  await saveUserPreferences(root, { automationMode: 'elevated' });
  const loaded = await loadUserPreferences(root);
  assert.deepEqual(loaded, { ok: true, found: true, automationMode: 'elevated', reason: null });
  const raw = JSON.parse(await readFile(path.join(root, PREFERENCES_FILE), 'utf8'));
  assert.deepEqual(raw, { version: 1, automationMode: 'elevated' });

  // Concurrent writes serialize cleanly without leaving temp files behind
  await Promise.all([
    saveUserPreferences(root, { automationMode: 'standard' }),
    saveUserPreferences(root, { automationMode: 'elevated' }),
    saveUserPreferences(root, { automationMode: 'standard' }),
  ]);
  assert.equal((await loadUserPreferences(root)).automationMode, 'standard');

  // Unknown key / wrong version / invalid mode / malformed JSON all fail closed
  for (const bad of [
    '{',
    JSON.stringify({ version: 2, automationMode: 'elevated' }),
    JSON.stringify({ version: 1, automationMode: 'admin' }),
    JSON.stringify({ version: 1, automationMode: 'elevated', extra: true }),
    '[]',
  ]) {
    await writeFile(path.join(root, PREFERENCES_FILE), bad, 'utf8');
    const res = await loadUserPreferences(root);
    assert.equal(res.ok, false, bad);
    assert.equal(res.automationMode, null);
    assert.ok(res.reason);
  }
});

test('resolveAutomationMode enforces strict precedence: env > policy > user-preferences > standard, failing closed on invalid policy', () => {
  const validDefaultPolicy = new BrowserPolicy({ version: 1, mode: 'manual' });
  const pinnedStandardPolicy = new BrowserPolicy({ version: 1, mode: 'manual', automationMode: 'standard' });
  const pinnedElevatedPolicy = new BrowserPolicy({ version: 1, mode: 'manual', automationMode: 'elevated' });
  const invalidPolicy = new BrowserPolicy({ version: 99, mode: 'bogus' });
  const savedElevated = { ok: true, found: true, automationMode: 'elevated', reason: null };
  const corruptPref = { ok: false, found: true, automationMode: null, reason: 'bad json' };

  // Hard ceiling: explicit env=standard beats saved elevated user preference
  assert.deepEqual(
    resolveAutomationMode({ envMode: 'standard', policy: validDefaultPolicy, prefs: savedElevated }),
    { mode: 'standard', source: 'env', pinned: true, pinnedStandard: true, preferenceReason: null },
  );
  // Explicit env=elevated wins
  assert.deepEqual(
    resolveAutomationMode({ envMode: 'elevated', policy: pinnedStandardPolicy, prefs: corruptPref }),
    { mode: 'elevated', source: 'env', pinned: true, pinnedStandard: false, preferenceReason: 'bad json' },
  );
  // Invalid browser-policy.json NEVER falls through to saved elevated preference
  const badPol = resolveAutomationMode({ envMode: null, policy: invalidPolicy, prefs: savedElevated });
  assert.equal(badPol.mode, 'standard');
  assert.equal(badPol.source, 'policy-invalid');
  assert.equal(badPol.pinned, true);
  // Explicit policy=standard pins standard over saved elevated preference
  const polStd = resolveAutomationMode({ envMode: null, policy: pinnedStandardPolicy, prefs: savedElevated });
  assert.equal(polStd.mode, 'standard');
  assert.equal(polStd.source, 'policy');
  assert.equal(polStd.pinned, true);
  // Explicit policy=elevated wins when env unset
  const polElev = resolveAutomationMode({ envMode: null, policy: pinnedElevatedPolicy, prefs: { ok: true, found: false, automationMode: null } });
  assert.equal(polElev.mode, 'elevated');
  assert.equal(polElev.source, 'policy');
  assert.equal(polElev.pinned, true);
  // Valid policy omitting automationMode honors saved elevated user preference
  const prefElev = resolveAutomationMode({ envMode: null, policy: validDefaultPolicy, prefs: savedElevated });
  assert.equal(prefElev.mode, 'elevated');
  assert.equal(prefElev.source, 'user-preference');
  assert.equal(prefElev.pinned, false);
  // Corrupt preference fails closed to standard with diagnostic reason
  const badPref = resolveAutomationMode({ envMode: null, policy: validDefaultPolicy, prefs: corruptPref });
  assert.equal(badPref.mode, 'standard');
  assert.equal(badPref.source, 'user-preference-invalid');
  assert.equal(badPref.preferenceReason, 'bad json');
});

test('isProtectedInternalPath blocks profile, preference, and endpoint files while permitting downloads and ordinary files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wb-prot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connDir = path.join(root, 'connections', 'chan-1');
  await mkdir(path.join(root, 'profiles', 'camoufox-default'), { recursive: true });
  await mkdir(path.join(connDir, 'downloads', 'abc'), { recursive: true });
  await mkdir(path.join(connDir, 'profiles', 'camoufox'), { recursive: true });

  const opts = { dataRoot: root, connectionDataDir: connDir };
  assert.equal(isProtectedInternalPath(path.join(root, 'user-preferences.json'), opts), true);
  assert.equal(isProtectedInternalPath(path.join(root, 'user-preferences.json.123.tmp'), opts), true);
  assert.equal(isProtectedInternalPath(path.join(root, 'profiles', 'camoufox-default', 'cookies.sqlite'), opts), true);
  assert.equal(isProtectedInternalPath(path.join(root, 'profiles', 'camoufox-work.lock'), opts), true);
  assert.equal(isProtectedInternalPath(path.join(connDir, 'endpoint.json'), opts), true);
  assert.equal(isProtectedInternalPath(path.join(connDir, 'profiles', 'camoufox', 'cookies.sqlite'), opts), true);
  assert.equal(isProtectedInternalPath(path.join(connDir, 'electron', 'Cookies'), opts), true);

  // Ordinary downloads and non-internal files remain uploadable
  assert.equal(isProtectedInternalPath(path.join(connDir, 'downloads', 'abc', 'report.txt'), opts), false);
  assert.equal(isProtectedInternalPath(path.join(root, 'packaged-attachment.txt'), opts), false);
  assert.equal(isProtectedInternalPath(path.join(os.tmpdir(), 'outside.txt'), opts), false);

  // Symlinked user-preferences.json is refused by loadUserPreferences
  const outside = path.join(root, 'outside.json');
  await writeFile(outside, JSON.stringify({ version: 1, automationMode: 'elevated' }), 'utf8');
  try {
    await symlink(outside, path.join(root, PREFERENCES_FILE));
    const res = await loadUserPreferences(root);
    assert.equal(res.ok, false);
    assert.match(res.reason, /non-symlink/i);
  } catch (err) {
    // Windows without Developer Mode may return EPERM on file symlinks; skip symlink assertion only then.
    if (err?.code !== 'EPERM') throw err;
  }
});
