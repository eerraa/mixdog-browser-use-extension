// Derived from Mixdog 1.3.4 (commit 968ee08965e75c3fa1999ab8d18d20e45229fc89),
// apps/desktop/src/main/browser/cdp-execution.ts, Apache License 2.0.
// Independent fork; Mixdog changes after that commit are not tracked
// (third_party/mixdog/provenance.json).
// Changed: TypeScript types removed; the CDP request timeout the original
// imports from `./command` is a local constant.

/** A cancelled reply is not proof that Chromium stopped. Fence subsequent
 * commands until the original dispatch and any termination request settle. */
const CDP_REQUEST_TIMEOUT_MS = 15_000;

const EXECUTION_METHODS = new Set(['Runtime.evaluate', 'Runtime.callFunctionOn']);
// These release an already-blocked operation rather than start another input.
const CLEANUP_METHODS = new Set([
  'Runtime.terminateExecution',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'Page.handleJavaScriptDialog',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
  'Fetch.continueRequest',
  'Fetch.continueResponse',
]);
const CLEANUP_TIMEOUT_MS = 2_000;

/**
 * `host.bounded(promise, timeoutMs, label, signal?, onTimeout?)` bounds a wait,
 * `host.diagnostic(guest, message)` reports, and the optional
 * `host.awaitingDialog(guest)` says the page is parked on a dialog the host has
 * yet to answer.
 */
export function createBrowserCdpExecution(host) {
  const settling = new WeakMap();
  /** Commands in flight per child session, settled when that session ends. */
  const inFlight = new WeakMap();

  /** A child target detached: its frame was removed or replaced, so nothing
   *  of its document can still run. Chromium never answers a command that was
   *  in flight on it (the reply only comes once the whole page is destroyed),
   *  which would hold the fence on this page forever; settle those here. */
  function endSession(guest, sessionId) {
    const sessions = inFlight.get(guest);
    const pending = sessions?.get(sessionId);
    if (!sessions || !pending) return;
    sessions.delete(sessionId);
    for (const end of pending) end(new Error('Inspected target navigated or closed (frame target detached)'));
  }

  function send(guest, cdp, method, params, sessionId) {
    const sent = cdp.sendCommand(method, params, sessionId);
    if (!sessionId) return sent;
    let sessions = inFlight.get(guest);
    if (!sessions) {
      sessions = new Map();
      inFlight.set(guest, sessions);
    }
    let pending = sessions.get(sessionId);
    if (!pending) {
      pending = new Set();
      sessions.set(sessionId, pending);
    }
    const owners = sessions;
    const group = pending;
    let end;
    const ended = new Promise((_resolve, reject) => {
      end = reject;
    });
    group.add(end);
    return Promise.race([sent, ended]).finally(() => {
      group.delete(end);
      if (!group.size && owners.get(sessionId) === group) owners.delete(sessionId);
    });
  }

  async function waitForIdle(guest, signal) {
    signal?.throwIfAborted();
    for (;;) {
      const barrier = settling.get(guest);
      if (!barrier) return;
      await host.bounded(
        barrier,
        CLEANUP_TIMEOUT_MS,
        'browser execution cleanup is pending; wait or reload the page before retrying',
        signal
      );
      signal?.throwIfAborted();
    }
  }

  async function sendCdp(
    guest,
    cdp,
    method,
    params = {},
    timeoutMs = CDP_REQUEST_TIMEOUT_MS,
    signal,
    sessionId,
    beforeDispatch
  ) {
    signal?.throwIfAborted();
    if (!CLEANUP_METHODS.has(method)) {
      // Recheck after each wait: another concurrent observation may have been
      // interrupted while this one was waiting for the previous generation.
      while (settling.has(guest)) await waitForIdle(guest, signal);
    }
    signal?.throwIfAborted();
    beforeDispatch?.();
    const dispatch = send(guest, cdp, method, params, sessionId);
    let interrupted = false;
    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      const previous = settling.get(guest);
      // A script stuck behind an open dialog is waiting for handle_dialog, not
      // running away. Termination cannot land while the dialog holds it, so V8
      // keeps the request and kills the script the moment the answer arrives —
      // the page never sees the value handle_dialog reported as delivered.
      const terminate =
        EXECUTION_METHODS.has(method) && !host.awaitingDialog?.(guest)
          ? Promise.resolve()
              .then(() =>
                host.bounded(
                  send(guest, cdp, 'Runtime.terminateExecution', {}, sessionId),
                  CLEANUP_TIMEOUT_MS,
                  'browser execution termination'
                )
              )
              .catch((error) => {
                host.diagnostic(guest, `CDP execution cleanup: ${String(error)}`);
              })
          : Promise.resolve();
      const barrier = Promise.allSettled([previous, dispatch, terminate]).then(() => undefined);
      settling.set(guest, barrier);
      // A cleanup timeout does not remove the fence. The actual old dispatch
      // must finish, be rejected by navigation/destruction, or lose its child
      // target (endSession) before reuse.
      void barrier.then(() => {
        if (settling.get(guest) === barrier) settling.delete(guest);
      });
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    // A synchronous bridge implementation can cancel during sendCommand.
    if (signal?.aborted) interrupt();
    try {
      return await host.bounded(dispatch, timeoutMs, `CDP ${method}`, signal, () => {
        interrupt();
        host.diagnostic(guest, `CDP ${method} timed out`);
      });
    } finally {
      signal?.removeEventListener('abort', interrupt);
    }
  }

  return { sendCdp, waitForIdle, endSession };
}
