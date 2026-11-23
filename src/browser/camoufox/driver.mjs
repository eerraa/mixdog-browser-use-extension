// Camoufox (Firefox 158 Juggler + narrow Firefox RDP) FrameDriver.
// Mirrors src/browser/frames.mjs at the driver seam so the pure perception
// layer (walker, semantics, model, refs, render, settle, signals) and
// DevToolsRecorder work identically on Camoufox without falling back to the
// page main world.
import { BrowserActionabilityError, waitForBrowserActionable } from '../actionability.mjs';
import { ELEMENT_SEMANTICS } from '../perception/semantics.mjs';
import { browserRefPointExpression } from '../perception/target-point.mjs';
import { bounded, pause } from '../../shared/async.mjs';
import { fail, freshId } from '../../shared/contract.mjs';
import { DEVTOOLS_LIMITS, INSPECT_ELEMENT, clip, redactURL } from '../devtools.mjs';
import { quote as quoteText } from '../perception/render.mjs';
import {
  actionTargetExpression, armGuardExpression, coveringExpression, describeExpression, disarmGuardExpression, hitExpression,
  inViewExpression, privatizeExpression, quietExpression, resolveExpression, sensitivePresentExpression,
  snapshotExpression, targetPointExpression, textIncludesExpression, viewportExpression, walkerInstallSource,
} from '../perception/walker.mjs';

export const FRAME_CAP = 50;
export const INPUT_CREDIT_MS = 500;
export const INPUT_BINDING = '__wbTrustedInput';
const ACTIONABLE_MS = 2000;
const PAINT_HOLDING_MS = 350;
const WALKER_SOURCE = walkerInstallSource(ELEMENT_SEMANTICS);
const L = DEVTOOLS_LIMITS;

const OWNER_STABLE = `function(){return new Promise(resolve=>{
  const box=()=>{const r=this.getBoundingClientRect();return [r.left,r.top,r.width,r.height]};
  const first=box();let frames=0;setTimeout(()=>resolve(false),1000);
  const step=()=>{if(box().some((v,i)=>Math.abs(v-first[i])>1))return resolve(false);if(++frames>=2)return resolve(true);requestAnimationFrame(step)};
  requestAnimationFrame(step)})}`;

const PAINT_HOLDING_EXPRESSION = `(()=>{if(performance.getEntriesByType('paint').some(e=>e.name==='first-contentful-paint'))return 0;`
  + `const nav=performance.getEntriesByType('navigation')[0];`
  + `return Math.max(0,(nav?nav.responseStart:0)+${PAINT_HOLDING_MS}-performance.now())})()`;

const DOM_PATH_EXPRESSION = `function(){
  const segments = [];
  let parts = [];
  let cur = this;
  while (cur && cur !== document) {
    const parent = cur.parentNode;
    if (!parent) return null;
    if (parent instanceof ShadowRoot) {
      if (parts.length) segments.unshift(parts.join(' > '));
      parts = [];
      cur = parent.host;
      continue;
    }
    if (!parent.children) return null;
    const idx = Array.prototype.indexOf.call(parent.children, cur);
    if (idx < 0) return null;
    parts.unshift(parent === document ? (cur.localName || ':root') : ':nth-child(' + (idx + 1) + ')');
    cur = parent;
  }
  if (parts.length) segments.unshift(parts.join(' > '));
  return segments.length ? segments : null;
}`;

const NAVIGATION_TIMING = `(() => {
  const n = performance.getEntriesByType('navigation')[0];
  const r = value => value > 0 ? Math.round(value) : undefined;
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  return {
    url: location.href,
    m: {
      nodes: document.getElementsByTagName('*').length,
      frames: window.frames.length + 1,
    },
    nav: n ? {
      type: n.type, ttfb: r(n.responseStart), dcl: r(n.domContentLoadedEventEnd), load: r(n.loadEventEnd),
      fcp: fcp && r(fcp.startTime), transfer: n.transferSize, decoded: n.decodedBodySize,
      resources: performance.getEntriesByType('resource').length,
    } : undefined,
  };
})()`;

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? '' : parsed.origin;
  } catch {
    return '';
  }
}

export class CamoufoxFrameDriver {
  #dialogCleanup = new Set();
  #inflight = new Set();
  #inputReady = new Set();
  #worlds = new Map(); // frameId → Map<worldName, executionContextId>
  #pendingDialog = null;

  constructor({ page, process: proc, sessionId, rdp, invalidate }) {
    this.page = page;
    this.proc = proc;
    this.sessionId = sessionId;
    this.rdp = rdp;
    this.invalidate = invalidate;
    this.worldName = `wb-walker-${freshId()}`;
    this.evaluationWorldName = `wb-eval-${freshId()}`;
    this.devtoolsWorldName = `wb-devtools-${freshId()}`;
    this.frames = new Map(); // frameId → { id, frameId, parentId, url, origin, name, documentId, contextId, evalContextId, devtoolsContextId }
    this.pageWorlds = new Map(); // frameId → executionContextId (main world, name === '')
    this.owners = new Map(); // child frameId → owner walker id in parent
    this.inputCredits = [];
    this.nativeMode = false;
    this.actorSignal = null;
    this.beforeInputDispatch = null;
    this.beforeCleanupDispatch = null;
    this.rootFrameId = null;
    this.ready = false;
  }

