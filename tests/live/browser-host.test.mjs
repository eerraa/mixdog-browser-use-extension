import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function launch(data, argument, marker) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'),
    [path.join(root, 'tests/live/harness.mjs'), data, argument], {
      cwd: root, env, windowsHide: false,
    });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 140_000);
  const code = await new Promise(resolve => {
    child.on('error', error => { stderr += `${error.stack}\n`; resolve(-1); });
    child.on('exit', resolve);
  }).finally(() => clearTimeout(timer));
  await Promise.all([
    writeFile(path.join(data, 'stdout.log'), stdout),
    writeFile(path.join(data, 'stderr.log'), stderr),
  ]);
  console.log(`Live browser logs: ${data}`);
  assert.equal(code, 0, `Electron exit ${code}\n${stdout}\n${stderr}`);
  assert.ok(stdout.includes(marker), `Missing harness marker ${marker}`);
  return stdout;
}

test('independent Electron host: local browser behavioral contract', { timeout: 150_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'independent-browser-live-'));
  const baselineData = await mkdtemp(path.join(workspace, 'baseline-'));
  const data = await mkdtemp(path.join(workspace, 'normalized-'));
  const baseline = await launch(baselineData, 'baseline', 'UA_BASELINE_RESULT ');
  const match = baseline.match(/^UA_BASELINE_RESULT (.+)$/m);
  assert.ok(match, 'Untouched companion must supply actual identity evidence');
  const baselinePath = path.join(workspace, 'identity-baseline.json');
  await writeFile(baselinePath, JSON.stringify(JSON.parse(match[1])));
  await launch(data, baselinePath, 'BROWSER_CONTRACT_PASSED');
});
