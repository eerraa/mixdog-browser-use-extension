import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('local application verification handles native requests autonomously in real Electron', { timeout: 120000 }, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const data = await mkdtemp(path.join(os.tmpdir(), 'browser-autonomous-live-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'),
    [path.join(root, 'tests/live/autonomous-harness.mjs'), data], { cwd: root, env, windowsHide: false });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 110000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).finally(() => clearTimeout(timer));
  await Promise.all([
    writeFile(path.join(data, 'stdout.log'), stdout),
    writeFile(path.join(data, 'stderr.log'), stderr),
  ]);
  console.log(`Autonomous browser logs: ${data}`);
  assert.equal(code, 0, `Electron exit ${code}\n${stdout}\n${stderr}`);
  assert.doesNotMatch(stderr, /UnhandledPromiseRejectionWarning|uncaught exception/i);
  assert.ok(stdout.includes('AUTONOMOUS_APP_VERIFICATION_PASSED'));
});
