import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'dist'), { recursive: true });
const allocation = await mkdtemp(path.join(root, 'dist/win-browser-'));
// The host derives the registry/server-name stem from the registered folder's
// basename. Keep it stable while allocating every build without overwriting.
const destination = path.join(allocation, 'win-browser');
await mkdir(destination);
const put = async (source, target = source) => {
  const output = path.join(destination, target);
  await mkdir(path.dirname(output), { recursive: true });
  await copyFile(path.join(root, source), output);
};
for (const name of ['plugin.json', 'browser-policy.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'upstream.lock.json']) await put(name);
for (const name of ['hooks', 'skills']) await cp(path.join(root, name), path.join(destination, name), { recursive: true });
await cp(path.join(root, 'node_modules/electron/dist'), path.join(destination, 'runtime'), { recursive: true });
await cp(path.join(root, 'build/app'), path.join(destination, 'app'), { recursive: true });
await cp(path.join(root, 'build/licenses'), path.join(destination, 'licenses'), { recursive: true });
await put('build/bridge.exe', 'bin/bridge.exe');
await put('build/native-consent.exe', 'bin/native-consent.exe');
// Exactly the locked upstream artifacts, each verified against its locked git
// blob id now; a file dropped from the lock is never shipped from a stale
// vendor directory, and a modified one stops the package.
for (const [name, expected] of Object.entries(JSON.parse(await readFile(path.join(root, 'upstream.lock.json'), 'utf8')).files)) {
  const bytes = await readFile(path.join(root, 'vendor/mixdog', name));
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Vendored file differs from upstream.lock.json: ${name}`);
  await put(`vendor/mixdog/${name}`);
}
await put('vendor/mixdog/LICENSE', 'LICENSE');
for (const name of ['consent.cpp', 'bridge.cpp']) await put(`native/${name}`, `sources/native/${name}`);

// The compiler's actual import graph, not package.json's entire dependency
// tree, determines which npm license texts accompany the bundled runtime.
const inputs = JSON.parse(await readFile(path.join(root, 'build/bundle-inputs.json'), 'utf8'));
const packageRoots = new Map();
for (const input of inputs) {
  const parts = input.replace(/\\/g, '/').split('/');
  const index = parts.lastIndexOf('node_modules');
  if (index < 0) continue;
  const count = parts[index + 1].startsWith('@') ? 2 : 1;
  const module = parts.slice(index + 1, index + 1 + count).join('/');
  packageRoots.set(module, path.resolve(root, ...parts.slice(0, index + 1 + count)));
}
const inventory = [];
for (const [name, directory] of [...packageRoots].sort(([a], [b]) => a.localeCompare(b))) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.name !== name) throw new Error(`Bundled package identity mismatch: ${name}`);
  const entries = await readdir(directory, { withFileTypes: true });
  const licenses = entries.filter(e => e.isFile() && /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(e.name));
  if (!licenses.length) throw new Error(`No redistributable license text found for bundled package ${name}`);
  const relative = `licenses/npm/${name.replaceAll('/', '__')}`;
  await mkdir(path.join(destination, relative), { recursive: true });
  for (const license of licenses) await copyFile(path.join(directory, license.name), path.join(destination, relative, license.name));
  inventory.push({
    name, version: metadata.version, license: metadata.license,
    texts: licenses.map(license => `${relative}/${license.name}`),
  });
}
await writeFile(path.join(destination, 'licenses/npm-packages.json'), JSON.stringify(inventory, null, 2));
console.log(JSON.stringify({ directory: destination, runtime: 'Electron 44.9.1', bundledPackages: inventory.map(p => p.name) }));
