import test from 'node:test';
import assert from 'node:assert/strict';
import { CallerAuthority, BROWSER_TOOL } from '../src/authority.mjs';

test('a delivered end event fences even a previously unknown caller', () => {
  const authority = new CallerAuthority();
  authority.end('not-seen-yet', 'SessionEnd');
  assert.throws(() => authority.issue({
    sessionId: 'not-seen-yet', callId: 'late', toolName: BROWSER_TOOL, args: { action: 'observe' },
  }), /ended/i);
});

test('duplicate activation does not cancel an already active generation', () => {
  const authority = new CallerAuthority();
  authority.begin('caller');
  const args = { action: 'observe' };
  const ticket = authority.issue({ sessionId: 'caller', callId: 'one', toolName: BROWSER_TOOL, args });
  const admitted = authority.consume(ticket, args);
  authority.begin('caller');
  assert.equal(admitted.signal.aborted, false);
  admitted.assertLive();
});
