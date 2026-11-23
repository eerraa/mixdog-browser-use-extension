import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RUNTIME, STABLE, VERSIONS, install } from '../../scripts/install-local.mjs';

// A release folder as `package:clean --release` lays it out, with a few files.
async function release(parent, version, files = { 'bin/bridge.exe': `bridge ${version}`, 'plugin.json': `{"version":"${version}"}` }) {
  const directory = path.join(parent, `release-v${version}`);
  const sums = [];
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, 'win-browser', name)), { recursive: true });
    await writeFile(path.join(directory, 'win-browser', name), content);
    sums.push(`${createHash('sha256').update(content).digest('hex')}  win-browser/${name}`);
  }
  await writeFile(path.join(directory, 'release.json'), JSON.stringify({ version }));
  await writeFile(path.join(directory, `win-browser-v${version}-files.sha256`), sums.join('\n') + '\n');
  return directory;
}

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root: path.join(directory, 'Apps') };
}

const idle = () => [];
const resolved = async root => (await realpath(path.join(root, STABLE))).toLowerCase();
const installed = (root, version) => path.join(root, VERSIONS, `v${version}`, 'win-browser');

test('first install copies a verified version and points the stable junction at it', async t => {
  const { directory, root } = await workspace(t);
  const result = await install({ root, release: await release(directory, '1.0.0'), running: idle });
  assert.equal(result.copied, true);
  assert.equal(result.previous, null);
  assert.ok((await lstat(path.join(root, STABLE))).isSymbolicLink(), 'the stable path is a junction');
  assert.equal(await resolved(root), installed(root, '1.0.0').toLowerCase());
  assert.equal(await readFile(path.join(root, STABLE, 'bin', 'bridge.exe'), 'utf8'), 'bridge 1.0.0');
});

test('a newer install switches the junction and removes an idle earlier version', async t => {
  const { directory, root } = await workspace(t);
  await install({ root, release: await release(directory, '1.0.0'), running: idle });
  const result = await install({ root, release: await release(directory, '1.0.1'), running: idle });
  assert.equal(result.previous.toLowerCase(), installed(root, '1.0.0').toLowerCase());
  assert.deepEqual(result.pruned, ['v1.0.0']);
  assert.equal(await resolved(root), installed(root, '1.0.1').toLowerCase());
  assert.deepEqual(await readdir(path.join(root, VERSIONS)), ['v1.0.1']);
  assert.deepEqual((await readdir(root)).sort(), [STABLE, VERSIONS].sort(), 'no temporary link is left');
});

test('an earlier version that still runs a process is kept for that process', async t => {
  const { directory, root } = await workspace(t);
  await install({ root, release: await release(directory, '1.0.0'), running: idle });
  const runningOld = () => [path.join(installed(root, '1.0.0'), 'bin', 'bridge.exe').toLowerCase()];
  const result = await install({ root, release: await release(directory, '1.0.1'), running: runningOld });
  assert.deepEqual(result.inUse, ['v1.0.0']);
  assert.equal(await readFile(path.join(installed(root, '1.0.0'), 'bin', 'bridge.exe'), 'utf8'), 'bridge 1.0.0');
  assert.equal(await resolved(root), installed(root, '1.0.1').toLowerCase(), 'new connections still start the new version');
  const later = await install({ root, release: await release(directory, '1.0.1'), running: idle });
  assert.equal(later.copied, false, 'an intact installed version is reused');
  assert.deepEqual(later.pruned, ['v1.0.0'], 'a later install removes it once idle');
});

test('a release whose files differ from its digests is refused before anything changes', async t => {
  const { directory, root } = await workspace(t);
  await install({ root, release: await release(directory, '1.0.0'), running: idle });
  const tampered = await release(directory, '1.0.1');
  await writeFile(path.join(tampered, 'win-browser', 'bin', 'bridge.exe'), 'changed');
  await assert.rejects(install({ root, release: tampered, running: idle }), /differs from the release/);
  const extra = await release(directory, '1.0.2');
  await writeFile(path.join(extra, 'win-browser', 'unlisted.txt'), 'x');
  await assert.rejects(install({ root, release: extra, running: idle }), /exactly the release files/);
  assert.equal(await resolved(root), installed(root, '1.0.0').toLowerCase());
  assert.deepEqual(await readdir(path.join(root, VERSIONS)), ['v1.0.0']);
});

test('a real folder at the stable path is never replaced', async t => {
  const { directory, root } = await workspace(t);
  await mkdir(path.join(root, STABLE), { recursive: true });
  await writeFile(path.join(root, STABLE, 'keep.txt'), 'user data');
  await assert.rejects(install({ root, release: await release(directory, '1.0.0'), running: idle }), /not a junction/);
  assert.equal(await readFile(path.join(root, STABLE, 'keep.txt'), 'utf8'), 'user data');
});