  isAttached() { return !this.proc.closed && !!this.page.connected; }
  hasPendingCleanup() { return this.#dialogCleanup.size > 0 || this.#inflight.size > 0; }

  #setWorld(frameId, name, contextId) {
    let map = this.#worlds.get(frameId);
    if (!map) { map = new Map(); this.#worlds.set(frameId, map); }
    map.set(name, contextId);
    if (name === '') this.pageWorlds.set(frameId, contextId);
    const frame = this.frames.get(frameId);
    if (frame) {
      if (name === this.worldName) frame.contextId = contextId;
      else if (name === this.evaluationWorldName) frame.evalContextId = contextId;
      else if (name === this.devtoolsWorldName) frame.devtoolsContextId = contextId;
    }
  }

  #dropContext(contextId) {
    for (const [frameId, map] of this.#worlds) {
      for (const [name, id] of map) {
        if (id !== contextId) continue;
        map.delete(name);
        if (name === '' && this.pageWorlds.get(frameId) === contextId) this.pageWorlds.delete(frameId);
        const frame = this.frames.get(frameId);
        if (frame) {
          if (frame.contextId === contextId) frame.contextId = null;
          if (frame.evalContextId === contextId) frame.evalContextId = null;
          if (frame.devtoolsContextId === contextId) frame.devtoolsContextId = null;
        }
      }
    }
  }

