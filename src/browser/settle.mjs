// Bounded settle after an ACKNOWLEDGED dispatch (decision D16), after Chrome
// DevTools MCP's WaitForHelper (Apache-2.0; algorithm only, no code copied):
// a short navigation probe, a bounded wait for the new document, then a quiet
// window in the root and target frames. Settle never sends input; its outcome
// only shapes the result observation.

export const SETTLE_BOUNDS = Object.freeze({
  probeMs: 150, navigationMs: 3000, quietMs: 100, capMs: 1000, shortCapMs: 500, requestPollMs: 25,
});

const defaults = { now: () => performance.now(), sleep: (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
}) };

/**
 * Arm BEFORE dispatch. subscribe(listener) must call listener({kind}) for
 * root or target-frame cross-document navigation events, kind one of
 * 'start' | 'ready' (DOM content loaded) | 'fail', and return an unsubscribe.
 */
export function armNavigation(subscribe, { now = defaults.now } = {}) {
  const events = [];
  const waiters = new Set();
  const unsubscribe = subscribe(event => {
    events.push({ ...event, at: now() });
    for (const waiter of [...waiters]) waiter();
  });
  // Readiness counts only after the latest start: the old document finishing
  // its own load is not the new document being ready.
  const latest = () => events.slice(events.findLastIndex(event => event.kind === 'start') + 1);
  const armed = {
    events,
    started: () => events.some(event => event.kind === 'start'),
    finished: () => latest().some(event => event.kind === 'ready' || event.kind === 'fail'),
    failed: () => latest().find(event => event.kind === 'fail') ?? null,
    // Resolves true once predicate() holds, false after ms.
    until(predicate, ms) {
      if (predicate()) return Promise.resolve(true);
      return new Promise(resolve => {
        const done = value => { clearTimeout(timer); waiters.delete(check); resolve(value); };
        const check = () => { if (predicate()) done(true); };
        const timer = setTimeout(() => done(false), ms);
        waiters.add(check);
      });
    },
    dispose() { unsubscribe?.(); for (const waiter of waiters) waiters.delete(waiter); },
  };
  return armed;
}

/**
 * quiet(ms, capMs) resolves {quiet} from the page (walker `quiet`); it may
 * reject when its document goes away. pendingRequests() counts requests the
 * action started that are still running (DevTools recorder; optional).
 * interrupt resolves with a reason (dialog, popup) to end the settle early.
 * Rejects only with signal.reason when the caller aborts.
 */
export async function settle({ armed, quiet, pendingRequests, interrupt, signal, short = false, bounds = {},
  now = defaults.now, sleep = defaults.sleep } = {}) {
  const b = { ...SETTLE_BOUNDS, ...bounds };
  const start = now();
  const result = { navigated: false, loading: false, failed: false, quiet: false, interrupted: null, ms: 0 };
  const INTERRUPTED = Symbol('interrupted');
  const stop = new Promise((resolve, reject) => {
    interrupt?.then(reason => { result.interrupted = reason ?? 'interrupted'; resolve(INTERRUPTED); });
    if (signal) {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }
  });
  stop.catch(() => {});
  const race = promise => Promise.race([promise, stop]);
  const finish = () => { result.ms = Math.round(now() - start); return result; };
  const awaitDocument = async () => {
    result.navigated = true;
    const ready = await race(armed.until(armed.finished, b.navigationMs));
    if (ready === INTERRUPTED) return false;
    if (!ready) { result.loading = true; return false; }
    if (armed.failed()) { result.failed = true; return false; }
    return true;
  };

  if (armed) {
    const started = await race(armed.until(armed.started, b.probeMs));
    if (started === INTERRUPTED) return finish();
    if (started && !(await awaitDocument())) return finish();
  }
  const cap = short ? b.shortCapMs : b.capMs;
  let deadline = now() + cap;
  const quietOnce = async () => {
    deadline = now() + cap;
    try {
      const outcome = await race(quiet(b.quietMs, cap));
      if (outcome === INTERRUPTED) return false;
      result.quiet = !!outcome?.quiet;
    } catch (error) {
      if (signal?.aborted) throw error;
      result.quiet = false;
    }
    return true;
  };
  if (!(await quietOnce())) return finish();
  // A navigation the action started late (after a fetch, a timer) still
  // replaces the document; wait for it instead of observing the old one.
  if (armed && !result.navigated && armed.started()) {
    if (!(await awaitDocument())) return finish();
    if (!(await quietOnce())) return finish();
  }
  while (pendingRequests && now() < deadline && pendingRequests() > 0) {
    if ((await race(sleep(b.requestPollMs, signal))) === INTERRUPTED) break;
  }
  return finish();
}
