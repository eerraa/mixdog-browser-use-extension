import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('real Electron browser sessions: storage, tabs, DevTools, handoff and scoped cleanup', { timeout: 90000 }, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  // Chromium's nested on-disk CacheStorage index paths hit Windows MAX_PATH
  // with a long fixture prefix; keep the real default profile path unchanged.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wb-ses-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'),
    [path.join(root, 'tests/live/sessions-harness.mjs'), directory], { cwd: root, env, windowsHide: false });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill(), 80000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).finally(() => clearTimeout(timer));
  await Promise.all([writeFile(path.join(directory, 'stdout.log'), stdout), writeFile(path.join(directory, 'stderr.log'), stderr)]);
  console.log(`Sessions browser logs: ${directory}`);
  assert.equal(code, 0, `Electron exit ${code}\n${stdout}\n${stderr}`);
  assert.ok(stdout.includes('SESSIONS_CONTRACT_PASSED'), stdout);
});
