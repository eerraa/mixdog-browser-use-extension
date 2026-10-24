import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('script runner in real Electron: sandbox isolation, bridge refusals, form flow, seal, Stop, handoff and deadline', { timeout: 120000 }, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-runner-live-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'),
    [path.join(root, 'tests/live/runner-harness.mjs'), directory], { cwd: root, env });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill(), 110000);
  const code = await new Promise(resolve => {
    child.once('error', error => { stderr += error.stack; resolve(-1); });
    child.once('exit', resolve);
  }).finally(() => clearTimeout(timer));
  await Promise.all([
    writeFile(path.join(directory, 'stdout.log'), stdout),
    writeFile(path.join(directory, 'stderr.log'), stderr),
  ]);
  console.log(`Runner logs: ${directory}`);
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /RUNNER_LIVE_PASSED/);
});
