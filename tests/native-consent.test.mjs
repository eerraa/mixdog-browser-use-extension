import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('Windows consent availability returns an enum without displaying a verification prompt', async () => {
  const { stdout } = await promisify(execFile)(
    fileURLToPath(new URL('../build/native-consent.exe', import.meta.url)),
    ['--availability'], { timeout: 15_000, windowsHide: true },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.mode, 'availability');
  assert.equal(result.verified, false);
  assert.ok([0, 1, 2, 3, 4].includes(result.result));
  assert.equal(result.hresult, '0x00000000');
});
