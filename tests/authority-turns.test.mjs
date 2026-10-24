import test from 'node:test';
import assert from 'node:assert/strict';
import { CallerAuthority, BROWSER_TOOL } from '../src/authority.mjs';

test('a trusted new user turn replaces the generation even if the preceding end notification was lost', () => {
  const authority = new CallerAuthority();
  const args = { action: 'observe', tabId: 'owned-page' };
  authority.begin('owner');
  const issue = callId => authority.issue({ sessionId: 'owner', callId, toolName: BROWSER_TOOL, args });
  const old = authority.consume(issue('first'), args);
  const unused = issue('unused');
  authority.begin('owner', { newTurn: true });
  assert.equal(old.signal.aborted, true);
  assert.throws(old.assertLive, /Caller ended/);
  assert.throws(() => authority.consume(unused, args), /Unknown|consumed|ended/);
  const current = authority.consume(issue('first'), args);
  assert.notEqual(current.signal, old.signal);
  authority.begin('owner');
  assert.equal(current.signal.aborted, false, 'Repeated session-start activation is still idempotent');
  current.assertLive();
  authority.close();
  assert.equal(current.signal.aborted, true);
});
