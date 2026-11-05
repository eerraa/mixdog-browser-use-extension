// Clean package build (build-release.md): native helpers, bundles and the
// package are built in a fresh temp copy, so the repo build/ never holds native
// helpers, and only the packaged folder comes back into dist/.
//   node scripts/clean-package.mjs <MinGW licenses dir>            working tree → dist/win-browser-XXXXXX/win-browser
//   node scripts/clean-package.mjs <MinGW licenses dir> --release  committed HEAD → dist/releases/v<version>/
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [licenses, ...flags] = process.argv.slice(2);
if (!licenses || !path.isAbsolute(licenses) || flags.some(flag => flag !== '--release')) {
  throw new Error('Usage: node scripts/clean-package.mjs <absolute MinGW licenses dir> [--release]');
}
const release = flags.includes('--release');
// What a package is built from (build-release.md Clean package build, step 1).
const SOURCES = ['src', 'scripts', 'native', 'third_party', 'skills', 'hooks', 'plugin.json', 'browser-policy.json',
  'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'LICENSE'];
// Windows bsdtar: writes ZIP archives and never reads "C:" as a remote host.
const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function files(directory, prefix = '') {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const found = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await files(directory, relative));
    else if (entry.isFile()) found.push(relative);
    else throw new Error(`Unexpected non-file entry in the package: ${relative}`);
  }
  return found;
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

let commit = null;
if (release) {
  // A release is exactly the committed tree: refuse uncommitted tracked changes.
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], root).trim()) {
    throw new Error('Commit or stash tracked changes first; a release is built from HEAD');
  }
  commit = run('git', ['rev-parse', 'HEAD'], root).trim();
}

const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'win-browser-build-')));
const electron = path.join(temp, 'node_modules', 'electron');
let result;
try {
  if (release) {
    const archive = path.join(temp, 'source.tar');
    // The committed bytes: core.autocrlf would rewrite text files on export, and
    // the shipped Mixdog notices must match their recorded blob ids.
    run('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', '-o', archive, commit, '--', ...SOURCES], root);
    run(tar, ['-x', '-f', archive, '-C', temp], temp);
    await rm(archive);
    // Every exported file must hash to its blob in the commit.
    for (const entry of run('git', ['ls-tree', '-r', '-z', commit, '--', ...SOURCES], root).split('\0').filter(Boolean)) {
      const [meta, file] = entry.split('\t');
      const [, type, blob] = meta.split(' ');
      if (type !== 'blob') throw new Error(`Unexpected ${type} in the release sources: ${file}`);
      const bytes = await readFile(path.join(temp, file));
      if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== blob) {
        throw new Error(`Exported ${file} differs from its blob in ${commit}`);
      }
    }
  } else {
    for (const name of SOURCES) await cp(path.join(root, name), path.join(temp, name), { recursive: true });
  }
  const version = JSON.parse(await readFile(path.join(temp, 'package.json'), 'utf8')).version;
  const manifest = JSON.parse(await readFile(path.join(temp, 'plugin.json'), 'utf8'));
  const server = await readFile(path.join(temp, 'src', 'mcp', 'main.mjs'), 'utf8');
  if (manifest.version !== version || !server.includes(`version: '${version}'`)) {
    throw new Error(`Version ${version} differs between package.json, plugin.json and src/mcp/main.mjs`);
  }
  // Never replace a release: Mixdog runs registered packages in place.
  const out = path.join(root, 'dist', 'releases', `v${version}`);
  if (release && await exists(out)) throw new Error(`${out} already exists; releases are never replaced`);
  // A real copy of node_modules: the SDK patch matches files by their real path
  // under the build root. Only the Electron runtime may be a junction.
  await mkdir(path.join(temp, 'node_modules'));
  for (const entry of await readdir(path.join(root, 'node_modules'))) {
    if (entry === 'electron') await symlink(path.join(root, 'node_modules', 'electron'), electron, 'junction');
    else await cp(path.join(root, 'node_modules', entry), path.join(temp, 'node_modules', entry), { recursive: true });
  }
  run(process.execPath, ['scripts/build-native.mjs', licenses], temp);
  run(process.execPath, ['scripts/build.mjs'], temp);
  const packaged = JSON.parse(run(process.execPath, ['scripts/package.mjs'], temp).trim().split(/\r?\n/).at(-1));

  if (!release) {
    await mkdir(path.join(root, 'dist'), { recursive: true });
    const allocation = await mkdtemp(path.join(root, 'dist', 'win-browser-'));
    const directory = path.join(allocation, 'win-browser');
    await cp(packaged.directory, directory, { recursive: true });
    result = { directory, version, runtime: packaged.runtime, source: 'working tree' };
  } else {
    await mkdir(path.dirname(out), { recursive: true });
    await mkdir(out); // EEXIST if a release of this version appeared meanwhile.
    const directory = path.join(out, 'win-browser');
    await cp(packaged.directory, directory, { recursive: true });
    const zip = `win-browser-v${version}-windows-x64.zip`;
    run(tar, ['-a', '-c', '-f', zip, 'win-browser'], out);
    const zipSha256 = await sha256(path.join(out, zip));
    await writeFile(path.join(out, `${zip}.sha256`), `${zipSha256}  ${zip}\n`);
    const listing = [];
    for (const relative of await files(directory)) listing.push(`${await sha256(path.join(directory, relative))}  win-browser/${relative}`);
    const sums = `win-browser-v${version}-files.sha256`;
    await writeFile(path.join(out, sums), `${listing.join('\n')}\n`);
    await writeFile(path.join(out, 'release.json'), `${JSON.stringify({
      version, commit, source: 'git archive of the commit', runtime: packaged.runtime,
      package: 'win-browser', zip, zipSha256, files: listing.length, fileSums: sums,
    }, null, 2)}\n`);
    result = { directory, version, commit, runtime: packaged.runtime, zip: path.join(out, zip), zipSha256, files: listing.length };
  }
} finally {
  // Remove the Electron junction itself before the copy, so no recursive delete
  // can ever reach the repository's runtime through it.
  try {
    if ((await lstat(electron)).isSymbolicLink()) await unlink(electron).catch(() => rmdir(electron));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (await exists(electron)) throw new Error(`Junction still present, temp copy kept: ${electron}`);
  await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
