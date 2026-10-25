import { createHash, randomBytes } from 'node:crypto';

export const BROWSER_TOOL = 'mcp__plugin-win-browser__browse';

export function withoutLease(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Browser arguments must be an object');
  const { _lease, ...body } = args;
  return body;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(args) {
  return createHash('sha256').update(canonical(withoutLease(args))).digest('hex');
}

/** Tickets originate in the host's PreToolUse payload, never model arguments.
 * A browser connection owns this in-memory authority; restarting it cannot
 * resurrect old tickets. Host lifecycle hooks and transport cancellation are
 * complementary evidence, not a claim that best-effort hooks cannot be lost.
 */
export class CallerAuthority {
  #callers = new Map();
  #tickets = new Map();
  #now;
  #lifetime;
  #closed = false;

  constructor({ now = Date.now, ticketLifetimeMs = 10_000 } = {}) {
    this.#now = now;
    this.#lifetime = ticketLifetimeMs;
  }

  begin(sessionId, { newTurn = false } = {}) {
    if (this.#closed) throw new Error('Browser connection ended');
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Missing host session identity');
    const current = this.#callers.get(sessionId);
    if (current?.active && !newTurn) return current;
    this.end(sessionId, 'New host turn');
    const state = { sessionId, active: true, controller: new AbortController(), calls: new Set() };
    this.#callers.set(sessionId, state);
    return state;
  }

  end(sessionId, reason = 'Host caller ended') {
    let state = this.#callers.get(sessionId);
    if (!state) {
      state = { sessionId, active: false, controller: new AbortController(), calls: new Set() };
      this.#callers.set(sessionId, state);
    }
    state.active = false;
    state.controller.abort(new Error(`Caller ended: ${reason}`));
    for (const [ticket, entry] of this.#tickets) if (entry.state === state) this.#tickets.delete(ticket);
  }

  issue({ sessionId, callId, toolName, args }) {
    if (this.#closed) throw new Error('Browser connection ended');
    if (toolName !== BROWSER_TOOL) throw new Error('This hook authorizes only the plugin browser tool');
    if (typeof sessionId !== 'string' || !sessionId.trim() ||
        typeof callId !== 'string' || !callId.trim()) throw new Error('Host session and call identities are required');
    let state = this.#callers.get(sessionId);
    if (!state) state = this.begin(sessionId);
    if (!state.active) throw new Error('Caller ended; only a new host turn may reopen it');
    if (state.calls.has(callId)) throw new Error('Duplicate host call id; action was not reissued');
    const hash = digest(args);
    state.calls.add(callId);
    const ticket = randomBytes(32).toString('base64url');
    this.#tickets.set(ticket, { state, callId, hash, expires: this.#now() + this.#lifetime });
    return ticket;
  }

  consume(ticket, args) {
    const entry = this.#tickets.get(ticket);
    if (!entry) throw new Error('Unknown or consumed caller ticket; run through the plugin hook');
    if (!entry.state.active) throw new Error('Caller ended');
    if (entry.expires < this.#now()) {
      this.#tickets.delete(ticket);
      throw new Error('Caller ticket expired before admission; no action was dispatched');
    }
    if (entry.hash !== digest(args)) throw new Error('Caller ticket arguments differ from the host-authorized call');
    this.#tickets.delete(ticket);
    const assertLive = () => {
      if (!entry.state.active || this.#callers.get(entry.state.sessionId) !== entry.state) throw new Error('Caller ended');
      entry.state.controller.signal.throwIfAborted();
    };
    return {
      sessionId: entry.state.sessionId,
      callId: entry.callId,
      signal: entry.state.controller.signal,
      assertLive,
    };
  }

  close(reason = 'Browser connection ended') {
    if (this.#closed) return;
    this.#closed = true;
    for (const sessionId of this.#callers.keys()) this.end(sessionId, reason);
    this.#tickets.clear();
  }
}