  onMessage(method, params = {}) {
    if (method === 'Page.ready') {
      this.ready = true;
      return;
    }
    if (method === 'Page.crashed') {
      this.page.connected = false;
      this.invalidate('presentation-renderer-lost');
      return;
    }
    if (method === 'Page.frameAttached') {
      const existing = this.frames.get(params.frameId);
      const frame = existing ?? {
        id: params.frameId, frameId: params.frameId, parentId: params.parentFrameId || null,
        url: '', origin: '', name: '', documentId: null,
        contextId: null, evalContextId: null, devtoolsContextId: null,
      };
      frame.parentId = params.parentFrameId || null;
      this.frames.set(params.frameId, frame);
      if (!frame.parentId) this.rootFrameId = params.frameId;
      const worlds = this.#worlds.get(params.frameId);
      if (worlds) {
        frame.contextId = worlds.get(this.worldName) ?? frame.contextId;
        frame.evalContextId = worlds.get(this.evaluationWorldName) ?? frame.evalContextId;
        frame.devtoolsContextId = worlds.get(this.devtoolsWorldName) ?? frame.devtoolsContextId;
      }
    } else if (method === 'Page.frameDetached') {
      this.frames.delete(params.frameId);
      this.pageWorlds.delete(params.frameId);
      this.#worlds.delete(params.frameId);
      this.owners.delete(params.frameId);
      this.#inputReady.delete(params.frameId);
      this.invalidate('Page.frameDetached');
    } else if (method === 'Page.navigationStarted') {
      if (params.frameId === this.rootFrameId) {
        this.page.emitNavigation?.({ kind: 'start', url: params.url });
      }
    } else if (method === 'Page.navigationAborted') {
      if (params.frameId === this.rootFrameId) {
        this.page.emitNavigation?.({ kind: 'fail', reason: params.errorText });
      }
    } else if (method === 'Page.navigationCommitted') {
      const frame = this.frames.get(params.frameId) ?? {
        id: params.frameId, frameId: params.frameId, parentId: null,
        url: '', origin: '', name: '', documentId: null,
        contextId: null, evalContextId: null, devtoolsContextId: null,
      };
      frame.url = params.url || '';
      frame.origin = originOf(frame.url);
      frame.name = params.name || '';
      frame.documentId = null;
      this.frames.set(params.frameId, frame);
      if (!frame.parentId) {
        this.rootFrameId = params.frameId;
        this.page.currentUrl = frame.url;
        this.invalidate('Page.frameNavigated');
        this.page.onNavigated?.(frame.url);
      }
      this.#inputReady.delete(params.frameId);
    } else if (method === 'Page.sameDocumentNavigation') {
      const frame = this.frames.get(params.frameId);
      if (frame) {
        frame.url = params.url || frame.url;
        frame.origin = originOf(frame.url);
        if (!frame.parentId) {
          this.page.currentUrl = frame.url;
          this.page.onNavigated?.(frame.url);
        }
      }
    } else if (method === 'Page.eventFired' && params.name === 'DOMContentLoaded') {
      this.page.onDomContentLoaded?.(params.frameId);
      if (params.frameId === this.rootFrameId) {
        this.page.emitNavigation?.({ kind: 'ready' });
      }
    } else if (method === 'Runtime.executionContextCreated') {
      const frameId = params.auxData?.frameId;
      const name = params.auxData?.name ?? '';
      if (frameId) this.#setWorld(frameId, name, params.executionContextId);
    } else if (method === 'Runtime.executionContextDestroyed') {
      this.#dropContext(params.executionContextId);
    } else if (method === 'Runtime.executionContextsCleared') {
      this.#worlds.clear();
      this.pageWorlds.clear();
      for (const frame of this.frames.values()) {
        frame.contextId = null;
        frame.evalContextId = null;
        frame.devtoolsContextId = null;
      }
    } else if (method === 'Page.bindingCalled' && params.name === INPUT_BINDING) {
      const kind = String(params.payload ?? '');
      if (kind === 'pointerdown' || kind === 'keydown' || kind === 'value') {
        if (!this.claimInput(kind)) this.page.onTrustedInput?.(kind);
      }
    } else if (method === 'Page.dialogOpened') {
      this.#pendingDialog = params;
      this.page.onDialogOpened?.(params);
    } else if (method === 'Page.dialogClosed') {
      if (this.#pendingDialog?.dialogId === params.dialogId) this.#pendingDialog = null;
      this.page.onDialogClosed?.(params);
    } else if (method === 'Page.fileChooserOpened') {
      this.page.onFileChooserOpened?.(params);
    }

    // Pass undefined as sessionId for page-scoped Juggler events so
    // DevToolsRecorder tags main-frame events with `in: undefined` and child
    // frames with `in: 'iframe'` via `#childFrames` (mirroring Electron CDP).
    this.page.devtools?.recordJuggler(method, params, undefined);
  }

  async start() {
    this.page.connected = true;
    await this.send('Page.setInitScripts', {
      scripts: [
        { script: WALKER_SOURCE, worldName: this.worldName },
        { script: 'void 0;', worldName: this.evaluationWorldName },
        { script: 'void 0;', worldName: this.devtoolsWorldName },
      ],
    }, null);
    await this.send('Page.addBinding', { worldName: this.worldName, name: INPUT_BINDING, script: '' }, null);
    await this.send('Page.setInterceptFileChooserDialog', { enabled: !this.nativeMode }, null);
  }

  async setNativeMode(enabled) {
    this.nativeMode = Boolean(enabled);
    await this.send('Page.setInterceptFileChooserDialog', { enabled: !this.nativeMode }, null).catch(() => {});
  }

  assertNoDialogCleanup() {
    if (this.#dialogCleanup.size) {
      fail('DIALOG_CLEANUP_PENDING', 'A dispatched dialog response is still settling; do not replay it or start new input');
    }
  }

  async waitForIdle(signal) {
    for (;;) {
      signal?.throwIfAborted();
      const pending = [...this.#dialogCleanup, ...this.#inflight];
      if (!pending.length) return;
      await bounded(Promise.allSettled(pending), 2000, 'Actual browser command is still settling', signal);
    }
  }

  send(method, params = {}, signal = this.actorSignal, beforeDispatch) {
    if (method === 'Page.handleDialog') {
      beforeDispatch?.();
      const actual = this.proc.sendRaw(method, params, this.sessionId, 15000);
      this.#dialogCleanup.add(actual);
      const clear = () => this.#dialogCleanup.delete(actual);
      actual.then(clear, clear);
      return actual;
    }
    const isRelease = (method === 'Page.dispatchMouseEvent' && params.type === 'mouseup')
      || (method === 'Page.dispatchKeyEvent' && params.type === 'keyup');
    if (isRelease) {
      this.beforeCleanupDispatch?.();
      return this.proc.sendRaw(method, params, this.sessionId, 15000);
    }
    const isInput = method.startsWith('Page.dispatch') || method === 'Page.insertText'
      || method === 'Page.setFileInputFiles' || method === 'Page.scrollIntoViewIfNeeded';
    const guard = beforeDispatch ?? (isInput ? this.beforeInputDispatch : undefined);
    if (isInput || beforeDispatch) {
      this.assertNoDialogCleanup();
      guard?.();
    }
    const actual = this.proc.sendRaw(method, params, this.sessionId, 15000);
    this.#inflight.add(actual);
    const done = () => this.#inflight.delete(actual);
    actual.then(done, done);
    if (!signal) return actual;
    return bounded(actual, 15000, `Juggler ${method}`, signal);
  }

  async #ensureWalkerContext(frame, signal) {
    if (frame.contextId) return frame.contextId;
    for (let i = 0; i < 25 && !frame.contextId; i++) {
      signal?.throwIfAborted();
      const cached = this.#worlds.get(frame.frameId)?.get(this.worldName);
      if (cached) { frame.contextId = cached; return cached; }
      await pause(40, signal);
    }
    return frame.contextId;
  }

  async #evaluateInContext(contextId, expression, returnByValue = true, signal = this.actorSignal, beforeDispatch = undefined) {
    if (!contextId) fail('FRAME_UNAVAILABLE', 'Frame has no isolated execution context');
    const reply = await this.send('Runtime.evaluate', {
      executionContextId: contextId, expression, returnByValue,
    }, signal, beforeDispatch);
    if (reply.exceptionDetails) {
      const detail = reply.exceptionDetails.text || reply.exceptionDetails.stack || 'Evaluation failed';
      fail('PAGE_SCRIPT_ERROR', String(detail));
    }
    if (returnByValue && reply.result?.unserializableValue !== undefined) {
      fail('NON_JSON_RESULT', 'Expression must return JSON-serializable data');
    }
    return returnByValue ? (reply.result?.value ?? null) : reply.result;
  }

  async evaluate(frame, expression, returnByValue = true, signal = this.actorSignal) {
    const ctx = await this.#ensureWalkerContext(frame, signal);
    if (!ctx) fail('FRAME_UNAVAILABLE', 'Frame walker world is unavailable; never falling back to page world');
    const result = await this.#evaluateInContext(ctx, expression, returnByValue, signal);
    if (returnByValue && result?.missing) {
      await this.#evaluateInContext(ctx, WALKER_SOURCE, true, signal);
      return this.#evaluateInContext(ctx, expression, returnByValue, signal);
    }
    return result;
  }

  async callOn(frame, objectId, fn, args = [], returnByValue = true, signal = this.actorSignal, beforeDispatch = undefined) {
    const ctx = await this.#ensureWalkerContext(frame, signal);
    if (!ctx) fail('FRAME_UNAVAILABLE', 'Frame walker world is unavailable');
    const reply = await this.send('Runtime.callFunction', {
      executionContextId: ctx,
      functionDeclaration: `function(target, ...rest) { return (${fn}).apply(target, rest); }`,
      args: [{ objectId }, ...args.map(value => ({ value }))],
      returnByValue,
    }, signal, beforeDispatch);
    if (reply.exceptionDetails) fail('TARGET_CHANGED', String(reply.exceptionDetails.text || 'callFunction failed'));
    return returnByValue ? (reply.result?.value ?? null) : reply.result;
  }

