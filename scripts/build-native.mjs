import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This distribution targets Windows x64');
const licenseRoot = process.argv[2];
if (!licenseRoot) throw new Error('Usage: node scripts/build-native.mjs <MinGW compiler licenses directory>');
await mkdir(resolve(root, 'build'), { recursive: true });
for (const [source, output] of [['consent.cpp', 'native-consent.exe'], ['bridge.cpp', 'bridge.exe']]) {
  const result = spawnSync('g++', [
    '-std=c++17', '-O2', '-static', '-municode',
    resolve(root, 'native', source), '-o', resolve(root, 'build', output),
  ], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const output = resolve(root, 'build/licenses/native');
await mkdir(output, { recursive: true });
const texts = {
  'gcc/COPYING3': 'GCC-GPL-3.0.txt',
  'gcc/COPYING.RUNTIME': 'GCC-runtime-exception-3.1.txt',
  'mingw-w64/COPYING.MinGW-w64-runtime.txt': 'MinGW-w64-runtime.txt',
  'winpthreads/COPYING': 'winpthreads.txt',
};
for (const [source, target] of Object.entries(texts)) {
  await copyFile(resolve(licenseRoot, source), resolve(output, target));
}
const compiler = spawnSync('g++', ['--version'], { encoding: 'utf8', windowsHide: true });
if (compiler.error || compiler.status !== 0) throw compiler.error ?? new Error('Compiler provenance query failed');
await writeFile(resolve(output, 'provenance.json'), JSON.stringify({
  compiler: compiler.stdout.split(/\r?\n/)[0],
  sources: ['native/consent.cpp', 'native/bridge.cpp'],
  flags: ['-std=c++17', '-O2', '-static', '-municode'],
  licenses: Object.values(texts),
}, null, 2));
console.log('Built owned-job launcher and Windows-owned consent helper.');
