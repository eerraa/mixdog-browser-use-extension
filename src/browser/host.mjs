import { session, WebContentsView } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { FenceQueue } from '../core/queue.mjs';
import { bounded } from '../async.mjs';
import { FrameDriver } from './frames.mjs';
import { BrowserPermissions } from './permissions.mjs';
import { BrowserPolicy } from './policy.mjs';
import { BrowserRequests } from './requests.mjs';
import { BrowserDialogs } from './dialogs.mjs';
import { installPageMenu } from './consent.mjs';
import { PagePresentation, TOOLBAR_HEIGHT } from './presentation.mjs';
import {
  BrowserHostError, fail, freshId, inputActions, keys, matchesTarget, pageURL, validateArgs,
} from './contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const plainCandidate = e => ({ ref: e.ref, frameId: e.frameId, role: e.role, name: e.name });

/**
 * Electron-main only. Construct AFTER app.ready, one host per MCP companion
 * connection. No model-supplied session IDs are accepted in the action object.
 * onRevokeConnection({connectionId, disposition, confirmed:false}) must request
 * companion termination; ONLY its parent gateway can confirm exit/revocation.
 */
export class BrowserHost {
  #pages = new Map();
  #profiles = new Map();
  #queue = new FenceQueue();
  #closed = false;
  #revoking = false;
  #revokeFlight;

