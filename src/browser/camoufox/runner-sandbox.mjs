// Dedicated hardened headless Camoufox sandbox for `run` scripts (D20/D22/D31).
// Every run gets its OWN dedicated, single-use, network-locked headless Camoufox
// process (WebRTC off, DNS prefetch/preconnect off, dead fixed proxy 127.0.0.1:9,
// request interception aborting all non-bootstrap requests, strict CSP `default-src
// 'none'`), and destroy() hard-terminates that process tree immediately so even
// CPU-bound loops end cleanly with zero cross-run or cross-caller state sharing.
// To move cold-start (~1.5-2s) off the critical path for consecutive runs without
// ever reusing a used process, the factory keeps at most ONE pre-started UNUSED
// blank spare (loaded only to CAMOUFOX_BOOTSTRAP_URL with no caller data, binding,
// nonce, or script) with an idle TTL; leasing it consumes it exclusively and
// asynchronously replenishes a fresh unused spare in the background.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CamoufoxProcess } from './juggler.mjs';

const RUNNER_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; style-src 'none'; "
  + "font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; "
  + "manifest-src 'none'; base-uri 'none'; form-action 'none'";
export const CAMOUFOX_BOOTSTRAP_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${RUNNER_CSP}">`
  + '<meta http-equiv="x-dns-prefetch-control" content="off"><title>script runner</title>')}`;

const BRIDGE_BINDING = '__wbRunnerOp';
const DEFAULT_SPARE_IDLE_MS = 60000;

function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function waitCondition(check, addWaiter, removeWaiter, timeoutMs, label, signal) {
  if (check()) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      removeWaiter(wake);
      signal?.removeEventListener('abort', onAbort);
    };
    const wake = () => { if (check()) { cleanup(); resolve(); } };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(label)); }, timeoutMs);
    timer.unref?.();
    addWaiter(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Boot one clean, unused, hardened headless Camoufox instance navigated to the
 * exact bootstrap URL, with zero caller data, bindings, nonces, or scripts.
 */
async function bootUnusedInstance({ executablePath, createProcess, signal, trackCleanup }) {
  signal?.throwIfAborted();
  const profileDir = mkdtempSync(path.join(tmpdir(), 'wb-cfx-run-'));
  const proc = createProcess
    ? createProcess({ executablePath, profileDir, headless: true, enableRdp: false, hardenedRunner: true })
    : new CamoufoxProcess({ executablePath, profileDir, headless: true, enableRdp: false, hardenedRunner: true });

  let destroyed = false;
  let sessionId = null;
  let frameId = null;
  let mainContextId = null;
  let bootstrapCommitted = false;
  let loadFired = false;
  let activeRun = null; // { nonce, onOp, onConsole, inflightOps, active }
  const waiters = new Set();
  const notify = () => { for (const fn of [...waiters]) fn(); };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (activeRun) activeRun.active = false;
    notify();
    const cleanup = Promise.resolve(proc.close({ force: true })).catch(() => {}).finally(() => {
      const removeProfile = () => { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } };
      removeProfile();
      // Retry once briefly on Windows if AV/file handle lingered right after process exit.
      const t = setTimeout(removeProfile, 200);
      t.unref?.();
    });
    trackCleanup(cleanup);
    return cleanup;
  };

  proc.on('message', (method, params, sid) => {
    if (destroyed) return;
    if (method === 'Browser.attachedToTarget' && !sessionId && params.targetInfo?.browserContextId === browserContextId) {
      sessionId = params.sessionId;
      notify();
      return;
    }
    if (sid !== sessionId) return;
    if (method === 'Network.requestWillBeSent' && params.isIntercepted) {
      proc.sendRaw('Network.abortInterceptedRequest', {
        requestId: params.requestId, errorCode: 'accessdenied',
      }, sessionId, 3000).catch(() => {});
      return;
    }
    if (method === 'Page.frameAttached' && !params.parentFrameId) {
      frameId = params.frameId;
      notify();
      return;
    }
    if (method === 'Runtime.executionContextCreated' && params.auxData?.frameId === frameId && !params.auxData?.name) {
      mainContextId = params.executionContextId;
      notify();
      return;
    }
    if (method === 'Runtime.executionContextDestroyed' && params.executionContextId === mainContextId) {
      mainContextId = null;
      return;
    }
    if (method === 'Runtime.executionContextsCleared') {
      mainContextId = null;
      return;
    }
    if (method === 'Page.navigationCommitted' && params.frameId === frameId) {
      bootstrapCommitted = String(params.url || '') === CAMOUFOX_BOOTSTRAP_URL;
      notify();
      return;
    }
    if (method === 'Page.eventFired' && (params.name === 'load' || params.name === 'DOMContentLoaded') && params.frameId === frameId && bootstrapCommitted) {
      loadFired = true;
      notify();
      return;
    }
    if (!activeRun || !activeRun.active || !bootstrapCommitted) return;
    if (method === 'Runtime.console') {
      if (params.executionContextId && mainContextId && params.executionContextId !== mainContextId) return;
      const text = (params.args ?? []).map(a => (a?.type === 'string' ? a.value : a?.value !== undefined ? String(a.value) : a?.type ?? '')).join(' ');
      activeRun.onConsole(params.type === 'warning' ? 'warn' : params.type || 'log', text);
      return;
    }
    if (method === 'Page.bindingCalled' && params.name === BRIDGE_BINDING) {
      if (params.executionContextId && mainContextId && params.executionContextId !== mainContextId) return;
      const run = activeRun;
      let req;
      try { req = JSON.parse(String(params.payload ?? '')); } catch { return; }
      const callId = Number(req?.id);
      const given = Buffer.from(typeof req?.nonce === 'string' ? req.nonce : '');
      const expected = Buffer.from(run.nonce);
      const sendBack = reply => {
        if (destroyed || !run.active || !mainContextId || !bootstrapCommitted) return;
        proc.sendRaw('Runtime.evaluate', {
          executionContextId: mainContextId,
          expression: `window.__wbResolve?.(${callId}, ${JSON.stringify(reply)})`,
          returnByValue: true,
        }, sessionId, 5000).catch(() => {});
      };
      if (!Number.isInteger(callId) || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        sendBack({ ok: false, error: { code: 'RUNNER_REFUSED', kind: 'not-executed', message: 'Bad runner nonce' } });
        return;
      }
      const flight = Promise.resolve().then(() => run.onOp(String(req.op ?? ''), req.args))
        .then(reply => sendBack(reply), error => sendBack({ ok: false, error: { code: error?.code ?? 'RUNNER_ERROR', kind: 'not-executed', message: String(error?.message ?? error) } }));
      run.inflightOps.add(flight);
      flight.finally(() => run.inflightOps.delete(flight));
    }
  });

  let browserContextId = null;
  try {
    await proc.start(signal);
    signal?.throwIfAborted();
    const created = await proc.send('Browser.createBrowserContext', { removeOnDetach: true }, undefined, signal ? { signal } : undefined);
    browserContextId = created.browserContextId;
    await Promise.all([
      proc.send('Browser.setContextProxy', {
        browserContextId, type: 'http', host: '127.0.0.1', port: 9, bypass: [],
      }, undefined, signal ? { signal } : undefined),
      proc.send('Browser.setRequestInterception', { browserContextId, enabled: true }, undefined, signal ? { signal } : undefined),
    ]);
    await proc.send('Browser.newPage', { browserContextId }, undefined, signal ? { signal } : undefined);
    await waitCondition(() => Boolean(sessionId && frameId), fn => waiters.add(fn), fn => waiters.delete(fn), 4000, 'Runner Camoufox page failed to attach', signal);

    mainContextId = null;
    bootstrapCommitted = false;
    loadFired = false;
    await proc.send('Page.navigate', { frameId, url: CAMOUFOX_BOOTSTRAP_URL }, sessionId, signal ? { signal } : undefined);
    // Exact bootstrap URL commit + main execution context guarantees the empty
    // zero-subresource CSP document is ready; wait briefly for load/DCL without
    // stalling 4s if Firefox suppresses load on data: URLs.
    await waitCondition(() => Boolean(bootstrapCommitted && mainContextId), fn => waiters.add(fn), fn => waiters.delete(fn), 4000, 'Runner Camoufox bootstrap context unavailable', signal);
    if (!loadFired) {
      await waitCondition(() => loadFired, fn => waiters.add(fn), fn => waiters.delete(fn), 120, 'load', signal).catch(() => {});
    }

    return {
      isAlive: () => !destroyed && !proc.closed && bootstrapCommitted && Boolean(sessionId && mainContextId),
      destroy,
      async bindAndLease({ onOp, onConsole = () => {}, signal: runSignal }) {
        if (destroyed || proc.closed || !bootstrapCommitted || !mainContextId) {
          throw new Error('Runner spare became unavailable');
        }
        const nonce = randomBytes(32).toString('base64url');
        activeRun = { nonce, onOp, onConsole, inflightOps: new Set(), active: true };
        await proc.send('Page.addBinding', { name: BRIDGE_BINDING, script: '' }, sessionId, runSignal ? { signal: runSignal } : undefined);
        const bridgeSetup = `(() => {
          const send = globalThis[${JSON.stringify(BRIDGE_BINDING)}];
          try { delete globalThis[${JSON.stringify(BRIDGE_BINDING)}]; } catch {}
          const waiters = new Map();
          let seq = 1;
          Object.defineProperty(window, '__wbResolve', {
            value: (id, reply) => { const fn = waiters.get(id); if (fn) { waiters.delete(id); fn(reply); } },
            enumerable: false, configurable: false, writable: false,
          });
          Object.defineProperty(window, '__wbBridge', {
            value: Object.freeze({
              call: (op, args) => new Promise(resolve => {
                const id = seq++;
                waiters.set(id, resolve);
                send(JSON.stringify({ id, nonce: ${JSON.stringify(nonce)}, op: String(op), args }));
              }),
            }),
            enumerable: false, configurable: false, writable: false,
          });
        })()`;
        await proc.send('Runtime.evaluate', {
          executionContextId: mainContextId, expression: bridgeSetup, returnByValue: true,
        }, sessionId, runSignal ? { signal: runSignal } : undefined);

        return {
          evaluate: async source => {
            const reply = await proc.send('Runtime.evaluate', {
              executionContextId: mainContextId, expression: source, returnByValue: true,
            }, sessionId, { timeoutMs: 110000 });
            if (reply.exceptionDetails) {
              throw new Error(String(reply.exceptionDetails.text || reply.exceptionDetails.stack || 'Runner evaluation failed'));
            }
            return reply.result?.value;
          },
          destroy,
        };
      },
    };
  } catch (error) {
    destroy();
    throw error;
  }
}

export function createCamoufoxRunnerSandboxFactory({
  executablePath,
  createProcess = null,
  enableWarmSpare = true,
  spareIdleMs = DEFAULT_SPARE_IDLE_MS,
}) {
  let closed = false;
  let spare = null;
  let spareTimer = null;
  let warmFlight = null;
  let warmAbort = null;
  const activeCleanups = new Set();

  const trackCleanup = promise => {
    if (!promise) return;
    activeCleanups.add(promise);
    promise.finally(() => activeCleanups.delete(promise));
  };

  const clearSpareTimer = () => {
    if (spareTimer) { clearTimeout(spareTimer); spareTimer = null; }
  };

  const disposeSpare = () => {
    clearSpareTimer();
    const cur = spare;
    spare = null;
    cur?.destroy();
  };

  const armSpareIdleTimer = instance => {
    clearSpareTimer();
    if (!(spareIdleMs > 0)) return;
    spareTimer = setTimeout(() => {
      spareTimer = null;
      if (spare === instance) disposeSpare();
    }, spareIdleMs);
    spareTimer.unref?.();
  };

  const replenishSpare = () => {
    if (closed || !enableWarmSpare || spare || warmFlight) return;
    const ac = new AbortController();
    warmAbort = ac;
    const flight = bootUnusedInstance({ executablePath, createProcess, signal: ac.signal, trackCleanup })
      .then(instance => {
        if (closed || spare || ac.signal.aborted) {
          instance.destroy();
          return null;
        }
        spare = instance;
        armSpareIdleTimer(instance);
        return instance;
      })
      .catch(() => null)
      .finally(() => {
        if (warmFlight === flight) { warmFlight = null; warmAbort = null; }
      });
    warmFlight = flight;
  };

  const takeSpare = async signal => {
    if (spare) {
      const candidate = spare;
      spare = null;
      clearSpareTimer();
      if (candidate.isAlive()) return candidate;
      candidate.destroy();
    }
    if (warmFlight) {
      // Join the in-flight unused spare boot; if caller aborts while waiting,
      // stop waiting without killing a still-valid spare for future runs.
      const pending = warmFlight;
      await raceSignal(pending, signal);
      if (spare) {
        const candidate = spare;
        spare = null;
        clearSpareTimer();
        if (candidate.isAlive()) return candidate;
        candidate.destroy();
      }
    }
    return null;
  };

  async function createCamoufoxRunnerSandbox({ onOp, onConsole = () => {}, signal = null }) {
    if (closed) throw new Error('Runner sandbox factory is closed');
    signal?.throwIfAborted();

    let instance = await takeSpare(signal);
    if (!instance) {
      instance = await bootUnusedInstance({ executablePath, createProcess, signal, trackCleanup });
    }
    // Replenish ONE fresh unused spare in the background for the next run while
    // this run owns its exclusively leased process tree.
    replenishSpare();
    try {
      return await instance.bindAndLease({ onOp, onConsole, signal });
    } catch (error) {
      instance.destroy();
      throw error;
    }
  }

  createCamoufoxRunnerSandbox.close = async () => {
    if (closed) return;
    closed = true;
    warmAbort?.abort(new Error('Runner sandbox factory closed'));
    disposeSpare();
    if (warmFlight) await warmFlight.catch(() => {});
    disposeSpare();
    if (activeCleanups.size) await Promise.allSettled([...activeCleanups]);
  };

  createCamoufoxRunnerSandbox.hasWarmSpare = () => Boolean(spare && spare.isAlive());
  return createCamoufoxRunnerSandbox;
}