  disposeObject(frame, objectId) {
    if (!objectId || !frame?.contextId) return;
    this.proc.sendRaw('Runtime.disposeObject', {
      executionContextId: frame.contextId, objectId,
    }, this.sessionId, 3000).catch(() => {});
  }

  rootFrame() {
    if (this.rootFrameId && this.frames.has(this.rootFrameId)) return this.frames.get(this.rootFrameId);
    for (const frame of this.frames.values()) if (!frame.parentId) return frame;
    return null;
  }

  async refresh(signal = this.actorSignal) {
    const root = this.rootFrame();
    if (!root) fail('ROOT_UNAVAILABLE', 'Page root frame is not available');
    const ordered = [];
    const queue = [root];
    const seen = new Set();
    while (queue.length) {
      const f = queue.shift();
      if (!f || seen.has(f.frameId)) continue;
      seen.add(f.frameId);
      ordered.push(f);
      for (const child of this.frames.values()) {
        if (child.parentId === f.frameId && !seen.has(child.frameId)) queue.push(child);
      }
    }
    return ordered;
  }

  // Returns the exact array shape expected by composeModel(frames):
  // [{ frameId, parentId, url, snapshot, error, ownerId, capped }]
  async snapshot(options = {}, signal = this.actorSignal) {
    const all = await this.refresh(signal);
    const root = all[0];
    if (!root) fail('ROOT_UNAVAILABLE', 'No root frame');
    const active = all.slice(0, FRAME_CAP);
    const capped = all.slice(FRAME_CAP);

    const captures = await Promise.all(active.map(async frame => {
      try {
        const snap = await this.evaluate(frame, snapshotExpression(options), true, signal);
        if (!snap?.checkpoint) {
          if (frame === root) fail('ROOT_UNAVAILABLE', 'Root frame walker snapshot unavailable');
          return { frame, snapshot: null, error: 'WALKER_UNAVAILABLE' };
        }
        frame.documentId = snap.checkpoint.documentId;
        if (snap.url) { frame.url = snap.url; frame.origin = originOf(snap.url); }
        return { frame, snapshot: snap, error: null };
      } catch (error) {
        signal?.throwIfAborted();
        if (frame === root) fail('ROOT_UNAVAILABLE', `Root frame snapshot failed: ${error.message}`);
        return { frame, snapshot: null, error: error.code ?? 'FRAME_SNAPSHOT_FAILED' };
      }
    }));

    const byId = new Map(captures.map(item => [item.frame.frameId, item]));
    this.owners.clear();
    const usedByParent = new Map(); // parentFrameId → Set<ownerLocalId>
    for (const item of captures) {
      if (!item.frame.parentId) continue;
      const parent = byId.get(item.frame.parentId);
      if (!parent?.snapshot) continue;
      let used = usedByParent.get(parent.frame.frameId);
      if (!used) { used = new Set(); usedByParent.set(parent.frame.frameId, used); }
      const emittedIframes = (parent.snapshot.nodes ?? []).filter(n => n.k === 'f');
      let matchedId = null;
      for (const n of emittedIframes) {
        if (used.has(n.id)) continue;
        const obj = await this.evaluate(parent.frame, resolveExpression(n.id, parent.snapshot.checkpoint.documentId), false, signal).catch(() => null);
        if (!obj?.objectId) continue;
        try {
          const desc = await this.send('Page.describeNode', { frameId: parent.frame.frameId, objectId: obj.objectId }, signal).catch(() => null);
          if (desc?.contentFrameId === item.frame.frameId) { matchedId = n.id; break; }
        } finally {
          this.disposeObject(parent.frame, obj.objectId);
        }
      }
      if (matchedId !== null) {
        used.add(matchedId);
        this.owners.set(item.frame.frameId, matchedId);
      }
    }

    const activeOut = captures.map(({ frame, snapshot, error }) => ({
      frameId: frame.frameId,
      parentId: frame.parentId ?? null,
      url: snapshot?.url || frame.url || '',
      snapshot,
      ...(error ? { error } : {}),
      ownerId: this.owners.get(frame.frameId) ?? null,
    }));
    const cappedOut = capped.map(frame => ({
      frameId: frame.frameId,
      parentId: frame.parentId ?? null,
      url: frame.url || '',
      snapshot: null,
      ownerId: null,
      capped: true,
    }));
    return [...activeOut, ...cappedOut];
  }

  async quiet(frameIds, ms, cap, signal = this.actorSignal) {
    const want = new Set(Array.isArray(frameIds) ? frameIds : frameIds ? [frameIds] : []);
    const all = await this.refresh(signal).catch(() => []);
    const frames = all.filter(f => f.contextId && (!f.parentId || want.has(f.frameId)));
    if (!frames.length) return { quiet: true, waited: 0 };
    const results = await Promise.all(frames.map(f =>
      this.evaluate(f, quietExpression(ms, cap), true, signal).catch(() => ({ quiet: false }))));
    return { quiet: results.every(r => r?.quiet !== false) };
  }

  async describe(frameId, id, documentId, signal = this.actorSignal) {
    const frame = this.frames.get(frameId);
    if (!frame) return { missing: true };
    return this.evaluate(frame, describeExpression(id, documentId), true, signal);
  }

