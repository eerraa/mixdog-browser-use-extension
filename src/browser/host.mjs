import { session, WebContentsView } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { FenceQueue } from './queue.mjs';
import { bounded, pause } from '../shared/async.mjs';
import { FrameDriver } from './frames.mjs';
import { BrowserPermissions } from './permissions.mjs';
import { BrowserPolicy } from './policy.mjs';
import { BrowserRequests } from './requests.mjs';
import { BrowserDialogs } from './dialogs.mjs';
import { installPageMenu } from './consent.mjs';
import { PagePresentation, TOOLBAR_HEIGHT } from './presentation.mjs';
import {
  DEVTOOLS_LIMITS, DevToolsRecorder, INSPECT_ELEMENT, PrivacyWindows, inspectNode, pageRead, performanceSnapshot, responseBody, selectElement,
} from './devtools.mjs';
import { rankBrowserSemanticMatch } from './perception/match.mjs';
import { composeModel } from './perception/model.mjs';
import { RefRegistry } from './perception/refs.mjs';
import { displayURL, quote, renderDiff, renderFind, renderHeader, renderSnapshot, renderText } from './perception/render.mjs';
import { armNavigation, settle } from './settle.mjs';
import { CONTROL_SIGNALS, formatSignals, SignalQueue } from './signals.mjs';
import { runScript } from './runner/run.mjs';
import { createRunnerSandbox } from './runner/sandbox.mjs';
import {
  BrowserHostError, devtoolsActions, fail, freshId, inputActions, keys, matchesTarget, pageURL, RUN_BOUNDS, validateArgs,
} from '../shared/contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const hostOf = url => { try { return new URL(url).host || String(url).slice(0, 40); } catch { return ''; } };
// Points: a 24×24 CSS-pixel tile around the point must be unchanged (D18).
const TILE = 24;
const WAIT_POLL_MS = 100;
const SHORT_SETTLE = new Set(['scroll', 'evaluate']);
// A native request other than a JS dialog leaves the renderer running; the
// input that opened it gets this long to be acknowledged before the result.
const NATIVE_REQUEST_ACK_GRACE_MS = 300;
// Points under a hit chain this transparent are refused (D18).
const MIN_POINT_OPACITY = 0.1;
// Open tabs per session at which `open` is refused (pages' own popups still open).
const MAX_SESSION_TABS = 32;
const clipText = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

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
  // Connection-wide refs (D14), result signals and short ids.
  #refs = new RefRegistry();
  #signals = new SignalQueue();
  #tabSequence = 0;
  #snapshotSequence = 0;

  constructor({ dataDir, consentHelperPath, toolbarPreloadPath, onRevokeConnection, policy = new BrowserPolicy(),
    runnerPreloadPath, createRunnerSandbox: sandboxFactory = createRunnerSandbox }) {
    if (![dataDir, consentHelperPath, toolbarPreloadPath].every(value => typeof value === 'string' && path.isAbsolute(value))
      || (runnerPreloadPath !== undefined && !(typeof runnerPreloadPath === 'string' && path.isAbsolute(runnerPreloadPath)))
      || typeof onRevokeConnection !== 'function') {
      throw new TypeError('Absolute plugin dataDir/consentHelperPath/toolbarPreloadPath and onRevokeConnection are required');
    }
    this.dataDir = dataDir;
    this.toolbarPreloadPath = toolbarPreloadPath;
    this.runnerPreloadPath = runnerPreloadPath;
    this.createRunnerSandbox = sandboxFactory;
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
    if (input && p.paused) fail('AUTOMATION_PAUSED', `Automation paused: ${p.paused}; only the person can resume it from the browser window`, { paused: p.paused });
    if (input && !p.visible) fail('PAGE_HIDDEN', 'Page is hidden; show and observe before input');
    if (input && !p.connected && !allowDisconnected) fail('DEBUGGER_DISCONNECTED', 'Browser disconnected; observe or explicitly navigate before new input');
    if (input && !dialogCleanup) p.driver.assertNoDialogCleanup();
    if (input) p.presentation.assertAutomation(p.actorGeneration ?? p.presentation.generation);
    return p;
  }
  // Page events withdraw permissions, dialogs and DevTools as needed. Refs are
  // not voided here: each one is validated against its own node at use (C7).
  #invalidate(p, reason) {
    if (reason === 'handoff-draining') this.#beginPrivate(p);
    this.#devtoolsMode(p);
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
    // Abort reasons carry result codes: a cancelled action reports why (#run).
    p.returnController?.abort(new BrowserHostError('AUTOMATION_PAUSED', `Automation paused: ${reason}`, { paused: reason }));
    this.#queue.abort(p.id, new BrowserHostError('AUTOMATION_PAUSED', `Automation paused: ${reason}`, { paused: reason }));
    p.presentation.refresh();
    if (p.presentation.mode !== 'automation') this.#beginPrivate(p);
    this.#signal(p, { kind: 'state', state: reason === 'explicit-stop' ? 'stopped' : `paused: ${reason} (only the person can resume)` });
  }
  // The person's activity is private from the moment control starts to move
  // to them: queued page-content signals of the tab are dropped, and fields
  // they type become sensitive at return (#resume, privatize).
  #beginPrivate(p) {
    p.privateSince ??= Date.now();
    this.#signals.purge(p.owner, p.id);
  }
  // Only state and closed signals leave a tab that is not in automation.
  #signal(p, signal) {
    if (p.closed && signal.kind !== 'closed') return;
    if (!CONTROL_SIGNALS.has(signal.kind) && p.presentation?.mode !== 'automation') return;
    this.#signals.push(p.owner, { tabId: p.id, ...signal });
  }
  /** A caller session ended: its queued signals are dropped. */
  endSession(sessionId) {
    this.#signals.end(sessionId);
  }
  // agent: the agent's handoff action. The window then only flashes; it never
  // takes focus, so keystrokes meant for another app cannot reach it (D19).
  #handoff(p, reason, fromMenu = false, agent = false) {
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
      p.presentation.enterNative(generation, { activate: !agent });
      this.#devtoolsMode(p);
      this.#signal(p, { kind: 'state', state: 'handoff' });
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
          // Human DevTools never outlive native handoff (D11).
          await this.#closeDevTools(p);
          if (p.devtoolsShown) {
            // The page view kept its in-window focus while DevTools was active, so no
            // focus event moved it to chrome; re-activate the window with chrome focused.
            p.devtoolsShown = false;
            if (!p.presentation.frame.isDestroyed()) p.presentation.frame.focus();
            p.presentation.toolbar.focus();
          }
          await p.driver.setNativeMode(false);
          if (!p.connected) { await p.driver.reconnect(); p.connected = true; }
          // The trusted return proves a presented frame and a readable root
          // document; it never captures an image.
          await p.driver.presented();
          // Whatever the person typed during the handoff stays theirs: those
          // fields are sensitive before the first agent-visible observation.
          if (p.privateSince !== undefined) await p.driver.privatize(p.privateSince);
          await this.#perceive(p, null, signal, true);
          signal.throwIfAborted();
          // Deliver every DevTools event queued during the handoff while
          // recording is still off, on every page sharing the profile.
          await Promise.all(this.#profilePages(p).map(q => q.driver?.devtoolsFlush()));
          signal.throwIfAborted();
          p.presentation.finishReturn(generation);
          p.privateSince = undefined;
          p.paused = null;
          this.#devtoolsMode(p);
          p.presentation.refresh();
          this.#signal(p, { kind: 'state', state: 'returned' });
        } finally { p.driver.actorSignal = undefined; }
      }, controller.signal);
    } catch {
      p.paused ||= 'return-failed';
      p.presentation.failClosed('return-failed');
    } finally {
      if (p.returnController === controller) p.returnController = null;
    }
  }
  #profilePages(p) {
    return [...this.#pages.values()].filter(q => q.profile === p.profile && !q.closed);
  }
  // Every mode transition passes here: DevTools privacy windows (this page and
  // the profile's shared workers), the human DevTools menu item, and closing
  // human DevTools whenever the person no longer controls the page.
  #devtoolsMode(p) {
    for (const q of this.#profilePages(p)) q.devtools.boundary();
    p.devtools.boundary();
    const handoff = p.presentation?.mode === 'native-handoff';
    if (p.devtoolsMenuItem) p.devtoolsMenuItem.enabled = handoff;
    if (!handoff && (p.devtoolsOpening || (!p.contents.isDestroyed() && p.contents.isDevToolsOpened()))) {
      this.#closeDevTools(p).catch(() => {});
    }
  }
  #openDevTools(p) {
    // Only for the page view, only while the person controls it; never for
    // the toolbar or shield documents.
    if (p.closed || this.#closed || this.#revoking || p.contents.isDestroyed()
      || p.presentation.mode !== 'native-handoff' || p.devtoolsOpening || p.contents.isDevToolsOpened()) return;
    // Settles synchronously on 'devtools-opened' (after the guard below has
    // run), or after a bound if the front end never loads.
    let finish;
    p.devtoolsOpening = new Promise(resolve => {
      const timer = setTimeout(() => finish(), DEVTOOLS_LIMITS.commandMs);
      timer.unref?.();
      finish = () => {
        clearTimeout(timer);
        p.contents.removeListener('devtools-opened', finish);
        p.devtoolsOpening = null;
        resolve();
      };
    });
    p.contents.once('devtools-opened', finish);
    // Outstanding until the front end actually opens, however long it loads.
    p.devtoolsRequested = true;
    p.contents.openDevTools({ mode: 'detach', activate: true });
  }
  async #closeDevTools(p) {
    // DevTools still loading its front end is not yet "opened", and a close
    // request has no effect then. However long it loads, it is closed the
    // moment it opens outside native handoff (the devtools-opened handler).
    if (p.contents.isDestroyed() || !p.contents.isDevToolsOpened()) return;
    const closed = new Promise(resolve => p.contents.once('devtools-closed', resolve));
    p.contents.closeDevTools();
    await bounded(closed, 3000, 'Human DevTools close');
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
        return this.#validateFiles(response.files, params.mode === 'selectMultiple');
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
  // Local regular files only; returns their real paths, which are what the
  // page receives. A network or device path (\\host\share, \\?\UNC\…, //host)
  // is refused before any filesystem call: touching it would send the user's
  // NTLM credentials to that host. The resolved path must still be a local
  // drive-letter path to a regular file.
  async #validateFiles(files, multiple) {
    if (!Array.isArray(files) || !files.length || files.length > 32 || (!multiple && files.length !== 1)) {
      fail('INVALID_UPLOAD_FILE', 'File selection must match the input multiplicity');
    }
    const local = file => typeof file === 'string' && !file.includes('\0') && /^[a-zA-Z]:[\\/]/.test(file);
    const refuse = () => fail('INVALID_UPLOAD_FILE', 'Upload requires existing local regular files with drive-letter paths; network and device paths are refused');
    const real = [];
    for (const file of files) {
      if (!local(file)) refuse();
      let resolved, info;
      try { resolved = await realpath(file); } catch { refuse(); }
      if (!local(resolved)) refuse();
      try { info = await stat(resolved); } catch { refuse(); }
      if (!info.isFile()) refuse();
      real.push(resolved);
    }
    return real;
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
        // A download the person started outside automation is private for its
        // whole life: never listed, never signalled, including when it ends.
        const hidden = p.presentation?.mode !== 'automation';
        if (!hidden) {
          p.downloads.push(entry);
          this.#signal(p, { kind: 'download', id: entry.id, name: filename, state: 'started', bytes: entry.totalBytes });
        }
        item.on('updated', (_e, state) => { entry.state = state; entry.receivedBytes = item.getReceivedBytes(); });
        item.once('done', (_e, state) => {
          entry.state = state;
          entry.receivedBytes = item.getReceivedBytes();
          if (!hidden) this.#signal(p, { kind: 'download', id: entry.id, name: filename, state, bytes: entry.receivedBytes });
        });
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
    // model: the latest full page model (host side, D13); base: the agent's
    // last view of the tab, the diff base; shot: the latest snapshot that
    // carried a screenshot, for points (D18); cursor: DevTools signal cursor.
    const p = {
      id: `t${++this.#tabSequence}`, owner, profile, view, contents: view.webContents, closed: false, connected: true, visible: false,
      paused: parent?.paused ?? null, model: null, base: null, shot: null, cursor: null,
      dialog: null, downloads: [], permissionDocuments: new Map(),
    };
    // Service and shared workers serve every page of the profile: their
    // events are private while any page of the profile is not in automation.
    profile.devtoolsPrivacy ??= new PrivacyWindows(() => [...this.#pages.values()]
      .every(q => q.closed || q.profile !== profile || (q.presentation?.mode ?? 'automation') === 'automation'));
    p.devtools = new DevToolsRecorder(() => p.presentation?.mode ?? 'automation',
      sessionId => p.driver?.targets.get(sessionId)?.type, profile.devtoolsPrivacy);
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
      openDevTools: () => this.#openDevTools(p),
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
    p.devtoolsMenuItem = installPageMenu(p.frame, humanActions).items.find(item => item.id === 'open-devtools');
    // DevTools outside native handoff would be human input that bypasses the shield.
    wc.on('devtools-opened', () => {
      p.devtoolsShown = true;
      const requested = p.devtoolsRequested;
      p.devtoolsRequested = false;
      if (p.presentation.mode === 'native-handoff') return;
      wc.closeDevTools();
      // Draining or returning: the handoff is ending and its close path waits.
      // A front end the person requested during handoff that finished loading
      // after it ended is closed without failing closed.
      if (p.presentation.mode === 'automation' && !requested) p.presentation.failClosed('devtools-outside-handoff');
    });
    p.frame.on('closed', () => {
      if (!p.closed && !p.closedByAgent) this.#signal(p, { kind: 'closed' });
      p.closed = true;
      this.#refs.retireTab(p.id);
      if (!wc.isDestroyed() && wc.isDevToolsOpened()) wc.closeDevTools();
      p.presentation.close();
      this.permissions.withdraw(p);
      this.dialogs.destroyed(p);
      this.#invalidate(p, 'closed');
      this.#queue.abort(p.id, new BrowserHostError('CLOSED_TAB', 'Tab closed'));
    });
    wc.on('render-process-gone', () => {
      p.connected = false;
      this.permissions.withdraw(p);
      this.dialogs.destroyed(p);
      this.#invalidate(p, 'renderer-disconnected');
      this.#queue.abort(p.id, new BrowserHostError('RENDERER_GONE', 'Renderer disconnected; input disposition may be uncertain'));
    });
    wc.on('did-start-navigation', details => {
      this.#invalidate(p, details.isSameDocument ? 'same-document-navigation' : 'navigation');
      if (!details.isSameDocument) {
        if (details.isMainFrame) this.permissions.withdraw(p);
        else if (details.frame) this.permissions.withdraw(p, details.frame.processId, details.frame.routingId);
        else this.permissions.prune(p);
      }
    });
    wc.on('did-navigate', (_event, url) => this.#signal(p, { kind: 'navigated', url: url ?? wc.getURL(), title: wc.getTitle() }));
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
        this.#signal(p, { kind: 'popup', popupTabId: popup.id, title: '', url: details.url });
        // A popup ends a running settle at once; the result reports it.
        p.settleInterrupt?.('popup');
        return popup.contents;
      } };
    });
    p.driver = new FrameDriver(p, reason => this.#invalidate(p, reason));
    p.onNativePicker = (params, sessionId) => this.#nativeFilePicker(p, params, sessionId);
    p.onNativeDialog = record => {
      this.#signal(p, { kind: 'dialog', type: record.type, message: record.message });
      // A dialog ends a running settle at once; the result reports it.
      p.settleInterrupt?.('dialog');
      return this.dialogs.opened(p, record);
    };
    // Trusted pointer or key input in the page outside an agent dispatch came
    // from an escape path around the shield (native pickers, popups).
    p.onTrustedInput = () => {
      if (p.closed || p.presentation.mode !== 'automation') return;
      p.presentation.failClosed('unexpected-page-input');
    };
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
   *   navigate{url}; observe{mode?,find?,scope?,depth?,screenshot?,wait?};
   *   close_tab; hide; show; downloads; handoff; permissions
   *   click{ref|target|point}; scroll{ref|target|point,deltaX,deltaY}
   *   fill/type{ref|target,text}; press{ref|target,key}
   *   select{ref|target,values:string[]}; upload{ref|target,files:absolutePath[]}
   *   every page-changing action also takes screenshot? and snapshot? (diff|full|none).
   *   read{ref?|target?}; evaluate{expression,frame?,world?}
   *   handle_dialog{accept:boolean,promptText?}.
   *   DevTools reads: console{since?,filter?,limit?} | console{expression,frame?,limit?};
   *   network{since?,filter?,limit?} | network{id,body?,limit?}; inspect{ref|target,values?}; performance.
   * ref: e<n> from any earlier result of this connection; it acts only on its
   * own live node (same document, role, name and presentation generation, C7).
   * target={role?,name?,exact?,selector?,frame?}, at least role/name/selector;
   * frame (here and on evaluate/console) is an iframe ref.
   * point={x,y,snapshotId}: CSS viewport pixels of that snapshot's screenshot.
   * press keys are exported from contract.mjs; no key-chord aliases.
   * evaluate runs in its OWN isolated page world (DOM access, no page-main JS
   * globals, Node, private refs or host binding); world:'page' opts into the
   * page main world. It is always treated as a mutation, never a retryable read.
   * caller={sessionId,callId,signal,assertLive()}: trusted IPC authority ONLY.
   * Page results are objects that src/mcp/tool.mjs renders as text: a status
   * line (action, disposition, ref, tabId, snapshotId, code, observed/cause,
   * replaySafe) and `text` (signals, page header, snapshot, find or diff).
   * Dispositions: observed; executed (observed:false + cause when the result
   * observation failed after an acknowledged dispatch); not-executed (thrown,
   * requestedInputDispatched:false); uncertain (replaySafe:false). Never
   * replay automatically. status, list_tabs, requests, respond, permissions,
   * downloads and the DevTools reads return JSON objects.
   * Permissions exposes pending descriptors/reasons, NEVER decide/approve.
   * Handoff and Stop can ONLY resume from the page window's toolbar or menu.
   */
  async execute(unchecked, caller, requestSignal) {
    try {
      return await this.#execute(validateArgs(unchecked), caller, requestSignal);
    } catch (error) {
      // An input action (or run) that throws never dispatched: after a
      // dispatch, #run, respond, handle_dialog and run return a result
      // instead of throwing. Invalid arguments are refused before anything.
      const action = unchecked?.action;
      if ((inputActions.has(action) || action === 'open' || action === 'run') && error && typeof error === 'object'
        && error.requestedInputDispatched === undefined) {
        Object.assign(error, { requestedInputDispatched: false, preparation: error.preparation ?? 'none', tabId: error.tabId ?? unchecked?.tabId });
      }
      throw error;
    }
  }
  async #execute(args, caller, requestSignal) {
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
    if (args.action === 'run') return this.#runScript(args, caller, signal);
    let p;
    if (args.action === 'open') {
      const open = [...this.#pages.values()].filter(q => q.owner === caller.sessionId && !q.closed).length;
      if (open >= MAX_SESSION_TABS) fail('TAB_LIMIT', `A session has at most ${MAX_SESSION_TABS} open tabs; close one first`);
      p = await this.#createPage(caller.sessionId, signal);
      try { this.#owned(p.id, caller, signal); }
      catch (error) { p.frame.destroy(); throw error; }
    } else p = this.#owned(args.tabId, caller, signal, inputActions.has(args.action), args.action === 'navigate',
      ['handle_dialog', 'respond'].includes(args.action));
    if (!p.connected && inputActions.has(args.action) && args.action !== 'navigate') {
      fail('DEBUGGER_DISCONNECTED', 'Browser debugger disconnected; observe or explicitly navigate to recover; no input was replayed');
    }
    if (args.action === 'close_tab') {
      p.closedByAgent = true;
      p.frame.destroy();
      return this.#plain(p, args.action, 'tab closed');
    }
    if (args.action === 'hide' || args.action === 'show') {
      this.#invalidate(p, args.action);
      if (args.action === 'hide') p.presentation.hide();
      else p.presentation.show();
      // hide starts a new presentation generation (refs retire); show does not.
      return this.#plain(p, args.action, `window ${p.presentation.logicalVisible() ? 'visible' : 'hidden'}${p.paused ? `; paused: ${p.paused}` : ''}`
        + (args.action === 'hide' ? '; earlier refs and points of this tab are void (observe again after show)' : '; observe before acting'));
    }
    if (args.action === 'handoff') {
      await this.#handoff(p, 'human-handoff', true, true);
      return this.#plain(p, args.action, `mode ${p.presentation.mode}; the window flashes for the person. Only the person can return control in the browser window; no tool can resume`);
    }
    if (['observe', 'read', 'downloads', 'requests'].includes(args.action) || devtoolsActions.has(args.action)) {
      await p.ready;
      this.#owned(p.id, caller, signal);
      p.presentation.assertObservable();
    }
    if (args.action === 'permissions') return this.permissions.status(p);
    if (args.action === 'requests') return {
      tabId: p.id, pending: this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller), capabilities: this.status().capabilities,
    };
    if (args.action === 'respond') {
      let dispatched = false;
      try {
        const request = await bounded(this.nativeRequests.respond(p, caller, args.requestRef, args.response, () => {
          this.#owned(p.id, caller, signal, true, false, true);
          dispatched = true;
        }, signal), 15000, 'Native response', signal);
        return { tabId: p.id, disposition: 'executed', request, pendingRequests: this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller) };
      } catch (error) {
        if (!dispatched) throw error;
        return { tabId: p.id, disposition: 'uncertain', replaySafe: false, reason: 'Native response or result failed; do not replay' };
      }
    }
    if (args.action === 'downloads') return { items: structuredClone(p.downloads) };
    // Buffer reads answer beside the action lane, even while an action runs.
    if (args.action === 'network' || args.action === 'performance' || (args.action === 'console' && args.expression === undefined)) {
      return this.#devtoolsRead(p, args, caller, signal);
    }
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
      } catch {
        return { action: args.action, tabId: p.id, disposition: 'uncertain', replaySafe: false, code: 'DIALOG_UNCERTAIN',
          text: 'note the dialog response may have been delivered; never repeat it; observe first' };
      }
      if (p.dialog === dialogRecord) p.dialog = null;
      this.#invalidate(p, 'dialog-handled');
      try {
        return await this.#run(p, { action: 'observe', tabId: p.id, after: args.action }, caller, signal);
      } catch (error) {
        return this.#unobserved(p, { action: args.action }, error.code ?? 'OBSERVE_FAILED');
      }
    }
    if (p.dialog) return this.#dialogFirst(p, caller, args.action);
    if (args.action === 'console') {
      // Page-world reads run page code (best-effort side-effect check), so an
      // explicit Stop or any other pause refuses them like input.
      if (p.paused) fail('AUTOMATION_PAUSED', `Automation paused: ${p.paused}; page-world reads wait until the person resumes`, { paused: p.paused });
      return this.#devtoolsRead(p, args, caller, signal);
    }
    return this.#run(p, args, caller, signal);
  }

  // Script runner (D20, runner/): every op is one execute() call under the
  // run's caller, through the same gates and pipeline as a direct call. Steps
  // render no snapshot and drain no signals; the result carries the final
  // diff of every touched tab, which drains them once.
  async #runScript(args, caller, signal) {
    if (args.tabId !== undefined) await this.#owned(args.tabId, caller, signal, true).ready;
    const runCaller = { sessionId: caller.sessionId, callId: caller.callId, signal, assertLive: () => caller.assertLive(),
      requestOwner: { caller, signal } };
    return runScript({
      script: args.script, tabId: args.tabId, timeoutMs: args.timeoutMs ?? RUN_BOUNDS.defaultMs, caller: runCaller,
      execute: (stepArgs, stepCaller) => this.execute(stepArgs, stepCaller),
      createSandbox: options => this.createRunnerSandbox({ ...options, preloadPath: this.runnerPreloadPath }),
      // Synchronous: whether the person controls one of the run's tabs.
      tabState: tabId => {
        const p = this.#pages.get(tabId);
        return p && !p.closed && p.owner === caller.sessionId ? { paused: p.paused, mode: p.presentation.mode } : null;
      },
      finalView: async (tabId, viewSignal) => {
        const both = AbortSignal.any([signal, viewSignal]);
        const p = this.#owned(tabId, caller, both);
        // A lane parked behind a dialog never observes: name the dialog instead.
        if (p.dialog) return this.#dialogFirst(p, caller, 'observe').text;
        const result = await this.#run(p, { action: 'observe', tabId, after: 'run' }, caller, both);
        return result.text;
      },
    });
  }

  // DevTools reads (devtools.mjs): never an observation or screenshot, never a
  // ref change, never the action lane. Callers passed the observe gates.
  async #devtoolsRead(p, args, caller, signal) {
    if (args.action === 'console' && args.expression === undefined) return { tabId: p.id, ...p.devtools.consoleRows(args) };
    if (args.action === 'network' && args.id === undefined) return { tabId: p.id, ...p.devtools.networkRows(args) };
    if (args.action === 'network' && !args.body) return { tabId: p.id, ...p.devtools.detail(args.id) };
    // Behind a modal JS dialog the browser cannot answer; refuse first, like
    // every other page read or action.
    if (p.dialog) return this.#dialogFirst(p, caller, args.action);
    if (!p.connected) fail('DEBUGGER_DISCONNECTED', 'Browser debugger disconnected; observe to reconnect');
    const generation = p.presentation.generation;
    const frameId = args.frame ? this.#frameOf(p, args.frame).id : undefined;
    if (args.action === 'console') await this.#assertNoSensitive(p, frameId ? p.driver.frames.get(frameId) : await this.#rootFrame(p));
    const result = args.action === 'network'
      ? await responseBody(p.driver, p.devtools.bodyTarget(args.id), args.limit ?? DEVTOOLS_LIMITS.chars, signal)
      : args.action === 'console' ? await pageRead(p.driver, { expression: args.expression, frameId, limit: args.limit }, signal)
        : await performanceSnapshot(p.driver, signal);
    // A person may have taken control while the browser answered.
    this.#owned(p.id, caller, signal);
    p.presentation.assertObservable();
    if (p.presentation.generation !== generation) fail('PRESENTATION_CHANGED', 'Presentation changed during the DevTools read; read again');
    return { tabId: p.id, ...result };
  }
  // Page code (evaluate in either world, console expressions) reaches every
  // same-origin document of its page and of the profile's other windows
  // (contentDocument, opener, open('', name)). It never runs while one of them
  // holds a filled sensitive or privately typed field (M4), nor while any
  // window of the profile is under the person's control.
  async #assertNoSensitive(p, frame) {
    if (!frame) fail('STALE_FRAME', 'The frame is not available; observe again');
    const refuse = reason => fail('SENSITIVE_PRESENT', reason, { requestedInputDispatched: false });
    const pages = [...this.#pages.values()].filter(q => !q.closed && q.profile === p.profile);
    if (pages.some(q => (q.presentation?.mode ?? 'automation') !== 'automation')) {
      refuse('A window of this profile is under the person\'s control; page code is not run until control returns');
    }
    for (const q of pages) {
      if (q.driver && await q.driver.sensitivePresent(frame.origin, q === p)) {
        refuse('A filled sensitive field is in a same-origin frame or window; page code is not run until it is submitted or cleared');
      }
    }
  }
  async #inspect(p, args, caller, signal) {
    // A ref is validated against its own node; a selector reaches elements
    // the projection omits. Neither path observes or changes refs.
    let frame, objectId, located;
    if (args.ref) {
      ({ frame, objectId } = await this.#validate(p, { action: 'inspect', ref: args.ref }, caller, signal));
      located = { ref: args.ref };
    } else {
      const frameId = args.target.frame ? this.#frameOf(p, args.target.frame).id : undefined;
      ({ frame, objectId } = await selectElement(p.driver, { selector: args.target.selector, frameId }));
      located = { selector: args.target.selector, frame: args.target.frame };
    }
    try {
      const node = await p.driver.callOn(frame, objectId, INSPECT_ELEMENT, [args.values ?? []]);
      const css = await inspectNode(p.driver, p.devtools, frame, objectId);
      this.#owned(p.id, caller, signal);
      return { tabId: p.id, ...located, ...node, ...css };
    } finally { await p.driver.release(frame, objectId); }
  }

  // Pipeline (D16, D17): validate the target and its frame chain (read-only,
  // except scrolling it into view) → dispatch once → bounded settle → one
  // result observation with one read-only re-take. Phases: sent (the first
  // input command was dispatched) and acked (every command of the input was
  // acknowledged). Failure before sent: not-executed (thrown); between sent
  // and acked: uncertain; after acked: executed, observed:false when the
  // observation failed. Input is never resent.
  async #run(p, args, caller, requestSignal) {
    const timeout = new AbortController();
    const signal = AbortSignal.any([requestSignal, timeout.signal]);
    // delivered: the caller already has a result (a parked dialog, a timeout);
    // the lane may still finish, but it never moves the agent's diff base or
    // drains signals into a result nobody receives.
    const state = { sent: false, acked: false, delivered: false, preparation: 'none', ref: args.ref };
    let dialogListener;
    const mutation = args.action === 'open' || inputActions.has(args.action);
    const markSent = () => { state.sent = true; };
    // A dialog that opens after dispatch parks the lane; the caller gets the
    // dialog instead of waiting for it. Before every command of the input was
    // acknowledged, its outcome is unknown. A JS dialog blocks the renderer,
    // so its acknowledgement cannot arrive; any other native request (file
    // chooser, permission) leaves the renderer running, so its input gets a
    // short grace to be acknowledged (or the whole action to finish) first.
    const decide = () => {
      if (!state.sent || state.delivered) return;
      const result = state.acked ? this.#unobserved(p, args, 'DIALOG_OPEN', state, caller) : this.#pendingUncertain(p, args, state, caller);
      state.delivered = true;
      dialogListener(result);
    };
    const parked = () => decide();
    const requested = () => {
      if (!state.sent || state.delivered) return;
      if (state.acked || p.dialog) decide(); else setTimeout(decide, NATIVE_REQUEST_ACK_GRACE_MS);
    };
    const actual = this.#queue.run(p.id, async laneSignal => {
      await p.ready;
      this.#owned(p.id, caller, laneSignal, mutation, args.action === 'navigate');
      await p.driver.waitForIdle(laneSignal);
      p.actorGeneration = p.presentation.generation;
      p.driver.actorSignal = laneSignal;
      p.driver.beforeInputDispatch = () => this.#owned(p.id, caller, laneSignal, true);
      p.driver.beforeCleanupDispatch = () => p.presentation.assertShielded();
      // A run step's native requests (dialogs, choosers, permissions) belong
      // to the run's own caller, so they outlive the run and the agent can
      // answer them after its result (requestOwner, runner).
      this.permissions.bindActor(p, caller.requestOwner?.caller ?? caller, caller.requestOwner?.signal ?? signal);
      let armed;
      try {
        if (!p.connected && args.action !== 'navigate') {
          if (mutation) fail('DEBUGGER_DISCONNECTED', 'Browser disconnected before dispatch; observe again');
          await p.driver.reconnect();
          p.connected = true;
        }
        if (!mutation) return await this.#read(p, args, caller, laneSignal);
        p.dialogOpened = parked;
        p.nativeRequestOpened = requested;
        state.wall = Date.now();
        if (args.action === 'open' || args.action === 'navigate') {
          this.#owned(p.id, caller, laneSignal, true, args.action === 'navigate');
          armed = this.#arm(p);
          markSent();
          state.load = p.contents.loadURL(pageURL(args.url)).then(() => null, error => error);
          state.acked = true;
        } else if (args.action === 'evaluate') {
          const frame = args.frame ? this.#frameOf(p, args.frame) : await this.#rootFrame(p);
          // A missing page world fails here, before dispatch (not-executed).
          const contextId = await p.driver.evaluationContext(frame, args.world);
          await this.#assertNoSensitive(p, frame);
          this.#owned(p.id, caller, laneSignal, true);
          state.frameId = frame.id;
          armed = this.#arm(p);
          try {
            // Marked sent inside the guard, right before the command goes out.
            state.value = await p.driver.evaluateUser(frame, args.expression, args.world, contextId, markSent);
          } catch (error) {
            // The page answered: the script ran and threw, or returned no JSON.
            if (!['PAGE_SCRIPT_ERROR', 'NON_JSON_RESULT'].includes(error?.code)) throw error;
            state.code = error.code;
          }
          state.acked = true;
        } else {
          const target = args.point ? await this.#validatePoint(p, args, caller, laneSignal)
            : await this.#validate(p, args, caller, laneSignal, phase => { state.preparation = phase; });
          state.ref = target.ref ?? state.ref;
          state.frameId = target.frame?.id;
          armed = this.#arm(p);
          try {
            await this.#perform(p, target, args, caller, laneSignal, markSent, state);
          } finally {
            if (target.objectId) await p.driver.release(target.frame, target.objectId).catch(() => {});
          }
          state.acked = true;
        }
        return await this.#afterDispatch(p, args, caller, laneSignal, armed, state);
      } finally {
        armed?.dispose();
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
      // Abort reasons are BrowserHostErrors (Stop, tab closed, renderer gone,
      // connection closed): their code says why the action ended.
      const code = timeout.signal.aborted ? 'TIMEOUT' : typeof error?.code === 'string' ? error.code : signal.aborted ? 'ABORTED' : 'BROWSER_ERROR';
      if (mutation && state.acked) return this.#unobserved(p, args, code, state, caller);
      if (mutation && state.sent) return this.#pendingUncertain(p, args, state, caller, code);
      if (mutation) {
        const failure = error instanceof BrowserHostError ? error
          : new BrowserHostError(code, signal.aborted ? 'Cancelled, timed out or stopped before dispatch' : 'Target validation failed');
        if (signal.aborted && failure.code !== 'AUTOMATION_PAUSED') failure.code = code;
        throw Object.assign(failure, { tabId: p.id, preparation: state.preparation, requestedInputDispatched: false });
      }
      throw error;
    } finally {
      state.delivered = true;
      if (p.dialogOpened === parked) p.dialogOpened = null;
      if (p.nativeRequestOpened === requested) p.nativeRequestOpened = null;
    }
  }
  // Sent but not every command acknowledged: the outcome is unknown.
  #pendingUncertain(p, args, state, caller, code = 'DIALOG_OPEN') {
    const parked = code === 'DIALOG_OPEN';
    const pending = parked && caller ? this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller) : [];
    return {
      action: args.action, ref: state.ref, tabId: p.id, disposition: 'uncertain', replaySafe: false, code,
      ...(parked ? { operationPending: true, pendingRequests: pending } : {}),
      text: [...this.#drainSignals(p, caller),
        ...(parked && p.dialog ? [`dialog ${p.dialog.type} ${quote(clipText(p.dialog.message ?? '', 200))}: answer with handle_dialog or respond`] : []),
        ...this.#requestLines(pending),
        'note the input may have been delivered in part or in full; never repeat it; observe first'].join('\n'),
    };
  }
  #arm(p) {
    const wc = p.contents;
    return armNavigation(listener => {
      const start = details => { if (details.isMainFrame && !details.isSameDocument) listener({ kind: 'start' }); };
      const ready = () => listener({ kind: 'ready' });
      // ERR_ABORTED: superseded by another navigation, which reports itself.
      const failed = (_event, code, _description, _url, isMainFrame) => { if (isMainFrame && code !== -3) listener({ kind: 'fail', code }); };
      wc.on('did-start-navigation', start);
      wc.on('dom-ready', ready);
      wc.on('did-fail-load', failed);
      return () => {
        wc.removeListener('did-start-navigation', start);
        wc.removeListener('dom-ready', ready);
        wc.removeListener('did-fail-load', failed);
      };
    });
  }
  async #afterDispatch(p, args, caller, signal, armed, state) {
    const interrupt = new Promise(resolve => { p.settleInterrupt = resolve; });
    const settled = await settle({
      armed, signal, interrupt, short: SHORT_SETTLE.has(args.action),
      // The host enforces the cap: a page that never answers cannot hold the
      // settle for the CDP command limit.
      quiet: (ms, cap) => {
        let timer;
        const capped = new Promise(resolve => { timer = setTimeout(() => resolve({ quiet: false }), cap + 100); });
        return Promise.race([p.driver.quiet(state.frameId ? [state.frameId] : [], ms, cap), capped]).finally(() => clearTimeout(timer));
      },
      pendingRequests: () => p.devtools.running(state.wall),
    });
    if (state.delivered) return null;
    if (!p.connected) {
      await p.driver.reconnect();
      p.connected = true;
    }
    if (p.dialog) return this.#unobserved(p, args, 'DIALOG_OPEN', state, caller);
    const loadError = state.load && await Promise.race([state.load, Promise.resolve(null)]);
    const result = { action: args.action, disposition: 'executed', tabId: p.id, ref: state.ref,
      code: state.code ?? (loadError && loadError.code !== 'ERR_ABORTED' ? 'NAVIGATION_FAILED' : undefined) };
    const lines = [];
    if (settled.loading) lines.push(`signal loading ${quote(displayURL(p.contents.getURL()))} (observe again for the finished page)`);
    let model;
    try { model = await this.#perceive(p, caller, signal); } catch (first) {
      if (signal.aborted) throw first;
      try { model = await this.#perceive(p, caller, signal); } catch (second) {
        if (signal.aborted) throw second;
        return this.#unobserved(p, args, second.code ?? 'OBSERVE_FAILED', state, caller);
      }
    }
    return this.#present(p, model, caller, result, {
      snapshot: args.snapshot ?? 'diff', screenshot: args.screenshot === true, lines, value: state.value, state,
    });
  }
  // Acknowledged input whose result could not be observed: executed, never resent.
  #unobserved(p, args, cause, state = {}, caller = null) {
    // A result for a caller that already has one is never built: no drain.
    if (state.delivered) return null;
    const parked = cause === 'DIALOG_OPEN';
    const pending = parked && caller ? this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller) : [];
    return {
      action: args.action, disposition: 'executed', tabId: p.id, ref: state.ref ?? args.ref, observed: false, cause, replaySafe: false,
      // What the dispatch itself reported (TARGET_MISMATCH, a page-script
      // error) survives an observation that could not follow.
      ...(state.code ? { code: state.code } : {}),
      ...(state.value === undefined ? {} : { value: state.value }),
      ...(parked ? { operationPending: true, pendingRequests: pending } : {}),
      text: [...this.#drainSignals(p, caller),
        ...(p.dialog ? [`dialog ${p.dialog.type} ${quote(clipText(p.dialog.message ?? '', 200))}: answer with handle_dialog or respond`] : []),
        ...this.#requestLines(pending),
        ...(parked ? ['note the action is still pending behind the dialog; its result follows the answer'] : []),
        ...(state.value === undefined ? [] : [`value ${clipText(JSON.stringify(state.value) ?? 'undefined', 4000)}`]),
        'note input delivered once; observe to see the result; never repeat it'].join('\n'),
    };
  }
  // Pending native requests with their offered refs, for respond.
  #requestLines(pending) {
    return pending.map(request => `request ${request.requestRef} ${request.kind}`
      + `${request.context?.message ? ` ${quote(clipText(String(request.context.message), 200))}` : ''}`
      + `${request.options?.length ? ` options ${request.options.map(option => `${option.optionRef}=${quote(option.label)}`).join(' ')}` : ' (respond with files or cancel)'}`);
  }
  #plain(p, action, text) {
    return { action, disposition: 'executed', tabId: p.id, text };
  }
  #dialogFirst(p, caller, action) {
    const pending = this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller);
    return {
      action, tabId: p.id, disposition: 'not-executed', code: 'DIALOG_OPEN', requestedInputDispatched: false,
      dialog: { type: p.dialog.type }, pendingRequests: pending,
      text: [`dialog ${p.dialog.type} ${quote(clipText(p.dialog.message ?? '', 200))}: answer it first with handle_dialog or respond`,
        ...this.#requestLines(pending)].join('\n'),
    };
  }
  #drainSignals(p, caller, header = false) {
    // Script steps keep the queue for the run's final views.
    if (caller?.keepSignals) return [];
    const queued = this.#signals.drain(p.owner, p.id)
      .filter(signal => !(header && signal.tabId === p.id && signal.kind === 'navigated'));
    const lines = formatSignals(queued, p.id);
    const devtools = p.devtools.since(p.cursor ?? { console: 0, network: 0 });
    p.cursor = devtools.cursor;
    if (devtools.errors) lines.push(formatSignals([{ tabId: p.id, kind: 'console', count: devtools.errors }], p.id)[0]);
    if (devtools.failed) lines.push(formatSignals([{ tabId: p.id, kind: 'network', count: devtools.failed }], p.id)[0]);
    const pending = caller ? this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller).length : 0;
    if (pending) lines.push(formatSignals([{ tabId: p.id, kind: 'requests', count: pending }], p.id)[0]);
    return lines;
  }

  // Read-only work in the lane: observe (with wait), read, inspect, and the
  // observation after a dialog answer.
  async #read(p, args, caller, signal) {
    if (args.action === 'inspect') return this.#inspect(p, args, caller, signal);
    if (args.action === 'read' && (args.ref || args.target)) {
      const target = await this.#validate(p, args, caller, signal);
      try {
        // Rendered text only, never textContent (no CSS or script text). The
        // walker decides sensitivity now (sticky rules, fields typed by the
        // person during a handoff), not the last model.
        // A container's text masks every sensitive element in its subtree.
        const value = await p.driver.callOn(target.frame, target.objectId, `function() {
          const s = globalThis.__independentState;
          if (!s || s.sensitive(this)) return {text:'', value:null, sensitive:true};
          const read = s.maskedText(this);
          return {text:read.text.slice(0,12000), sensitive:read.masked,
            value:!read.masked && typeof this.value==='string'?this.value.slice(0,12000):null};
        }`);
        const lines = [`text ${quote(value.text)}`];
        if (value.sensitive) lines.push('sensitive (value withheld)');
        else if (value.value !== null) lines.push(`value ${quote(value.value)}`);
        return { action: 'read', disposition: 'observed', tabId: p.id, ref: target.ref,
          text: [...this.#drainSignals(p, caller), ...lines].join('\n') };
      } finally { await p.driver.release(target.frame, target.objectId).catch(() => {}); }
    }
    let met = true;
    if (args.wait) met = await this.#wait(p, args.wait, caller, signal);
    const model = await this.#perceive(p, caller, signal);
    if (args.after) {
      return this.#present(p, model, caller, { action: args.after, disposition: 'executed', tabId: p.id }, { snapshot: 'diff' });
    }
    return this.#present(p, model, caller, {
      action: args.action, disposition: 'observed', tabId: p.id, code: met ? undefined : 'WAIT_TIMEOUT',
    }, { observe: args.action === 'read' ? { mode: 'text' } : args, screenshot: args.screenshot === true });
  }
  async #wait(p, wait, caller, signal) {
    const deadline = Date.now() + (wait.timeoutMs ?? 5000);
    for (;;) {
      this.#owned(p.id, caller, signal);
      p.presentation.assertObservable();
      const met = wait.url !== undefined ? p.contents.getURL().includes(wait.url)
        : (await p.driver.textIncludes(wait.text ?? wait.gone)) === (wait.text !== undefined);
      if (met) return true;
      if (Date.now() >= deadline) return false;
      await pause(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())), signal);
    }
  }

  // One page model from parallel per-frame walker snapshots (D15). Never an
  // image. Retires refs whose node, document or generation is gone.
  async #perceive(p, caller, signal, returning = false) {
    if (caller) this.#owned(p.id, caller, signal);
    else if (p.closed || this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Page closed during trusted return');
    signal?.throwIfAborted();
    p.presentation.assertObservable(returning);
    const generation = p.presentation.generation;
    const frames = await p.driver.snapshot();
    let model;
    try { model = composeModel(frames); } catch (error) {
      fail(error.code ?? 'ROOT_UNAVAILABLE', 'The page root document could not be read; observe again (no input was replayed)');
    }
    if (caller) this.#owned(p.id, caller, signal);
    signal?.throwIfAborted();
    p.presentation.assertObservable(returning);
    if (p.presentation.generation !== generation) fail('PRESENTATION_CHANGED', 'Presentation changed during observation');
    this.#refs.retireGeneration(p.id, generation);
    for (const frame of model.frames.values()) {
      if (!frame.documentId) continue;
      this.#refs.retireDocument(p.id, frame.frameId, frame.documentId);
      this.#refs.gone(p.id, frame.frameId, frame.documentId, frame.gone, frame.renamed);
    }
    for (const frameId of p.model?.frames.keys() ?? []) if (!model.frames.has(frameId)) this.#refs.retireDocument(p.id, frameId);
    p.model = model;
    return model;
  }
  // Text result for a model: signals, page header, then the snapshot, find,
  // text or diff body. Updates the agent's view (the next diff base).
  // Everything that can fail runs first; the agent's view (the next diff base)
  // and the signal queue change only for a result that is delivered.
  async #present(p, model, caller, result, { observe, snapshot = 'diff', screenshot = false, lines = [], value, state } = {}) {
    const generation = p.presentation.generation;
    const root = model.frames.get(model.rootId);
    const snapshotId = `s${++this.#snapshotSequence}`;
    const refFor = item => this.#refs.ref({
      tabId: p.id, frameId: item.frameId, documentId: item.documentId, id: item.id, role: item.role, name: item.name, generation,
    });
    const isGone = (_key, ref) => this.#refs.lookup(ref)?.state !== 'live';
    const base = p.base?.generation === generation && p.base.rootDocument === root.documentId ? p.base : null;
    let nextView = null;
    const merges = [];
    const view = next => { nextView = next; };
    // find and scope add what they showed to the current view.
    const merge = partial => { if (base) merges.push(partial); };
    const commit = () => {
      if (nextView) p.base = { view: nextView, snapshotId, rootDocument: root.documentId, generation, url: model.url, scroll: model.scroll.y };
      for (const partial of merges) {
        for (const [key, line] of partial.lines) base.view.lines.set(key, line);
        for (const [key, ref] of partial.refs) base.view.refs.set(key, ref);
      }
    };
    let header = !base || base.url !== model.url || screenshot;
    // A scroll since the agent's last view prints the view line.
    let viewLine = !header && base.scroll !== undefined && base.scroll !== model.scroll.y;
    let body = '';
    const full = mode => {
      const rendered = renderSnapshot(model, { mode, refFor });
      view(rendered.view);
      header = true;
      return rendered.text;
    };
    if (observe) {
      header = true;
      if (observe.find !== undefined) {
        const found = renderFind(model, observe.find, { match: rankBrowserSemanticMatch, refFor });
        merge(found.view);
        body = found.text;
      } else if (observe.mode === 'text') {
        body = renderText(model);
      } else if (observe.scope !== undefined) {
        const rendered = renderSnapshot(model, { scopeKey: this.#scopeKey(p, observe.scope), depth: observe.depth, refFor });
        merge(rendered.view);
        body = rendered.text;
      } else {
        const rendered = renderSnapshot(model, { mode: observe.mode ?? 'default', depth: observe.depth, refFor });
        view(rendered.view);
        body = rendered.text;
      }
    } else if (snapshot === 'full' || (snapshot === 'diff' && !base)) {
      body = full(snapshot === 'full' ? 'full' : 'default');
    } else if (snapshot === 'diff') {
      const diff = renderDiff(model, base.view, { from: base.snapshotId, to: snapshotId, refFor, isGone });
      if (diff.large) body = full('default');
      else { view(diff.view); body = diff.text; }
    }
    if (screenshot) result.screenshot = await this.#screenshot(p, model, snapshotId);
    if (state?.delivered) return null;
    // A script step's view goes to the script, not the agent: the agent's diff
    // base stays its own last view, so the run's final diff covers the run.
    if (!caller?.keepSignals) commit();
    const out = [...this.#drainSignals(p, caller, header), ...lines];
    if (header) out.push(renderHeader(model, { points: p.shot?.snapshotId === snapshotId }));
    else if (viewLine) out.push(renderHeader(model).split('\n')[1]);
    if (value !== undefined) out.push(`value ${clipText(JSON.stringify(value) ?? 'undefined', 4000)}`);
    if (body) out.push(body);
    return { ...result, ...(value === undefined ? {} : { value }), snapshotId, text: out.join('\n') };
  }
  // On request only: the image at CSS scale (image pixels = CSS pixels). It
  // grounds points only if the page did not move while it was taken.
  async #screenshot(p, model, snapshotId) {
    const root = await this.#rootFrame(p);
    const image = await this.#captureImage(p);
    const after = await p.driver.viewport(root);
    const checkpoint = model.frames.get(model.rootId).checkpoint;
    const { w, h } = model.viewport;
    p.shot = after?.documentId === checkpoint.documentId && after.w === w && after.h === h
      && after.x === checkpoint.x && after.y === checkpoint.y
      ? { snapshotId, image, documentId: checkpoint.documentId, w, h, x: checkpoint.x, y: checkpoint.y, generation: p.presentation.generation }
      : null;
    const size = image.getSize();
    const scaled = size.width === w && size.height === h ? image : image.resize({ width: w, height: h, quality: 'good' });
    return { mimeType: 'image/png', data: scaled.toPNG().toString('base64'), width: w, height: h };
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
  async #rootFrame(p) {
    const root = (await p.driver.refresh()).find(frame => !frame.parentId);
    if (!root) fail('STALE_FRAME', 'The root frame is not available; observe again');
    return root;
  }
  #scopeKey(p, ref) {
    const entry = this.#liveRef(p, ref);
    const key = `${entry.frameId}:${entry.documentId}:${entry.id}`;
    if (!p.model?.byKey.has(key)) fail('STALE_REF', `${ref} is not on the page now; observe again`);
    return key;
  }
  // A registry entry this tab may act on (C7): live, same tab, same generation.
  #liveRef(p, ref) {
    const entry = this.#refs.lookup(ref);
    if (!entry) fail('STALE_REF', `Unknown ref ${ref}; observe for current refs`);
    if (entry.tabId !== p.id) {
      const other = this.#pages.get(entry.tabId);
      if (other && other.owner === p.owner && !other.closed) fail('WRONG_TAB', `${ref} belongs to tab ${entry.tabId}`);
      if (other && other.owner === p.owner) fail('STALE_REF', `${ref} belonged to tab ${entry.tabId}, which is closed`);
      fail('STALE_REF', `Unknown ref ${ref}; observe for current refs`);
    }
    if (entry.state !== 'live' || entry.generation !== p.presentation.generation) {
      const reason = entry.generation !== p.presentation.generation || entry.state === 'retired'
        ? 'is from an earlier presentation (handoff, Stop, hide or show)'
        : entry.state === 'renamed' ? 'changed its role or name' : entry.state === 'replaced' ? 'belongs to a replaced document' : 'was removed';
      this.#staleRef(p, entry, reason);
    }
    return entry;
  }
  // No fallback to another node: same-role+name refs are a hint only.
  #staleRef(p, entry, reason) {
    const generation = p.presentation.generation;
    const now = (p.model?.items ?? []).filter(item => item.id !== undefined && item.role === entry.role && item.name === entry.name
      && !(item.frameId === entry.frameId && item.documentId === entry.documentId && item.id === entry.id))
      .slice(0, 3).map(item => this.#refs.ref({ tabId: p.id, frameId: item.frameId, documentId: item.documentId, id: item.id,
        role: item.role, name: item.name, generation }));
    fail('STALE_REF', `${entry.ref} ${entry.role}${entry.name ? ` ${quote(clipText(entry.name, 60))}` : ''} ${reason}`
      + `${now.length ? `; same role+name now: ${now.join(' ')} (verify before acting)` : '; observe again'}`);
  }
  #frameOf(p, ref) {
    const entry = this.#liveRef(p, ref);
    if (entry.role !== 'iframe') fail('INVALID_ARGUMENT', `${ref} is not an iframe ref`);
    const item = p.model?.byKey.get(`${entry.frameId}:${entry.documentId}:${entry.id}`);
    const frame = item?.childFrameId && p.driver.frames.get(item.childFrameId);
    if (!frame) fail('STALE_FRAME', `${ref} has no current frame document; observe again`);
    return frame;
  }
  async #targetEntry(p, target, caller, signal) {
    const model = await this.#perceive(p, caller, signal);
    const frameId = target.frame ? this.#frameOf(p, target.frame).id : undefined;
    let matches = model.items.filter(item => item.id !== undefined && ['i', 'c', 'f', 'l', 'm'].includes(item.kind)
      && matchesTarget({ role: item.role, name: item.name, frameId: item.frameId }, { ...target, frameId }));
    if (target.selector) {
      const selected = [];
      for (const item of matches) {
        const frame = p.driver.frames.get(item.frameId);
        if (!frame) continue;
        const objectId = await p.driver.resolveObject(frame, item.id, item.documentId);
        try {
          if (await p.driver.callOn(frame, objectId, 'function(selector){return this.matches(selector)}', [target.selector])) selected.push(item);
        } finally { await p.driver.release(frame, objectId); }
      }
      matches = selected;
    }
    const generation = p.presentation.generation;
    const refFor = item => this.#refs.ref({ tabId: p.id, frameId: item.frameId, documentId: item.documentId, id: item.id,
      role: item.role, name: item.name, generation });
    if (matches.length !== 1) {
      const shown = (matches.length ? matches : []).slice(0, 10);
      fail(matches.length ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
        matches.length ? `${matches.length} elements match; act on one ref` : 'No element matches; observe or use find',
        { candidates: shown.map(item => `${refFor(item)} ${item.role}${item.name ? ` ${quote(clipText(item.name, 60))}` : ''}`) });
    }
    return this.#refs.lookup(refFor(matches[0]));
  }
  // Validation before dispatch (C7): the ref's own live node (same document,
  // role and name), visibility, enabled state, a stable rect, a hit test at
  // the dispatch point and hit tests of its ancestor frame owners. Only the
  // target's frame chain is checked. Read-only except scrolling an out-of-view
  // target into view (preparation=scrolled).
  async #validate(p, args, caller, signal, onPreparation = () => {}) {
    const input = !['read', 'inspect'].includes(args.action);
    this.#owned(p.id, caller, signal, input);
    const entry = args.ref ? this.#liveRef(p, args.ref) : await this.#targetEntry(p, args.target, caller, signal);
    await p.driver.refresh();
    const frame = p.driver.frames.get(entry.frameId);
    if (!frame) this.#staleRef(p, entry, 'is in a frame that is gone');
    // Paint holding is waited out first, so the hit tests below are the last
    // reads before dispatch (H1).
    if (input) await p.driver.inputReady(frame, signal);
    const described = await p.driver.describe(frame, entry.id, entry.documentId);
    if (described?.stale || described?.missing) {
      this.#refs.retireDocument(p.id, entry.frameId, null);
      this.#staleRef(p, entry, 'belongs to a replaced document');
    }
    if (!described?.described) { this.#refs.gone(p.id, entry.frameId, entry.documentId, [entry.id]); this.#staleRef(p, entry, 'was removed'); }
    if (described.described.role !== entry.role || described.described.name !== entry.name) this.#staleRef(p, entry, 'changed its role or name');
    const objectId = await p.driver.resolveObject(frame, entry.id, entry.documentId);
    if (!input) return { frame, entry, ref: entry.ref, objectId };
    try {
      // Decided live, not from the last model: the page may have scrolled.
      // A child frame's own viewport may itself be scrolled out of the root
      // view, so an iframe target the model saw offscreen is prepared too.
      const item = p.model?.byKey.get(`${entry.frameId}:${entry.documentId}:${entry.id}`);
      const now = await p.driver.inView(frame, entry.id, entry.documentId);
      if (!now.inView || (frame.parentId && !item?.inView)) {
        await p.driver.prepare(frame, objectId, () => onPreparation('scrolled'),
          now.proxied ? { id: entry.id, documentId: entry.documentId } : null);
      }
      this.#owned(p.id, caller, signal, true);
      const point = await p.driver.pointFor(frame, entry.id, entry.documentId, signal);
      this.#owned(p.id, caller, signal, true);
      return { frame, entry, ref: entry.ref, objectId, point };
    } catch (error) {
      await p.driver.release(frame, objectId).catch(() => {});
      throw error;
    }
  }
  // A point acts only on the unchanged screenshot tile it was read from (D18).
  async #validatePoint(p, args, caller, signal) {
    this.#owned(p.id, caller, signal, true);
    const shot = p.shot;
    const { x, y, snapshotId } = args.point;
    if (!shot) fail('POINTS_UNAVAILABLE', 'Points need the latest snapshot taken with screenshot:true (with points in its view line)');
    if (snapshotId !== shot.snapshotId) fail('STALE_COORDINATES', `Points come only from the tab's latest screenshot (${shot.snapshotId})`);
    if (shot.generation !== p.presentation.generation) fail('STALE_COORDINATES', 'The presentation changed since the screenshot');
    if (!(x >= 0 && y >= 0 && x < shot.w && y < shot.h)) fail('INVALID_COORDINATES', 'Coordinates are outside the screenshot viewport');
    const root = await this.#rootFrame(p);
    await p.driver.inputReady(root, signal);
    const now = await p.driver.viewport(root);
    if (now?.documentId !== shot.documentId || now.w !== shot.w || now.h !== shot.h || now.x !== shot.x || now.y !== shot.y) {
      fail('STALE_COORDINATES', 'The document, viewport or scroll changed since the screenshot');
    }
    const image = await this.#captureImage(p);
    const size = shot.image.getSize(), current = image.getSize();
    const sx = size.width / shot.w, sy = size.height / shot.h;
    const left = Math.max(0, Math.min(shot.w - TILE, x - TILE / 2)), top = Math.max(0, Math.min(shot.h - TILE, y - TILE / 2));
    const tile = { x: Math.floor(left * sx), y: Math.floor(top * sy), width: Math.ceil(TILE * sx), height: Math.ceil(TILE * sy) };
    if (current.width !== size.width || current.height !== size.height
      || !shot.image.crop(tile).toBitmap().equals(image.crop(tile).toBitmap())) {
      fail('STALE_COORDINATES', 'The pixels around the point changed since the screenshot');
    }
    // An unchanged tile can hide a transparent frame over the point: hit-test
    // the point from the root through every frame (M2).
    const chain = await p.driver.hitChain({ x, y });
    const last = chain.hops.at(-1);
    // The hit element, the host of a hit iframe, and the host of the frame it is in.
    const where = hop => `${hop.role}${hop.name ? ` ${quote(hop.name)}` : ''}${hop.src ? ` from ${quote(hostOf(hop.src))}` : ''}`
      + ` in ${quote(hostOf(hop.document.url))}`;
    if (chain.unverified) fail('POINT_UNVERIFIED', `The point cannot be verified through its frames: ${chain.unverified}`);
    if (!last || chain.opacity < MIN_POINT_OPACITY || !last.visible) {
      fail('POINT_HIDDEN_TARGET', `The point hits ${last ? where(last) : 'nothing'}, which is transparent or hidden; act on a ref instead`);
    }
    this.#owned(p.id, caller, signal, true);
    return { frame: root, point: { x, y } };
  }

  async #perform(p, target, args, caller, signal, markSent, state) {
    const { frame, entry, point, objectId } = target;
    // The ownership check, the pressed mark and markSent run inside the
    // guarded command itself, right before it is sent (L1): a Stop in
    // between leaves nothing marked sent and nothing to release. A press or
    // key also takes the one credit its trusted event may claim (M5).
    const dispatch = async (method, params, sessionId, onDispatch = () => {}) => {
      const expected = method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' ? 'pointerdown'
        : method === 'Input.dispatchKeyEvent' && ['rawKeyDown', 'keyDown'].includes(params.type) ? 'keydown' : null;
      let credit = null;
      try {
        return await p.driver.send(method, params, sessionId, undefined, () => {
          this.#owned(p.id, caller, signal, true);
          onDispatch();
          markSent();
          if (expected) credit = p.driver.expectInput(expected);
        });
      } finally { if (credit) p.driver.settleCredit(credit); }
    };
    // One-shot guard in the target's walker world: did the trusted event land
    // on the validated element (H1)? Read-only until the dispatch. Text and
    // keys also arm every other frame of the page, where a stray event is
    // cancelled in the same turn (M2): focus can move between frames.
    const guarded = async (type, send) => {
      if (!entry) return send();
      const others = type === 'pointerdown' ? []
        : [...p.driver.frames.values()].filter(other => other.id !== frame.id && other.contextId !== undefined);
      const armed = await p.driver.armGuard(frame, entry.id, type, entry.documentId);
      if (!armed?.armed) fail('STALE_REF', `${entry.ref} was replaced before dispatch`);
      await Promise.all(others.map(other => p.driver.armGuard(other, 0, type).catch(() => null)));
      let outcome;
      try { await send(); } finally {
        outcome = await p.driver.disarmGuard(frame).catch(() => null);
        const strays = await Promise.all(others.map(other => p.driver.disarmGuard(other).catch(() => null)));
        if (outcome && strays.some(stray => stray?.fired)) outcome = { ...outcome, inside: false };
      }
      return outcome;
    };
    const missed = outcome => !!entry && !(outcome?.fired && outcome.inside);
    if (args.action === 'click') {
      let pressed = false;
      let mismatch = false;
      try {
        const outcome = await guarded('pointerdown', () => dispatch('Input.dispatchMouseEvent',
          { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, undefined, () => { pressed = true; }));
        mismatch = missed(outcome);
      } finally {
        // Releasing an already pressed button is cleanup, not fresh input. A
        // press that landed elsewhere is released far outside the viewport,
        // so no click forms on what it hit.
        if (pressed) {
          const at = mismatch ? { x: -100000, y: -100000 } : point;
          await p.driver.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 });
        }
      }
      if (mismatch) state.code = 'TARGET_MISMATCH';
      return;
    }
    if (args.action === 'scroll') {
      // Scroll the verified DOM's actual overflow container exactly once. A
      // synthetic wheel targets whatever is under the point and its ACK races
      // layout, so it cannot prove which container scrolled.
      const scrollFrame = frame;
      const start = entry
        ? `(()=>{const s=globalThis.__independentState;return s&&s.documentId===${JSON.stringify(entry.documentId)}?s.resolve(${Number(entry.id)}):null})()`
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
        // Marked sent inside the guard, right before the command goes out (L1).
        await p.driver.callOn(scrollFrame, scroller.objectId, `function(x,y){
          if(!this.isConnected)throw new Error('Scroller replaced');
          this.scrollBy({left:x,top:y,behavior:'instant'});
          return {x:this.scrollLeft,y:this.scrollTop};
        }`, [args.deltaX, args.deltaY], true, markSent);
      } finally { await p.driver.release(scrollFrame, scroller.objectId); }
      return;
    }
    {
      const info = await p.driver.callOn(frame, objectId, `function() {
        return {connected:this.isConnected,disabled:!!this.disabled,readOnly:!!this.readOnly,
          tag:this.tagName,type:this.type,multiple:!!this.multiple,editable:this.isContentEditable};
      }`);
      if (!info.connected || info.disabled || info.readOnly) fail('NOT_ACTIONABLE', 'Target is replaced, disabled or readonly');
      if (args.action === 'upload') {
        if (info.tag !== 'INPUT' || info.type !== 'file' || (!info.multiple && args.files.length !== 1)) fail('INVALID_UPLOAD_TARGET', 'Upload requires a matching explicit file input');
        const files = await this.#validateFiles(args.files, info.multiple);
        this.#owned(p.id, caller, signal, true);
        await dispatch('DOM.setFileInputFiles', { files, objectId }, frame.sessionId);
      } else if (args.action === 'select') {
        if (info.tag !== 'SELECT' || (!info.multiple && args.values.length !== 1)) fail('INVALID_SELECT_TARGET', 'Target must be a select with matching multiplicity');
        const valid = await p.driver.callOn(frame, objectId, 'function(values){return values.every(v=>Array.from(this.options).some(o=>o.value===v&&!o.disabled))}', [args.values]);
        if (!valid) fail('INVALID_OPTION', 'An exact enabled option is missing');
        this.#owned(p.id, caller, signal, true);
        await p.driver.callOn(frame, objectId, `function(values){
          if(!this.isConnected||this.disabled)throw new Error('changed');
          for(const option of this.options)option.selected=values.includes(option.value);
          this.dispatchEvent(new Event('input',{bubbles:true}));
          this.dispatchEvent(new Event('change',{bubbles:true}));
        }`, [args.values], true, markSent);
      } else {
        if (['fill', 'type'].includes(args.action) && !info.editable
          && !(info.tag === 'TEXTAREA' || (info.tag === 'INPUT' && !['file', 'button', 'submit', 'reset', 'checkbox', 'radio', 'hidden'].includes(info.type)))) {
          fail('INVALID_TEXT_TARGET', 'Target is not an editable text input');
        }
        await dispatch('DOM.focus', { objectId }, frame.sessionId);
        // Keys go to the focused element, so BEFORE each step the target must
        // still be the live, enabled, focused element of the same document,
        // in the frame that has focus (activeElement stays set in a frame
        // that lost focus). Never after the last one: Tab moves focus, Enter
        // may navigate or remove the field, Escape may close a widget; that is
        // the effect.
        const ensureEditable = async () => {
          await p.driver.refresh();
          if (p.driver.frames.get(frame.id)?.documentId !== frame.documentId) fail('STALE_FRAME', 'Document changed after focus');
          const stillLive = await p.driver.callOn(frame, objectId, 'function(){return this.isConnected&&!this.disabled&&!this.readOnly'
            + '&&this.getRootNode().activeElement===this&&this.ownerDocument.hasFocus()}');
          if (!stillLive) fail('TARGET_CHANGED', 'Target changed or lost focus after focus; no text was replayed');
          this.#owned(p.id, caller, signal, true);
        };
        // Each step is guarded in the same turn: a keydown or beforeinput that
        // is not on the validated element is cancelled before it acts, and
        // nothing after it is sent. Returns whether the step landed.
        // A key with a character (Enter) goes down as keyDown, so Chromium
        // also sends that character as a real keyboard does: forms submit and
        // a textarea breaks the line, and a keydown the page cancels
        // suppresses it. Every other key is a rawKeyDown.
        const key = async ({ text, ...data }) => {
          await ensureEditable();
          let pressed = false;
          const down = text ? { type: 'keyDown', ...data, text, unmodifiedText: text } : { type: 'rawKeyDown', ...data };
          try {
            const outcome = await guarded('keydown', () => dispatch('Input.dispatchKeyEvent', down,
              undefined, () => { pressed = true; }));
            if (missed(outcome)) state.code = 'TARGET_MISMATCH';
          } finally {
            if (pressed) await p.driver.send('Input.dispatchKeyEvent', { type: 'keyUp', ...data });
          }
          return state.code !== 'TARGET_MISMATCH';
        };
        const insert = async () => {
          await ensureEditable();
          const outcome = await guarded('beforeinput', () => dispatch('Input.insertText', { text: args.text }));
          if (missed(outcome)) state.code = 'TARGET_MISMATCH';
        };
        if (args.action === 'fill') {
          if (await key({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }) && await key(keys.Backspace) && args.text) await insert();
        } else if (args.action === 'type') {
          if (args.text) await insert();
        } else if (args.action === 'press') await key(keys[args.key]);
      }
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
      this.#queue.abort(p.id, new BrowserHostError('CONNECTION_CLOSED', 'Browser connection closed'));
      if (!p.frame.isDestroyed()) p.frame.destroy();
    }
    this.dialogs.close();
  }
}
