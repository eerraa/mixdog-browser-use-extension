// Narrow, read-only Firefox DevTools Remote Debugging Protocol (RDP) client.
// Supplements Juggler with the four capabilities Juggler lacks:
//   1. Matched CSS rules with stylesheet URL & source line (`pageStyle.getApplied`)
//   2. Native DOM event listeners (`node.getEventListenerInfo`)
//   3. Best-effort side-effect-free page-world console reads (`evaluateJSAsync({ eager: true })`)
//   4. Dedicated/service-worker network & console resource watching (`watchResources`)
// All network/console events flow back into the single DevToolsRecorder under
// its privacy-window timestamp gate (nothing recorded during human handoff).
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { DEVTOOLS_LIMITS } from '../devtools.mjs';
import { clip, redactURL } from '../redact.mjs';
import { fail } from '../../shared/contract.mjs';

const L = DEVTOOLS_LIMITS;
const UNSOLICITED_TYPES = new Set([
  'resource-available-form',
  'resource-updated-form',
  'resources-available-array',
  'resources-updated-array',
  'target-available-form',
  'target-destroyed-form',
  'tabListChanged',
  'frameUpdate',
  'evaluationResult',
  'newSource',
  'will-navigate',
  'navigate',
  'styleSheetAdded',
  'styleSheetRemoved',
]);

function firstLine(text) { return String(text ?? '').split('\n', 1)[0]; }

function formatRdpGrip(value, limit = L.chars) {
  if (value === null) return { type: 'null', value: null };
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'string') return { type: 'string', value: clip(value, limit) };
  if (typeof value === 'number' || typeof value === 'boolean') return { type: typeof value, value };
  if (typeof value !== 'object') return { type: typeof value, value: clip(String(value), limit) };
  if (value.type === 'undefined') return { type: 'undefined' };
  if (value.type === 'null') return { type: 'null', value: null };
  if (value.type === 'Infinity' || value.type === '-Infinity' || value.type === 'NaN' || value.type === '-0') {
    return { type: 'number', value: value.type };
  }
  if (value.type === 'BigInt') return { type: 'bigint', value: clip(value.text ?? '0n', limit) };
  if (value.type === 'longString') return { type: 'string', value: clip(value.initial ?? '', limit) };
  if (value.type === 'symbol') return { type: 'symbol', value: clip(value.name ? `Symbol(${value.name})` : 'Symbol()', limit) };
  if (value.type === 'object') {
    const preview = value.preview;
    let desc = value.class || 'Object';
    if (preview?.kind === 'ArrayLike' && Array.isArray(preview.items)) {
      const items = preview.items.slice(0, 10).map(item => {
        const formatted = formatRdpGrip(item, 80);
        return formatted.type === 'string' ? JSON.stringify(formatted.value) : String(formatted.value ?? formatted.preview ?? formatted.type);
      });
      if ((preview.length ?? 0) > items.length) items.push('…');
      desc = `${value.class}(${preview.length ?? items.length}) [${items.join(', ')}]`;
    } else if (preview?.ownProperties) {
      const props = Object.entries(preview.ownProperties).slice(0, 10).map(([k, v]) => {
        const formatted = formatRdpGrip(v?.value, 80);
        const rendered = formatted.type === 'string' ? JSON.stringify(formatted.value) : String(formatted.value ?? formatted.preview ?? formatted.type);
        return `${k}: ${rendered}`;
      });
      if ((preview.ownPropertiesLength ?? 0) > props.length) props.push('…');
      desc = `${value.class || 'Object'} {${props.join(', ')}}`;
    }
    return { type: value.class === 'Array' ? 'array' : 'object', class: value.class, preview: clip(desc, limit) };
  }
  return { type: String(value.type ?? 'object'), preview: clip(JSON.stringify(value), limit) };
}

/**
 * Length-prefixed JSON wire framing (`<byteLength>:<utf8Json>`) for Firefox RDP.
 */
export class FirefoxRdpTransport extends EventEmitter {
  #socket;
  #buffer = Buffer.alloc(0);
  #greeted = false;
  #pending = [];
  #closed = false;

  constructor(socket) {
    super();
    this.#socket = socket;
    this.#socket.on('data', chunk => this.#onData(chunk));
    this.#socket.on('error', error => this.close(error));
    this.#socket.on('close', () => this.close());
  }

