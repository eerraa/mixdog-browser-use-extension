// Local install (build-release.md Local install): one stable folder that every
// host registers once. Each version is copied side by side and verified against
// the release's per-file digests; the stable folder is a junction switched to
// the new version. The launcher resolves the junction when it starts, so a
// running process tree keeps its own version and new connections start the new
// one. Earlier versions are removed once no process runs from them.
//   node scripts/install-local.mjs <absolute install root> [<release dir>]
//     <root>\win-browser                                junction: the path hosts register
//     <root>\win-browser-versions\v<ver>\win-browser   verified installs
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, cp, link, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STABLE = 'win-browser';
export const VERSIONS = 'win-browser-versions';
export const RUNTIME = 'win-browser-runtime';
const VERSION_DIR = /^v\d+\.\d+\.\d+$/;

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function listFiles(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await listFiles(directory, relative));
    else if (entry.isFile()) found.push(relative);
    else throw new Error(`${path.join(directory, relative)} is neither a file nor a directory`);
  }
  return found;
}

/** Parse release per-file sha256 manifest into Map<relativePath, sha256>. */
function parseSums(sums) {
  return new Map(sums.trim().split(/\r?\n/).map(line => {
    const match = line.match(/^([0-9a-f]{64}) {2}win-browser\/(.+)$/);
    if (!match) throw new Error(`Malformed release digest line: ${line}`);
    return [match[2], match[1]];
  }));
}

/** The folder holds exactly the release's files, each with its recorded sha256. */
export async function verify(directory, sums) {
  const expected = sums instanceof Map ? sums : parseSums(sums);
  const actual = await listFiles(directory);
  if (actual.length !== expected.size || actual.some(file => !expected.has(file))) {
    throw new Error(`${directory} does not hold exactly the release files`);
  }
  for (const file of actual) {
    if (await sha256(path.join(directory, file)) !== expected.get(file)) throw new Error(`${file} differs from the release`);
  }
}

/**
 * Stage `win-browser/` by hard-linking byte-identical files from existing
 * verified immutable sibling installs on the same volume (MSIX-style NTFS
 * deduplication), falling back to copyFile for new/changed files or when hard
 * linking is unavailable. Preserves real directories, exact paths, and full
 * per-file SHA-256 verification without junctions inside version folders.
 */
async function stageReleaseFiles({ sourceDir, destDir, expected, siblingDirs }) {
  await mkdir(destDir, { recursive: true });
  let hardLinkedFiles = 0;
  let copiedFiles = 0;
  let savedBytes = 0;
  for (const [relative, expectedHash] of expected) {
    const srcFile = path.join(sourceDir, ...relative.split('/'));
    const dstFile = path.join(destDir, ...relative.split('/'));
    await mkdir(path.dirname(dstFile), { recursive: true });
    const srcStat = await stat(srcFile);
    let linked = false;
    for (const sibling of siblingDirs) {
      const candidate = path.join(sibling, ...relative.split('/'));
      try {
        const candStat = await lstat(candidate);
        if (!candStat.isFile() || candStat.size !== srcStat.size) continue;
        if (await sha256(candidate) !== expectedHash) continue;
        await link(candidate, dstFile);
        linked = true;
        hardLinkedFiles++;
        savedBytes += srcStat.size;
        break;
      } catch {
        // Candidate absent, modified, or cross-volume/unsupported hard link; try next sibling or copy.
      }
    }
    if (!linked) {
      await copyFile(srcFile, dstFile);
      copiedFiles++;
    }
  }
  return { hardLinkedFiles, copiedFiles, savedBytes };
}

/** Lower-cased image paths of running processes (read-only listing). */
export function runningImages() {
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + '@(Get-CimInstance Win32_Process | Where-Object ExecutablePath | Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress';
  const output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return [].concat(JSON.parse(output.trim() || '[]')).map(image => image.toLowerCase());
}