  async resolveObject(frameId, id, documentId, signal = this.actorSignal) {
    const frame = this.frames.get(frameId);
    if (!frame) fail('STALE_REF', 'Stale ref: frame no longer exists');
    const res = await this.evaluate(frame, resolveExpression(id, documentId), false, signal);
    if (!res?.objectId || res.subtype === 'null') fail('STALE_REF', 'Stale ref: its node was removed or its document replaced');
    return { frame, objectId: res.objectId };
  }

  async inView(frameId, id, documentId, signal = this.actorSignal) {
    const frame = this.frames.get(frameId);
    if (!frame) fail('STALE_REF', 'Stale ref: frame no longer exists');
    const res = await this.evaluate(frame, inViewExpression(id, documentId), true, signal);
    if (res?.stale || !res?.view) fail('STALE_REF', 'Stale ref: its node was removed or its document replaced');
    return res.view;
  }

  async prepare(frameId, objectId, beforeDispatch, proxy = null, signal = this.actorSignal) {
    const frame = this.frames.get(frameId);
    if (!frame) fail('STALE_REF', 'Frame no longer exists');
    let targetObj = objectId;
    let disposeTarget = false;
    if (proxy) {
      const resolved = await this.evaluate(frame, actionTargetExpression(proxy.id, proxy.documentId), false, signal);
      if (!resolved?.objectId || resolved.subtype === 'null') fail('STALE_REF', 'Stale ref: its node was removed or its document replaced');
      targetObj = resolved.objectId;
      disposeTarget = true;
    }
    const guard = () => { this.beforeInputDispatch?.(); beforeDispatch?.(); };
    try {
      await this.send('Page.scrollIntoViewIfNeeded', { frameId: frame.frameId, objectId: targetObj }, signal, guard);
      let cur = frame;
      while (cur.parentId) {
        const parent = this.frames.get(cur.parentId);
        const ownerId = this.owners.get(cur.frameId);
        if (!parent || !ownerId) break;
        const ownerObj = await this.evaluate(parent, resolveExpression(ownerId), false, signal).catch(() => null);
        if (ownerObj?.objectId) {
          try {
            await this.send('Page.scrollIntoViewIfNeeded', { frameId: parent.frameId, objectId: ownerObj.objectId }, signal, guard);
          } finally {
            this.disposeObject(parent, ownerObj.objectId);
          }
        }
        cur = parent;
      }
    } finally {
      if (disposeTarget) this.disposeObject(frame, targetObj);
    }
  }

