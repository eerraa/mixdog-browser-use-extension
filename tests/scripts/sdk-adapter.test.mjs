import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adaptSdkCancellation } from '../../scripts/sdk-adapter.mjs';

test('pinned SDK adaptation admits zero without changing its other cancellation handling', async () => {
  const sourcePath = new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js', import.meta.url);
  const source = await readFile(sourcePath, 'utf8');
  const adapted = adaptSdkCancellation(source, '1.32.1');
  const compile = text => {
    const method = text.match(/async _oncancel\(notification\) \{([\s\S]*?)\n    \}/);
    assert.ok(method);
    return new Function('notification', method[1]);
  };
  for (const id of [0, 17, 'tool-request']) {
    const controller = new AbortController();
    compile(adapted).call({ _requestHandlerAbortControllers: new Map([[id, controller]]) },
      { params: { requestId: id, reason: 'test cancellation' } });
    assert.equal(controller.signal.aborted, true);
    assert.equal(controller.signal.reason, 'test cancellation');
  }
  assert.doesNotThrow(() => compile(adapted).call({}, { params: {} }));
  assert.throws(() => adaptSdkCancellation(source, '1.32.2'), /version/);
  assert.throws(() => adaptSdkCancellation(adapted, '1.32.1'), /source mismatch/);
  assert.throws(() => adaptSdkCancellation(source + source, '1.32.1'), /source mismatch/);
  assert.equal(await readFile(sourcePath, 'utf8'), source, 'The installed dependency must stay untouched');
});
