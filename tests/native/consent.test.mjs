import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const helper = process.env.WB_INPUT_HELPER ?? fileURLToPath(new URL('../../build/native-consent.exe', import.meta.url));

test('Windows consent availability returns an enum without displaying a verification prompt', async () => {
  const { stdout } = await promisify(execFile)(
    helper,
    ['--availability'], { timeout: 15_000, windowsHide: true },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.mode, 'availability');
  assert.equal(result.verified, false);
  assert.ok([0, 1, 2, 3, 4].includes(result.result));
  assert.equal(result.hresult, '0x00000000');
});

test('input-idle reports unknown for invalid owners without a prompt or key identities', async () => {
  for (const args of [['--input-idle'], ['--input-idle', '0x0', String(process.pid)], ['--input-idle', 'invalid', '0']]) {
    const { stdout } = await promisify(execFile)(helper, args, { timeout: 3000, windowsHide: true });
    assert.deepEqual(JSON.parse(stdout), { mode: 'input-idle', known: false, idle: false });
  }
});

test('native input scan detects physical keys and mouse buttons while ignoring historical low bits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-input-state-'));
  const executable = path.join(directory, 'input-state.exe');
  try {
    await promisify(execFile)('g++', ['-std=c++17', '-O2', '-static', '-municode',
      fileURLToPath(new URL('./input-state.cpp', import.meta.url)), '-o', executable], { timeout: 30000, windowsHide: true });
    const { stdout } = await promisify(execFile)(executable, [], { timeout: 3000, windowsHide: true });
    assert.match(stdout, /INPUT_STATE_BITS_PASSED/);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('browser-input-state-'));
    await rm(directory, { recursive: true, force: true });
  }
});
