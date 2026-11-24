import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { authorityMode, automationMode, camoufoxExecutable, engineMode, persistentProfilesEnabled, pluginData } from '../../src/shared/paths.mjs';

const legacy = path.resolve('C:\\legacy-data');
const own = path.resolve('C:\\wb-data');

test('connection authority is the sole mode; WB_AUTHORITY is optional and hook/unknown values fail closed', () => {
  assert.equal(authorityMode({}), 'connection');
  assert.equal(authorityMode({ WB_AUTHORITY: '' }), 'connection');
  assert.equal(authorityMode({ WB_AUTHORITY: 'connection' }), 'connection');
  assert.throws(() => authorityMode({ WB_AUTHORITY: 'hook' }), /WB_AUTHORITY=hook is no longer supported/);
  for (const value of ['Connection', 'none', 'hooks', ' connection']) {
    assert.throws(() => authorityMode({ WB_AUTHORITY: value }), /WB_AUTHORITY must be connection/, value);
  }
});

test('pluginData always requires an absolute WB_DATA_DIR and never falls back to MIXDOG_PLUGIN_DATA', () => {
  assert.equal(pluginData({ WB_DATA_DIR: own }), own);
  assert.equal(pluginData({ WB_AUTHORITY: 'connection', WB_DATA_DIR: own, MIXDOG_PLUGIN_DATA: legacy }), own);
  for (const env of [{}, { MIXDOG_PLUGIN_DATA: legacy }, { WB_AUTHORITY: 'connection' },
    { WB_AUTHORITY: 'connection', MIXDOG_PLUGIN_DATA: legacy }, { WB_DATA_DIR: 'relative\\data' }]) {
    assert.throws(() => pluginData(env), /WB_DATA_DIR must be an absolute directory/);
  }
  assert.throws(() => pluginData({ WB_AUTHORITY: 'hook', WB_DATA_DIR: own, MIXDOG_PLUGIN_DATA: legacy }), /WB_AUTHORITY=hook is no longer supported/);
  assert.throws(() => pluginData({ WB_AUTHORITY: 'other', WB_DATA_DIR: own }), /WB_AUTHORITY/);
  assert.equal(persistentProfilesEnabled({}), true);
  assert.equal(persistentProfilesEnabled({ WB_PERSISTENT_PROFILE: '1' }), true);
  assert.equal(persistentProfilesEnabled({ WB_PERSISTENT_PROFILE: '0' }), false);
  assert.equal(persistentProfilesEnabled({ WB_PERSISTENT_PROFILE: 'false' }), false);
});

test('automationMode is unset by default, accepts only standard or elevated, and fails closed on unknown values', () => {
  assert.equal(automationMode({}), null);
  assert.equal(automationMode({ WB_AUTOMATION_MODE: '' }), null);
  assert.equal(automationMode({ WB_AUTOMATION_MODE: 'standard' }), 'standard');
  assert.equal(automationMode({ WB_AUTOMATION_MODE: 'elevated' }), 'elevated');
  for (const value of ['Elevated', 'full', 'true', '1', ' elevated', 'unsafe']) {
    assert.throws(() => automationMode({ WB_AUTOMATION_MODE: value }), /WB_AUTOMATION_MODE must be standard or elevated/, value);
  }
});

test('engineMode is unset by default, accepts only camoufox or electron, and fails closed on unknown values', () => {
  assert.equal(engineMode({}), null);
  assert.equal(engineMode({ WB_ENGINE: '' }), null);
  assert.equal(engineMode({ WB_ENGINE: 'camoufox' }), 'camoufox');
  assert.equal(engineMode({ WB_ENGINE: 'electron' }), 'electron');
  for (const value of ['Camoufox', 'firefox', 'chromium', ' electron', '1']) {
    assert.throws(() => engineMode({ WB_ENGINE: value }), /WB_ENGINE must be camoufox or electron/, value);
  }
});

test('camoufoxExecutable resolves explicit WB_CAMOUFOX_PATH, bundled camoufox/, and shared runtime folders', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wb-paths-cfx-'));
  try {
    const pkg = path.join(tmp, 'win-browser');
    const cfxDir = path.join(pkg, 'camoufox');
    mkdirSync(cfxDir, { recursive: true });
    const exe = path.join(cfxDir, 'camoufox.exe');
    writeFileSync(exe, 'stub');
    writeFileSync(path.join(cfxDir, 'version.json'), JSON.stringify({ version: '158.0.1', release: 'beta.41' }));

    const bundled = camoufoxExecutable(pkg, {});
    assert.equal(bundled.executablePath, exe);
    assert.equal(bundled.source, 'package');
    assert.equal(bundled.version, '158.0.1-beta.41');

    const explicit = camoufoxExecutable(tmp, { WB_CAMOUFOX_PATH: exe });
    assert.equal(explicit.executablePath, exe);
    assert.equal(explicit.source, 'env');

    assert.throws(() => camoufoxExecutable(tmp, { WB_CAMOUFOX_PATH: 'relative\\camoufox.exe' }), /WB_CAMOUFOX_PATH must be an absolute path/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
