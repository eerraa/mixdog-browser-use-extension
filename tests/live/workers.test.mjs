import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('real Electron preserves worker startup in both modes and hidden worker-backed rendering', { timeout: 60000 }, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-workers-live-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'),
    [path.join(root, 'tests/live/workers-harness.mjs'), directory], { cwd: root, env, windowsHide: false });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill(), 50000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).finally(() => clearTimeout(timer));
  await Promise.all([
    writeFile(path.join(directory, 'stdout.log'), stdout),
    writeFile(path.join(directory, 'stderr.log'), stderr),
  ]);
  console.log(`Worker browser logs: ${directory}`);
  assert.equal(code, 0, `Electron exit ${code}\n${stdout}\n${stderr}`);
  assert.doesNotMatch(stderr, /UnhandledPromiseRejectionWarning|uncaught exception/i);
  assert.ok(stdout.includes('WORKER_CONTRACT_PASSED'));
});
