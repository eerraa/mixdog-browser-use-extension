// Dedicated hardened headless Camoufox sandbox for `run` scripts (D20/D31).
// Each run gets its own network-locked headless Camoufox process (WebRTC off,
// DNS prefetch/preconnect off, dead fixed proxy 127.0.0.1:9, request
// interception aborting all non-bootstrap requests, strict CSP `default-src
// 'none'`), so global Firefox prefs never affect normal browsing and destroy()
// terminates even CPU-bound loops cleanly.
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

export function createCamoufoxRunnerSandboxFactory({ executablePath }) {
  return async function createCamoufoxRunnerSandbox({ onOp, onConsole = () => {} }) {
    const profileDir = mkdtempSync(path.join(tmpdir(), 'wb-cfx-run-'));
    const nonce = randomBytes(32).toString('base64url');
    const proc = new CamoufoxProcess({
      executablePath,
      profileDir,
      headless: true,
      enableRdp: false,
      hardenedRunner: true,
    });

    let destroyed = false;
    let sessionId = null;
    let frameId = null;
    let mainContextId = null;
    const inflightOps = new Set();

    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      proc.close().finally(() => {
        setTimeout(() => { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } }, 250).unref?.();
      });
    };

    try {
      await proc.start();
      const { browserContextId } = await proc.send('Browser.createBrowserContext', { removeOnDetach: true });
      await proc.send('Browser.setContextProxy', {
        browserContextId, type: 'http', host: '127.0.0.1', port: 9, bypass: [],
      });
      await proc.send('Browser.setRequestInterception', { browserContextId, enabled: true });

      let readyResolve;
      let navigatedBootstrap = false;
      const readyPromise = new Promise(resolve => { readyResolve = resolve; });

      proc.on('message', (method, params, sid) => {
        if (destroyed) return;
        if (method === 'Browser.attachedToTarget' && params.targetInfo?.browserContextId === browserContextId && !sessionId) {
          sessionId = params.sessionId;
          return;
        }
        if (sid !== sessionId) return;
        if (method === 'Network.requestWillBeSent' && params.isIntercepted) {
          // Abort every non-bootstrap network request immediately.
          proc.sendRaw('Network.abortInterceptedRequest', {
            requestId: params.requestId, errorCode: 'accessdenied',
          }, sessionId, 3000).catch(() => {});
          return;
        }
        if (method === 'Page.frameAttached' && !params.parentFrameId) {
          frameId = params.frameId;
          return;
        }
        if (method === 'Runtime.executionContextCreated' && params.auxData?.frameId === frameId && !params.auxData?.name) {
          mainContextId = params.executionContextId;
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
        if (method === 'Page.eventFired' && params.name === 'load' && params.frameId === frameId && navigatedBootstrap) {
          readyResolve?.();
          return;
        }
        if (method === 'Page.navigationCommitted' && params.frameId === frameId && String(params.url || '').startsWith('data:text/html')) {
          navigatedBootstrap = true;
          return;
        }
        if (method === 'Runtime.console') {
          const text = (params.args ?? []).map(a => (a?.type === 'string' ? a.value : a?.value !== undefined ? String(a.value) : a?.type ?? '')).join(' ');
          onConsole(params.type === 'warning' ? 'warn' : params.type || 'log', text);
          return;
        }
        if (method === 'Page.bindingCalled' && params.name === BRIDGE_BINDING) {
          let req;
          try { req = JSON.parse(String(params.payload ?? '')); } catch { return; }
          const callId = Number(req?.id);
          const given = Buffer.from(typeof req?.nonce === 'string' ? req.nonce : '');
          const expected = Buffer.from(nonce);
          const sendBack = reply => {
            if (destroyed || !mainContextId) return;
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
          const flight = Promise.resolve().then(() => onOp(String(req.op ?? ''), req.args))
            .then(reply => sendBack(reply), error => sendBack({ ok: false, error: { code: error?.code ?? 'RUNNER_ERROR', kind: 'not-executed', message: String(error?.message ?? error) } }));
          inflightOps.add(flight);
          flight.finally(() => inflightOps.delete(flight));
        }
      });

      await proc.send('Browser.newPage', { browserContextId });
      for (let i = 0; i < 60 && (!sessionId || !frameId); i++) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (!sessionId || !frameId) throw new Error('Runner Camoufox page failed to attach');

      await proc.send('Page.addBinding', { name: BRIDGE_BINDING, script: '' }, sessionId);
      mainContextId = null;
      await proc.send('Page.navigate', { frameId, url: CAMOUFOX_BOOTSTRAP_URL }, sessionId);
      await Promise.race([readyPromise, new Promise(r => setTimeout(r, 4000))]);

      for (let i = 0; i < 60 && (!navigatedBootstrap || !mainContextId); i++) await new Promise(r => setTimeout(r, 50));
      if (!mainContextId) throw new Error('Runner Camoufox execution context unavailable');

      // Install sealed window.__wbBridge.call(op, args) closing over the run nonce
      // and hiding the raw binding so user script code cannot forge calls.
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
      }, sessionId);

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
    } catch (error) {
      destroy();
      throw error;
    }
  };
}