// 'none', 'junction' (Node reports a junction as a symbolic link) or 'other'.
async function kindOf(location) {
  try { return (await lstat(location)).isSymbolicLink() ? 'junction' : 'other'; }
  catch (error) { if (error.code === 'ENOENT') return 'none'; throw error; }
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export async function install({ root, release, running = runningImages, camoufoxSource = null }) {
  if (!path.isAbsolute(root) || !path.isAbsolute(release)) throw new Error('Install root and release dir must be absolute');
  const { version } = JSON.parse(await readFile(path.join(release, 'release.json'), 'utf8'));
  if (!VERSION_DIR.test(`v${version}`)) throw new Error(`Invalid release version ${version}`);
  const sums = await readFile(path.join(release, `win-browser-v${version}-files.sha256`), 'utf8');
  const expected = parseSums(sums);
  await verify(path.join(release, 'win-browser'), expected);

  const versions = path.join(root, VERSIONS);
  const home = path.join(versions, `v${version}`);
  const target = path.join(home, 'win-browser');
  await mkdir(versions, { recursive: true });
  let copied = false;
  let hardLinkedFiles = 0;
  let copiedFiles = 0;
  let savedBytes = 0;
  if (await kindOf(home) !== 'none') {
    // An existing install may be running: reuse it only when intact, never overwrite it.
    await verify(target, expected);
  } else {
    const existingEntries = await readdir(versions, { withFileTypes: true }).catch(() => []);
    const siblingDirs = existingEntries
      .filter(entry => entry.isDirectory() && VERSION_DIR.test(entry.name) && entry.name !== `v${version}`)
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(name => path.join(versions, name, 'win-browser'));
    const staging = path.join(versions, `.staging-${randomUUID()}`);
    try {
      const staged = await stageReleaseFiles({
        sourceDir: path.join(release, 'win-browser'),
        destDir: path.join(staging, 'win-browser'),
        expected,
        siblingDirs,
      });
      hardLinkedFiles = staged.hardLinkedFiles;
      copiedFiles = staged.copiedFiles;
      savedBytes = staged.savedBytes;
      await verify(path.join(staging, 'win-browser'), expected);
      await rename(staging, home);
      copied = true;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  const stable = path.join(root, STABLE);
  const kind = await kindOf(stable);
  if (kind === 'other') throw new Error(`${stable} exists and is not a junction; move it away first`);
  const previous = kind === 'junction' ? path.resolve(await readlink(stable)) : null;
  if (!previous || !same(previous, target)) {
    // Build the new link beside the old one, then swap names: the stable path
    // is missing only between two renames, and a failed swap restores it.
    const next = `${stable}.next-${randomUUID()}`;
    await symlink(target, next, 'junction');
    try {
      if (kind === 'junction') {
        const old = `${stable}.old-${randomUUID()}`;
        await rename(stable, old);
        try { await rename(next, stable); } catch (error) { await rename(old, stable); throw error; }
        await unlink(old); // Removes the link only.
      } else {
        await rename(next, stable);
      }
    } finally {
      if (await kindOf(next) === 'junction') await unlink(next);
    }
  }

  // Remove earlier versions no process runs from. A version in use stays until
  // a later install finds it idle; its processes keep their own files.
  const images = await running();
  const pruned = [], inUse = [];
  for (const entry of await readdir(versions, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('.trash-')) {
      await rm(path.join(versions, entry.name), { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (!entry.isDirectory() || !VERSION_DIR.test(entry.name) || entry.name === `v${version}`) continue;
    const directory = path.join(versions, entry.name);
    const prefix = directory.toLowerCase() + path.sep;
    if (images.some(image => image.startsWith(prefix))) { inUse.push(entry.name); continue; }
    // Detach the name first: an open file inside refuses the rename, and a
    // removal that fails halfway leaves only an unnamed trash folder.
    const trash = path.join(versions, `.trash-${randomUUID()}`);
    try { await rename(directory, trash); } catch { inUse.push(entry.name); continue; }
    await rm(trash, { recursive: true, force: true });
    pruned.push(entry.name);
  }
  // Optional shared Camoufox runtime: stored once under <root>\win-browser-runtime\camoufox
  // so version upgrades never duplicate the ~1.3 GB browser runtime and never alter
  // the per-file SHA-256 verified version folder.
  let sharedCamoufox = null;
  if (camoufoxSource) {
    if (!path.isAbsolute(camoufoxSource)) throw new Error('camoufoxSource must be an absolute directory');
    const runtimeRoot = path.join(root, RUNTIME);
    const camoufoxDest = path.join(runtimeRoot, 'camoufox');
    await mkdir(runtimeRoot, { recursive: true });
    if (await kindOf(camoufoxDest) === 'none') {
      const stagingRuntime = path.join(runtimeRoot, `.staging-${randomUUID()}`);
      try {
        await cp(camoufoxSource, stagingRuntime, { recursive: true, errorOnExist: true, force: false });
        await rename(stagingRuntime, camoufoxDest);
      } finally {
        await rm(stagingRuntime, { recursive: true, force: true });
      }
    }
    sharedCamoufox = camoufoxDest;
  }

  return {
    version, stable, target, previous, copied, hardLinkedFiles, copiedFiles, savedBytes, pruned, inUse,
    ...(sharedCamoufox ? { sharedCamoufox } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, release, camoufoxSource] = process.argv.slice(2);
  if (!root || !path.isAbsolute(root)) throw new Error('Usage: node scripts/install-local.mjs <absolute install root> [<release dir>] [<camoufox dir>]');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
  const source = release && release !== '-' ? path.resolve(release) : path.join(repo, 'dist', 'releases', `v${version}`);
  console.log(JSON.stringify(await install({ root, release: source, camoufoxSource: camoufoxSource ? path.resolve(camoufoxSource) : null }), null, 2));
}
