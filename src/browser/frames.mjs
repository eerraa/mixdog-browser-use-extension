import { BrowserActionabilityError, waitForBrowserActionable } from './actionability.mjs';
import { createBrowserCdpExecution } from './cdp-execution.mjs';
import { ELEMENT_SEMANTICS } from './perception/semantics.mjs';
import { browserRefPointExpression, BROWSER_STABLE_RECT } from './perception/target-point.mjs';
import { bounded, pause } from '../shared/async.mjs';
import { fail, freshId } from '../shared/contract.mjs';
import { DEVTOOLS_LIMITS } from './devtools.mjs';
import { quote as quoteText } from './perception/render.mjs';
import {
  actionTargetExpression, armGuardExpression, coveringExpression, describeExpression, disarmGuardExpression, hitExpression,
  inViewExpression, privatizeExpression,
  quietExpression, resolveExpression, sensitivePresentExpression, snapshotExpression, targetPointExpression,
  textIncludesExpression, viewportExpression, walkerInstallSource,
} from './perception/walker.mjs';

const TARGET_TYPES = ['iframe', 'worker', 'shared_worker', 'service_worker'];
// Frames normally arrive within milliseconds; this bounds a stopped compositor.
const PRESENT_TIMEOUT_MS = 3000;
// Transient `moving`, `covered` or occluded-frame results retry read-only (D15).
const ACTIONABLE_MS = 2000;
// Paint holding: Chromium defers a newly committed local root's commits until
// its first contentful paint, at most 500 ms, and drops input meanwhile while
// still acknowledging the dispatch. The margin covers commit after responseStart.
const PAINT_HOLDING_MS = 700;
// Paint entries cannot be created by page script (performance.mark can only
// create marks), so filter them by name rather than getEntriesByName.
const PAINT_HOLDING_EXPRESSION = `(()=>{if(performance.getEntriesByType('paint').some(e=>e.name==='first-contentful-paint'))return 0;`
  + `const nav=performance.getEntriesByType('navigation')[0];`
  + `return Math.max(0,(nav?nav.responseStart:0)+${PAINT_HOLDING_MS}-performance.now())})()`;
// At most this many frames are captured per observation; the rest count as hidden frames.
export const FRAME_CAP = 50;
// How long after its command returned a press or key may still claim the
// trusted event it caused (the binding call and the acknowledgement race).
export const INPUT_CREDIT_MS = 500;
// Binding visible only in the walker world: trusted page input outside an agent dispatch.
export const INPUT_BINDING = '__wbTrustedInput';
// A frame owner's box in its parent document, sampled now and after each of
// the next two animation frames: true only if it never moved.
const OWNER_STABLE = `function(){return new Promise(resolve=>{
  const box=()=>{const r=this.getBoundingClientRect();return [r.left,r.top,r.width,r.height]};
  const first=box();let frames=0;setTimeout(()=>resolve(false),1000);
  const step=()=>{if(box().some((v,i)=>Math.abs(v-first[i])>1))return resolve(false);if(++frames>=2)return resolve(true);requestAnimationFrame(step)};
  requestAnimationFrame(step)})}`;
// Composed once from the walker and its role/name/state helpers
// (walker.mjs, semantics.mjs).
const WALKER_SOURCE = walkerInstallSource(ELEMENT_SEMANTICS);
const TREE_EVENTS = new Set(['Page.frameAttached', 'Page.frameNavigated', 'Page.frameDetached',
  'Runtime.executionContextsCleared', 'Target.attachedToTarget', 'Target.detachedFromTarget']);

// The walker, its document tokens, contexts and node ids exist only in this
// driver's isolated worlds. No preload, Node binding, or renderer-to-main IPC
// is exposed to web pages.
export class FrameDriver {
  #dialogCleanup = new Set();
  #startupCleanup = new Map();
  #consoleEvents = new Map();
  #refreshFlight = null;
  #inputReady = new Set();

  constructor(page, invalidate) {
    this.page = page;
    this.wc = page.contents;
    this.worldName = `independent-browser-${freshId()}`;
    this.evaluationWorldName = `independent-browser-evaluate-${freshId()}`;
    this.devtoolsWorldName = `independent-browser-devtools-${freshId()}`;
    // CDP frameId → {contextId, sessionId} of the page's own main world.
    this.pageWorlds = new Map();
    // The frame tree is cached and rebuilt only after frame or context events.
    this.treeDirty = true;
    // Trusted pointerdown/keydown events the agent's own commands cause: one
    // credit per dispatched press or key, claimed by one event, lapsing
    // INPUT_CREDIT_MS after its command returned (M5). Any other trusted
    // input came from the person around the shield.
    this.inputCredits = [];
    // Child frameId → its owner element's walker id in the parent document.
    this.owners = new Map();
    this.frames = new Map();
    this.sessions = new Map();
    this.targets = new Map();
    this.pending = new Set();
    this.invalidate = invalidate;
    this.cdp = createBrowserCdpExecution({
      bounded, diagnostic: () => {}, awaitingDialog: () => !!page.dialog,
    });
    this.message = (_event, method, params, sessionId) => this.onMessage(method, params, sessionId);
    this.detached = () => {
      this.#retireTargets(true);
      this.page.connected = false;
      this.invalidate('debugger-disconnected');
    };
  }

  async start() {
    this.wc.debugger.attach('1.3');
    this.wc.debugger.on('message', this.message);
    this.wc.debugger.on('detach', this.detached);
    await this.enable();
  }
  async reconnect() {
    // Called only behind the original dispatch/cleanup fence, for a fresh
    // observation or explicit navigation; never to replay an earlier input.
    this.assertNoDialogCleanup();
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3');
    this.#retireTargets();
    this.pageWorlds.clear();
    this.page.frameFailure = null;
    this.treeDirty = true;
    await this.enable();
  }