  get closed() { return this.#closed; }

  #onData(chunk) {
    if (this.#closed) return;
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
    while (true) {
      const colon = this.#buffer.indexOf(0x3a);
      if (colon === -1) break;
      const len = Number(this.#buffer.subarray(0, colon).toString('ascii'));
      if (!Number.isFinite(len) || len < 0 || len > 32 * 1024 * 1024) {
        this.close(new Error('Invalid Firefox RDP frame length'));
        return;
      }
      if (this.#buffer.length < colon + 1 + len) break;
      const raw = this.#buffer.subarray(colon + 1, colon + 1 + len).toString('utf8');
      this.#buffer = this.#buffer.subarray(colon + 1 + len);
      let msg;
      try { msg = JSON.parse(raw); }
      catch (error) { this.close(new Error(`Malformed Firefox RDP JSON: ${error.message}`)); return; }
      if (!this.#greeted) {
        this.#greeted = true;
        this.emit('greeting', msg);
        continue;
      }
      const isEvent = typeof msg.type === 'string' && UNSOLICITED_TYPES.has(msg.type);
      if (!isEvent) {
        const idx = this.#pending.findIndex(item => item.to === msg.from);
        if (idx >= 0) {
          const [item] = this.#pending.splice(idx, 1);
          clearTimeout(item.timer);
          if (msg.error) item.reject(new Error(`${msg.error}: ${msg.message ?? ''}`.trim()));
          else item.resolve(msg);
          continue;
        }
      }
      this.emit('event', msg);
    }
  }

  request(to, type, extra = {}, { timeoutMs = L.commandMs, signal } = {}) {
    if (this.#closed) return Promise.reject(new Error(`Firefox RDP closed before ${to}.${type}`));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
    return new Promise((resolve, reject) => {
      const entry = { to, resolve, reject, timer: null };
      const onAbort = () => {
        const i = this.#pending.indexOf(entry);
        if (i >= 0) this.#pending.splice(i, 1);
        clearTimeout(entry.timer);
        reject(signal.reason ?? new Error('Aborted'));
      };
      entry.timer = setTimeout(() => {
        const i = this.#pending.indexOf(entry);
        if (i >= 0) this.#pending.splice(i, 1);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Firefox RDP ${to}.${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      entry.timer.unref?.();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const origResolve = resolve;
      const origReject = reject;
      entry.resolve = value => { signal?.removeEventListener('abort', onAbort); origResolve(value); };
      entry.reject = error => { signal?.removeEventListener('abort', onAbort); origReject(error); };
      this.#pending.push(entry);
      const payload = JSON.stringify({ to, type, ...extra });
      try {
        this.#socket.write(`${Buffer.byteLength(payload, 'utf8')}:${payload}`);
      } catch (error) {
        const i = this.#pending.indexOf(entry);
        if (i >= 0) this.#pending.splice(i, 1);
        clearTimeout(entry.timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  close(reason) {
    if (this.#closed) return;
    this.#closed = true;
    const error = reason instanceof Error ? reason : new Error(reason ? String(reason) : 'Firefox RDP closed');
    for (const item of this.#pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.#pending.length = 0;
    try { this.#socket.destroy(); } catch { /* ignore */ }
    this.emit('close', error);
  }
}

export class FirefoxRdpClient extends EventEmitter {
  #port;
  #transport = null;
  #connectFlight = null;
  #chromeConsoleActor = null;
  #chromeConsoleFlight = null;
  #watchers = new Map(); // pageId → { tabActor, watcherActor, browsingContextID, targets: Map<actor, target>, stylesheets: Map, watching: boolean, onResource }
  #evalWaiters = new Map(); // resultID → { consoleActor, resolve, reject, timer }
  #earlyEvalResults = new Map(); // resultID → { msg, timer } (handles same-TCP-chunk evaluationResult before await resumes)
  #targetWaiters = new Set(); // () => void
  #closed = false;

  constructor(port, { connectImpl } = {}) {
    super();
    this.#port = port;
    this.connectImpl = connectImpl ?? (p => net.createConnection({ host: '127.0.0.1', port: p }));
  }

  get connected() { return !!this.#transport && !this.#transport.closed; }
  get closed() { return this.#closed; }

  async ensureConnected(timeoutMs = 6000) {
    if (this.#closed || !this.#port) return false;
    if (this.connected) return true;
    if (this.#connectFlight) return this.#connectFlight;
    this.#connectFlight = (async () => {
      const deadline = Date.now() + timeoutMs;
      while (!this.#closed && Date.now() < deadline) {
        try {
          const transport = await new Promise((resolve, reject) => {
            const sock = this.connectImpl(this.#port);
            const t = new FirefoxRdpTransport(sock);
            const timer = setTimeout(() => { t.close('connect timeout'); reject(new Error('RDP connect timeout')); }, 1500);
            t.once('greeting', () => { clearTimeout(timer); resolve(t); });
            t.once('close', err => { clearTimeout(timer); reject(err); });
          });
          this.#transport = transport;
          transport.on('event', msg => this.#onEvent(msg));
          transport.on('close', err => {
            if (this.#transport === transport) this.#transport = null;
            this.#chromeConsoleActor = null;
            this.#watchers.clear();
            for (const [id, waiter] of [...this.#evalWaiters.entries()]) {
              this.#evalWaiters.delete(id);
              clearTimeout(waiter.timer);
              waiter.reject(err ?? new Error('Firefox RDP closed'));
            }
            for (const entry of this.#earlyEvalResults.values()) clearTimeout(entry.timer);
            this.#earlyEvalResults.clear();
            for (const wake of [...this.#targetWaiters]) wake();
          });
          return true;
        } catch {
          await new Promise(r => setTimeout(r, 150));
        }
      }
      return false;
    })().finally(() => { this.#connectFlight = null; });
    return this.#connectFlight;
  }

  #onEvent(msg) {
    if (msg.type === 'evaluationResult' && msg.resultID) {
      const waiter = this.#evalWaiters.get(msg.resultID);
      if (waiter) {
        this.#evalWaiters.delete(msg.resultID);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        if (this.#earlyEvalResults.size >= 64) {
          const firstKey = this.#earlyEvalResults.keys().next().value;
          const old = this.#earlyEvalResults.get(firstKey);
          if (old) clearTimeout(old.timer);
          this.#earlyEvalResults.delete(firstKey);
        }
        const timer = setTimeout(() => this.#earlyEvalResults.delete(msg.resultID), 15000);
        timer.unref?.();
        this.#earlyEvalResults.set(msg.resultID, { msg, timer });
      }
      return;
    }
    if (msg.type === 'target-available-form' && msg.target) {
      const state = this.#watcherFor(msg.from);
      if (state) {
        state.targets.set(msg.target.actor, msg.target);
        for (const wake of [...this.#targetWaiters]) wake();
      }
      return;
    }
    if (msg.type === 'navigate' && msg.from && typeof msg.url === 'string') {
      const state = this.#watcherForTargetOrWatcher(msg.from);
      const target = state?.targets.get(msg.from);
      if (target) {
        target.url = msg.url;
        for (const wake of [...this.#targetWaiters]) wake();
      }
      return;
    }
    if (msg.type === 'target-destroyed-form' && msg.target) {
      const state = this.#watcherFor(msg.from);
      const old = state?.targets.get(msg.target.actor);
      if (state) state.targets.delete(msg.target.actor);
      const deadConsole = old?.consoleActor ?? msg.target.consoleActor;
      if (deadConsole) {
        for (const [id, waiter] of [...this.#evalWaiters.entries()]) {
          if (waiter.consoleActor === deadConsole) {
            this.#evalWaiters.delete(id);
            clearTimeout(waiter.timer);
            waiter.reject(Object.assign(new Error('Firefox DevTools target was destroyed during evaluation'), { code: 'TARGET_DESTROYED' }));
          }
        }
      }
      return;
    }
    if ((msg.type === 'resources-available-array' || msg.type === 'resource-available-form') && Array.isArray(msg.array)) {
      const state = this.#watcherForTargetOrWatcher(msg.from);
      if (!state) return;
      for (const [resourceType, items] of msg.array) {
        if (!Array.isArray(items)) continue;
        if (resourceType === 'stylesheet') {
          for (const item of items) {
            if (item?.resourceId && item?.href) {
              state.stylesheets.set(item.resourceId, item.href);
              if (state.stylesheets.size > L.styleSheets) state.stylesheets.delete(state.stylesheets.keys().next().value);
            }
          }
          continue;
        }
        if (!state.onResource) continue;
        for (const item of items) state.onResource('available', resourceType, item, msg.from, state.targets.get(msg.from));
      }
      return;
    }
    if ((msg.type === 'resources-updated-array' || msg.type === 'resource-updated-form') && Array.isArray(msg.array)) {
      const state = this.#watcherForTargetOrWatcher(msg.from);
      if (!state?.onResource) return;
      for (const [resourceType, items] of msg.array) {
        if (!Array.isArray(items)) continue;
        for (const item of items) state.onResource('updated', resourceType, item, msg.from, state.targets.get(msg.from));
      }
    }
  }

  #watcherFor(watcherActor) {
    for (const state of this.#watchers.values()) if (state.watcherActor === watcherActor) return state;
    return null;
  }
  #watcherForTargetOrWatcher(actor) {
    for (const state of this.#watchers.values()) {
      if (state.watcherActor === actor || state.targets.has(actor)) return state;
    }
    return null;
  }

  async attachTab(pageId, { matchTab, onResource, watchResources = true } = {}) {
    if (!(await this.ensureConnected())) return false;
    const existing = this.#watchers.get(pageId);
    if (existing) {
      if (onResource) existing.onResource = onResource;
      return true;
    }
    try {
      const { tabs = [] } = await this.#transport.request('root', 'listTabs');
      const taken = new Set([...this.#watchers.values()].map(w => w.tabActor));
      const available = tabs.filter(t => !taken.has(t.actor));
      let tab = null;
      if (matchTab) {
        const matches = available.filter(t => matchTab(t));
        if (matches.length === 1) tab = matches[0];
        else if (matches.length > 1) tab = matches.at(-1);
        else if (available.length === 1) tab = available[0];
      } else if (available.length === 1) {
        tab = available[0];
      }
      if (!tab) return false;
      const watcherRes = await this.#transport.request(tab.actor, 'getWatcher', {
        isServerTargetSwitchingEnabled: true, isPopupDebuggingEnabled: true,
      });
      const watcherActor = watcherRes.actor;
      const state = {
        tabActor: tab.actor, watcherActor,
        browsingContextID: typeof tab.browsingContextID === 'number' ? tab.browsingContextID : null,
        targets: new Map(), stylesheets: new Map(), watching: false, onResource,
      };
      this.#watchers.set(pageId, state);
      // Watch only 'frame' targets (never 'worker', which pauses newly created
      // dedicated workers waiting for debugger thread attach). Parent-process
      // watchResources('network-event') still captures dedicated and service
      // worker requests with innerWindowId: null!
      await this.#transport.request(watcherActor, 'watchTargets', { targetType: 'frame' }).catch(() => {});
      if (watchResources) {
        await this.setWatching(pageId, true);
      }
      return true;
    } catch {
      this.#watchers.delete(pageId);
      return false;
    }
  }

  async setWatching(pageId, enabled) {
    const state = this.#watchers.get(pageId);
    if (!state || !this.connected || state.watching === enabled) return;
    state.watching = enabled;
    const method = enabled ? 'watchResources' : 'unwatchResources';
    try {
      if (enabled) {
        const netParent = await this.#transport.request(state.watcherActor, 'getNetworkParentActor').catch(() => null);
        if (netParent?.network?.actor) {
          await this.#transport.request(netParent.network.actor, 'setPersist', { persist: true }).catch(() => {});
          await this.#transport.request(netParent.network.actor, 'setSaveRequestAndResponseBodies', { save: true }).catch(() => {});
        }
      }
      await this.#transport.request(state.watcherActor, method, {
        resourceTypes: ['network-event', 'console-message', 'stylesheet'],
      });
    } catch { /* best effort */ }
  }

  detachTab(pageId) {
    const state = this.#watchers.get(pageId);
    if (!state) return;
    this.#watchers.delete(pageId);
    if (this.connected && state.watching) {
      this.#transport.request(state.watcherActor, 'unwatchResources', {
        resourceTypes: ['network-event', 'console-message', 'stylesheet'],
      }).catch(() => {});
    }
  }

  #frameTarget(pageId, frameUrl, { requireExact = false } = {}) {
    const state = this.#watchers.get(pageId);
    if (!state) return null;
    const frames = [...state.targets.values()].filter(t => t.inspectorActor && t.consoleActor);
    if (frameUrl) {
      const exact = frames.findLast(t => t.url === frameUrl);
      if (exact) return exact;
      if (requireExact) return null;
    }
    return frames.findLast(t => t.isTopLevelTarget) ?? frames.at(-1) ?? null;
  }

  async #waitForFrameTarget(pageId, frameUrl, signal, timeoutMs = 2000) {
    const wantReal = Boolean(frameUrl && frameUrl !== 'about:blank');
    const match = () => this.#frameTarget(pageId, frameUrl, { requireExact: wantReal });
    const immediate = match();
    if (immediate) return immediate;
    if (!wantReal) return this.#frameTarget(pageId, frameUrl);
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#targetWaiters.delete(check);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const check = () => { if (match() || !this.connected) finish(); };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.#targetWaiters.add(check);
      if (signal) signal.addEventListener('abort', finish, { once: true });
      check();
    });
    signal?.throwIfAborted();
    return this.#frameTarget(pageId, frameUrl);
  }

  async #evalConsole(consoleActor, text, { eager = false, timeoutMs = L.evaluationMs, signal } = {}) {
    const started = await this.#transport.request(consoleActor, 'evaluateJSAsync', { text, eager }, { timeoutMs, signal });
    const { resultID } = started;
    if (!resultID || started.result !== undefined) return started;
    const early = this.#earlyEvalResults.get(resultID);
    if (early) {
      clearTimeout(early.timer);
      this.#earlyEvalResults.delete(resultID);
      return early.msg;
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.#evalWaiters.delete(resultID)) return;
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      };
      const timer = setTimeout(() => {
        if (!this.#evalWaiters.delete(resultID)) return;
        signal?.removeEventListener('abort', onAbort);
        reject(Object.assign(new Error(`Evaluation exceeded ${timeoutMs} ms`), { code: 'SCRIPT_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.#evalWaiters.set(resultID, {
        consoleActor,
        timer,
        resolve: msg => { signal?.removeEventListener('abort', onAbort); resolve(msg); },
        reject: err => { signal?.removeEventListener('abort', onAbort); reject(err); },
      });
    });
  }

  /**
   * Side-effect-free page-world read (`console` with `expression`), using
   * Firefox DevTools' native `evaluateJSAsync({ eager: true })`.
   */
  async eagerRead(pageId, { expression, frameUrl, limit = L.chars }, signal) {
    if (!(await this.ensureConnected())) {
      fail('DEBUGGER_DISCONNECTED', 'Firefox DevTools RDP is not connected for page-world console reads');
    }
    let target = await this.#waitForFrameTarget(pageId, frameUrl, signal);
    if (!target?.consoleActor) fail('STALE_FRAME', 'The frame has no current DevTools console actor; observe for current frames');
    let reply;
    try {
      reply = await this.#evalConsole(target.consoleActor, expression, { eager: true, timeoutMs: L.evaluationMs, signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === 'TARGET_DESTROYED') {
        target = await this.#waitForFrameTarget(pageId, frameUrl, signal);
        if (!target?.consoleActor) fail('STALE_FRAME', 'The frame target changed during read; observe for current frames');
        reply = await this.#evalConsole(target.consoleActor, expression, { eager: true, timeoutMs: L.evaluationMs, signal });
      } else if (error.code === 'SCRIPT_TIMEOUT') {
        fail('SCRIPT_TIMEOUT', `The page-world read exceeded ${L.evaluationMs} ms`);
      } else {
        throw error;
      }
    }
    if (reply.hasException) {
      const msg = String(reply.exceptionMessage || reply.exception?.preview?.message || 'Exception');
      return { exception: clip(firstLine(msg), L.message) };
    }
    // Firefox eager evaluation returns { type: 'undefined' } with no exception
    // when it aborts due to a side effect. Distinguish genuine `undefined`
    // expressions via a quick probe check when result is undefined and the
    // expression looks mutating or differs from an explicit undefined literal.
    if (reply.result?.type === 'undefined' && !/^\s*(?:undefined|void\s+0)\s*;?\s*$/.test(expression)) {
      const probe = await this.#evalConsole(target.consoleActor, `(() => { const __v = (${expression}); return __v === undefined ? '__WB_UNDEF__' : '__WB_VAL__'; })()`, {
        eager: true, timeoutMs: Math.min(500, L.evaluationMs), signal,
      }).catch(() => null);
      if (!probe || probe.result !== '__WB_UNDEF__') {
        fail('SIDE_EFFECT', 'The expression may have side effects, so this read-only evaluation refused it. Use evaluate with world:"page" (a mutation) only when the side effect is intended.');
      }
    }
    return formatRdpGrip(reply.result, limit);
  }

  /**
   * True page-main-world evaluation (`evaluate` with `world:"page"`). Camoufox's
   * anti-detection patch isolates Juggler Runtime.evaluate worlds by default, so
   * Firefox RDP's console actor provides real page-global access while keeping
   * Juggler's isolation intact. Supports both sync values and returned Promises.
   */
  async pageEvaluate(pageId, { expression, frameUrl, timeoutMs = 15000, beforeSend = null }, signal) {
    if (!(await this.ensureConnected())) {
      fail('DEBUGGER_DISCONNECTED', 'Firefox DevTools RDP is not connected for page-world evaluation');
    }
    const target = await this.#waitForFrameTarget(pageId, frameUrl, signal);
    if (!target?.consoleActor) fail('STALE_FRAME', 'The frame has no current page world; observe again');
    beforeSend?.();

    const readString = async val => {
      if (typeof val === 'string') return val;
      if (val && typeof val === 'object' && val.type === 'longString' && val.actor) {
        const cap = Math.min(val.length ?? 65536, 1024 * 1024);
        const full = await this.#transport.request(val.actor, 'substring', { start: 0, end: cap }, { signal }).catch(() => null);
        return full?.substring ?? val.initial ?? '';
      }
      return '';
    };

    const slot = `__wbEv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const wrapped = `(() => {
      const ser = v => {
        if (v === undefined) return '{"ok":true,"undef":true}';
        if (typeof v === 'number' && !Number.isFinite(v)) return '{"ok":false,"nonJson":true}';
        if (typeof v === 'bigint' || typeof v === 'symbol' || typeof v === 'function') return '{"ok":false,"nonJson":true}';
        try {
          const j = JSON.stringify(v);
          return j === undefined ? '{"ok":false,"nonJson":true}' : JSON.stringify({ ok: true, json: j });
        } catch { return '{"ok":false,"nonJson":true}'; }
      };
      try {
        const r = (0, eval)(${JSON.stringify(expression)});
        if (r && (typeof r === 'object' || typeof r === 'function') && typeof r.then === 'function') {
          const box = { done: false, payload: null };
          Object.defineProperty(globalThis, ${JSON.stringify(slot)}, { value: box, configurable: true, enumerable: false });
          Promise.resolve(r).then(
            v => { box.done = true; box.payload = ser(v); },
            e => { box.done = true; box.payload = JSON.stringify({ ok: false, err: String(e?.message || e || 'Rejected') }); },
          );
          return '{"pending":true}';
        }
        return ser(r);
      } catch (e) {
        return JSON.stringify({ ok: false, err: String(e?.message || e || 'Script error') });
      }
    })()`;

    const first = await this.#evalConsole(target.consoleActor, wrapped, { eager: false, timeoutMs, signal });
    if (first.hasException) fail('PAGE_SCRIPT_ERROR', 'Page script failed (details withheld to avoid exposing secrets)');
    let raw = await readString(first.result);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail('PAGE_SCRIPT_ERROR', 'Page script returned an unreadable response'); }

    if (parsed?.pending) {
      const deadline = Date.now() + timeoutMs;
      const pollExpr = `(() => {
        const b = globalThis[${JSON.stringify(slot)}];
        if (!b) return '{"ok":false,"err":"Evaluation context reset"}';
        if (!b.done) return '{"pending":true}';
        delete globalThis[${JSON.stringify(slot)}];
        return b.payload;
      })()`;
      let pollMs = 5;
      while (parsed?.pending) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) {
          await this.#evalConsole(target.consoleActor, `delete globalThis[${JSON.stringify(slot)}]`, { eager: false, timeoutMs: 1000 }).catch(() => {});
          fail('SCRIPT_TIMEOUT', `Page-world evaluation exceeded ${timeoutMs} ms`);
        }
        await new Promise(r => setTimeout(r, pollMs));
        pollMs = Math.min(20, pollMs * 2);
        const next = await this.#evalConsole(target.consoleActor, pollExpr, { eager: false, timeoutMs: Math.max(500, deadline - Date.now()), signal });
        if (next.hasException) fail('PAGE_SCRIPT_ERROR', 'Page script failed (details withheld to avoid exposing secrets)');
        raw = await readString(next.result);
        try { parsed = JSON.parse(raw); } catch { fail('PAGE_SCRIPT_ERROR', 'Page script returned an unreadable response'); }
      }
    }

    if (parsed?.nonJson) fail('NON_JSON_RESULT', 'Expression must return JSON-serializable data');
    if (!parsed?.ok) fail('PAGE_SCRIPT_ERROR', 'Page script failed (details withheld to avoid exposing secrets)');
    if (parsed.undef) return undefined;
    return JSON.parse(parsed.json);
  }

  /**
   * Native matched CSS rules (with stylesheet URL + line) and DOM event
   * listeners for an element located by a zero-mutation DOM index path or selector.
   */
  async inspectNode(pageId, { frameUrl, domPath, selector }, signal) {
    if (!this.connected) return {};
    const target = await this.#waitForFrameTarget(pageId, frameUrl, signal);
    if (!target?.inspectorActor) return {};
    try {
      const { walker } = await this.#transport.request(target.inspectorActor, 'getWalker', {}, { signal });
      const doc = await this.#transport.request(walker.actor, 'document', {}, { signal });
      let nodeActor = null;
      if (selector) {
        const found = await this.#transport.request(walker.actor, 'querySelector', {
          node: doc.node.actor, selector,
        }, { signal }).catch(() => null);
        nodeActor = found?.node?.actor ?? null;
      }
      if (!nodeActor && Array.isArray(domPath) && domPath.length) {
        let curActor = doc.node.actor;
        for (let i = 0; i < domPath.length && curActor; i++) {
          const seg = domPath[i];
          if (i > 0) {
            const kids = await this.#transport.request(walker.actor, 'children', { node: curActor }, { signal }).catch(() => null);
            const shadow = (kids?.nodes ?? []).find(n => n.isShadowRoot);
            if (!shadow) { curActor = null; break; }
            curActor = shadow.actor;
          }
          const found = await this.#transport.request(walker.actor, 'querySelector', {
            node: curActor, selector: seg,
          }, { signal }).catch(() => null);
          curActor = found?.node?.actor ?? null;
        }
        nodeActor = curActor;
      }
      if (!nodeActor) return {};

      const { pageStyle } = await this.#transport.request(target.inspectorActor, 'getPageStyle', {}, { signal });
      const [applied, listenerInfo] = await Promise.all([
        this.#transport.request(pageStyle.actor, 'getApplied', { node: nodeActor, skipPseudo: true }, { signal }).catch(() => ({ entries: [] })),
        this.#transport.request(nodeActor, 'getEventListenerInfo', {}, { signal }).catch(() => ({ events: [] })),
      ]);

      const state = this.#watchers.get(pageId);
      const sheetHref = new Map(state?.stylesheets ?? []);
      for (const s of applied.sheets ?? []) {
        if (s?.resourceId && s?.href) sheetHref.set(s.resourceId, s.href);
        if (s?.actor && s?.href) sheetHref.set(s.actor, s.href);
      }

      const rules = [];
      for (const entry of applied.entries ?? []) {
        const rule = entry.rule;
        if (!rule) continue;
        const declarations = String(rule.cssText ?? '').trim().replace(/\s+/g, ' ');
        if (!declarations) continue;
        if (!rule.selectors && rule.type === 100) {
          rules.push({ s: 'element.style', d: clip(declarations, L.declarations) });
          continue;
        }
        const selectorText = Array.isArray(rule.selectors) ? rule.selectors.join(', ') : 'element.style';
        const href = rule.href
          || (typeof rule.parentStyleSheet === 'string' ? sheetHref.get(rule.parentStyleSheet) : rule.parentStyleSheet?.href)
          || '';
        const line = typeof rule.line === 'number' ? rule.line : undefined;
        const src = entry.isSystem ? 'user-agent'
          : `${clip(redactURL(href) || '<inline>', L.url)}${line === undefined ? '' : `:${line}`}`;
        rules.push({ s: clip(selectorText, L.url), d: clip(declarations, L.declarations), src });
      }
      const counts = {};
      for (const ev of listenerInfo.events ?? []) {
        if (ev?.type) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
      }
      const out = {};
      if (rules.length) out.rules = rules.slice(0, L.rules);
      if (rules.length > L.rules) out.rulesOmitted = rules.length - L.rules;
      if (Object.keys(counts).length) out.listeners = Object.fromEntries(Object.entries(counts).slice(0, L.listeners));
      return out;
    } catch {
      return {};
    }
  }

  async getNetworkHeaders(actor, signal) {
    if (!this.connected || !actor) return {};
    const [req, res] = await Promise.all([
      this.#transport.request(actor, 'getRequestHeaders', {}, { signal }).catch(() => null),
      this.#transport.request(actor, 'getResponseHeaders', {}, { signal }).catch(() => null),
    ]);
    const toMap = list => Object.fromEntries((list ?? []).map(h => [h.name, h.value]));
    return { reqHeaders: req?.headers ? toMap(req.headers) : undefined, resHeaders: res?.headers ? toMap(res.headers) : undefined };
  }

  async getNetworkPostData(actor, signal) {
    if (!this.connected || !actor) return undefined;
    const reply = await this.#transport.request(actor, 'getRequestPostData', {}, { signal }).catch(() => null);
    const text = reply?.postData?.text;
    if (typeof text === 'string') return text;
    if (text?.type === 'longString' && text.actor) {
      const full = await this.#transport.request(text.actor, 'substring', { start: 0, end: Math.min(text.length ?? L.postData, L.postData) }, { signal }).catch(() => null);
      return full?.substring ?? text.initial;
    }
    return undefined;
  }

  async getNetworkResponseBody(actor, limit = L.chars, signal) {
    if (!this.connected || !actor) fail('BODY_UNAVAILABLE', 'Firefox RDP connection unavailable');
    const reply = await this.#transport.request(actor, 'getResponseContent', {}, { signal });
    const content = reply?.content;
    if (!content) fail('BODY_UNAVAILABLE', 'Response content unavailable');
    let text = content.text;
    if (text && typeof text === 'object' && text.type === 'longString' && text.actor) {
      const cap = Math.min(text.length ?? limit * 2, L.resourceBuffer);
      const full = await this.#transport.request(text.actor, 'substring', { start: 0, end: cap }, { signal }).catch(() => null);
      text = full?.substring ?? text.initial ?? '';
    }
    return {
      text: typeof text === 'string' ? text : '',
      base64Encoded: content.encoding === 'base64',
      mimeType: content.mimeType,
      size: content.size,
    };
  }

  browsingContextId(pageId) {
    const state = this.#watchers.get(pageId);
    if (!state) return null;
    if (typeof state.browsingContextID === 'number') return state.browsingContextID;
    for (const target of state.targets.values()) {
      if (target.isTopLevelTarget && typeof target.browsingContextID === 'number') return target.browsingContextID;
    }
    return null;
  }

  async #ensureChromeConsole() {
    if (!(await this.ensureConnected())) return null;
    if (this.#chromeConsoleActor) return this.#chromeConsoleActor;
    if (this.#chromeConsoleFlight) return this.#chromeConsoleFlight;
    this.#chromeConsoleFlight = (async () => {
      const desc = await this.#transport.request('root', 'getProcess', { id: 0 });
      const actor = desc?.processDescriptor?.actor;
      if (!actor) return null;
      const target = await this.#transport.request(actor, 'getTarget');
      const consoleActor = target?.process?.consoleActor ?? null;
      this.#chromeConsoleActor = consoleActor;
      return consoleActor;
    })().catch(() => null).finally(() => { this.#chromeConsoleFlight = null; });
    return this.#chromeConsoleFlight;
  }

  // Evaluate a privileged browser-chrome snippet in Firefox's parent process
  // (used strictly for mounting/tearing down the trusted #nav-bar Agent Control UI).
  async chromeEval(text, timeoutMs = 4000) {
    const consoleActor = await this.#ensureChromeConsole();
    if (!consoleActor) throw new Error('Firefox parent chrome console unavailable');
    const msg = await this.#evalConsole(consoleActor, text, { eager: false, timeoutMs });
    if (msg.hasException || msg.exception) {
      throw new Error(msg.exceptionMessage || 'Firefox chrome evaluation failed');
    }
    return msg.result;
  }

  close() {
    this.#closed = true;
    this.#chromeConsoleActor = null;
    for (const waiter of this.#evalWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject?.(new Error('FirefoxRdpClient closed'));
    }
    this.#evalWaiters.clear();
    for (const entry of this.#earlyEvalResults.values()) clearTimeout(entry.timer);
    this.#earlyEvalResults.clear();
    for (const wake of [...this.#targetWaiters]) wake();
    this.#targetWaiters.clear();
    this.#watchers.clear();
    this.#transport?.close('FirefoxRdpClient closed');
    this.#transport = null;
  }
}
