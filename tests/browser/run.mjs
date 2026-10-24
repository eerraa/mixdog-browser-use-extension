// Narrow test runner retaining execution logs, not a generated verification report.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'independent-browser-check-'));
const selected = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', ...(selected.length ? selected : [
  'tests/browser/contract.test.mjs', 'tests/browser/frames.test.mjs', 'tests/browser/host.test.mjs',
  'tests/browser/policy.test.mjs', 'tests/browser/requests.test.mjs',
  'tests/browser/dialogs.test.mjs', 'tests/browser/user-agent.test.mjs', 'tests/browser/devtools.test.mjs',
  'tests/browser/perception.test.mjs', 'tests/browser/runner.test.mjs'])], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data; process.stdout.write(data); });
child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
const timer = setTimeout(() => child.kill(), 30000);
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
clearTimeout(timer);
await Promise.all([writeFile(path.join(directory, 'stdout.log'), stdout), writeFile(path.join(directory, 'stderr.log'), stderr)]);
console.log(`Browser unit logs: ${directory}`);
process.exitCode = code ?? 1;
