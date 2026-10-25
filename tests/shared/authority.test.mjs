import test from 'node:test';
import assert from 'node:assert/strict';
import { CallerAuthority } from '../../src/shared/authority.mjs';

const make = () => new CallerAuthority({ now: () => 1_000 });
const call = (authority, sessionId = 'session-a', callId = 'call-1', args = { action: 'observe' }) =>
  authority.issue({ sessionId, callId, toolName: 'mcp__plugin-win-browser__browse', args });

test('a host-issued ticket is bound to exact arguments and can only be consumed once', () => {
  const authority = make();
  const ticket = call(authority);
  assert.throws(() => authority.consume(ticket, { action: 'click' }), /arguments/i);
  const caller = authority.consume(ticket, { action: 'observe' });
  assert.equal(caller.sessionId, 'session-a');
  assert.equal(caller.callId, 'call-1');
  assert.throws(() => authority.consume(ticket, { action: 'observe' }), /consumed|unknown/i);
  assert.throws(() => authority.consume('invented', {}), /unknown/i);
});

test('ended callers cannot issue or consume delayed calls; a new host turn is explicit', () => {
  const authority = make();
  const ticket = call(authority);
  authority.end('session-a', 'SessionEnd');
  assert.throws(() => authority.consume(ticket, { action: 'observe' }), /ended|unknown/i);
  assert.throws(() => call(authority), /ended/i);
  authority.begin('session-a');
  const caller = authority.consume(call(authority, 'session-a', 'call-2'), { action: 'observe' });
  assert.equal(caller.signal.aborted, false);
});

test('ending one caller aborts its admitted work without affecting another caller', () => {
  const authority = make();
  const first = authority.consume(call(authority), { action: 'observe' });
  const other = authority.consume(call(authority, 'session-b'), { action: 'observe' });
  authority.end('session-a', 'StopFailure');
  assert.equal(first.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  assert.throws(() => first.assertLive(), /ended/i);
  other.assertLive();
});

test('tickets expire before admission and a repeated host call id never creates a second action', () => {
  let now = 1_000;
  const authority = new CallerAuthority({ now: () => now, ticketLifetimeMs: 100 });
  const ticket = call(authority);
  now += 101;
  assert.throws(() => authority.consume(ticket, { action: 'observe' }), /expired/i);
  assert.throws(() => call(authority), /duplicate/i);
});

test('unrelated tools cannot acquire browser tickets, and object key order is immaterial', () => {
  const authority = make();
  assert.throws(() => authority.issue({
    sessionId: 'session-a', callId: 'other', toolName: 'mcp__another-plugin__browse', args: {},
  }), /tool/i);
  const ticket = call(authority, 'session-a', 'ordered', { action: 'observe', tab: 'p1' });
  const caller = authority.consume(ticket, { tab: 'p1', action: 'observe' });
  assert.equal(caller.sessionId, 'session-a');
});
