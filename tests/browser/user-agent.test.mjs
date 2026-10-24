import test from 'node:test';
import assert from 'node:assert/strict';
import { configureBrowserIdentity } from '../../src/browser/user-agent.mjs';

test('companion identity removes only its desktop products and is idempotent', () => {
  const original = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) IndependentWindowsBrowser/44.9.1 Chrome/152.0.7977.167 Electron/44.9.1 Safari/537.36';
  const expected = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.167 Safari/537.36';
  const app = { userAgentFallback: original, name: 'Independent Windows Browser', permissions: {} };
  const permissions = app.permissions;
  const otherApplication = { userAgentFallback: original };
  configureBrowserIdentity(app);
  assert.equal(app.userAgentFallback, expected);
  configureBrowserIdentity(app);
  assert.equal(app.userAgentFallback, expected);
  assert.equal(app.name, 'Independent Windows Browser');
  assert.equal(app.permissions, permissions);
  assert.equal(otherApplication.userAgentFallback, original);
});

test('companion identity never substitutes an engine version or removes unrelated browser products', () => {
  const app = { userAgentFallback: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OtherProduct/7.2 Chrome/999.1.2.3 Electron/99.4 Safari/537.36' };
  configureBrowserIdentity(app);
  assert.equal(app.userAgentFallback, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OtherProduct/7.2 Chrome/999.1.2.3 Safari/537.36');
});
