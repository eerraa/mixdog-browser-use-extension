import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { authorityMode, automationMode, camoufoxExecutable, engineMode, pluginData } from '../../src/shared/paths.mjs';

const mixdog = path.resolve('C:\\mixdog-data');
const own = path.resolve('C:\\wb-data');

test('host hooks stay the default authority; only an explicit registration selects connection authority', () => {
  assert.equal(authorityMode({}), 'hook');
  assert.equal(authorityMode({ WB_AUTHORITY: '' }), 'hook');
  assert.equal(authorityMode({ WB_AUTHORITY: 'hook' }), 'hook');
  assert.equal(authorityMode({ WB_AUTHORITY: 'connection' }), 'connection');
  for (const value of ['Connection', 'none', 'hooks', ' connection']) {
    assert.throws(() => authorityMode({ WB_AUTHORITY: value }), /WB_AUTHORITY must be hook or connection/, value);
  }
});

test('each authority reads only its own absolute data root and never falls back to the other', () => {
  assert.equal(pluginData({ MIXDOG_PLUGIN_DATA: mixdog, WB_DATA_DIR: own }), mixdog);
  assert.throws(() => pluginData({ WB_DATA_DIR: own }), /MIXDOG_PLUGIN_DATA is required/);
  assert.throws(() => pluginData({ MIXDOG_PLUGIN_DATA: 'relative' }), /MIXDOG_PLUGIN_DATA is required/);
  assert.equal(pluginData({ WB_AUTHORITY: 'connection', WB_DATA_DIR: own, MIXDOG_PLUGIN_DATA: mixdog }), own);
  for (const env of [{ WB_AUTHORITY: 'connection' }, { WB_AUTHORITY: 'connection', MIXDOG_PLUGIN_DATA: mixdog },
    { WB_AUTHORITY: 'connection', WB_DATA_DIR: 'relative\\data' }]) {
    assert.throws(() => pluginData(env), /WB_DATA_DIR must be an absolute directory/);
  }
  assert.throws(() => pluginData({ WB_AUTHORITY: 'other', MIXDOG_PLUGIN_DATA: mixdog }), /WB_AUTHORITY/);
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