  async inputReady(frameId, signal = this.actorSignal) {
    const frame = this.frames.get(frameId) ?? this.rootFrame();
    const key = frame?.documentId ?? frame?.frameId;
    if (!frame || !key || this.#inputReady.has(key)) return;
    const waitMs = await this.evaluate(frame, PAINT_HOLDING_EXPRESSION, true, signal).catch(() => 0);
    if (typeof waitMs === 'number' && waitMs > 0) await pause(Math.min(waitMs, PAINT_HOLDING_MS), signal);
    if (this.#inputReady.size > 1000) this.#inputReady.clear();
    this.#inputReady.add(key);
  }

  async #toRootOffset(frame, signal) {
    let x = 0, y = 0;
    let cur = frame;
    while (cur?.parentId) {
      const parent = this.frames.get(cur.parentId);
      const ownerId = this.owners.get(cur.frameId);
      if (!parent || !ownerId) fail('STALE_FRAME', 'Parent frame owner could not be resolved');
      const obj = await this.evaluate(parent, resolveExpression(ownerId), false, signal);
      if (!obj?.objectId) fail('STALE_FRAME', 'Iframe owner element disappeared');
      try {
        const stable = await this.callOn(parent, obj.objectId, OWNER_STABLE, [], true, signal);
        if (!stable) throw new BrowserActionabilityError('Target frame kept moving', 'moving');
        const box = await this.callOn(parent, obj.objectId, `function(){
          const r=this.getBoundingClientRect(), s=getComputedStyle(this);
          return { left: r.left + this.clientLeft + parseFloat(s.paddingLeft), top: r.top + this.clientTop + parseFloat(s.paddingTop),
            w: this.clientWidth, h: this.clientHeight,
            visible: this.checkVisibility({ opacityProperty: true, visibilityProperty: true }) };
        }`, [], true, signal);
        if (!box?.visible) throw new BrowserActionabilityError('Target iframe is hidden or occluded', 'frame-occluded');
        x += box.left;
        y += box.top;
      } finally {
        this.disposeObject(parent, obj.objectId);
      }
      cur = parent;
    }
    return { x, y };
  }

  async pointFor(frameId, id, documentId, signal = this.actorSignal) {
    try {
      return await waitForBrowserActionable(async () => {
        const frame = this.frames.get(frameId);
        if (!frame) fail('STALE_REF', 'Target frame no longer exists');
        const res = await this.evaluate(frame, targetPointExpression(id, browserRefPointExpression('t'), documentId), true, signal);
        if (res?.error === 'moving') throw new BrowserActionabilityError('Target kept moving', 'moving');
        if (res?.error === 'covered') {
          const cov = (await this.evaluate(frame, coveringExpression(id, documentId), true, signal).catch(() => null))?.covering;
          throw new BrowserActionabilityError(`Target is covered by ${cov
            ? `${cov.role}${cov.name ? ` ${quoteText(cov.name)}` : ''}` : 'another element'}`, 'covered');
        }
        if (res?.error === 'stale' || res?.stale) fail('STALE_REF', 'Stale ref: its node was removed or its document replaced');
        if (res?.error || !Number.isFinite(res?.x)) fail('NOT_ACTIONABLE', `Target is not actionable: ${String(res?.error ?? 'no point').slice(0, 40)}`);
        const offset = await this.#toRootOffset(frame, signal);
        return { x: Math.round(res.x + offset.x), y: Math.round(res.y + offset.y), frame };
      }, signal ?? undefined, ACTIONABLE_MS);
    } catch (error) {
      if (!(error instanceof BrowserActionabilityError)) throw error;
      fail(error.reason === 'frame-occluded' ? 'FRAME_OCCLUDED' : 'NOT_ACTIONABLE', error.message);
    }
  }

  // Matches FrameDriver.hitChain: { hops, opacity, unverified }
  async hitChain(point, signal = this.actorSignal) {
    let frame = this.rootFrame();
    if (!frame) return { hops: [], opacity: 1, unverified: 'root frame unavailable' };
    let { x, y } = point;
    let opacity = 1;
    const hops = [];
    for (let depth = 0; frame && depth < 16; depth++) {
      const hit = (await this.evaluate(frame, hitExpression(x, y), true, signal).catch(() => null))?.hit;
      if (!hit) return { hops, opacity, unverified: 'no element at the point' };
      opacity *= hit.opacity;
      hops.push({ ...hit, opacity, document: frame });
      if (!hit.visible || !hit.frame) return { hops, opacity };
      const childEntry = [...this.owners.entries()].find(([, ownerId]) => ownerId === hit.frame.id);
      const child = childEntry ? this.frames.get(childEntry[0]) : null;
      if (!child || !child.contextId) return { hops, opacity, unverified: 'frame under the point is not observed' };
      const vp = await this.viewport(child, signal).catch(() => null);
      if (!(vp?.w > 0 && vp?.h > 0 && hit.frame.width > 0 && hit.frame.height > 0)) {
        return { hops, opacity, unverified: 'empty frame' };
      }
      x = (x - hit.frame.left) * vp.w / hit.frame.width;
      y = (y - hit.frame.top) * vp.h / hit.frame.height;
      frame = child;
    }
    return { hops, opacity };
  }

  async armGuard(frameId, id, type, documentId, signal = this.actorSignal) {
    const targetFrame = this.frames.get(frameId);
    if (!targetFrame) return { armed: false };
    const targetRes = await this.evaluate(targetFrame, armGuardExpression(id, type, documentId), true, signal).catch(() => null);
    if (type !== 'pointerdown') {
      const others = [...this.frames.values()].filter(f => f !== targetFrame && f.contextId);
      await Promise.all(others.map(f => this.evaluate(f, armGuardExpression(0, type), true, signal).catch(() => null)));
    }
    return targetRes ?? { armed: false };
  }

  async disarmGuard(frameId) {
    let result = null;
    for (const frame of this.frames.values()) {
      if (!frame.contextId) continue;
      const res = await this.evaluate(frame, disarmGuardExpression(), true, null).catch(() => null);
      if (frame.frameId === frameId) result = res?.guard ?? null;
      else if (res?.guard?.fired) result = { ...(result ?? {}), fired: true, inside: false };
    }
    return result;
  }

  expectInput(type) {
    const credit = { type, until: Infinity };
    this.inputCredits.push(credit);
    return credit;
  }

  settleCredit(credit) { credit.until = Date.now() + INPUT_CREDIT_MS; }

  claimInput(type) {
    const now = Date.now();
    this.inputCredits = this.inputCredits.filter(c => c.until >= now);
    if (type === 'value') return this.inputCredits.some(c => c.type === 'value');
    const at = this.inputCredits.findIndex(c => c.type === type);
    if (at < 0) return false;
    this.inputCredits.splice(at, 1);
    return true;
  }

  async sensitivePresent(origin, signal = this.actorSignal) {
    if (!this.page.connected) return true;
    const frames = [...this.frames.values()];
    if (!frames.length) return true;
    const reachable = frames.filter(f => !origin || !f.origin || f.origin === origin);
    const checks = await Promise.all(reachable.map(f => (!f.contextId
      ? true
      : this.evaluate(f, sensitivePresentExpression(), true, signal).then(r => r?.present !== false, () => true))));
    return checks.some(Boolean);
  }

  async privatize(since, allNonEmpty = false, signal = this.actorSignal) {
    let total = 0;
    for (const frame of this.frames.values()) {
      if (!frame.contextId) continue;
      const res = await this.evaluate(frame, privatizeExpression(since, allNonEmpty), true, signal).catch(() => null);
      if (typeof res?.marked === 'number') total += res.marked;
    }
    return total;
  }

  async textIncludes(text, signal = this.actorSignal) {
    const frames = await this.refresh(signal).catch(() => []);
    const results = await Promise.all(frames.map(f => (f.contextId
      ? this.evaluate(f, textIncludesExpression(text), true, signal).catch(() => null)
      : null)));
    return results.some(r => r?.found);
  }

  async viewport(frame = null, signal = this.actorSignal) {
    const target = frame ?? this.rootFrame();
    if (!target) fail('ROOT_UNAVAILABLE', 'Root frame unavailable');
    return this.evaluate(target, viewportExpression(), true, signal);
  }

  async screenshot(signal = this.actorSignal) {
    const vp = await this.viewport(null, signal);
    const width = Math.max(1, Math.round(vp?.w || 1120));
    const height = Math.max(1, Math.round(vp?.h || 820));
    const reply = await this.send('Page.screenshot', {
      mimeType: 'image/png',
      clip: { x: Math.round(vp?.x || 0), y: Math.round(vp?.y || 0), width, height },
      omitDeviceScaleFactor: true,
    }, signal);
    if (!reply?.data) fail('CAPTURE_FAILED', 'Browser image capture failed; observe again without replaying input');
    return { data: reply.data, buffer: Buffer.from(reply.data, 'base64'), width, height };
  }

  async evaluationContext(frameId, world = 'isolated', signal = this.actorSignal) {
    const frame = frameId ? this.frames.get(frameId) : this.rootFrame();
    if (!frame) fail('STALE_FRAME', 'The frame is not available; observe again');
    if (world === 'page') {
      const ctx = this.pageWorlds.get(frame.frameId);
      if (!ctx) fail('STALE_FRAME', 'The frame has no current page world; observe again');
      return { frame, contextId: ctx };
    }
    let ctx = frame.evalContextId ?? this.#worlds.get(frame.frameId)?.get(this.evaluationWorldName);
    for (let i = 0; i < 20 && !ctx; i++) {
      signal?.throwIfAborted();
      await pause(30, signal);
      ctx = frame.evalContextId ?? this.#worlds.get(frame.frameId)?.get(this.evaluationWorldName);
    }
    if (!ctx) fail('FRAME_UNAVAILABLE', 'Isolated evaluation world is unavailable; never falling back to page world');
    return { frame, contextId: ctx };
  }

  async evaluateUser(frame, contextId, expression, world, beforeDispatch, signal = this.actorSignal) {
    if (world === 'page' && this.rdp) {
      await this.rdp.attachTab(this.page.id, {
        matchTab: t => t.url === this.page.currentUrl,
        onResource: (phase, rtype, item, _from, target) => {
          this.page.devtools?.recordRdp(phase, rtype, item, target?.targetType || null);
        },
      });
      if (this.rdp.connected) {
        return this.rdp.pageEvaluate(this.page.id, {
          expression,
          frameUrl: frame.url,
          beforeSend: () => {
            this.assertNoDialogCleanup();
            this.beforeInputDispatch?.();
            beforeDispatch?.();
          },
        }, signal);
      }
    }
    return this.#evaluateInContext(contextId, expression, true, signal, () => {
      this.beforeInputDispatch?.();
      beforeDispatch?.();
    });
  }

  async pageRead({ expression, frameId, limit = L.chars }, signal = this.actorSignal) {
    const frame = frameId ? this.frames.get(frameId) : this.rootFrame();
    if (!frame) fail('STALE_FRAME', 'The frame has no current page world; observe for current frames');
    if (this.rdp) {
      await this.rdp.attachTab(this.page.id, {
        matchTab: t => t.url === this.page.currentUrl,
        onResource: (phase, rtype, item, _from, target) => {
          this.page.devtools?.recordRdp(phase, rtype, item, target?.targetType || null);
        },
      });
      if (this.rdp.connected) {
        return this.rdp.eagerRead(this.page.id, { expression, frameUrl: frame.url, limit }, signal);
      }
    }
    fail('DEBUGGER_DISCONNECTED', 'Firefox DevTools RDP is unavailable for side-effect-free console reads');
  }

  async inspectElement({ frameId, id, documentId, selector, values = [] }, signal = this.actorSignal) {
    const frame = frameId ? this.frames.get(frameId) : this.rootFrame();
    if (!frame) fail('STALE_FRAME', 'Unknown frame; observe for current frames');
    let obj;
    if (id !== undefined) {
      obj = await this.evaluate(frame, resolveExpression(id, documentId), false, signal);
      if (!obj?.objectId) fail('STALE_REF', 'Element no longer exists; observe for current refs');
    } else {
      const found = await this.evaluate(frame, `(() => {
        let all;
        try { all = document.querySelectorAll(${JSON.stringify(selector)}); } catch { return 'invalid'; }
        return all.length === 1 ? all[0] : String(all.length);
      })()`, false, signal);
      if (found?.type === 'string') {
        if (found.value === 'invalid') fail('INVALID_ARGUMENT', 'Invalid CSS selector');
        fail(found.value === '0' ? 'TARGET_NOT_FOUND' : 'AMBIGUOUS_TARGET', `The selector matches ${found.value} elements in this frame's document; it must match exactly one`);
      }
      obj = found;
    }
    if (!obj?.objectId) fail('TARGET_NOT_FOUND', 'Element could not be resolved');
    try {
      const [info, domPath] = await Promise.all([
        this.callOn(frame, obj.objectId, INSPECT_ELEMENT, [values], true, signal),
        this.callOn(frame, obj.objectId, DOM_PATH_EXPRESSION, [], true, signal).catch(() => null),
      ]);
      let rdpDetails = {};
      if (this.rdp) {
        await this.rdp.attachTab(this.page.id, {
          matchTab: t => t.url === this.page.currentUrl,
          onResource: (phase, rtype, item, _from, target) => {
            this.page.devtools?.recordRdp(phase, rtype, item, target?.targetType || 'worker');
          },
        }).catch(() => {});
        rdpDetails = await this.rdp.inspectNode(this.page.id, { frameUrl: frame.url, domPath, selector }, signal);
      }
      return { ...info, ...rdpDetails };
    } finally {
      this.disposeObject(frame, obj.objectId);
    }
  }

  async performanceSnapshot(signal = this.actorSignal) {
    const root = this.rootFrame();
    if (!root) fail('ROOT_UNAVAILABLE', 'Root frame unavailable');
    const ctx = root.devtoolsContextId ?? this.#worlds.get(root.frameId)?.get(this.devtoolsWorldName) ?? await this.#ensureWalkerContext(root, signal);
    const data = await this.#evaluateInContext(ctx, NAVIGATION_TIMING, true, signal);
    return {
      url: clip(redactURL(data?.url || root.url), L.url),
      m: data?.m,
      nav: data?.nav,
    };
  }

  async jugglerResponseBody(requestId, signal) {
    return this.proc.send('Network.getResponseBody', { requestId }, this.sessionId, { timeoutMs: L.commandMs, signal });
  }

  async rdpResponseBody(actor, limit, signal) {
    if (!this.rdp) fail('BODY_UNAVAILABLE', 'Firefox RDP unavailable');
    return this.rdp.getNetworkResponseBody(actor, limit, signal);
  }

  async dispatchWithCredits(kinds, fn) {
    const credits = [];
    try {
      return await fn(() => {
        for (const kind of kinds) credits.push(this.expectInput(kind));
      });
    } finally {
      for (const c of credits) this.settleCredit(c);
    }
  }

  async dispatchClick(x, y, { beforeDown, onDown, signal = this.actorSignal } = {}) {
    return this.dispatchWithCredits(['pointerdown', 'value'], async grant => {
      let pressed = false;
      try {
        await this.send('Page.dispatchMouseEvent', { type: 'mousemove', button: 0, x, y, modifiers: 0, buttons: 0 }, signal);
        await this.send('Page.dispatchMouseEvent', { type: 'mousedown', button: 0, x, y, modifiers: 0, clickCount: 1, buttons: 1 }, signal, () => {
          this.beforeInputDispatch?.();
          beforeDown?.();
          grant();
          pressed = true;
          onDown?.();
        });
      } finally {
        if (pressed) {
          await this.send('Page.dispatchMouseEvent', { type: 'mouseup', button: 0, x, y, modifiers: 0, clickCount: 1, buttons: 0 }, null).catch(() => {});
        }
      }
    });
  }

  async dispatchKey(keyDef, { beforeDown, signal = this.actorSignal } = {}) {
    const base = {
      key: keyDef.key,
      code: keyDef.code,
      keyCode: keyDef.windowsVirtualKeyCode ?? 0,
      location: 0,
      repeat: false,
      ...(keyDef.text ? { text: keyDef.text } : {}),
    };
    return this.dispatchWithCredits(['keydown', 'value'], async grant => {
      let pressed = false;
      try {
        await this.send('Page.dispatchKeyEvent', { ...base, type: 'keydown' }, signal, () => {
          this.beforeInputDispatch?.();
          beforeDown?.();
          grant();
          pressed = true;
        });
      } finally {
        if (pressed) {
          await this.send('Page.dispatchKeyEvent', { ...base, type: 'keyup' }, null).catch(() => {});
        }
      }
    });
  }

  async dispatchInsertText(text, { beforeSend, signal = this.actorSignal } = {}) {
    return this.dispatchWithCredits(['keydown', 'value'], async grant => {
      await this.send('Page.insertText', { text }, signal, () => {
        this.beforeInputDispatch?.();
        beforeSend?.();
        grant();
      });
    });
  }

  async dispatchSelectAllDelete({ beforeSend, signal = this.actorSignal } = {}) {
    return this.dispatchWithCredits(['keydown', 'value'], async grant => {
      let ctrlDown = false;
      try {
        await this.send('Page.dispatchKeyEvent', { type: 'keydown', key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1, repeat: false }, signal, () => {
          this.beforeInputDispatch?.();
          beforeSend?.();
          grant();
          ctrlDown = true;
        });
        await this.send('Page.dispatchKeyEvent', { type: 'keydown', key: 'a', code: 'KeyA', keyCode: 65, location: 0, repeat: false }, signal, () => {
          this.beforeInputDispatch?.();
          this.expectInput('keydown');
        });
        await this.send('Page.dispatchKeyEvent', { type: 'keyup', key: 'a', code: 'KeyA', keyCode: 65, location: 0, repeat: false }, null).catch(() => {});
      } finally {
        if (ctrlDown) {
          await this.send('Page.dispatchKeyEvent', { type: 'keyup', key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1, repeat: false }, null).catch(() => {});
        }
      }
      let bsDown = false;
      try {
        await this.send('Page.dispatchKeyEvent', { type: 'keydown', key: 'Backspace', code: 'Backspace', keyCode: 8, location: 0, repeat: false }, signal, () => {
          this.beforeInputDispatch?.();
          this.expectInput('keydown');
          bsDown = true;
        });
      } finally {
        if (bsDown) {
          await this.send('Page.dispatchKeyEvent', { type: 'keyup', key: 'Backspace', code: 'Backspace', keyCode: 8, location: 0, repeat: false }, null).catch(() => {});
        }
      }
    });
  }

  async setFileInputFiles(frameId, objectId, files, { beforeSend, signal = this.actorSignal } = {}) {
    return this.dispatchWithCredits(['value'], async grant => {
      await this.send('Page.setFileInputFiles', { frameId, objectId, files }, signal, () => {
        this.beforeInputDispatch?.();
        beforeSend?.();
        grant();
      });
    });
  }

  async handleDialog(dialogId, accept, promptText) {
    return this.send('Page.handleDialog', {
      dialogId, accept: Boolean(accept), ...(promptText !== undefined ? { promptText } : {}),
    });
  }
}

export { quoteText };
