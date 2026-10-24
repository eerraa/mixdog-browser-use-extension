import {
  browserSnapshotExpression, browserRefPointExpression, BROWSER_STABLE_RECT, createBrowserCdpExecution,
} from '../../build/upstream.mjs';
import { bounded } from '../async.mjs';
import { fail, freshId, sameCheckpoint } from './contract.mjs';

const TARGET_TYPES = ['iframe', 'worker', 'shared_worker', 'service_worker'];

// The name, document tokens, contexts and refs exist only in isolated worlds.
// No preload, Node binding, or renderer-to-main IPC is exposed to web pages.
export class FrameDriver {
  #dialogCleanup = new Set();
  #startupCleanup = new Map();

  constructor(page, invalidate) {
    this.page = page;
    this.wc = page.window.webContents;
    this.worldName = `independent-browser-${freshId()}`;
    this.evaluationWorldName = `independent-browser-evaluate-${freshId()}`;
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
    this.page.frameFailure = null;
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
      // Upstream's cleanup whitelist does not include held-input releases.
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
  async enable(sessionId) {
    await this.send('Page.enable', {}, sessionId, null);
    await this.send('Runtime.enable', {}, sessionId, null);
    await this.send('DOM.enable', {}, sessionId, null);
    await this.send('Page.setInterceptFileChooserDialog', { enabled: !this.nativeMode }, sessionId, null);
    await this.send('Runtime.addBinding', { name: '__independentChanged', executionContextName: this.worldName }, sessionId, null);
    await this.#autoAttach(sessionId);
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
    // upstream execution barrier. Only an actual reply or native termination
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
      if (target.type === 'iframe') await this.enable(target.sessionId);
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
    await this.send('Page.setInterceptFileChooserDialog', { enabled: !native }, undefined, null);
    for (const sessionId of this.sessions.keys()) {
      await this.send('Page.setInterceptFileChooserDialog', { enabled: !native }, sessionId, null);
    }
  }

  onMessage(method, params, sessionId) {
    sessionId = sessionId || undefined;
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
        this.page.frameFailure = type === 'iframe'
          ? 'Child target initialization failed' : 'Worker target initialization failed';
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
      } else if (params.frame?.id || params.frameId) {
        this.frames.delete(params.frame?.id || params.frameId);
      }
      this.invalidate(method);
    } else if (method === 'Runtime.bindingCalled' && params.name === '__independentChanged') {
      if ([...this.frames.values()].some(f => f.contextId === params.executionContextId && f.sessionId === sessionId)) {
        this.invalidate('document-revision');
      }
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

  async refresh() {
    while (this.pending.size) await Promise.all([...this.pending]);
    if (this.page.frameFailure) fail('FRAME_UNAVAILABLE', this.page.frameFailure);
    const tree = new Map();
    const add = (node, sessionId, inheritedParent) => {
      const id = node.frame.id;
      const existing = tree.get(id);
      // A child target's own tree is authoritative for its execution session.
      if (!existing || sessionId) tree.set(id, {
        id, parentId: node.frame.parentId || inheritedParent || existing?.parentId,
        url: node.frame.url, sessionId,
      });
      for (const child of node.childFrames || []) add(child, sessionId, id);
    };
    add((await this.send('Page.getFrameTree')).frameTree, undefined);
    for (const [sessionId, targetId] of this.sessions) {
      const parent = tree.get(targetId)?.parentId;
      add((await this.send('Page.getFrameTree', {}, sessionId)).frameTree, sessionId, parent);
    }
    for (const id of this.frames.keys()) if (!tree.has(id)) this.frames.delete(id);
    for (const [id, frame] of tree) {
      const old = this.frames.get(id);
      const result = await this.send('Page.createIsolatedWorld', {
        frameId: id, worldName: this.worldName, grantUniveralAccess: false,
      }, frame.sessionId);
      frame.contextId = result.executionContextId;
      frame.documentId = old?.contextId === frame.contextId && old?.sessionId === frame.sessionId ? old.documentId : freshId();
      this.frames.set(id, frame);
      await this.evaluate(frame, `(() => {
        if (globalThis.__independentState) { globalThis.__independentState.syncShadows(); return; }
        const state = { documentId: ${JSON.stringify(frame.documentId)}, revision: 0 };
        globalThis.__independentState = state;
        const changed = reason => { state.revision++; globalThis.__independentChanged(reason); };
        const viewport = () => [innerWidth,innerHeight,devicePixelRatio];
        let lastViewport = viewport();
        const options = {subtree:true,childList:true,attributes:true,characterData:true};
        new MutationObserver(() => changed('mutation')).observe(document, options);
        const roots = new Map();
        let rootsInitialized = false;
        state.syncShadows = () => {
          const nodes=[],stack=[document.documentElement],current=new Set();
          let membershipChanged = false;
          while(stack.length){
            const el=stack.pop();if(!el)continue;nodes.push(el);
            for(const child of Array.from(el.children||[]).reverse())stack.push(child);
            const root=el.shadowRoot;
            if(root){
              current.add(root);
              if(!roots.has(root)){
                const observer=new MutationObserver(()=>changed('mutation'));
                observer.observe(root,options);roots.set(root,observer);membershipChanged=true;
              }
              for(const child of Array.from(root.children).reverse())stack.push(child);
            }
          }
          for(const [root,observer] of roots){
            if(!current.has(root)){observer.disconnect();roots.delete(root);membershipChanged=true;}
          }
          if(rootsInitialized&&membershipChanged)changed('shadow-root');
          rootsInitialized=true;
          return nodes;
        };
        state.syncShadows();
        for(const event of ['scroll','input','change']) addEventListener(event,()=>changed(event),true);
        addEventListener('resize',()=>{
          const current=viewport();
          if(current.some((value,index)=>value!==lastViewport[index])){
            lastViewport=current;changed('resize');
          }
        },true);
      })()`);
    }
    return [...this.frames.values()];
  }

  async evaluate(frame, expression, byValue = true, mutation = false) {
    const result = await this.send('Runtime.evaluate', {
      expression, contextId: frame.contextId, returnByValue: byValue, awaitPromise: true,
      // Never userGesture:true: browser/OS activation requirements remain intact.
    }, frame.sessionId, this.actorSignal, mutation ? this.beforeInputDispatch : undefined);
    if (result.exceptionDetails) fail('PAGE_SCRIPT_ERROR', 'Page script failed (details withheld to avoid exposing secrets)');
    if (byValue && result.result.unserializableValue !== undefined) fail('NON_JSON_RESULT', 'Expression must return JSON-serializable data');
    return byValue ? result.result.value ?? null : result.result;
  }
  async evaluateUser(frame, expression) {
    // Model JavaScript never runs in the observation/ref authority world.
    const { executionContextId } = await this.send('Page.createIsolatedWorld', {
      frameId: frame.id, worldName: this.evaluationWorldName, grantUniveralAccess: false,
    }, frame.sessionId);
    return this.evaluate({ ...frame, contextId: executionContextId }, expression, true, true);
  }
  checkpoint(frame) {
    return this.evaluate(frame, `(() => { const s=globalThis.__independentState;
      // DOM observers do not see JS writes to input.value/checked/selected or
      // scroll properties. Sample them privately before every checkpoint.
      // Password data stays in this world and is NEVER returned to the host.
      // Root discovery has no document-MutationObserver equivalent: attaching a
      // root to an already connected host need not mutate the light DOM.
      const nodes=s.syncShadows().slice(0,12000);
      const properties=JSON.stringify(nodes.map(el=>[el.isConnected,String(el.value??''),el.checked,el.selected,el.disabled,el.readOnly,el.scrollLeft,el.scrollTop]));
      if(s.properties!==undefined&&s.properties!==properties){s.revision++;globalThis.__independentChanged('properties');}
      s.properties=properties;
      return {documentId:s.documentId,revision:s.revision,width:innerWidth,height:innerHeight,x:scrollX,y:scrollY}; })()`);
  }
  async capture(snapshotId) {
    const frames = await this.refresh();
    const output = [];
    const checkpoints = new Map();
    for (const frame of frames) {
      const before = await this.checkpoint(frame);
      const snapshot = await this.evaluate(frame, browserSnapshotExpression({ snapshotId: `${snapshotId}:${frame.id}` }));
      const after = await this.checkpoint(frame);
      if (!sameCheckpoint(before, after)) fail('OBSERVATION_CHANGED', 'Document changed during observation; observe again');
      checkpoints.set(frame.id, after);
      output.push({ ...snapshot, frameId: frame.id, documentId: frame.documentId, revision: after.revision });
    }
    return { output, checkpoints };
  }
  async assertCheckpoints(checkpoints) {
    const frames = await this.refresh();
    if (frames.length !== checkpoints.size) fail('STALE_OBSERVATION', 'Stale observation: frame membership changed');
    for (const frame of frames) {
      if (!sameCheckpoint(checkpoints.get(frame.id), await this.checkpoint(frame))) {
        fail('STALE_OBSERVATION', 'Stale ref/coordinates: document, revision, scroll or viewport changed');
      }
    }
  }
  async objectFor(frame, ref) {
    const result = await this.evaluate(frame, `(() => {
      const r=globalThis.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
      const el=r?.element || r; return el?.isConnected ? el : null;
    })()`, false);
    if (!result.objectId || result.subtype === 'null') fail('STALE_REF', 'Stale ref: target was replaced');
    return result.objectId;
  }
  async callOn(frame, objectId, functionDeclaration, values = [], byValue = true, mutation = false) {
    const result = await this.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration, arguments: values.map(value => ({ value })),
      returnByValue: byValue, awaitPromise: true,
    }, frame.sessionId, this.actorSignal, mutation ? this.beforeInputDispatch : undefined);
    if (result.exceptionDetails) fail('TARGET_CHANGED', 'Target verification or operation failed');
    return result.result.value;
  }
  async prepare(frame, objectId, beforeDispatch) {
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
  async refForObject(frame, objectId) {
    const ref = await this.callOn(frame, objectId, `function() {
      if(!this.isConnected||this.ownerDocument!==document)return null;
      for(const [ref,record] of globalThis.__mixdogAgentSnapshot.refs) {
        if((record?.element||record)===this)return ref;
      }
      return null;
    }`);
    if (!ref) fail('STALE_REF', 'Prepared target was replaced or is absent from the fresh observation');
    return ref;
  }
  async point(frame, ref) {
    const point = await this.evaluate(frame, browserRefPointExpression(ref));
    if (point.error) fail('NOT_ACTIONABLE', `Target is not actionable: ${point.error}`);
    return this.toRoot(frame, point);
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
        const viewport = await this.checkpoint(parent);
        if (viewport.width <= 0 || viewport.height <= 0) fail('NOT_ACTIONABLE', 'Parent frame has an empty viewport');
        q = q.map((value, index) => index % 2
          ? (value - box[1]) * viewport.height / (box[5] - box[1])
          : (value - box[0]) * viewport.width / (box[2] - box[0]));
      }
      const childState = await this.checkpoint(current);
      if (childState.width <= 0 || childState.height <= 0) fail('NOT_ACTIONABLE', 'Child frame has an empty viewport');
      p = { x: q[0] + p.x * (q[2] - q[0]) / childState.width,
        y: q[1] + p.y * (q[5] - q[1]) / childState.height };
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
    const rootState = await this.checkpoint(current);
    if (p.x < 0 || p.y < 0 || p.x >= rootState.width || p.y >= rootState.height) fail('NOT_ACTIONABLE', 'Target is outside the root viewport');
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
