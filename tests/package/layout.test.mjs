import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const artifact = process.env.WB_PACKAGE_DIR;
assert.ok(artifact && path.isAbsolute(artifact), 'Set WB_PACKAGE_DIR to the exact packaged plugin folder');
const json = async relative => JSON.parse(await readFile(path.join(artifact, relative), 'utf8'));
const present = async relative => {
  assert.ok((await stat(path.join(artifact, relative))).isFile(), `Missing packaged file: ${relative}`);
};

test('folder includes its launch/runtime/policy dependencies and original redistribution notices without legacy Mixdog plugin files', async () => {
  assert.equal(path.basename(artifact), 'win-browser',
    'Register the stable win-browser child, not its unique build allocation parent');
  const policy = await json('browser-policy.json');
  assert.equal(policy.mode, 'delegated');
  assert.deepEqual(policy.permissions, ['hid', 'usb', 'notifications', 'geolocation']);
  assert.equal(policy.origins, 'owned-pages');
  assert.equal(policy.lifetime, 'caller-generation');
  assert.equal(policy.newGrants, true);
  for (const relative of [
    'bin/bridge.exe', 'bin/native-consent.exe', 'runtime/electron.exe',
    'runtime/LICENSE', 'runtime/LICENSES.chromium.html', 'runtime/resources.pak',
    'runtime/resources/default_app.asar',
    'app/mcp.cjs', 'app/companion.cjs', 'app/companion-camoufox.cjs', 'app/toolbar-preload.cjs', 'app/runner-preload.cjs',
    'browser-policy.json', 'README.md',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/mixdog/LICENSE', 'licenses/mixdog/NOTICE.md', 'licenses/mixdog/provenance.json',
    'licenses/camoufox/NOTICE.md', 'licenses/camoufox/provenance.json',
    'sources/native/bridge.cpp', 'sources/native/consent.cpp',
  ]) await present(relative);
  for (const gone of [
    'plugin.json', 'hooks/hooks.json', 'app/hook.cjs', 'skills/independent-browser/SKILL.md',
    'bin/control-bar.exe', 'sources/native/control-bar.cpp',
  ]) {
    await assert.rejects(stat(path.join(artifact, gone)), { code: 'ENOENT' }, `${gone} must not be shipped`);
  }
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

test('Mixdog-derived code ships its fork record and Mixdog\'s unmodified LICENSE and NOTICE, not Mixdog sources', async () => {
  const fork = await json('licenses/mixdog/provenance.json');
  assert.deepEqual(fork.forkPoint, { version: '1.3.4', commit: '968ee08965e75c3fa1999ab8d18d20e45229fc89' });
  assert.equal(fork.tracking, 'none');
  assert.equal(fork.license, 'Apache-2.0');
  assert.deepEqual((await readdir(path.join(artifact, 'licenses/mixdog'))).sort(), ['LICENSE', 'NOTICE.md', 'provenance.json']);
  for (const [name, expected] of Object.entries(fork.notices)) {
    const bytes = await readFile(path.join(artifact, 'licenses/mixdog', name));
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), expected, name);
  }
  for (const gone of ['vendor', 'upstream.lock.json']) {
    await assert.rejects(stat(path.join(artifact, gone)), { code: 'ENOENT' }, `${gone} is not shipped`);
  }
});

test('bundled SDK maps preserve actual source content rather than incomplete chained references', async () => {
  const map = await json('app/mcp.cjs.map');
  const sdk = map.sources.map((source, index) => ({ source, content: map.sourcesContent[index] }))
    .filter(entry => entry.source.includes('/@modelcontextprotocol/sdk/'));
  assert.ok(sdk.length > 0);
  for (const entry of sdk) assert.equal(typeof entry.content, 'string', `Missing mapped SDK source: ${entry.source}`);
});