test('optional shared Camoufox runtime installs once beside versions and is reused across version upgrades', async t => {
  const { directory, root } = await workspace(t);
  const cfxSrc = path.join(directory, 'camoufox-src');
  await mkdir(cfxSrc, { recursive: true });
  await writeFile(path.join(cfxSrc, 'camoufox.exe'), 'cfx-bin');
  await writeFile(path.join(cfxSrc, 'version.json'), JSON.stringify({ version: '158.0.1', build: 'beta.41' }));

  const first = await install({ root, release: await release(directory, '1.0.0'), running: idle, camoufoxSource: cfxSrc });
  assert.equal(first.sharedCamoufox, path.join(root, RUNTIME, 'camoufox'));
  assert.equal(await readFile(path.join(root, RUNTIME, 'camoufox', 'camoufox.exe'), 'utf8'), 'cfx-bin');

  // Upgrading to 1.0.1 reuses the single shared runtime without touching the verified version folder.
  const second = await install({ root, release: await release(directory, '1.0.1'), running: idle, camoufoxSource: cfxSrc });
  assert.equal(second.sharedCamoufox, path.join(root, RUNTIME, 'camoufox'));
  assert.deepEqual(second.pruned, ['v1.0.0']);
  assert.equal(await readFile(path.join(root, RUNTIME, 'camoufox', 'camoufox.exe'), 'utf8'), 'cfx-bin');
});

test('side-by-side upgrade deduplicates byte-identical runtime files via NTFS hard links while preserving independence when older version is pruned', async t => {
  const { directory, root } = await workspace(t);
  const sharedElectron = 'electron-44.9.1-binary-payload'.repeat(1024);
  const rel1 = await release(directory, '1.0.0', {
    'bin/bridge.exe': 'bridge 1.0.0',
    'plugin.json': '{"version":"1.0.0"}',
    'runtime/electron.exe': sharedElectron,
    'runtime/icudtl.dat': 'icu-data-identical',
  });
  const rel2 = await release(directory, '1.0.1', {
    'bin/bridge.exe': 'bridge 1.0.1',
    'plugin.json': '{"version":"1.0.1"}',
    'runtime/electron.exe': sharedElectron,
    'runtime/icudtl.dat': 'icu-data-identical',
  });

  const first = await install({ root, release: rel1, running: idle });
  assert.equal(first.copiedFiles, 4);
  assert.equal(first.hardLinkedFiles, 0);

  // Keep v1.0.0 in use so both versions coexist side-by-side; unchanged runtime files must share inodes (hard links)
  const runningOld = () => [path.join(installed(root, '1.0.0'), 'bin', 'bridge.exe').toLowerCase()];
  const second = await install({ root, release: rel2, running: runningOld });
  assert.deepEqual(second.inUse, ['v1.0.0']);
  assert.equal(second.hardLinkedFiles, 2, 'unchanged runtime files are hard-linked from verified v1.0.0');
  assert.equal(second.copiedFiles, 2, 'changed app files are freshly copied');
  assert.ok(second.savedBytes >= Buffer.byteLength(sharedElectron));

  const st1 = await stat(path.join(installed(root, '1.0.0'), 'runtime', 'electron.exe'), { bigint: true });
  const st2 = await stat(path.join(installed(root, '1.0.1'), 'runtime', 'electron.exe'), { bigint: true });
  assert.equal(st1.ino, st2.ino, 'identical runtime file shares the same NTFS inode across side-by-side versions');
  assert.equal((await lstat(path.join(installed(root, '1.0.1'), 'runtime'))).isSymbolicLink(), false, 'runtime stays a real directory, not a junction');

  const stBridge1 = await stat(path.join(installed(root, '1.0.0'), 'bin', 'bridge.exe'), { bigint: true });
  const stBridge2 = await stat(path.join(installed(root, '1.0.1'), 'bin', 'bridge.exe'), { bigint: true });
  assert.notEqual(stBridge1.ino, stBridge2.ino, 'changed files remain distinct inodes');

  // Once v1.0.0 goes idle and is pruned, v1.0.1 keeps its hard-linked runtime files intact
  const third = await install({ root, release: rel2, running: idle });
  assert.deepEqual(third.pruned, ['v1.0.0']);
  assert.equal(await readFile(path.join(installed(root, '1.0.1'), 'runtime', 'electron.exe'), 'utf8'), sharedElectron);
});
