// Derived from Mixdog 1.3.4 (commit 968ee08965e75c3fa1999ab8d18d20e45229fc89),
// apps/desktop/src/main/browser/actionability.ts, Apache License 2.0.
// Independent fork; Mixdog changes after that commit are not tracked
// (third_party/mixdog/provenance.json).
// Changed: TypeScript types removed; `pause` comes from this plugin's async
// helper instead of `./settle`.

/** Retry only read-only preflight failures, never an input or its verification. */
import { pause } from '../async.mjs';

export class BrowserActionabilityError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
    this.name = 'BrowserActionabilityError';
  }
}

export async function waitForBrowserActionable(probe, signal, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const result = await probe();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof BrowserActionabilityError)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      await pause(Math.min(100, remaining), signal);
    }
  }
}