  send(method, params = {}, sessionId, signal = this.actorSignal, beforeDispatch) {
    if (method === 'Page.handleJavaScriptDialog') {
      // Dispatch outside the parked execution lane, but retain the ACTUAL reply
      // independently of any caller-visible cancellation/timeout wrapper.
      return this.nativeResponse(method, params, sessionId);
    }
    const release = (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased')
      || (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp');
    if (release) {
      // The execution fence's cleanup whitelist (cdp-execution.mjs) does not
      // include held-input releases.
      // Release directly, without the aborted actor or its settling barrier.
      // The owning FenceQueue operation awaits this ACTUAL promise, so neither
      // another input nor manual reveal can pass a still-pending release.
      this.beforeCleanupDispatch?.();
      return this.wc.debugger.sendCommand(method, params, sessionId);
    }
    const cleanup = ['Runtime.releaseObject', 'Runtime.releaseObjectGroup', 'Runtime.runIfWaitingForDebugger'].includes(method);
    const input = /^Input\./.test(method) || ['DOM.focus', 'DOM.setFileInputFiles', 'DOM.scrollIntoViewIfNeeded'].includes(method);
    const guard = beforeDispatch ?? (input ? this.beforeInputDispatch : undefined);
    return this.cdp.sendCdp(this.wc, this.wc.debugger, method, params, 15000,
      cleanup ? undefined : signal ?? undefined, sessionId,
      input || beforeDispatch ? () => { this.assertNoDialogCleanup(); guard?.(); } : undefined);
  }
  nativeResponse(method, params, sessionId, beforeDispatch) {
    // Native responses must resolve requests even when the originating page
    // command is waiting on them. Their actual replies still fence new input.
    beforeDispatch?.();
    return this.trackNativeResponse(this.wc.debugger.sendCommand(method, params, sessionId));
  }
  trackNativeResponse(actual) {
    this.#dialogCleanup.add(actual);
    const settled = () => this.#dialogCleanup.delete(actual);
    actual.then(settled, settled);
    return actual;
  }
  assertNoDialogCleanup() {
    if (this.#dialogCleanup.size) fail('DIALOG_CLEANUP_PENDING', 'A dispatched dialog response is still settling; do not replay it or start new input');
    if (this.pending.size || this.#startupCleanup.size) {
      fail('TARGET_STARTUP_PENDING', 'Owned target startup is still settling; input, native reveal and reconnection remain fenced');
    }
  }
  async waitForIdle(signal) {
    for (;;) {
      signal?.throwIfAborted();
      await this.cdp.waitForIdle(this.wc, signal);
      const actual = [...this.#dialogCleanup, ...this.pending, ...this.#startupCleanup.keys()];
      if (!actual.length) return;
      await bounded(Promise.allSettled(actual), 2000, 'Actual browser dialog or target startup cleanup is pending', signal);
    }
  }
  async enable(sessionId, replays = false) {
    // Recording starts first: its replay cutoff precedes Runtime.enable.
    const recording = this.#record(sessionId, sessionId === undefined ? 'page' : 'iframe', replays);
    await this.send('Page.enable', {}, sessionId, null);
    await this.send('Runtime.enable', {}, sessionId, null);
    await this.send('DOM.enable', {}, sessionId, null);
    await this.send('Page.setInterceptFileChooserDialog', { enabled: !this.nativeMode }, sessionId, null);
    // New documents get the walker before their own scripts run; documents
    // that already exist get it from refresh(), which installs idempotently.
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: WALKER_SOURCE, worldName: this.worldName }, sessionId, null)
      .catch(() => {});
    await this.send('Runtime.addBinding', { name: INPUT_BINDING, executionContextName: this.worldName }, sessionId, null)
      .catch(() => {});
    // Focus emulation: a page in automation behaves as focused without OS
    // focus (agent windows never take focus, D19); off while the person
    // controls it. An out-of-process iframe is its own widget and needs it too.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: !this.nativeMode }, sessionId, null)
      .catch(error => { if (sessionId === undefined) throw error; });
    await this.#autoAttach(sessionId);
    await recording;
  }
  // DevTools recording (devtools.mjs). Page and iframe sessions start it before
  // the target runs, so load-time entries are captured; worker sessions start
  // it after their startup release. It is diagnostic only: commands are sent
  // together and bounded, a target without a domain simply records nothing,
  // and it never fails, fences or replays target setup.
  #record(sessionId, type, replays) {
    const recorder = this.page.devtools;
    if (!recorder) return Promise.resolve();
    return Promise.allSettled(recorder.attach(sessionId, type, replays).map(([method, params]) =>
      this.devtoolsCommand(method, params, sessionId, undefined, DEVTOOLS_LIMITS.enableMs)));
  }
  // One round trip per recording session: once this settles, every event the
  // browser sent before the replies has reached the recorder.
  devtoolsFlush() {
    return Promise.allSettled([undefined, ...this.targets.keys()].map(sessionId =>
      this.devtoolsCommand('Runtime.getIsolateId', {}, sessionId, undefined, DEVTOOLS_LIMITS.flushMs)));
  }
  // DevTools reads beside the action lane: no input, no execution fence; the
  // only evaluation sent here uses V8's best-effort throwOnSideEffect
  // (devtools.mjs pageRead).
  devtoolsCommand(method, params = {}, sessionId, signal, timeoutMs = DEVTOOLS_LIMITS.commandMs) {
    // Dispatched synchronously, so callers control the order against setup commands.
    signal?.throwIfAborted();
    let actual;
    try { actual = this.wc.debugger.sendCommand(method, params, sessionId); } catch (error) { actual = Promise.reject(error); }
    return bounded(actual, timeoutMs, `DevTools ${method}`, signal);
  }
  pageContext(frameId) {
    return this.pageWorlds.get(frameId);
  }
  #attachmentPolicy() {
    return {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      // Excluded workers can remain paused without a session to release them
      // in the pinned runtime. Admit only these known target kinds, then keep
      // worker startup entirely separate from iframe observation authority.
      filter: [...TARGET_TYPES.map(type => ({ type, exclude: false })), { exclude: true }],
    };
  }
  async #autoAttach(sessionId) {
    await this.send('Target.setAutoAttach', this.#attachmentPolicy(), sessionId, null);
  }
  #currentTarget(target) {
    return !this.page.closed && this.targets.get(target.sessionId) === target;
  }
  #workerControl(target, method) {
    if (!this.#currentTarget(target) || target.type === 'iframe'
      || !['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'].includes(method)) {
      fail('TARGET_SESSION_ENDED', 'Worker startup control requires its current owned session');
    }
    const params = method === 'Target.setAutoAttach' ? this.#attachmentPolicy() : {};
    let resolve, reject, end;
    const actual = new Promise((yes, no) => { resolve = yes; reject = no; });
    const ended = new Promise((_yes, no) => { end = no; });
    const fence = Promise.race([actual, ended]);
    // Register before dispatch, independently of the current actor and the
    // CDP execution barrier. Only an actual reply or native termination
    // ends this obligation; caller-facing timeouts never release startup early.
    this.#startupCleanup.set(fence, { sessionId: target.sessionId, end });
    const settled = () => this.#startupCleanup.delete(fence);
    fence.then(settled, settled);
    try {
      this.wc.debugger.sendCommand(method, params, target.sessionId).then(resolve, reject);
    } catch (error) { reject(error); }
    return fence;
  }
  #endStartup(sessionId) {
    for (const [fence, owner] of this.#startupCleanup) {
      if (sessionId !== undefined && owner.sessionId !== sessionId) continue;
      this.#startupCleanup.delete(fence);
      owner.end(new Error('Inspected worker session ended'));
    }
  }
  async #initializeTarget(target) {
    if (!this.#currentTarget(target)) return;
    let setupError;
    try {
      if (target.type === 'iframe') await this.enable(target.sessionId, !target.waitingForDebugger);
      else await this.#workerControl(target, 'Target.setAutoAttach');
    } catch (error) {
      if (!this.#currentTarget(target)) return;
      // A failed iframe must not execute without its required initialization.
      if (target.type === 'iframe') throw error;
      setupError = error;
    }
    if (!this.#currentTarget(target)) return;
    try {
      if (target.type === 'iframe' || target.waitingForDebugger) {
        // This is cancellation-independent cleanup of our debugger's startup
        // pause, not permission to evaluate, send input, or resume automation.
        if (target.type === 'iframe') {
          await this.send('Runtime.runIfWaitingForDebugger', {}, target.sessionId, null);
        } else {
          await this.#workerControl(target, 'Runtime.runIfWaitingForDebugger');
        }
      }
    } catch (error) {
      if (setupError) throw new AggregateError([setupError, error], 'Worker setup and startup release failed');
      throw error;
    }
    if (setupError) throw setupError;
    // Worker recording is never part of the startup fence: Runtime.enable
    // replays what the worker logged since its release.
    if (target.type !== 'iframe' && this.#currentTarget(target)) void this.#record(target.sessionId, target.type, !target.waitingForDebugger);
  }
  #retireTarget(sessionId, nativeEnded = false) {
    // Parent metadata is not proof that a descendant's native session ended.
    // Each child remains owned/fenced until its own event or debugger detach.
    const target = this.targets.get(sessionId);
    this.targets.delete(sessionId);
    if (target) this.pending.delete(target.task);
    this.cdp.endSession(this.wc, sessionId);
    this.sessions.delete(sessionId);
    for (const [id, frame] of this.frames) if (frame.sessionId === sessionId) this.frames.delete(id);
    for (const [id, world] of this.pageWorlds) if (world.sessionId === sessionId) this.pageWorlds.delete(id);
    this.page.devtools?.detach(sessionId);
    this.#consoleEvents.delete(sessionId);
    if (nativeEnded) this.#endStartup(sessionId);
  }
  #retireTargets(nativeEnded = false) {
    for (const sessionId of this.targets.keys()) this.#retireTarget(sessionId, nativeEnded);
    for (const sessionId of this.sessions.keys()) this.#retireTarget(sessionId, nativeEnded);
    this.frames.clear();
    if (nativeEnded) this.#endStartup();
  }
  async setNativeMode(native) {
    this.nativeMode = native;
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: !native }, undefined, null);
    await this.send('Page.setInterceptFileChooserDialog', { enabled: !native }, undefined, null);
    for (const sessionId of this.sessions.keys()) {
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: !native }, sessionId, null).catch(() => {});
      await this.send('Page.setInterceptFileChooserDialog', { enabled: !native }, sessionId, null);
    }
  }

  onMessage(method, params, sessionId) {
    sessionId = sessionId || undefined;
    this.page.devtools?.record(method, params, sessionId);
    if (TREE_EVENTS.has(method) || (method === 'Runtime.executionContextCreated' && params.context?.name === this.worldName)) {
      this.treeDirty = true;
    }
    if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
      // The renderer keeps its own console store for replays; trim it periodically.
      const count = (this.#consoleEvents.get(sessionId) ?? 0) + 1;
      this.#consoleEvents.set(sessionId, count % DEVTOOLS_LIMITS.discardEvery);
      if (count >= DEVTOOLS_LIMITS.discardEvery) this.devtoolsCommand('Runtime.discardConsoleEntries', {}, sessionId).catch(() => {});
    }
    if (method === 'Runtime.bindingCalled' && params.name === INPUT_BINDING) {
      // The binding exists only in contexts named after the walker world
      // (Runtime.addBinding executionContextName); page scripts cannot call it.
      const type = String(params.payload);
      if (!this.claimInput(type)) this.page.onTrustedInput?.(type);
      return;
    }
    if (method.startsWith('Runtime.')) {
      this.#trackPageWorld(method, params, sessionId);
      // Worker Runtime events exist only for DevTools recording; workers never
      // carry observation authority.
      if (sessionId !== undefined && this.targets.has(sessionId) && this.targets.get(sessionId).type !== 'iframe') return;
    }
    if (method === 'Target.attachedToTarget') {
      // A delayed descendant event cannot revive a retired parent session.
      if (sessionId && !this.targets.has(sessionId)) return;
      const child = params.sessionId;
      const type = params.targetInfo.type;
      if (!TARGET_TYPES.includes(type)) {
        this.page.frameFailure = 'Unsupported child target type';
        this.invalidate('unsupported-target');
        return;
      }
      const target = {
        sessionId: child, type,
        waitingForDebugger: params.waitingForDebugger,
      };
      this.targets.set(child, target);
      if (type === 'iframe') this.sessions.set(child, params.targetInfo.targetId);
      const task = Promise.resolve().then(() => this.#initializeTarget(target)).catch(error => {
        if (!this.#currentTarget(target)) return;
        target.failure = error;
        // A failed iframe stays paused (never released without its setup) and
        // is reported as an unavailable frame; it does not block the page.
        if (type === 'iframe') this.treeDirty = true;
        else this.page.frameFailure = 'Worker target initialization failed';
        this.invalidate(type === 'iframe' ? 'frame-attach-failed' : 'worker-attach-failed');
      }).finally(() => this.pending.delete(task));
      target.task = task;
      this.pending.add(task);
      if (type === 'iframe') this.invalidate('frame-attached');
    } else if (method === 'Target.detachedFromTarget') {
      const frame = this.sessions.has(params.sessionId);
      this.#retireTarget(params.sessionId, true);
      if (frame) this.invalidate('frame-detached');
    } else if (['Page.frameNavigated', 'Page.frameDetached', 'Page.navigatedWithinDocument', 'Runtime.executionContextsCleared'].includes(method)) {
      if (method === 'Runtime.executionContextsCleared') {
        for (const [id, frame] of this.frames) if (frame.sessionId === sessionId) this.frames.delete(id);
      } else if (method !== 'Page.navigatedWithinDocument' && (params.frame?.id || params.frameId)) {
        // A same-document navigation keeps the document and its walker.
        this.frames.delete(params.frame?.id || params.frameId);
      }
      this.invalidate(method);
    } else if (method === 'Page.javascriptDialogOpening') {
      this.page.dialog = { type: params.type, message: params.message ?? '', sessionId };
      const managed = this.page.onNativeDialog?.(this.page.dialog);
      if (!managed) this.page.dialogOpened?.({ disposition: 'executed', tabId: this.page.id, dialog: { type: params.type } });
    } else if (method === 'Page.javascriptDialogClosed') {
      this.page.onNativeDialogClosed?.(this.page.dialog);
      this.page.dialog = null;
    } else if (method === 'Page.fileChooserOpened') {
      this.page.onNativePicker?.(params, sessionId);
    }
  }

  // The current frame tree with the walker installed in every frame. Cached:
  // rebuilt only after frame, target or context events (TREE_EVENTS).
  async refresh() {
    for (;;) {
      while (this.pending.size) await Promise.all([...this.pending]);
      if (this.page.frameFailure) fail('FRAME_UNAVAILABLE', this.page.frameFailure);
      if (this.#refreshFlight) { await this.#refreshFlight; continue; }
      if (!this.treeDirty) return [...this.frames.values()];
      this.treeDirty = false;
      this.#refreshFlight = this.#rebuild().catch(error => { this.treeDirty = true; throw error; })
        .finally(() => { this.#refreshFlight = null; });
      await this.#refreshFlight;
    }
  }
  async #rebuild() {
    const tree = new Map();
    const add = (node, sessionId, inheritedParent) => {
      const id = node.frame.id;
      const existing = tree.get(id);
      // A child target's own tree is authoritative for its execution session.
      if (!existing || sessionId) tree.set(id, {
        id, parentId: node.frame.parentId || inheritedParent || existing?.parentId,
        url: node.frame.url, origin: node.frame.securityOrigin, sessionId,
      });
      for (const child of node.childFrames || []) add(child, sessionId, id);
    };
    // Only the root is required. A child whose session, tree, world or walker
    // cannot be set up is an unavailable frame: observations report it and
    // carry on, and the next observation tries it again.
    add((await this.send('Page.getFrameTree')).frameTree, undefined);
    for (const [sessionId, targetId] of this.sessions) {
      const parent = tree.get(targetId)?.parentId;
      const failed = this.targets.get(sessionId)?.failure;
      let subtree = null;
      if (!failed) {
        try { subtree = (await this.send('Page.getFrameTree', {}, sessionId)).frameTree; } catch {
          this.actorSignal?.throwIfAborted();
        }
      }
      if (subtree) add(subtree, sessionId, parent);
      else if (tree.has(targetId)) {
        const known = tree.get(targetId);
        tree.set(targetId, { id: targetId, parentId: parent, url: known.url, origin: known.origin, sessionId, unavailable: true });
      }
    }
    for (const id of this.frames.keys()) if (!tree.has(id)) { this.frames.delete(id); this.owners.delete(id); }
    // Root first, then tree order: only the first FRAME_CAP frames get a world
    // and the walker; the rest are listed as capped (hidden frames) and never
    // evaluated, so a page with thousands of frames costs a bounded setup.
    const ordered = [...[...tree].filter(([, frame]) => !frame.parentId), ...[...tree].filter(([, frame]) => frame.parentId)];
    for (const [id, frame] of ordered.slice(FRAME_CAP)) this.frames.set(id, { ...frame, contextId: undefined, capped: true });
    await Promise.all(ordered.slice(0, FRAME_CAP).map(async ([id, frame]) => {
      if (frame.unavailable) { this.frames.set(id, frame); return; }
      const old = this.frames.get(id);
      try {
        // The same world name returns the frame's existing isolated world.
        const result = await this.send('Page.createIsolatedWorld', {
          frameId: id, worldName: this.worldName, grantUniveralAccess: false,
        }, frame.sessionId);
        frame.contextId = result.executionContextId;
        frame.documentId = old?.contextId === frame.contextId && old?.sessionId === frame.sessionId ? old.documentId : freshId();
        this.frames.set(id, frame);
        // Idempotent: a document that already has the walker keeps its state.
        await this.evaluate(frame, WALKER_SOURCE);
      } catch (error) {
        if (!frame.parentId) throw error;
        this.actorSignal?.throwIfAborted();
        this.frames.set(id, { ...frame, contextId: undefined, unavailable: true });
      }
    }));
  }
  // One parallel walker snapshot per frame (D15): each is atomic with its own
  // checkpoint, so no cross-frame quiet is required. A subframe failure is
  // reported in its entry and never fails the snapshot (composeModel decides).
  async snapshot() {
    // The frames set up by refresh (root first, at most FRAME_CAP); the rest are hidden.
    const capture = all => all.filter(frame => !frame.capped);
    let all = await this.refresh();
    let frames = capture(all);
    let results = await Promise.all(frames.map(frame => this.#snapshotFrame(frame)));
    if (results.some(result => !result.snapshot) && this.treeDirty) {
      // A document was replaced during the capture: re-take the failed frames once.
      all = await this.refresh();
      frames = capture(all);
      const failed = new Set(results.filter(result => !result.snapshot).map(result => result.frameId));
      const kept = new Map(results.filter(result => result.snapshot).map(result => [result.frameId, result]));
      results = await Promise.all(frames.map(frame => (kept.has(frame.id) && !failed.has(frame.id)
        ? kept.get(frame.id) : this.#snapshotFrame(frame))));
    }
    const byId = new Map(results.map(result => [result.frameId, result]));
    await Promise.all(results.filter(result => result.parentId).map(async result => {
      result.ownerId = await this.#ownerId(result, byId.get(result.parentId));
    }));
    // Unavailable frames are set up again on the next observation.
    if (all.some(frame => frame.unavailable)) this.treeDirty = true;
    const captured = new Set(frames.map(frame => frame.id));
    return [...results, ...all.filter(frame => !captured.has(frame.id)).map(frame => ({
      frameId: frame.id, parentId: frame.parentId ?? null, url: frame.url, snapshot: null, ownerId: null, capped: true,
    }))];
  }
  async #snapshotFrame(frame) {
    const entry = { frameId: frame.id, parentId: frame.parentId ?? null, url: frame.url, snapshot: null, ownerId: null };
    if (frame.unavailable) return { ...entry, error: 'FRAME_UNAVAILABLE' };
    try {
      let snapshot = await this.evaluate(frame, snapshotExpression());
      if (snapshot?.missing) {
        await this.evaluate(frame, WALKER_SOURCE);
        snapshot = await this.evaluate(frame, snapshotExpression());
      }
      if (!snapshot?.checkpoint) return { ...entry, error: 'WALKER_UNAVAILABLE' };
      return { ...entry, snapshot };
    } catch (error) {
      this.actorSignal?.throwIfAborted();
      return { ...entry, error: error.code ?? 'FRAME_SNAPSHOT_FAILED' };
    }
  }
  // The walker id of a child frame's owner element in its parent document:
  // an id when the owner was emitted, -1 when it exists but was not rendered,
  // null when it could not be mapped. Cached while the owner keeps its id.
  async #ownerId(child, parentResult) {
    const parent = this.frames.get(child.parentId);
    if (!parent || !parentResult?.snapshot) return null;
    const emitted = new Set(parentResult.snapshot.nodes.filter(node => node.k === 'f').map(node => node.id));
    const cached = this.owners.get(child.frameId);
    if (cached && cached.contextId === parent.contextId && emitted.has(cached.id)) return cached.id;
    try {
      const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId: child.frameId }, parent.sessionId);
      const { object } = await this.send('DOM.resolveNode', { backendNodeId, executionContextId: parent.contextId }, parent.sessionId);
      try {
        const id = await this.callOn(parent, object.objectId, 'function(){return globalThis.__independentState?.idOf(this)||0}');
        if (!id || !emitted.has(id)) return -1;
        this.owners.set(child.frameId, { id, contextId: parent.contextId });
        return id;
      } finally { await this.release(parent, object.objectId); }
    } catch (error) {
      this.actorSignal?.throwIfAborted();
      return null;
    }
  }
  // Settle's quiet window (D16): no significant mutation for `ms` in the root
  // and the given frames, capped at `cap`. A frame that goes away is not quiet.
  async quiet(frameIds, ms, cap) {
    const frames = (await this.refresh()).filter(frame => frame.contextId !== undefined && (!frame.parentId || frameIds.includes(frame.id)));
    // A read-only probe outside the execution fence, bounded by the cap: a
    // busy renderer that answers late leaves nothing that holds up the next
    // action's fence.
    const results = await Promise.all(frames.map(async frame => {
      try {
        const reply = await this.devtoolsCommand('Runtime.evaluate', {
          expression: quietExpression(ms, cap), contextId: frame.contextId, returnByValue: true, awaitPromise: true,
        }, frame.sessionId, this.actorSignal ?? undefined, cap + 100);
        return reply.exceptionDetails ? { quiet: false } : reply.result?.value;
      } catch (error) {
        this.actorSignal?.throwIfAborted();
        return { quiet: false, error: error.code };
      }
    }));
    return { quiet: results.every(result => result?.quiet !== false) };
  }
  // observe {wait}: is the text rendered in any frame?
  async textIncludes(text) {
    const frames = await this.refresh();
    const results = await Promise.all(frames.map(frame => this.evaluate(frame, textIncludesExpression(text)).catch(error => {
      this.actorSignal?.throwIfAborted();
      return null;
    })));
    return results.some(result => result?.found);
  }
  // The live element behind a walker id, only in the same document.
  async resolveObject(frame, id, documentId) {
    const result = await this.evaluate(frame, resolveExpression(id, documentId), false);
    if (!result.objectId || result.subtype === 'null') fail('STALE_REF', 'Stale ref: its node was removed or its document replaced');
    return result.objectId;
  }
  describe(frame, id, documentId) {
    return this.evaluate(frame, describeExpression(id, documentId));
  }
  viewport(frame) {
    return this.evaluate(frame, viewportExpression());
  }
  // Live check before input: is the target (or its label proxy) in its frame's viewport now?
  async inView(frame, id, documentId) {
    const result = await this.evaluate(frame, inViewExpression(id, documentId));
    if (result?.stale || !result?.view) fail('STALE_REF', 'Stale ref: its node was removed or its document replaced');
    return result.view;
  }
  // Read-only actionability (ref-point script, target-point.mjs) plus ancestor frame
  // hit tests; transient results retry for up to ACTIONABLE_MS.
  async pointFor(frame, id, documentId, signal = this.actorSignal) {
    try {
      return await waitForBrowserActionable(async () => {
        const point = await this.evaluate(frame, targetPointExpression(id, browserRefPointExpression('t'), documentId));
        if (point?.error === 'moving') throw new BrowserActionabilityError('Target kept moving', 'moving');
        if (point?.error === 'covered') {
          // Named by the walker, never by the ref-point script's textContent label.
          const covering = (await this.evaluate(frame, coveringExpression(id, documentId)).catch(() => null))?.covering;
          throw new BrowserActionabilityError(`Target is covered by ${covering
            ? `${covering.role}${covering.name ? ` ${quoteText(covering.name)}` : ''}` : 'another element'}`, 'covered');
        }
        if (point?.error === 'stale' || point?.stale) fail('STALE_REF', 'Stale ref: its node was removed or its document replaced');
        if (point?.error || !Number.isFinite(point?.x)) fail('NOT_ACTIONABLE', `Target is not actionable: ${String(point?.error ?? 'no point').slice(0, 40)}`);
        try {
          // Every frame owner on the chain must hold still across two
          // animation frames, measured inside its parent document; a moving
          // (cross-origin) frame is not a target.
          await this.#ownersStable(frame);
          return await this.toRoot(frame, point);
        } catch (error) {
          if (error.code === 'FRAME_OCCLUDED') throw new BrowserActionabilityError(error.message, 'frame-occluded');
          throw error;
        }
      }, signal ?? undefined, ACTIONABLE_MS);
    } catch (error) {
      if (!(error instanceof BrowserActionabilityError)) throw error;
      fail(error.reason === 'frame-occluded' ? 'FRAME_OCCLUDED' : 'NOT_ACTIONABLE', error.message);
    }
  }

  async presented() {
    // A visible view's newly committed document has no copyable surface until
    // it presents a frame. Two animation frames prove one was produced. The
    // page-side timer settles the evaluation if frames stop, so no command
    // stays pending behind a capture that can never complete.
    const root = (await this.refresh()).find(frame => !frame.parentId);
    if (!root) fail('STALE_FRAME', 'The root frame is not observed');
    const presented = await this.evaluate(root, `new Promise(resolve=>{setTimeout(()=>resolve(false),${PRESENT_TIMEOUT_MS});`
      + 'requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))})');
    if (presented !== true) fail('CAPTURE_FAILED', 'The page presented no frame; observe again without replaying input');
  }
  // Before the first input to a document: wait out paint holding of the root
  // and of the target's frame (an iframe may be its own local root). Read-only;
  // once a document is past it, it stays past it.
  async inputReady(target, signal = this.actorSignal) {
    const all = await this.refresh();
    // Every local root on the target's frame chain: the root and each frame
    // whose parent runs in another session (an out-of-process iframe).
    const chain = [];
    for (let frame = target ? this.frames.get(target.id) ?? target : null; frame; frame = frame.parentId ? this.frames.get(frame.parentId) : null) {
      const parent = frame.parentId ? this.frames.get(frame.parentId) : null;
      if (!parent || parent.sessionId !== frame.sessionId) chain.push(frame);
    }
    const root = all.find(frame => !frame.parentId);
    const frames = [...new Set([root, ...chain])].filter(frame => frame && !this.#inputReady.has(frame.documentId));
    if (!frames.length) return;
    const waits = await Promise.all(frames.map(frame => this.evaluate(frame, PAINT_HOLDING_EXPRESSION)));
    const wait = Math.max(...waits.map(value => Number(value) || 0));
    if (wait > 0) await pause(Math.min(wait, PAINT_HOLDING_MS), signal ?? undefined);
    if (this.#inputReady.size > 1000) this.#inputReady.clear();
    for (const frame of frames) this.#inputReady.add(frame.documentId);
  }
  async #ownersStable(frame) {
    for (let current = frame; current.parentId;) {
      const parent = this.frames.get(current.parentId);
      if (!parent) fail('STALE_FRAME', 'Ancestor frame was replaced');
      const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId: current.id }, parent.sessionId);
      const { object } = await this.send('DOM.resolveNode', { backendNodeId, executionContextId: parent.contextId }, parent.sessionId);
      try {
        if (!await this.callOn(parent, object.objectId, OWNER_STABLE)) throw new BrowserActionabilityError('Target frame kept moving', 'moving');
      } finally { await this.release(parent, object.objectId); }
      current = parent;
    }
  }
  expectInput(type) {
    const credit = { type, until: Infinity };
    this.inputCredits.push(credit);
    return credit;
  }
  settleCredit(credit) { credit.until = Date.now() + INPUT_CREDIT_MS; }
  claimInput(type) {
    const now = Date.now();
    this.inputCredits = this.inputCredits.filter(credit => credit.until >= now);
    const at = this.inputCredits.findIndex(credit => credit.type === type);
    if (at < 0) return false;
    this.inputCredits.splice(at, 1);
    return true;
  }
  // Marks fields typed by the person since `since` as sensitive in every frame.
  async privatize(since) {
    const frames = await this.refresh();
    await Promise.all(frames.map(frame => this.evaluate(frame, privatizeExpression(since)).catch(() => null)));
  }
  // Page code in one frame reaches every same-origin document of the page
  // (contentDocument, parent, named windows), so a filled secret in any of
  // them counts. A same-origin frame that cannot be checked counts too.
  async sensitivePresent(origin, refresh = true) {
    const frames = refresh ? await this.refresh() : [...this.frames.values()];
    const reachable = frames.filter(frame => !origin || !frame.origin || frame.origin === origin);
    const present = await Promise.all(reachable.map(frame => (frame.contextId === undefined ? true
      : this.evaluate(frame, sensitivePresentExpression()).then(result => result?.present !== false, () => true))));
    return present.some(Boolean);
  }
  armGuard(frame, id, type, documentId) {
    return this.evaluate(frame, armGuardExpression(id, type, documentId));
  }
  async disarmGuard(frame) {
    return (await this.evaluate(frame, disarmGuardExpression()))?.guard ?? null;
  }
  // The hit chain under a root viewport point, through every frame: each hop
  // with its element label, effective opacity and visibility (D18, points).
  async hitChain(point) {
    const frames = await this.refresh();
    let frame = frames.find(candidate => !candidate.parentId);
    let { x, y } = point;
    let opacity = 1;
    const hops = [];
    for (let depth = 0; frame && depth < 16; depth++) {
      const hit = (await this.evaluate(frame, hitExpression(x, y)))?.hit;
      if (!hit) return { hops, opacity, unverified: 'no element at the point' };
      opacity *= hit.opacity;
      // document: the frame the hit element is in (hit.frame is an iframe's box).
      hops.push({ ...hit, opacity, document: frame });
      if (!hit.visible) return { hops, opacity };
      if (!hit.frame) return { hops, opacity };
      let child = null;
      for (const candidate of frames.filter(entry => entry.parentId === frame.id)) {
        try {
          const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId: candidate.id }, frame.sessionId);
          const { object } = await this.send('DOM.resolveNode', { backendNodeId, executionContextId: frame.contextId }, frame.sessionId);
          try {
            if (await this.callOn(frame, object.objectId, 'function(){return globalThis.__independentState?.idOf(this)||0}') === hit.frame.id) child = candidate;
          } finally { await this.release(frame, object.objectId); }
        } catch { /* a frame that went away is not the hit */ }
        if (child) break;
      }
      if (!child || child.contextId === undefined) return { hops, opacity, unverified: 'frame under the point is not observed' };
      const viewport = await this.viewport(child);
      if (!(viewport?.w > 0 && viewport?.h > 0 && hit.frame.width > 0 && hit.frame.height > 0)) return { hops, opacity, unverified: 'empty frame' };
      x = (x - hit.frame.left) * viewport.w / hit.frame.width;
      y = (y - hit.frame.top) * viewport.h / hit.frame.height;
      frame = child;
    }
    return { hops, opacity };
  }
  // mutation: true (guarded like input) or a function run inside the guard,
  // right before the command is sent (marks the input as sent).
  #guard(mutation) {
    if (typeof mutation === 'function') return () => { this.beforeInputDispatch?.(); mutation(); };
    return mutation ? this.beforeInputDispatch : undefined;
  }
  async evaluate(frame, expression, byValue = true, mutation = false) {
    // Without its own context id an evaluation would run in the page's main
    // world; an unavailable frame is never evaluated.
    if (frame.unavailable || frame.capped || frame.contextId === undefined) fail('FRAME_UNAVAILABLE', 'The frame is unavailable; observe again');
    const result = await this.send('Runtime.evaluate', {
      expression, contextId: frame.contextId, returnByValue: byValue, awaitPromise: true,
      // Never userGesture:true: browser/OS activation requirements remain intact.
    }, frame.sessionId, this.actorSignal, this.#guard(mutation));
    if (result.exceptionDetails) fail('PAGE_SCRIPT_ERROR', 'Page script failed (details withheld to avoid exposing secrets)');
    if (byValue && result.result.unserializableValue !== undefined) fail('NON_JSON_RESULT', 'Expression must return JSON-serializable data');
    return byValue ? result.result.value ?? null : result.result;
  }
  #trackPageWorld(method, params, sessionId) {
    if (method === 'Runtime.executionContextCreated') {
      const { id, auxData } = params.context;
      if (auxData?.isDefault && auxData.frameId) this.pageWorlds.set(auxData.frameId, { contextId: id, sessionId });
    } else if (method === 'Runtime.executionContextDestroyed' || method === 'Runtime.executionContextsCleared') {
      for (const [frameId, world] of this.pageWorlds) {
        if (world.sessionId === sessionId && (method === 'Runtime.executionContextsCleared'
          || world.contextId === params.executionContextId)) this.pageWorlds.delete(frameId);
      }
    }
  }
  // The evaluation context, resolved BEFORE the evaluation is dispatched, so a
  // missing world is a not-executed failure.
  async evaluationContext(frame, world = 'isolated') {
    if (world === 'page') {
      // Explicit opt-in (D11): the page's own main world. Page scripts can
      // observe and tamper with this evaluation and its result.
      const context = this.pageWorlds.get(frame.id);
      if (!context || context.sessionId !== frame.sessionId) fail('STALE_FRAME', 'The frame has no current page world; observe again');
      return context.contextId;
    }
    // Model JavaScript never runs in the observation/ref authority world.
    const { executionContextId } = await this.send('Page.createIsolatedWorld', {
      frameId: frame.id, worldName: this.evaluationWorldName, grantUniveralAccess: false,
    }, frame.sessionId);
    return executionContextId;
  }
  evaluateUser(frame, expression, _world, contextId, beforeDispatch = true) {
    return this.evaluate({ ...frame, contextId }, expression, true, beforeDispatch);
  }
  async callOn(frame, objectId, functionDeclaration, values = [], byValue = true, mutation = false) {
    const result = await this.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration, arguments: values.map(value => ({ value })),
      returnByValue: byValue, awaitPromise: true,
    }, frame.sessionId, this.actorSignal, this.#guard(mutation));
    if (result.exceptionDetails) fail('TARGET_CHANGED', 'Target verification or operation failed');
    return result.result.value;
  }
  // Scroll a target into view: its own box, or its label proxy's box for a
  // hidden custom checkbox/radio/file input (proxy = { id, documentId }).
  async prepare(frame, elementObjectId, beforeDispatch, proxy = null) {
    if (proxy) {
      const target = await this.evaluate(frame, actionTargetExpression(proxy.id, proxy.documentId), false);
      if (!target.objectId || target.subtype === 'null') fail('STALE_REF', 'Stale ref: its node was removed or its document replaced');
      try { return await this.prepare(frame, target.objectId, beforeDispatch); } finally { await this.release(frame, target.objectId); }
    }
    const objectId = elementObjectId;
    const guard = () => { this.beforeInputDispatch?.(); beforeDispatch(); };
    await this.send('DOM.scrollIntoViewIfNeeded', { objectId }, frame.sessionId, this.actorSignal, guard);
    let current = frame;
    while (current.parentId) {
      const parent = this.frames.get(current.parentId);
      if (!parent) fail('STALE_FRAME', 'Ancestor frame was replaced during preparation');
      const { backendNodeId } = await this.#frameOwner(current, parent);
      await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, parent.sessionId, this.actorSignal, guard);
      current = parent;
    }
    const stable = await this.callOn(frame, objectId, `async function() {
      if(!this.isConnected)return false;
      const rect=await (${BROWSER_STABLE_RECT})(this);
      return !!rect&&this.isConnected;
    }`);
    if (!stable) fail('TARGET_CHANGED', 'Target was replaced or moved during preparation');
  }
  async toRoot(frame, point) {
    let current = frame;
    let p = point;
    while (current.parentId) {
      const parent = this.frames.get(current.parentId);
      if (!parent) fail('STALE_FRAME', 'Parent frame was replaced');
      const owner = await this.#frameOwner(current, parent);
      const backendNodeId = owner.backendNodeId;
      let q = owner.quad;
      const grandparent = parent.parentId ? this.frames.get(parent.parentId) : null;
      if (parent.parentId && !grandparent) fail('STALE_FRAME', 'Ancestor frame was replaced');
      if (grandparent && grandparent.sessionId === parent.sessionId) {
        // getBoxModel is relative to the CDP target root, not necessarily this
        // parent document. Invert the parent's actual target-root content box
        // before composing or doing parent-document elementFromPoint.
        const box = (await this.#frameOwner(parent, grandparent)).quad;
        const viewport = await this.viewport(parent);
        if (!(viewport?.w > 0 && viewport?.h > 0)) fail('NOT_ACTIONABLE', 'Parent frame has an empty viewport');
        q = q.map((value, index) => index % 2
          ? (value - box[1]) * viewport.h / (box[5] - box[1])
          : (value - box[0]) * viewport.w / (box[2] - box[0]));
      }
      const childState = await this.viewport(current);
      if (!(childState?.w > 0 && childState?.h > 0)) fail('NOT_ACTIONABLE', 'Child frame has an empty viewport');
      p = { x: q[0] + p.x * (q[2] - q[0]) / childState.w,
        y: q[1] + p.y * (q[5] - q[1]) / childState.h };
      const { object } = await this.send('DOM.resolveNode', { backendNodeId, executionContextId: parent.contextId }, parent.sessionId);
      try {
        const hit = await this.callOn(parent, object.objectId, `function(x,y) {
          let hit=document.elementFromPoint(x,y);
          while(hit?.shadowRoot) { const next=hit.shadowRoot.elementFromPoint(x,y); if(!next||next===hit)break;hit=next; }
          return hit===this;
        }`, [p.x, p.y]);
        if (!hit) fail('FRAME_OCCLUDED', 'Parent frame is clipped or occluded');
      } finally {
        await this.send('Runtime.releaseObject', { objectId: object.objectId }, parent.sessionId);
      }
      current = parent;
    }
    const rootState = await this.viewport(current);
    if (!(p.x >= 0 && p.y >= 0 && p.x < rootState?.w && p.y < rootState?.h)) fail('NOT_ACTIONABLE', 'Target is outside the root viewport');
    return p;
  }
  async #frameOwner(frame, parent) {
    const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId: frame.id }, parent.sessionId);
    const { model } = await this.send('DOM.getBoxModel', { backendNodeId }, parent.sessionId);
    const q = model.content;
    const epsilon = Number.EPSILON * Math.max(1, ...q.map(Math.abs));
    if (!q.every(Number.isFinite) || Math.abs(q[1] - q[3]) > epsilon || Math.abs(q[5] - q[7]) > epsilon
      || Math.abs(q[0] - q[6]) > epsilon || Math.abs(q[2] - q[4]) > epsilon || q[2] <= q[0] || q[5] <= q[1]) {
      fail('UNSUPPORTED_FRAME_GEOMETRY', 'Rotated/skewed frame targeting is not supported');
    }
    return { backendNodeId, quad: q };
  }
  async release(frame, objectId) {
    await this.send('Runtime.releaseObject', { objectId }, frame.sessionId);
  }
}
