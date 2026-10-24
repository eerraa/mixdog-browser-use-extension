import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const artifact = process.env.WB_PACKAGE_DIR;
assert.ok(artifact && path.isAbsolute(artifact), 'Set WB_PACKAGE_DIR to the exact packaged plugin folder');
const json = async relative => JSON.parse(await readFile(path.join(artifact, relative), 'utf8'));
const present = async relative => {
  assert.ok((await stat(path.join(artifact, relative))).isFile(), `Missing packaged file: ${relative}`);
};

test('folder includes its launch/runtime/skill/hook dependencies and original redistribution notices', async () => {
  const manifest = await json('plugin.json');
  assert.equal(manifest.name, 'win-browser');
  // Official host registry IDs derive from the registered source basename,
  // not manifest.name. Equal registry stem/server key yields plugin-win-browser.
  assert.equal(path.basename(artifact), 'win-browser',
    'Register the stable win-browser child, not its unique build allocation parent');
  const server = manifest.mcpServers['win-browser'];
  const policy = await json('browser-policy.json');
  assert.equal(policy.mode, 'delegated');
  assert.deepEqual(policy.permissions, ['hid', 'usb', 'notifications', 'geolocation']);
  assert.equal(policy.origins, 'owned-pages');
  assert.equal(policy.lifetime, 'caller-generation');
  assert.equal(policy.newGrants, true);
  assert.equal(server.command, '${MIXDOG_PLUGIN_ROOT}/bin/bridge.exe');
  assert.deepEqual(server.args, ['--mcp']);
  assert.equal(server.cwd, '${MIXDOG_PLUGIN_ROOT}');
  for (const relative of [
    'bin/bridge.exe', 'bin/native-consent.exe', 'runtime/electron.exe',
    'runtime/LICENSE', 'runtime/LICENSES.chromium.html', 'runtime/resources.pak',
    'runtime/resources/default_app.asar',
    'app/mcp.cjs', 'app/hook.cjs', 'app/companion.cjs', 'app/toolbar-preload.cjs',
    'skills/independent-browser/SKILL.md', 'hooks/hooks.json',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'vendor/mixdog/LICENSE', 'vendor/mixdog/NOTICE.md',
    'sources/native/bridge.cpp', 'sources/native/consent.cpp',
  ]) await present(relative);
  const native = await json('licenses/native/provenance.json');
  assert.ok(native.compiler);
  for (const license of native.licenses) await present(`licenses/native/${license}`);
  const packages = await json('licenses/npm-packages.json');
  assert.ok(packages.some(pkg => pkg.name === '@modelcontextprotocol/sdk' && pkg.version === '1.32.1'));
  for (const pkg of packages) {
    assert.ok(pkg.version && pkg.license && pkg.texts.length);
    for (const relative of pkg.texts) {
      const full = path.resolve(artifact, relative);
      assert.ok(full.startsWith(path.resolve(artifact) + path.sep));
      await access(full);
    }
  }
});

test('bundled SDK maps preserve actual source content rather than incomplete chained references', async () => {
  const map = await json('app/mcp.cjs.map');
  const sdk = map.sources.map((source, index) => ({ source, content: map.sourcesContent[index] }))
    .filter(entry => entry.source.includes('/@modelcontextprotocol/sdk/'));
  assert.ok(sdk.length > 0);
  for (const entry of sdk) assert.equal(typeof entry.content, 'string', `Missing mapped SDK source: ${entry.source}`);
});
