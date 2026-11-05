import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { authorityMode, pluginData } from '../../src/shared/paths.mjs';

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