  constructor({ dataDir, consentHelperPath, toolbarPreloadPath, onRevokeConnection, policy = new BrowserPolicy() }) {
    if (![dataDir, consentHelperPath, toolbarPreloadPath].every(value => typeof value === 'string' && path.isAbsolute(value))
      || typeof onRevokeConnection !== 'function') {
      throw new TypeError('Absolute plugin dataDir/consentHelperPath/toolbarPreloadPath and onRevokeConnection are required');
    }
    this.dataDir = dataDir;
    this.toolbarPreloadPath = toolbarPreloadPath;
    this.connectionId = freshId();
    this.onRevokeConnection = onRevokeConnection;
    this.policy = policy;
    this.nativeRequests = new BrowserRequests();
    this.permissions = new BrowserPermissions({
      connectionId: this.connectionId, consentHelperPath, policy, nativeRequests: this.nativeRequests,
      pageFor: wc => [...this.#pages.values()].find(p => !p.closed && p.contents === wc),
      isClosed: () => this.#closed || this.#revoking,
      revoke: () => this.#revoke(),
    });
    this.dialogs = new BrowserDialogs({
      pageForWindow: window => [...this.#pages.values()].find(page => page.frame === window),
      onReady: (page, event) => this.#nativeDialog(page, event),
      note: (page, reason) => this.permissions.note('javascript-dialog', reason, page),
    });
  }

  status() {
    return {
      state: this.#closed ? 'closed' : this.#revoking ? 'terminating-revocation' : 'connected',
      connectionId: this.connectionId, tabCount: [...this.#pages.values()].filter(p => !p.closed).length,
      pausedCount: [...this.#pages.values()].filter(p => !p.closed && p.paused).length,
      capabilities: {
        nativeRequests: ['javascript-dialog', 'file-picker', 'hid', 'usb', 'notifications', 'geolocation'],
        javascriptDialogs: {
          supported: ['alert', 'confirm'],
          unsupported: { prompt: 'Electron 44.9.1 overrides window.prompt() and throws before native dialog creation.' },
          integration: 'Companion-local public-module adapter pinned to Electron 44.9.1; not a documented interception API',
        },
        filePickers: {
          supported: ['html-file-input'],
          unsupported: ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'],
        },
        unsupported: ['display-capture', 'serial', 'bluetooth', 'javascript-prompt'],
        mandatoryHuman: ['OS identity', 'passwords', 'CAPTCHA', '2FA', 'human Resume in the browser window after Stop/handoff'],
        delegation: this.policy.describe(),
      },
    };
  }
  #assertCaller(caller, signal) {
    if (!caller || typeof caller.sessionId !== 'string' || !caller.sessionId || typeof caller.callId !== 'string'
      || !caller.callId || typeof caller.assertLive !== 'function' || !caller.signal) {
      fail('UNAUTHENTICATED_CALLER', 'Authenticated live host caller is required');
    }
    caller.assertLive();
    caller.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Browser connection is closed or terminating revocation');
  }
  #owned(tabId, caller, signal, input = false, allowDisconnected = false, dialogCleanup = false) {
    this.#assertCaller(caller, signal);
    const p = this.#pages.get(tabId);
    if (!p || p.closed || p.contents.isDestroyed()) fail('CLOSED_TAB', 'Unknown or closed tab');
    if (p.owner !== caller.sessionId) fail('FOREIGN_TAB', 'Tab is owned by another session');
    if (input && p.paused) fail('AUTOMATION_PAUSED', `Automation paused: ${p.paused}; only the person can resume it from the browser window`);
    if (input && !p.visible) fail('PAGE_HIDDEN', 'Page is hidden; show and observe before input');
    if (input && !p.connected && !allowDisconnected) fail('DEBUGGER_DISCONNECTED', 'Browser disconnected; observe or explicitly navigate before new input');
    if (input && !dialogCleanup) p.driver.assertNoDialogCleanup();
    if (input) p.presentation.assertAutomation(p.actorGeneration ?? p.presentation.generation);
    return p;
  }
  #invalidate(p, reason) {
    p.observation = null;
    p.lastChange = reason;
    p.stamp++;
    if (reason === 'Page.frameDetached' || reason === 'frame-detached') this.permissions.prune(p);
    if (reason === 'debugger-disconnected' || (reason === 'logical-visibility' && !p.visible)) this.permissions.withdraw(p);
    if (['debugger-disconnected', 'navigation', 'frame-detached', 'Page.frameDetached', 'Page.frameNavigated'].includes(reason)
      || (reason === 'logical-visibility' && !p.visible)) this.dialogs.withdraw(p);
  }
  #pause(p, reason) {
    if (p.closed) return;
    p.paused = reason;
    this.#invalidate(p, reason);
    this.permissions.withdraw(p);
    this.dialogs.withdraw(p);
    p.returnController?.abort(new Error(`Automation paused: ${reason}`));
    this.#queue.abort(p.id, new Error(`Automation paused: ${reason}`));
    p.presentation.refresh();
  }
  #handoff(p, reason, fromMenu = false) {
    if (this.#closed || this.#revoking || p.closed) return Promise.resolve();
    if (p.presentation.mode === 'native-handoff') return Promise.resolve();
    const generation = p.presentation.beginDrain(fromMenu);
    if (p.manualFlight) { p.presentation.releaseIfSafe(); return p.manualFlight; }
    this.#pause(p, p.paused === 'explicit-stop' ? p.paused : reason);
    p.manualFlight = this.#queue.run(p.id, async signal => {
      await p.ready;
      signal.throwIfAborted();
      await p.driver.waitForIdle(signal);
      await p.presentation.waitForRelease();
      signal.throwIfAborted();
      if (p.closed || this.#closed || this.#revoking) return;
      await p.driver.setNativeMode(true);
      signal.throwIfAborted();
      p.driver.assertNoDialogCleanup();
      p.presentation.enterNative(generation);
    }).catch(() => {
      p.presentation.clear('drainFailed');
    }).finally(() => { p.manualFlight = null; });
    return p.manualFlight;
  }
  async #resume(p) {
    if (this.#closed || this.#revoking || p.closed || p.returnController) return;
    if (p.dialog) {
      p.presentation.clear('dialogBeforeResume');
      return;
    }
    const controller = new AbortController();
    p.returnController = controller;
    // Gate new requests and withdraw old UI before the queued return can wait.
    // Late device selection/Windows results must not survive a successful return.
    this.permissions.withdraw(p);
    try {
      await this.#queue.run(p.id, async signal => {
        await p.driver.waitForIdle(signal);
        const generation = p.presentation.beginReturn();
        this.#invalidate(p, 'trusted-human-resume');
        p.driver.actorSignal = signal;
        try {
          await p.driver.setNativeMode(false);
          if (!p.connected) { await p.driver.reconnect(); p.connected = true; }
          await this.#observe(p, null, signal, true);
          signal.throwIfAborted();
          p.presentation.finishReturn(generation);
          p.paused = null;
          p.presentation.refresh();
        } finally { p.driver.actorSignal = undefined; }
      }, controller.signal);
    } catch {
      p.paused ||= 'return-failed';
      p.presentation.failClosed('return-failed');
    } finally {
      if (p.returnController === controller) p.returnController = null;
    }
  }
  async #humanDialog(p, accept) {
    if (p.closed || this.#closed || this.#revoking || !p.dialog || p.dialog.attempted) return;
    const record = p.dialog;
    if (p.presentation.mode !== 'native-handoff' && !this.dialogs.ready(p, record)) return;
    record.attempted = true;
    try {
      await bounded(p.presentation.mode === 'native-handoff'
        ? p.driver.send('Page.handleJavaScriptDialog', { accept }, record.sessionId, null)
        : this.dialogs.answer(p, record, accept), 15000, 'Trusted dialog response');
      if (p.dialog === record) p.dialog = null;
      this.#invalidate(p, 'human-dialog-response');
    } catch {
      p.presentation.clear('dialogUncertain');
    }
  }
  #nativeDialog(p, dialogRecord) {
    const actor = this.permissions.actor(p);
    if (!actor || p.paused || p.presentation.mode !== 'automation') return;
    const generation = p.presentation.generation;
    let record;
    record = this.nativeRequests.create({
      page: p, caller: actor.caller, signal: actor.signal, kind: 'javascript-dialog',
      context: { type: dialogRecord.type, message: dialogRecord.message },
      options: [
        { label: 'Accept', metadata: { accept: true }, value: true },
        { label: 'Dismiss', metadata: { accept: false }, value: false },
      ],
      isCurrent: () => !p.closed && p.connected && !p.paused
        && (p.dialog === dialogRecord || record?.state === 'responding')
        && (!dialogRecord.attempted || record?.state === 'responding')
        && (record?.state === 'responding' || this.dialogs.ready(p, dialogRecord))
        && p.presentation.mode === 'automation' && p.presentation.generation === generation,
      validate: (response, accept) => {
        if (response.files !== undefined || (response.text !== undefined && dialogRecord.type !== 'prompt')) {
          fail('INVALID_NATIVE_RESPONSE', 'Dialog accepts an offered decision; text is only valid for prompts');
        }
        if (response.cancel) return { accept: false };
        if (typeof accept !== 'boolean') fail('INVALID_NATIVE_RESPONSE', 'Choose a current dialog option');
        return { accept, promptText: response.text ?? '' };
      },
      respond: async (response, caller, signal) => {
        this.#owned(p.id, caller, signal, true, false, true);
        if (p.dialog !== dialogRecord || dialogRecord.attempted) fail('DIALOG_UNCERTAIN', 'Dialog response already dispatched or closed');
        dialogRecord.attempted = true;
        await bounded(this.dialogs.answer(p, dialogRecord, response.accept),
          15000, 'Dialog response', signal);
        await this.#queue.run(p.id, () => p.driver.waitForIdle(signal), signal);
        if (p.dialog === dialogRecord) p.dialog = null;
        this.#invalidate(p, 'dialog-handled');
        return { requestRef: record.requestRef, kind: record.kind, resolution: 'resolved' };
      },
      withdraw: () => this.dialogs.withdraw(p),
    });
    dialogRecord.nativeRequest = record;
    return record;
  }
  #nativeFilePicker(p, params, sessionId) {
    const actor = this.permissions.actor(p);
    const frame = p.driver.frames.get(params.frameId);
    if (!actor || p.paused || p.presentation.mode !== 'automation' || !frame
      || frame.sessionId !== sessionId || !Number.isInteger(params.backendNodeId)
      || !['selectSingle', 'selectMultiple'].includes(params.mode)) {
      this.permissions.note('file-picker', 'Intercepted picker lacks a current owned document/input', p);
      return;
    }
    const generation = p.presentation.generation;
    const documentId = this.permissions.document(p, p.contents.mainFrame);
    let record;
    const current = () => !p.closed && p.connected && !p.paused && p.visible
      && p.presentation.mode === 'automation' && p.presentation.generation === generation
      && p.driver.frames.get(frame.id)?.documentId === frame.documentId
      && p.permissionDocuments.get(`${p.contents.mainFrame.processId}:${p.contents.mainFrame.routingId}`) === documentId;
    record = this.nativeRequests.create({
      page: p, caller: actor.caller, signal: actor.signal, kind: 'file-picker',
      context: { frameId: frame.id, mode: params.mode, disclosure: 'Selecting files exposes their contents to this website' },
      options: [],
      isCurrent: current,
      validate: async response => {
        if (response.optionRef !== undefined || response.text !== undefined) fail('INVALID_NATIVE_RESPONSE', 'File picker accepts explicit file paths or cancel');
        if (response.cancel) return [];
        await this.#validateFiles(response.files, params.mode === 'selectMultiple');
        return response.files;
      },
      respond: async (files, caller, signal) => {
        if (!files.length) return { requestRef: record.requestRef, kind: record.kind, resolution: 'cancelled' };
        const guard = () => this.#owned(p.id, caller, signal, true);
        const resolved = await p.driver.nativeResponse('DOM.resolveNode', {
          backendNodeId: params.backendNodeId, executionContextId: frame.contextId,
        }, sessionId, guard);
        const objectId = resolved.object?.objectId;
        if (!objectId) fail('STALE_NATIVE_REQUEST', 'Original file input no longer exists');
        try {
          const checked = await p.driver.nativeResponse('Runtime.callFunctionOn', {
            objectId, functionDeclaration: 'function(){return this.isConnected&&!this.disabled&&this.tagName==="INPUT"&&this.type==="file"}',
            returnByValue: true,
          }, sessionId, guard);
          if (checked.exceptionDetails || checked.result?.value !== true || !current()
            || !this.nativeRequests.isResponding(record)) fail('STALE_NATIVE_REQUEST', 'Original file input/document changed');
          this.#owned(p.id, caller, signal, true);
          await bounded(p.driver.nativeResponse('DOM.setFileInputFiles', { files, objectId }, sessionId,
            () => this.#owned(p.id, caller, signal, true)), 15000, 'File picker response', signal);
          this.#invalidate(p, 'file-picker-responded');
          return { requestRef: record.requestRef, kind: record.kind, resolution: files.length ? 'selected' : 'cancelled' };
        } finally { await p.driver.release(frame, objectId); }
      },
      withdraw: () => {},
    });
  }
  async #validateFiles(files, multiple) {
    if (!Array.isArray(files) || !files.length || files.length > 32 || (!multiple && files.length !== 1)) {
      fail('INVALID_UPLOAD_FILE', 'File selection must match the input multiplicity');
    }
    for (const file of files) {
      if (!path.isAbsolute(file) || !(await stat(file)).isFile()) fail('INVALID_UPLOAD_FILE', 'Upload requires existing absolute regular files');
    }
  }

  async #profile(owner) {
    const key = hash(owner);
    if (this.#profiles.has(key)) return this.#profiles.get(key);
    const pending = (async () => {
      const directory = path.join(this.dataDir, 'profiles', key);
      const downloadDir = path.join(this.dataDir, 'downloads', key);
      await mkdir(directory, { recursive: true });
      await mkdir(downloadDir, { recursive: true });
      // No existing profile, account, cookies, host settings or agents are copied.
      const browserSession = session.fromPath(directory, { cache: true });
      const profile = { browserSession, downloadDir };
      this.permissions.install(browserSession);
      browserSession.on('will-download', (event, item, wc) => {
        const p = [...this.#pages.values()].find(page => !page.closed && page.contents === wc);
        if (!p || this.#closed || this.#revoking) { event.preventDefault(); return; }
        // Never trust a server filename as a path.
        const filename = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'download';
        const target = path.join(downloadDir, `${freshId()}-${filename}`);
        item.setSavePath(target);
        const entry = { id: freshId(), filename, path: target, state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes() };
        p.downloads.push(entry);
        item.on('updated', (_e, state) => { entry.state = state; entry.receivedBytes = item.getReceivedBytes(); });
        item.once('done', (_e, state) => { entry.state = state; entry.receivedBytes = item.getReceivedBytes(); });
      });
      return profile;
    })();
    this.#profiles.set(key, pending);
    return pending;
  }
  async #createPage(owner, signal) {
    const profile = await this.#profile(owner);
    signal.throwIfAborted();
    if (this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Connection closed before page creation');
    const view = new WebContentsView({ webPreferences: this.#guestPreferences(profile) });
    const p = this.#registerPage(owner, profile, view, null, { width: 1120, height: 820 });
    try {
      await bounded(p.ready, 20000, 'Browser page startup', signal);
      return p;
    } catch (error) {
      if (!p.frame.isDestroyed()) p.frame.destroy();
      throw error;
    }
  }
  #guestPreferences(profile) {
    return {
      session: profile.browserSession, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, navigateOnDragDrop: false, webviewTag: false,
      // Navigation must never move OS keyboard focus into a shielded page.
      backgroundThrottling: false, focusOnNavigation: false, preload: undefined,
    };
  }
  #registerPage(owner, profile, view, parent, size) {
    const p = {
      id: freshId(), owner, profile, view, contents: view.webContents, closed: false, connected: true, visible: false,
      paused: parent?.paused ?? null, observation: null, stamp: 0, dialog: null, downloads: [], permissionDocuments: new Map(),
    };
    this.#pages.set(p.id, p);
    const inheritedActor = parent && this.permissions.actor(parent);
    if (inheritedActor) this.permissions.bindActor(p, inheritedActor.caller, inheritedActor.signal);
    const wc = p.contents;
    // The window toolbar and its native menu are the only human controls.
    const humanActions = {
      stop: () => this.#pause(p, 'explicit-stop'),
      resume: () => this.#resume(p),
      handoff: () => this.#handoff(p, 'human-handoff', true),
      acceptDialog: () => this.#humanDialog(p, true),
      dismissDialog: () => this.#humanDialog(p, false),
      revoke: () => { this.#revoke().catch(() => {}); },
    };
    p.presentation = new PagePresentation(view, {
      interrupt: reason => this.#pause(p, reason),
      handoff: reason => { void this.#handoff(p, reason); },
      invalidate: reason => this.#invalidate(p, reason),
      guardNativeInput: () => p.driver.assertNoDialogCleanup(),
      paused: () => p.paused,
      visibility: visible => {
        if (p.visible !== visible) { p.visible = visible; this.#invalidate(p, 'logical-visibility'); }
      },
    }, { preloadPath: this.toolbarPreloadPath, actions: humanActions, ...size });
    p.frame = p.presentation.frame;
    const inheritedManual = parent && parent.presentation.mode !== 'automation';
    if (inheritedManual) { p.paused ||= 'inherited-native-handoff'; p.presentation.beginDrain(); }
    installPageMenu(p.frame, humanActions);
    p.frame.on('closed', () => {
      p.closed = true;
      p.presentation.close();
      this.permissions.withdraw(p);
      this.dialogs.destroyed(p);
      this.#invalidate(p, 'closed');
      this.#queue.abort(p.id, new Error('Tab closed'));
    });
    wc.on('render-process-gone', () => {
      p.connected = false;
      this.permissions.withdraw(p);
      this.dialogs.destroyed(p);
      this.#invalidate(p, 'renderer-disconnected');
      this.#queue.abort(p.id, new Error('Renderer disconnected; input disposition may be uncertain'));
    });
    wc.on('did-start-navigation', details => {
      this.#invalidate(p, details.isSameDocument ? 'same-document-navigation' : 'navigation');
      if (!details.isSameDocument) {
        if (details.isMainFrame) this.permissions.withdraw(p);
        else if (details.frame) this.permissions.withdraw(p, details.frame.processId, details.frame.routingId);
        else this.permissions.prune(p);
      }
    });
    wc.on('will-frame-navigate', event => {
      try { if (event.url !== 'about:blank') pageURL(event.url); } catch { event.preventDefault(); this.#invalidate(p, 'unsafe-navigation-blocked'); }
    });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      this.permissions.note('bluetooth', 'Unverifiable requester frame; Bluetooth is unsupported', p);
      callback('');
    });
    // Electron's public createWindow contract preserves Chromium's opener,
    // session and POST navigation. We synchronously own/shield the adopted
    // view before returning its WebContents; never replace its initial document.
    wc.setWindowOpenHandler(details => {
      try { if (details.url !== 'about:blank') pageURL(details.url); } catch { return { action: 'deny' }; }
      if (p.closed || this.#closed || this.#revoking) return { action: 'deny' };
      return { action: 'allow', outlivesOpener: false, createWindow: options => {
        if (p.closed || this.#closed || this.#revoking) throw new Error('Popup owner closed before creation');
        const popupView = new WebContentsView({ webContents: options.webContents });
        // Adopted contents do not inherit this preference; match owned pages.
        popupView.webContents.setBackgroundThrottling(false);
        const popup = this.#registerPage(owner, profile, popupView, p, {
          width: options.width, height: options.height + TOOLBAR_HEIGHT, useContentSize: true,
        });
        popup.ready.catch(() => this.#invalidate(p, 'popup-failed'));
        return popup.contents;
      } };
    });
    p.driver = new FrameDriver(p, reason => this.#invalidate(p, reason));
    p.onNativePicker = (params, sessionId) => this.#nativeFilePicker(p, params, sessionId);
    p.onNativeDialog = record => this.dialogs.opened(p, record);
    p.onNativeDialogClosed = record => {
      this.dialogs.closed(p, record);
      if (record?.nativeRequest?.state === 'pending') this.nativeRequests.withdraw(record.nativeRequest, 'Native dialog closed');
    };
    p.ready = (async () => {
      if (!parent) await wc.loadURL('about:blank');
      await p.driver.start();
      await p.presentation.start();
      if (parent?.closed || this.#closed || this.#revoking) { p.frame.destroy(); return; }
    })().catch(error => { if (!p.frame.isDestroyed()) p.frame.destroy(); throw error; });
    if (parent) {
      p.ready.then(async () => {
        if (!inheritedManual && parent.presentation.mode === 'automation') return;
        await parent.manualFlight;
        await this.#handoff(p, parent.paused || 'inherited-native-handoff', true);
      }).catch(() => { /* Initialization closes its owned windows on failure. */ });
    }
    return p;
  }

  /**
   * args use EXACTLY these fields; unknown keys and aliases are rejected.
   * No tabId: status | list_tabs | revoke | open{url}.
   * With tabId:
   *   navigate{url}; observe; close_tab; hide; show; downloads; handoff; permissions
   *   click{ref|target|point}; scroll{ref|target|point,deltaX,deltaY}
   *   fill/type{ref|target,text}; press{ref|target,key}
   *   select{ref|target,values:string[]}; upload{ref|target,files:absolutePath[]}
   *   read{ref?|target?}; evaluate{expression,frameId?}
   *   handle_dialog{accept:boolean,promptText?}.
   * target={role?,name?,exact?,selector?,frameId?}, at least role/name/selector.
   * point={x,y,snapshotId}; x/y are CSS viewport coordinates, not PNG pixels.
   * press keys are exported from contract.mjs; no key-chord aliases.
   * evaluate runs in its OWN isolated page world (DOM access, no page-main JS
   * globals, Node, private refs or host binding). It is always treated as a
   * mutation, never a retryable read.
   * caller={sessionId,callId,signal,assertLive()}: trusted IPC authority ONLY.
   * New observations include tabId/snapshotId/frames and a base64 PNG with
   * pixel/CSS scale metadata. Mutation errors after dispatch return
   * {disposition:'uncertain',replaySafe:false}; never replay automatically.
   * Permissions exposes pending descriptors/reasons, NEVER decide/approve.
   * Handoff and Stop can ONLY resume from the page window's toolbar or menu.
   */
  async execute(unchecked, caller, requestSignal) {
    const args = validateArgs(unchecked);
    this.#assertCaller(caller, requestSignal);
    const signal = requestSignal ? AbortSignal.any([caller.signal, requestSignal]) : caller.signal;
    if (args.action === 'status') return this.status();
    if (args.action === 'revoke') return this.#revoke();
    if (args.action === 'list_tabs') return {
      tabs: [...this.#pages.values()].filter(p => p.owner === caller.sessionId && !p.closed).map(p => ({
        tabId: p.id,
        url: p.presentation.mode === 'automation' ? p.contents.getURL() : null,
        title: p.presentation.mode === 'automation' ? p.contents.getTitle() : null,
        mode: p.presentation.mode, generation: p.presentation.generation,
        paused: p.paused, visible: p.presentation.logicalVisible(), connected: p.connected, busy: this.#queue.isBusy(p.id),
      })),
    };
    let p;
    if (args.action === 'open') {
      p = await this.#createPage(caller.sessionId, signal);
      try { this.#owned(p.id, caller, signal); }
      catch (error) { p.frame.destroy(); throw error; }
    } else p = this.#owned(args.tabId, caller, signal, inputActions.has(args.action), args.action === 'navigate',
      ['handle_dialog', 'respond'].includes(args.action));
    if (!p.connected && inputActions.has(args.action) && args.action !== 'navigate') {
      fail('DEBUGGER_DISCONNECTED', 'Browser debugger disconnected; observe or explicitly navigate to recover; no input was replayed');
    }
    if (args.action === 'close_tab') {
      p.frame.destroy();
      return { tabId: p.id, disposition: 'executed', closed: true };
    }
    if (args.action === 'hide' || args.action === 'show') {
      this.#invalidate(p, args.action);
      if (args.action === 'hide') p.presentation.hide();
      else p.presentation.show();
      return { tabId: p.id, disposition: 'executed', visible: p.presentation.logicalVisible(), paused: p.paused };
    }
    if (args.action === 'handoff') {
      await this.#handoff(p, 'human-handoff', true);
      return { tabId: p.id, disposition: 'executed', paused: p.paused, mode: p.presentation.mode, resume: 'Only the person can return control in the browser window; no tool can resume' };
    }
    if (['observe', 'read', 'downloads', 'requests'].includes(args.action)) {
      await p.ready;
      this.#owned(p.id, caller, signal);
      p.presentation.assertObservable();
    }
    if (args.action === 'permissions') return this.permissions.status(p);
    if (args.action === 'requests') return {
      tabId: p.id, pending: this.nativeRequests.list(p, caller), capabilities: this.status().capabilities,
    };
    if (args.action === 'respond') {
      let dispatched = false;
      try {
        const request = await bounded(this.nativeRequests.respond(p, caller, args.requestRef, args.response, () => {
          this.#owned(p.id, caller, signal, true, false, true);
          dispatched = true;
        }, signal), 15000, 'Native response', signal);
        return { tabId: p.id, disposition: 'executed', request, pendingRequests: this.nativeRequests.list(p, caller) };
      } catch (error) {
        if (!dispatched) throw error;
        return { tabId: p.id, disposition: 'uncertain', replaySafe: false, reason: 'Native response or result failed; do not replay' };
      }
    }
    if (args.action === 'downloads') return { items: structuredClone(p.downloads) };
    // Dialog handling is cleanup: it must bypass a lane parked on that dialog.
    if (args.action === 'handle_dialog') {
      if (!p.dialog) fail('NO_DIALOG', 'No pending dialog');
      if (p.dialog.attempted) fail('DIALOG_UNCERTAIN', 'Dialog response was already dispatched; never replay an uncertain response');
      this.#owned(p.id, caller, signal, true, false, true);
      if (!this.dialogs.ready(p, p.dialog)) fail('NATIVE_DIALOG_NOT_READY', 'Native dialog association is not ready; inspect requests');
      const dialogRecord = p.dialog;
      dialogRecord.attempted = true;
      try {
        await bounded(this.dialogs.answer(p, dialogRecord, args.accept),
          15000, 'Dialog response', signal);
        if (p.dialog === dialogRecord) p.dialog = null;
        this.#invalidate(p, 'dialog-handled');
        return await this.#run(p, { action: 'observe', tabId: p.id }, caller, signal);
      } catch {
        return { tabId: p.id, disposition: 'uncertain', replaySafe: false, reason: 'Dialog response or result checkpoint failed; do not replay' };
      }
    }
    if (p.dialog) return { tabId: p.id, dialog: { type: p.dialog.type }, pendingRequests: this.nativeRequests.list(p, caller),
      disposition: 'not-executed', reason: 'Respond to the pending dialog first' };
    return this.#run(p, args, caller, signal);
  }

  async #run(p, args, caller, requestSignal) {
    const timeout = new AbortController();
    const signal = AbortSignal.any([requestSignal, timeout.signal]);
    let sent = false;
    let preparation = 'none';
    let dialogListener;
    const mutation = args.action === 'open' || inputActions.has(args.action);
    const markSent = () => { sent = true; this.#invalidate(p, `dispatch:${args.action}`); };
    const actual = this.#queue.run(p.id, async laneSignal => {
      await p.ready;
      this.#owned(p.id, caller, laneSignal, mutation, args.action === 'navigate');
      await p.driver.waitForIdle(laneSignal);
      p.actorGeneration = p.presentation.generation;
      p.driver.actorSignal = laneSignal;
      p.driver.beforeInputDispatch = () => this.#owned(p.id, caller, laneSignal, true);
      p.driver.beforeCleanupDispatch = () => p.presentation.assertShielded();
      this.permissions.bindActor(p, caller, signal);
      try {
      if (!p.connected && args.action !== 'navigate') {
        if (mutation) fail('DEBUGGER_DISCONNECTED', 'Browser disconnected before dispatch; observe again');
        await p.driver.reconnect();
        p.connected = true;
      }
      if (mutation) {
        p.dialogOpened = dialogListener;
        p.nativeRequestOpened = () => dialogListener({
          tabId: p.id, disposition: 'executed', operationPending: true, replaySafe: false,
          ...(p.dialog ? { dialog: { type: p.dialog.type } } : {}),
          pendingRequests: this.nativeRequests.list(p, caller),
        });
      }
      if (!mutation) {
        if (args.action === 'read' && (args.ref || args.target)) {
          const resolved = await this.#resolve(p, args, caller, laneSignal);
          const objectId = await p.driver.objectFor(resolved.frame, resolved.element.ref);
          try {
            const value = await p.driver.callOn(resolved.frame, objectId, `function() {
              if(this.matches('input[type=password]'))return {text:'',value:'',sensitive:true};
              return {text:String(this.innerText||this.textContent||'').slice(0,12000),
                value:typeof this.value==='string'?this.value.slice(0,12000):null,sensitive:false};
            }`);
            return { tabId: p.id, snapshotId: p.observation.id, ...value };
          } finally { await p.driver.release(resolved.frame, objectId); }
        }
        return await this.#observe(p, caller, laneSignal);
      }
      if (args.action === 'open' || args.action === 'navigate') {
        this.#owned(p.id, caller, laneSignal, true, args.action === 'navigate');
        markSent();
        await p.contents.loadURL(pageURL(args.url));
        if (!p.connected) {
          await p.driver.reconnect();
          p.connected = true;
        }
      } else if (args.action === 'evaluate') {
        await p.driver.refresh();
        const frame = args.frameId ? p.driver.frames.get(args.frameId)
          : [...p.driver.frames.values()].find(f => !f.parentId);
        if (!frame) fail('STALE_FRAME', 'Unknown/replaced frame');
        this.#owned(p.id, caller, laneSignal, true);
        markSent();
        const value = await p.driver.evaluateUser(frame, args.expression);
        this.#owned(p.id, caller, laneSignal, true);
        return { tabId: p.id, disposition: 'executed', value, observation: await this.#observe(p, caller, laneSignal) };
      } else {
        const resolved = await this.#resolve(p, args, caller, laneSignal, phase => {
          preparation = phase;
          if (phase === 'attempted') this.#invalidate(p, `prepare:${args.action}`);
        });
        await this.#perform(p, resolved, args, caller, laneSignal, markSent);
      }
      this.#owned(p.id, caller, laneSignal, true);
      if (p.dialog) return { tabId: p.id, disposition: 'executed', dialog: { type: p.dialog.type } };
      return await this.#observe(p, caller, laneSignal);
      } finally {
        p.driver.actorSignal = undefined;
        p.driver.beforeInputDispatch = undefined;
        p.driver.beforeCleanupDispatch = undefined;
        p.actorGeneration = undefined;
      }
    }, signal);
    const dialog = new Promise(resolve => {
      dialogListener = result => resolve(result);
    });
    try {
      return await bounded(Promise.race([actual, dialog]), 25000, 'Browser action', signal, () => {
        timeout.abort(new Error('Browser action timed out; dispatch may still be fenced'));
      });
    } catch (error) {
      if (mutation && sent) return {
        tabId: p.id, disposition: 'uncertain', replaySafe: false,
        code: signal.aborted ? 'ABORTED' : error instanceof BrowserHostError ? error.code : 'DISPATCH_OR_CHECKPOINT_FAILED',
        reason: signal.aborted ? 'Caller cancelled, timed out or automation stopped after dispatch' : 'Dispatch or result checkpoint failed',
      };
      if (mutation && preparation !== 'none') {
        throw new BrowserHostError(signal.aborted ? 'ABORTED' : error instanceof BrowserHostError ? error.code : 'PREPARATION_FAILED',
          `${error instanceof BrowserHostError ? error.message : 'Target preparation failed'}; requested input was not dispatched`,
          { tabId: p.id, preparation, requestedInputDispatched: false });
      }
      throw error;
    } finally {
      if (p.dialogOpened === dialogListener) p.dialogOpened = null;
      p.nativeRequestOpened = null;
    }
  }

  async #observe(p, caller, signal, returning = false) {
    if (caller) this.#owned(p.id, caller, signal);
    else if (p.closed || this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Page closed during trusted return');
    signal?.throwIfAborted();
    p.presentation.assertObservable(returning);
    const generation = p.presentation.generation;
    // Every observation replaces ALL prior refs, even if the DOM is unchanged.
    this.#invalidate(p, 'reobserve');
    const id = freshId();
    const { output, checkpoints } = await p.driver.capture(id);
    const stamp = p.stamp;
    const image = await this.#captureImage(p);
    await p.driver.assertCheckpoints(checkpoints);
    if (caller) this.#owned(p.id, caller, signal);
    signal?.throwIfAborted();
    p.presentation.assertObservable(returning);
    if (p.presentation.generation !== generation) fail('PRESENTATION_CHANGED', 'Presentation changed during observation');
    if (p.stamp !== stamp) fail('OBSERVATION_CHANGED', 'Page changed during DOM/screenshot observation; observe again');
    const data = image.toPNG();
    const root = output.find(frame => !p.driver.frames.get(frame.frameId)?.parentId);
    const pixelWidth = data.readUInt32BE(16), pixelHeight = data.readUInt32BE(20);
    const result = {
      tabId: p.id, snapshotId: id, disposition: 'observed', paused: p.paused,
      frames: output,
      pendingRequests: caller ? this.nativeRequests.list(p, caller) : [],
      screenshot: {
        mimeType: 'image/png', data: data.toString('base64'), pixelWidth, pixelHeight,
        coordinateSpace: 'css-viewport', viewportWidth: root.viewportWidth, viewportHeight: root.viewportHeight,
        pixelsPerCssX: pixelWidth / root.viewportWidth, pixelsPerCssY: pixelHeight / root.viewportHeight,
      },
    };
    p.observation = { id, checkpoints, result, imageHash: hash(data), generation };
    return structuredClone(result);
  }
  async #captureImage(p) {
    // A newly committed document has no copyable surface until it presents a
    // frame; wait for an actual frame instead of polling the capture API.
    await p.driver.presented();
    let image;
    try { image = await p.contents.capturePage(undefined, { stayHidden: true, stayAwake: true }); } catch { image = null; }
    if (!image || image.isEmpty()) fail('CAPTURE_FAILED', 'Browser image capture failed; observe again without replaying input');
    return image;
  }
  async #fresh(p, caller, signal, input = true) {
    this.#owned(p.id, caller, signal, input);
    const observation = p.observation;
    if (!observation) fail('STALE_REF', 'Stale ref/observation: observe again');
    if (observation.generation !== p.presentation.generation) fail('STALE_REF', 'Stale presentation generation');
    await p.driver.assertCheckpoints(observation.checkpoints);
    if (p.observation !== observation) fail('STALE_REF', 'Stale ref/observation after page change');
    this.#owned(p.id, caller, signal, input);
    return observation;
  }
  async #resolve(p, args, caller, signal, onPreparation = () => {}) {
    if (args.target) await this.#observe(p, caller, signal);
    const input = args.action !== 'read';
    const observation = await this.#fresh(p, caller, signal, input);
    if (args.point) {
      if (args.point.snapshotId !== observation.id) fail('STALE_COORDINATES', 'Stale coordinate snapshotId');
      const root = observation.result.frames.find(f => !p.driver.frames.get(f.frameId)?.parentId);
      if (args.point.x < 0 || args.point.y < 0 || args.point.x >= root.viewportWidth || args.point.y >= root.viewportHeight) {
        fail('INVALID_COORDINATES', 'Coordinates are outside the current viewport');
      }
      const now = (await this.#captureImage(p)).toPNG();
      if (hash(now) !== observation.imageHash) fail('STALE_COORDINATES', 'Stale coordinates: screenshot pixels changed');
      await this.#fresh(p, caller, signal);
      return { point: { x: args.point.x, y: args.point.y } };
    }
    const entries = observation.result.frames.flatMap(f => f.elements.map(e => ({ ...e, frameId: f.frameId })));
    let matches = args.ref ? entries.filter(e => e.ref === args.ref) : entries.filter(e => matchesTarget(e, args.target));
    if (args.target?.selector) {
      const selected = [];
      for (const element of matches) {
        const frame = p.driver.frames.get(element.frameId);
        const objectId = await p.driver.objectFor(frame, element.ref);
        try {
          if (await p.driver.callOn(frame, objectId, 'function(selector){return this.matches(selector)}', [args.target.selector])) selected.push(element);
        } finally { await p.driver.release(frame, objectId); }
      }
      matches = selected;
    }
    if (matches.length !== 1) fail(matches.length ? 'AMBIGUOUS_TARGET' : args.ref ? 'STALE_REF' : 'TARGET_NOT_FOUND',
      matches.length ? 'Ambiguous target; choose a fresh candidate' : args.ref ? 'Stale or unknown ref' : 'No matching target',
      { snapshotId: observation.id, candidates: (matches.length ? matches : entries).slice(0, 30).map(plainCandidate) });
    const element = matches[0], frame = p.driver.frames.get(element.frameId);
    if (!input) return { frame, element, point: null, observation };
    const documentId = frame.documentId;
    const objectId = await p.driver.objectFor(frame, element.ref);
    try {
      await p.driver.prepare(frame, objectId, () => onPreparation('attempted'));
      onPreparation('completed');
      this.#owned(p.id, caller, signal, true);
      await this.#observe(p, caller, signal);
      const preparedFrame = p.driver.frames.get(frame.id);
      if (!preparedFrame || preparedFrame.documentId !== documentId) fail('STALE_FRAME', 'Target document changed during preparation');
      const ref = await p.driver.refForObject(preparedFrame, objectId);
      const preparedObservation = await this.#fresh(p, caller, signal);
      const preparedElement = preparedObservation.result.frames
        .find(value => value.frameId === preparedFrame.id)?.elements.find(value => value.ref === ref);
      if (!preparedElement) fail('STALE_REF', 'Prepared target is absent from the fresh observation');
      const point = await p.driver.point(preparedFrame, ref);
      await this.#fresh(p, caller, signal);
      return { frame: preparedFrame, element: preparedElement, point, observation: preparedObservation };
    } finally { await p.driver.release(frame, objectId); }
  }

  async #perform(p, resolved, args, caller, signal, markSent) {
    const { frame, element, point } = resolved;
    const dispatch = async (method, params, sessionId, onDispatch = () => {}) => {
      this.#owned(p.id, caller, signal, true);
      onDispatch();
      markSent();
      return p.driver.send(method, params, sessionId);
    };
    if (args.action === 'click') {
      let pressed = false;
      try {
        await dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, undefined, () => { pressed = true; });
      } finally {
        // Releasing an already pressed button is cleanup, not fresh input.
        if (pressed) await p.driver.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      }
      return;
    }
    if (args.action === 'scroll') {
      // Scroll the verified DOM's actual overflow container exactly once. A
      // synthetic wheel targets whatever is under the point and its ACK races
      // layout, so it cannot prove which container scrolled.
      const scrollFrame = frame || [...p.driver.frames.values()].find(f => !f.parentId);
      const start = element
        ? `(()=>{const r=globalThis.__mixdogAgentSnapshot.refs.get(${JSON.stringify(element.ref)});return r?.element||r})()`
        : `document.elementFromPoint(${point.x},${point.y})`;
      const scroller = await p.driver.evaluate(scrollFrame, `(()=>{
        let el=${start};
        if(!el||!el.isConnected||el.matches('iframe,frame'))throw new Error('Explicit frame target required');
        while(el && el!==document.scrollingElement){
          const style=getComputedStyle(el);
          if((${args.deltaY}!==0 && el.scrollHeight>el.clientHeight && /(auto|scroll)/.test(style.overflowY))
            ||(${args.deltaX}!==0 && el.scrollWidth>el.clientWidth && /(auto|scroll)/.test(style.overflowX)))return el;
          el=el.parentElement||el.getRootNode()?.host;
        }
        return document.scrollingElement;
      })()`, false);
      if (!scroller.objectId) fail('INVALID_SCROLL_TARGET', 'No connected native scrolling container');
      try {
        this.#owned(p.id, caller, signal, true);
        markSent();
        await p.driver.callOn(scrollFrame, scroller.objectId, `function(x,y){
          if(!this.isConnected)throw new Error('Scroller replaced');
          this.scrollBy({left:x,top:y,behavior:'instant'});
          return {x:this.scrollLeft,y:this.scrollTop};
        }`, [args.deltaX, args.deltaY], true, true);
      } finally { await p.driver.release(scrollFrame, scroller.objectId); }
      return;
    }
    const objectId = await p.driver.objectFor(frame, element.ref);
    try {
      const info = await p.driver.callOn(frame, objectId, `function() {
        return {connected:this.isConnected,disabled:!!this.disabled,readOnly:!!this.readOnly,
          tag:this.tagName,type:this.type,multiple:!!this.multiple,editable:this.isContentEditable};
      }`);
      if (!info.connected || info.disabled || info.readOnly) fail('NOT_ACTIONABLE', 'Target is replaced, disabled or readonly');
      if (args.action === 'upload') {
        if (info.tag !== 'INPUT' || info.type !== 'file' || (!info.multiple && args.files.length !== 1)) fail('INVALID_UPLOAD_TARGET', 'Upload requires a matching explicit file input');
        await this.#validateFiles(args.files, info.multiple);
        await this.#fresh(p, caller, signal);
        await dispatch('DOM.setFileInputFiles', { files: args.files, objectId }, frame.sessionId);
      } else if (args.action === 'select') {
        if (info.tag !== 'SELECT' || (!info.multiple && args.values.length !== 1)) fail('INVALID_SELECT_TARGET', 'Target must be a select with matching multiplicity');
        const valid = await p.driver.callOn(frame, objectId, 'function(values){return values.every(v=>Array.from(this.options).some(o=>o.value===v&&!o.disabled))}', [args.values]);
        if (!valid) fail('INVALID_OPTION', 'An exact enabled option is missing');
        this.#owned(p.id, caller, signal, true);
        markSent();
        await p.driver.callOn(frame, objectId, `function(values){
          if(!this.isConnected||this.disabled)throw new Error('changed');
          for(const option of this.options)option.selected=values.includes(option.value);
          this.dispatchEvent(new Event('input',{bubbles:true}));
          this.dispatchEvent(new Event('change',{bubbles:true}));
        }`, [args.values], true, true);
      } else {
        if (['fill', 'type'].includes(args.action) && !info.editable
          && !(info.tag === 'TEXTAREA' || (info.tag === 'INPUT' && !['file', 'button', 'submit', 'reset', 'checkbox', 'radio', 'hidden'].includes(info.type)))) {
          fail('INVALID_TEXT_TARGET', 'Target is not an editable text input');
        }
        await dispatch('DOM.focus', { objectId }, frame.sessionId);
        const ensureEditable = async () => {
          await p.driver.refresh();
          if (p.driver.frames.get(frame.id)?.documentId !== frame.documentId) fail('STALE_FRAME', 'Document changed after focus');
          const stillLive = await p.driver.callOn(frame, objectId, 'function(){return this.isConnected&&!this.disabled&&!this.readOnly&&this.getRootNode().activeElement===this}');
          if (!stillLive) fail('TARGET_CHANGED', 'Target changed after focus; no text was replayed');
          await p.driver.point(frame, element.ref);
          this.#owned(p.id, caller, signal, true);
        };
        await p.driver.assertCheckpoints(resolved.observation.checkpoints);
        await ensureEditable();
        const key = async data => {
          let pressed = false;
          try {
            await dispatch('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...data }, undefined, () => { pressed = true; });
          } finally {
            if (pressed) await p.driver.send('Input.dispatchKeyEvent', { type: 'keyUp', ...data });
          }
          await ensureEditable();
        };
        if (args.action === 'fill') {
          await key({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
          await key(keys.Backspace);
          if (args.text) await dispatch('Input.insertText', { text: args.text });
        } else if (args.action === 'type') {
          if (args.text) await dispatch('Input.insertText', { text: args.text });
        } else if (args.action === 'press') await key(keys[args.key]);
      }
    } finally {
      await p.driver.release(frame, objectId);
    }
  }

  #revoke() {
    if (this.#revokeFlight) return this.#revokeFlight;
    // Synchronous fail-closed admission stop BEFORE any callback/await.
    this.#revoking = true;
    for (const p of this.#pages.values()) this.#pause(p, 'permission-revocation');
    this.permissions.close();
    const disposition = {
      connectionId: this.connectionId, disposition: 'terminating-revocation',
      confirmed: false, closesConnection: true,
    };
    this.#revokeFlight = Promise.resolve().then(() => this.onRevokeConnection(disposition)).then(
      () => ({ ...disposition, reason: 'Gateway must confirm companion process exit; this process cannot confirm its own termination' }),
      () => ({ ...disposition, reason: 'Companion termination was not confirmed; automation remains blocked' }),
    );
    return this.#revokeFlight;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.permissions.close();
    for (const p of this.#pages.values()) {
      this.#queue.abort(p.id, new Error('Browser connection closed'));
      if (!p.frame.isDestroyed()) p.frame.destroy();
    }
    this.dialogs.close();
  }
}
