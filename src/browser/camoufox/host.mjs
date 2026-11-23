// Camoufox-backed BrowserHost (pure Node.js, zero Electron dependency).
// Preserves the full 32-action browse contract, token-saving perception
// pipeline (walker, composeModel, persistent e<n> refs, diffs, find, budgets),
// complete Juggler + WebSocket + Firefox RDP network/DevTools debugging with
// privacy windows, isolated multi-sessions via Firefox BrowserContexts,
// native alert/confirm/prompt dialogs, standard vs elevated automation mode,
// Win32 Control Bar handoff/Stop/Revert, and hardened Camoufox `run` sandboxes.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { FenceQueue } from '../queue.mjs';
import { bounded, pause } from '../../shared/async.mjs';
import { BrowserPolicy } from '../policy.mjs';
import { BrowserRequests } from '../requests.mjs';
import { DEVTOOLS_LIMITS, DevToolsRecorder, PrivacyWindows, responseBody } from '../devtools.mjs';
import { rankBrowserSemanticMatch } from '../perception/match.mjs';
import { composeModel } from '../perception/model.mjs';
import { RefRegistry } from '../perception/refs.mjs';
import { displayURL, quote, renderDiff, renderFind, renderHeader, renderSnapshot, renderText } from '../perception/render.mjs';
import { armNavigation, settle } from '../settle.mjs';
import { CONTROL_SIGNALS, formatSignals, SignalQueue } from '../signals.mjs';
import { runScript } from '../runner/run.mjs';
import {
  BrowserHostError, devtoolsActions, fail, freshId, inputActions, keys, matchesTarget, pageURL, RUN_BOUNDS, validateArgs,
} from '../../shared/contract.mjs';
import { CamoufoxProcess } from './juggler.mjs';
import { FirefoxRdpClient } from './rdp.mjs';
import { CamoufoxFrameDriver } from './driver.mjs';
import { CamoufoxPresentation, ChromeToolbarClient, ControlBarClient } from './presentation.mjs';
import { createCamoufoxRunnerSandboxFactory } from './runner-sandbox.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const hostOf = url => { try { return new URL(url).host || String(url).slice(0, 40); } catch { return ''; } };
const clipText = (value, max) => { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const WAIT_POLL_MS = 100;
const SHORT_SETTLE = new Set(['scroll', 'evaluate']);
const MIN_POINT_OPACITY = 0.1;
const TILE = 32;
const MAX_SESSION_TABS = 32;
const MAX_TEMPORARY_SESSIONS = 16;
const RETURN_TIMEOUT_MS = 25000;
const NATIVE_REQUEST_ACK_GRACE_MS = 250;
const L = DEVTOOLS_LIMITS;

// Minimal zero-dependency PNG decoder (8-bit RGB/RGBA non-interlaced) used to
// compare a 32×32 pixel tile around a screenshot coordinate (D18 parity).
function decodePngPixels(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    if (type === 'IHDR' && len >= 13) {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      if (buf[dataStart + 12] !== 0) return null; // interlaced unsupported
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!width || !height || bitDepth !== 8 || !bpp || !idat.length) return null;
  let raw;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.allocUnsafe(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[dst + x - bpp] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[dst - stride + x - bpp] : 0;
      const v = raw[src + x];
      pixels[dst + x] = filter === 0 ? v : filter === 1 ? (v + a) & 0xff
        : filter === 2 ? (v + b) & 0xff : filter === 3 ? (v + ((a + b) >> 1)) & 0xff
          : (v + paeth(a, b, c)) & 0xff;
    }
  }
  return { width, height, bpp, pixels };
}

function pngTilesEqual(aBuf, bBuf, w, h, x, y) {
  const a = decodePngPixels(aBuf), b = decodePngPixels(bBuf);
  if (!a || !b) return aBuf.equals(bBuf);
  if (a.width !== b.width || a.height !== b.height || a.bpp !== b.bpp) return false;
  const sx = a.width / w, sy = a.height / h;
  const left = Math.max(0, Math.min(w - TILE, x - TILE / 2));
  const top = Math.max(0, Math.min(h - TILE, y - TILE / 2));
  const x0 = Math.max(0, Math.floor(left * sx));
  const y0 = Math.max(0, Math.floor(top * sy));
  const x1 = Math.min(a.width, x0 + Math.ceil(TILE * sx));
  const y1 = Math.min(a.height, y0 + Math.ceil(TILE * sy));
  const stride = a.width * a.bpp;
  for (let row = y0; row < y1; row++) {
    const start = row * stride + x0 * a.bpp;
    const end = row * stride + x1 * a.bpp;
    if (!a.pixels.subarray(start, end).equals(b.pixels.subarray(start, end))) return false;
  }
  return true;
}

function mapPermissionKind(kind) {
  return kind === 'notifications' ? 'notifications' : kind === 'geolocation' ? 'geolocation' : null;
}

export class CamoufoxHost {
  #pages = new Map();
  #bySessionId = new Map(); // juggler sessionId → page
  #byTargetId = new Map();  // juggler targetId → page
  #profiles = new Map();    // callerSessionId → default profile
  #sessions = new Map();    // ctx<n> → profile
  #byBrowserContext = new Map(); // juggler browserContextId → profile
  #sessionSequence = 0;
  #queue = new FenceQueue();
  #closed = false;
  #revoking = false;
  #revokeFlight;
  #automationMode = 'standard';
  #configuredAutomationMode = 'standard';
  #automationModeSource = 'default';
  #refs = new RefRegistry();
  #signals = new SignalQueue();
  #tabSequence = 0;
  #snapshotSequence = 0;
  #proc = null;
  #rdp = null;
  #startFlight = null;
  #chromeToolbar = null;
  #controlBar = null;
  #useFallbackBar = false;
  #downloadsByUuid = new Map();
  #permissionGrants = new Map(); // `${origin}\0${kind}` → 'allow' | 'deny'
  #activeTabId = null;
  #pendingAttach = null;
  #earlyMessages = new Map(); // sessionId → Array<{ method, params }>
  #profileLockPath = null;
  #profilePersistence = 'ephemeral';

  constructor({
    dataDir, persistentProfileDir = null, executablePath, camoufoxVersion = '158.0.1-beta.41', controlBarPath = null,
    onRevokeConnection, policy = new BrowserPolicy(),
    automationMode = policy.automationMode ?? 'standard',
    automationModeSource = policy.explicitAutomationMode ? 'policy' : 'default',
    headless = false, enableRdp = true, locale = 'ko-KR',
    createProcess = null, createRdp = null, createRunnerSandbox = null,
  }) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof onRevokeConnection !== 'function') {
      throw new TypeError('Absolute dataDir and onRevokeConnection are required');
    }
    if (automationMode !== 'standard' && automationMode !== 'elevated') {
      throw new TypeError('automationMode must be standard or elevated');
    }
    this.dataDir = dataDir;
    this.persistentProfileDir = typeof persistentProfileDir === 'string' && path.isAbsolute(persistentProfileDir)
      ? persistentProfileDir : null;
    this.#profilePersistence = this.persistentProfileDir ? 'persistent-pending' : 'ephemeral';
    this.executablePath = executablePath;
    this.camoufoxVersion = camoufoxVersion;
    this.headless = headless;
    this.enableRdp = enableRdp;
    this.locale = locale;
    this.connectionId = freshId();
    this.onRevokeConnection = onRevokeConnection;
    this.policy = policy;
    this.#automationMode = automationMode;
    this.#configuredAutomationMode = automationMode;
    this.#automationModeSource = automationModeSource;
    this.nativeRequests = new BrowserRequests();
    this.createProcess = createProcess;
    this.createRdp = createRdp;
    this.createRunnerSandbox = createRunnerSandbox ?? (executablePath ? createCamoufoxRunnerSandboxFactory({ executablePath }) : null);
    this.#chromeToolbar = new ChromeToolbarClient({
      getRdp: () => this.#rdp,
      headless: headless || !enableRdp,
      locale,
    });
    this.#chromeToolbar.on('action', (action, tabId) => this.#onControlBarAction(action, tabId));
    this.#chromeToolbar.on('fallback', (_err, lastState) => {
      this.#useFallbackBar = true;
      if (lastState) this.#controlBar.sync(lastState);
    });
    this.#controlBar = new ControlBarClient({ executablePath: controlBarPath, headless, locale });
    this.#controlBar.on('action', (action, tabId) => this.#onControlBarAction(action, tabId));
    this.#useFallbackBar = !enableRdp;
  }

  status() {
    const elevated = this.#automationMode === 'elevated';
    const rdpActive = !!this.#rdp?.connected;
    return {
      state: this.#closed ? 'closed' : this.#revoking ? 'terminating-revocation' : 'connected',
      engine: 'camoufox',
      runtime: `Camoufox ${this.camoufoxVersion}`,
      connectionId: this.connectionId,
      automationMode: this.#automationMode,
      profilePersistence: this.#profilePersistence,
      tabCount: [...this.#pages.values()].filter(p => !p.closed).length,
      pausedCount: [...this.#pages.values()].filter(p => !p.closed && p.paused).length,
      capabilities: {
        engine: 'camoufox',
        fallbackEngine: 'electron (set WB_ENGINE=electron or browser-policy.json engine:"electron" for WebHID/WebUSB)',
        automation: {
          mode: this.#automationMode,
          configuredMode: this.#configuredAutomationMode,
          source: this.#automationModeSource,
          scope: elevated
            ? 'connection-wide opt-in: login and sensitive fill/type/click/observe permitted; user-revocable via Control Bar'
            : 'standard safety boundary: human handles sign-in and secrets; trusted page input pauses automation',
          shieldAutoHandoff: false,
          trustedInputGuard: true,
          controlBar: true,
          sensitiveInputAllowed: elevated,
          sensitiveValuesMasked: true,
          pageCodeBlockedBesideSecrets: true,
          manualHandoffRequiredFor: ['OS identity', 'CAPTCHA', 'human verification'],
          revocableByUser: true,
        },
        devtools: {
          protocol: this.enableRdp ? 'juggler+firefox-rdp' : 'juggler',
          rdpConnected: rdpActive,
          network: ['http', 'https', 'redirects', 'headers', 'request-body', 'response-body', 'timing', 'tls', 'cache', 'service-worker', 'websocket', ...(this.enableRdp ? ['worker-rdp'] : [])],
          inspect: this.enableRdp ? ['computed-style', 'matched-css-rules', 'event-listeners'] : ['computed-style'],
          consoleExpression: this.enableRdp ? 'firefox-rdp-eager' : 'unavailable',
        },
        sessions: { temporary: true, maxCreatedPerCaller: MAX_TEMPORARY_SESSIONS, defaultClosable: false },
        nativeRequests: ['javascript-dialog', 'file-picker', 'notifications', 'geolocation'],
        javascriptDialogs: {
          supported: ['alert', 'confirm', 'prompt'],
          unsupported: {},
          integration: 'Camoufox Juggler native Page.dialogOpened/handleDialog',
        },
        filePickers: {
          supported: ['html-file-input'],
          unsupported: ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'],
        },
        unsupported: ['hid', 'usb', 'display-capture', 'serial', 'bluetooth'],
        mandatoryHuman: elevated
          ? ['OS identity', 'CAPTCHA', 'human Resume in the Control Bar after Stop/handoff']
          : ['OS identity', 'passwords', 'CAPTCHA', '2FA', 'human Resume in the Control Bar after Stop/handoff'],
        delegation: this.policy.describe(),
      },
    };
  }

  static #pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
  }

  async #acquireProfileDir() {
    const connProfilesRoot = path.join(this.dataDir, 'profiles');
    await mkdir(connProfilesRoot, { recursive: true });
    if (this.persistentProfileDir) {
      const lockPath = `${this.persistentProfileDir}.lock`;
      await mkdir(path.dirname(this.persistentProfileDir), { recursive: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fh = await open(lockPath, 'wx');
          try {
            await fh.writeFile(JSON.stringify({ pid: process.pid, connectionId: this.connectionId, acquiredAt: Date.now() }));
          } finally {
            await fh.close();
          }
          await mkdir(this.persistentProfileDir, { recursive: true });
          this.#profileLockPath = lockPath;
          this.#profilePersistence = 'persistent';
          await writeFile(path.join(connProfilesRoot, 'camoufox.persistent.json'),
            JSON.stringify({ profileDir: this.persistentProfileDir, persistent: true }), 'utf8').catch(() => {});
          return this.persistentProfileDir;
        } catch (error) {
          if (error?.code !== 'EEXIST') break;
          let ownerPid = 0;
          try { ownerPid = JSON.parse(await readFile(lockPath, 'utf8'))?.pid ?? 0; } catch { ownerPid = 0; }
          if (ownerPid === 0) {
            const info = await stat(lockPath).catch(() => null);
            if (info && Date.now() - info.mtimeMs < 2000) {
              await pause(50);
              try { ownerPid = JSON.parse(await readFile(lockPath, 'utf8'))?.pid ?? 0; } catch { ownerPid = 0; }
              if (ownerPid === 0) {
                this.#profilePersistence = 'ephemeral-busy';
                break;
              }
            }
          }
          if (CamoufoxHost.#pidAlive(ownerPid)) {
            this.#profilePersistence = 'ephemeral-busy';
            break;
          }
          await unlink(lockPath).catch(() => {});
        }
      }
    }
    const fallbackDir = path.join(connProfilesRoot, 'camoufox');
    await mkdir(fallbackDir, { recursive: true });
    if (this.#profilePersistence !== 'ephemeral-busy') this.#profilePersistence = 'ephemeral';
    return fallbackDir;
  }

  async #releaseProfileLock() {
    if (!this.#profileLockPath) return;
    const lockPath = this.#profileLockPath;
    this.#profileLockPath = null;
    await unlink(lockPath).catch(() => {});
  }

  async #ensureBrowser() {
    if (this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Browser connection is closed or terminating revocation');
    if (this.#proc && !this.#proc.closed) return this.#proc;
    if (this.#startFlight) return this.#startFlight;
    this.#startFlight = (async () => {
      const profileDir = await this.#acquireProfileDir();
      const proc = this.createProcess
        ? await this.createProcess({ profileDir, enableRdp: this.enableRdp, headless: this.headless, locale: this.locale })
        : new CamoufoxProcess({
          executablePath: this.executablePath, profileDir, headless: this.headless,
          enableRdp: this.enableRdp, locale: this.locale,
        });
      proc.on('message', (method, params, sessionId) => this.#onJugglerMessage(method, params, sessionId));
      proc.on('close', () => {
        for (const p of this.#pages.values()) {
          if (!p.closed) { p.connected = false; this.#pause(p, 'presentation-lost'); }
        }
      });
      try {
        await proc.start();
      } catch (error) {
        await this.#releaseProfileLock();
        throw error;
      }
      this.#proc = proc;
      if (this.enableRdp && proc.rdpPort) {
        this.#rdp = this.createRdp ? this.createRdp(proc.rdpPort) : new FirefoxRdpClient(proc.rdpPort);
      }
      return proc;
    })().finally(() => { this.#startFlight = null; });
    return this.#startFlight;
  }

  #syncControlBar() {
    if (this.#closed) return;
    const tabs = [...this.#pages.values()]
      .filter(p => !p.closed)
      .map(p => p.presentation.barEntry({
        title: p.currentTitle,
        url: p.currentUrl,
        browsingContextId: this.#rdp?.browsingContextId?.(p.id) ?? null,
      }));
    const browserPid = this.#proc?.pid ?? 0;
    const payload = !tabs.length
      ? { elevated: this.#automationMode === 'elevated', activeId: '', tabs: [], visible: false, browserPid }
      : (() => {
        if (!this.#activeTabId || !this.#pages.get(this.#activeTabId) || this.#pages.get(this.#activeTabId).closed) {
          this.#activeTabId = tabs.at(-1).id;
        }
        return {
          elevated: this.#automationMode === 'elevated',
          activeId: this.#activeTabId,
          tabs,
          visible: true,
          browserPid,
        };
      })();
    if (!this.#useFallbackBar && this.#chromeToolbar.active) {
      this.#chromeToolbar.sync(payload);
    } else {
      this.#controlBar.sync(payload);
    }
  }

  #flashControlBar(tabId = '') {
    if (!this.#useFallbackBar && this.#chromeToolbar.active) {
      this.#chromeToolbar.flash(tabId);
    } else {
      this.#controlBar.flash();
    }
  }

  // Exposed for live/unit tests that simulate a person clicking a Control Bar button.
  triggerControlBarAction(action, tabId = null) {
    this.#onControlBarAction(action, tabId);
  }

  #onControlBarAction(action, tabId) {
    if (this.#closed || this.#revoking) return;
    if (action === 'revoke') { this.#revoke().catch(() => {}); return; }
    if (action === 'revert-standard') { this.#revertToStandard(); return; }
    if (action === 'resume-all') {
      for (const q of this.#pages.values()) {
        if (!q.closed && (q.presentation.mode !== 'automation' || q.paused)) {
          this.#resume(q).catch(() => {});
        }
      }
      return;
    }
    const p = (tabId && this.#pages.get(tabId)) || (this.#activeTabId && this.#pages.get(this.#activeTabId));
    if (!p || p.closed) return;
    if (action === 'stop-automation') {
      this.#pause(p, 'explicit-stop');
      p.presentation.pauseInAutomation('explicit-stop');
      this.#signal(p, { kind: 'state', state: 'stopped' });
    } else if (action === 'take-control') {
      this.#handoff(p, 'human-handoff', 'human').catch(() => {});
    } else if (action === 'resume') {
      this.#resume(p).catch(() => {});
    }
  }

  #revertToStandard() {
    if (this.#closed || this.#revoking || this.#automationMode === 'standard') return;
    this.#automationMode = 'standard';
    this.#automationModeSource = 'revoked-by-user';
    for (const q of this.#pages.values()) {
      if (q.closed) continue;
      q.presentation.refresh();
      this.#signal(q, { kind: 'state', state: 'automation mode reverted to standard by person' });
    }
    this.#syncControlBar();
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
    if (!p || p.closed) fail('CLOSED_TAB', 'Unknown or closed tab');
    if (p.owner !== caller.sessionId) fail('FOREIGN_TAB', 'Tab is owned by another session');
    if (p.profile.state !== 'open') fail('CLOSED_SESSION', 'Browser session is closing or closed');
    if (input && p.paused) fail('AUTOMATION_PAUSED', `Automation paused: ${p.paused}; only the person can resume it from the Control Bar`, { paused: p.paused });
    if (input && !p.visible) fail('PAGE_HIDDEN', 'Page is hidden; show and observe before input');
    if (input && !p.connected && !allowDisconnected) fail('DEBUGGER_DISCONNECTED', 'Browser disconnected; observe or explicitly navigate before new input');
    if (input && !dialogCleanup) p.driver.assertNoDialogCleanup();
    if (input) p.presentation.assertAutomation(p.actorGeneration ?? p.presentation.generation);
    return p;
  }

  #signal(p, event) {
    if (p.closed) return;
    if (p.presentation.mode !== 'automation' && !CONTROL_SIGNALS.has(event.kind)) return;
    this.#signals.push(p.owner, { tabId: p.id, ...event });
  }

  #devtoolsMode(p) {
    p.profile.devtoolsPrivacy.update();
    for (const q of this.#pages.values()) {
      if (!q.closed && q.profile === p.profile) q.devtools.boundary();
    }
    const allow = p.presentation.mode === 'automation';
    if (this.#rdp?.connected) this.#rdp.setWatching(p.id, allow).catch(() => {});
  }

  #beginPrivate(p) {
    if (p.privateSince === null) p.privateSince = Date.now();
    this.#signals.purge(p.owner, p.id);
    this.nativeRequests.withdrawPage(p);
  }

  #invalidate(p, reason) {
    if (reason === 'handoff-draining') this.#beginPrivate(p);
    this.#devtoolsMode(p);
    if (['Page.frameNavigated', 'Page.frameDetached', 'navigation', 'closed'].includes(reason)) {
      this.nativeRequests.withdrawPage(p);
    }
  }

  #pause(p, reason) {
    if (p.closed) return;
    p.paused = reason;
    this.#invalidate(p, reason);
    this.#syncControlBar();
  }

  #ownerPages(owner) { return [...this.#pages.values()].filter(p => !p.closed && p.owner === owner); }

  #assertSessionMutationAllowed(owner, targetProfile = null) {
    const pages = targetProfile ? this.#ownerPages(owner).filter(p => p.profile === targetProfile) : this.#ownerPages(owner);
    const blocked = pages.find(p => p.paused || p.presentation.mode !== 'automation');
    if (blocked) {
      fail('AUTOMATION_PAUSED', `Cannot change browser sessions while ${blocked.id} is paused or under human control (${blocked.paused ?? blocked.presentation.mode})`);
    }
  }

  async #newProfile(owner, { name, temporary }) {
    const proc = await this.#ensureBrowser();
    if (temporary) {
      const created = [...this.#sessions.values()].filter(s => s.owner === owner && s.temporary).length;
      if (created >= MAX_TEMPORARY_SESSIONS) fail('SESSION_LIMIT', `At most ${MAX_TEMPORARY_SESSIONS} temporary browser sessions may be created per caller`);
    }
    const id = `ctx${++this.#sessionSequence}`;
    const downloadDir = path.join(this.dataDir, 'downloads', hash(temporary ? `${owner}\0${id}` : owner));
    await mkdir(downloadDir, { recursive: true });
    let browserContextId = undefined;
    if (temporary) {
      const created = await proc.send('Browser.createBrowserContext', { removeOnDetach: true });
      browserContextId = created.browserContextId;
    }
    await proc.send('Browser.setDownloadOptions', {
      ...(browserContextId ? { browserContextId } : {}),
      downloadOptions: { behavior: 'saveToDisk', downloadsDir: downloadDir },
    }).catch(() => {});
    const profile = {
      id, owner, name: name || (temporary ? `Session ${id}` : 'Default'), temporary, isDefault: !temporary,
      state: 'open', browserContextId, downloadDir, downloads: [],
      devtoolsPrivacy: new PrivacyWindows(() => this.#ownerPages(owner).filter(p => p.profile === profile)
        .every(p => p.presentation.mode === 'automation')),
    };
    this.#sessions.set(id, profile);
    if (browserContextId) this.#byBrowserContext.set(browserContextId, profile);
    return profile;
  }

  async #defaultProfile(owner) {
    let profile = this.#profiles.get(owner);
    if (!profile) {
      profile = await this.#newProfile(owner, { name: 'Default', temporary: false });
      this.#profiles.set(owner, profile);
    }
    return profile;
  }

  async #selectedSession(owner, sessionId) {
    if (!sessionId) return this.#defaultProfile(owner);
    const profile = this.#sessions.get(sessionId);
    if (!profile) fail('CLOSED_SESSION', `Unknown browser session ${sessionId}`);
    if (profile.owner !== owner) fail('FOREIGN_SESSION', `Browser session ${sessionId} belongs to another caller`);
    if (profile.state !== 'open') fail('CLOSED_SESSION', `Browser session ${sessionId} is ${profile.state}`);
    return profile;
  }

  #sessionInfo(profile) {
    return {
      sessionId: profile.id, name: profile.name, temporary: profile.temporary,
      isolated: true, isDefault: profile.isDefault, state: profile.state,
      tabCount: [...this.#pages.values()].filter(p => !p.closed && p.profile === profile).length,
    };
  }

  #onJugglerMessage(method, params, sessionId) {
    if (method === 'Browser.attachedToTarget') {
      const info = params.targetInfo ?? {};
      if (this.#bySessionId.has(params.sessionId)) return;
      const opener = info.openerId ? this.#byTargetId.get(info.openerId) : null;
      if (opener && !opener.closed) {
        const popup = this.#registerPage({
          owner: opener.owner, profile: opener.profile,
          sessionId: params.sessionId, targetId: info.targetId,
          actor: opener.actor,
        });
        if (opener.presentation.mode !== 'automation' || opener.paused) {
          popup.paused = opener.paused ?? 'inherited-native-handoff';
          popup.presentation.beginDrain('inherited-native-handoff');
          popup.presentation.enterNative('inherited-native-handoff');
          this.#devtoolsMode(popup);
        } else {
          this.#signal(opener, { kind: 'popup', popupTabId: popup.id, title: '', url: '' });
          opener.settleInterrupt?.('popup');
        }
        popup.driver.start().catch(() => {});
        return;
      }
      this.#pendingAttach?.(params);
      return;
    }
    if (method === 'Browser.detachedFromTarget') {
      const p = this.#bySessionId.get(params.sessionId) ?? this.#byTargetId.get(params.targetId);
      if (p && !p.closed) this.#closePageRecord(p);
      return;
    }
    if (method === 'Browser.downloadCreated') {
      const p = this.#byTargetId.get(params.pageTargetId);
      if (!p || p.closed) return;
      const isPrivate = p.presentation.mode !== 'automation';
      const safeName = path.basename(String(params.suggestedFileName || 'download')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'download';
      const item = {
        id: params.uuid, tabId: p.id, url: params.url,
        filename: safeName,
        path: path.join(p.profile.downloadDir, params.uuid),
        state: 'progressing', receivedBytes: 0, totalBytes: 0, private: isPrivate,
      };
      this.#downloadsByUuid.set(params.uuid, { item, page: p });
      if (!isPrivate) {
        p.downloads.push(item);
        p.profile.downloads.push(item);
        this.#signal(p, { kind: 'download', id: item.id, name: safeName, state: 'started', bytes: 0 });
      }
      return;
    }
    if (method === 'Browser.downloadFinished') {
      const record = this.#downloadsByUuid.get(params.uuid);
      if (!record) return;
      const { item, page: p } = record;
      item.state = params.canceled ? 'cancelled' : params.error ? 'interrupted' : 'completed';
      if (params.error) item.error = params.error;
      if (!item.private && !p.closed) {
        this.#signal(p, { kind: 'download', id: item.id, name: item.filename, state: item.state, bytes: item.receivedBytes });
      }
      return;
    }
    if (sessionId) {
      const p = this.#bySessionId.get(sessionId);
      if (p && !p.closed) p.driver.onMessage(method, params);
      else if (!p) {
        let queue = this.#earlyMessages.get(sessionId);
        if (!queue) { queue = []; this.#earlyMessages.set(sessionId, queue); }
        if (queue.length < 256) queue.push({ method, params });
      }
    }
  }

  #registerPage({ owner, profile, sessionId, targetId, actor = null }) {
    const id = `t${++this.#tabSequence}`;
    const navListeners = new Set();
    const p = {
      id, owner, profile, sessionId, targetId, actor,
      currentUrl: 'about:blank', currentTitle: '',
      visible: true, connected: true, closed: false, closedByAgent: false,
      paused: null, actorGeneration: null, privateSince: null,
      model: null, base: null, shot: null, cursor: null,
      dialog: null, dialogRecord: null, downloads: [], returnAttempt: 0, returnFailure: null,
      onDomContentLoaded: null, dialogOpened: null, nativeRequestOpened: null, settleInterrupt: null,
      navListeners,
      emitNavigation: event => { for (const fn of navListeners) fn(event); },
    };
    p.presentation = new CamoufoxPresentation({
      id,
      sessionLabel: `${profile.name} (${profile.id})`,
      locale: this.locale,
      isElevated: () => this.#automationMode === 'elevated',
      onSync: () => this.#syncControlBar(),
    });
    p.devtools = new DevToolsRecorder(
      () => p.presentation.mode,
      sid => (typeof sid === 'string' && sid.startsWith('rdp:service_worker') ? 'service_worker'
        : typeof sid === 'string' && sid.startsWith('rdp:shared_worker') ? 'shared_worker'
          : typeof sid === 'string' && (sid.startsWith('worker:') || sid.startsWith('rdp:worker')) ? 'worker' : 'iframe'),
      profile.devtoolsPrivacy,
    );
    p.driver = new CamoufoxFrameDriver({
      page: p, process: this.#proc, sessionId, rdp: this.#rdp,
      invalidate: reason => this.#invalidate(p, reason),
    });
    p.onNavigated = url => {
      if (!p.closed && p.presentation.mode === 'automation') {
        this.#signal(p, { kind: 'navigated', url, title: p.currentTitle });
      }
    };
    p.onTrustedInput = kind => {
      if (p.closed || p.presentation.mode !== 'automation') return;
      p.paused = 'unexpected-page-input';
      p.presentation.failClosed('unexpected-page-input');
      this.#invalidate(p, 'unexpected-page-input');
      this.#signal(p, { kind: 'state', state: `paused (${kind}: unexpected-page-input)` });
    };
    p.onDialogOpened = evt => {
      if (p.closed) return;
      p.dialog = { ...evt, attempted: false };
      if (p.presentation.mode !== 'automation') return;
      const req = this.#nativeDialog(p, p.dialog);
      this.#signal(p, { kind: 'dialog', type: evt.type, message: evt.message, requestRef: req?.requestRef });
      p.settleInterrupt?.('dialog');
      p.dialogOpened?.();
    };
    p.onDialogClosed = () => {
      if (p.dialog?.nativeRequest) this.nativeRequests.withdraw(p.dialog.nativeRequest, 'Dialog closed');
      p.dialog = null;
    };
    p.onFileChooserOpened = evt => {
      if (p.closed || p.presentation.mode !== 'automation') return;
      this.#nativeFilePicker(p, evt);
    };
    this.#pages.set(id, p);
    this.#bySessionId.set(sessionId, p);
    this.#byTargetId.set(targetId, p);
    const early = this.#earlyMessages.get(sessionId);
    if (early) {
      this.#earlyMessages.delete(sessionId);
      for (const msg of early) p.driver.onMessage(msg.method, msg.params);
    }
    this.#activeTabId = id;
    this.#syncControlBar();
    return p;
  }

  #nativeDialog(p, dialogRecord) {
    const actor = p.actor;
    if (!actor || p.paused || p.presentation.mode !== 'automation') return null;
    const generation = p.presentation.generation;
    let record;
    try {
      record = this.nativeRequests.create({
        page: p, caller: actor.caller, signal: actor.signal, kind: 'javascript-dialog',
        context: {
          type: dialogRecord.type,
          message: String(dialogRecord.message ?? ''),
          ...(dialogRecord.type === 'prompt' ? { defaultValue: String(dialogRecord.defaultValue ?? '') } : {}),
        },
        options: [
          { label: 'Accept', metadata: { accept: true }, value: true },
          { label: 'Dismiss', metadata: { accept: false }, value: false },
        ],
        isCurrent: () => !p.closed && p.connected && !p.paused
          && (p.dialog === dialogRecord || record?.state === 'responding')
          && (!dialogRecord.attempted || record?.state === 'responding')
          && p.presentation.mode === 'automation' && p.presentation.generation === generation,
        validate: (response, accept) => {
          if (response.files !== undefined || (response.text !== undefined && dialogRecord.type !== 'prompt')) {
            fail('INVALID_NATIVE_RESPONSE', 'Dialog accepts an offered decision; text is only valid for prompts');
          }
          if (response.cancel) return { accept: false };
          if (typeof accept !== 'boolean') fail('INVALID_NATIVE_RESPONSE', 'Choose a current dialog option');
          return {
            accept,
            promptText: accept && dialogRecord.type === 'prompt'
              ? String(response.text ?? dialogRecord.defaultValue ?? '')
              : undefined,
          };
        },
        respond: async (response, caller, signal) => {
          this.#owned(p.id, caller, signal, true, false, true);
          if (p.dialog !== dialogRecord || dialogRecord.attempted) {
            fail('DIALOG_UNCERTAIN', 'Dialog response already dispatched or closed');
          }
          dialogRecord.attempted = true;
          await bounded(p.driver.handleDialog(dialogRecord.dialogId, response.accept, response.promptText),
            15000, 'Dialog response', signal);
          await p.driver.waitForIdle(signal);
          if (p.dialog === dialogRecord) p.dialog = null;
          this.#invalidate(p, 'dialog-handled');
          return { requestRef: record.requestRef, kind: record.kind, resolution: 'resolved' };
        },
        withdraw: () => {},
      });
      dialogRecord.nativeRequest = record;
      return record;
    } catch {
      return null;
    }
  }

  #nativeFilePicker(p, evt) {
    const actor = p.actor;
    const root = p.driver.rootFrame();
    if (!actor || p.paused || p.presentation.mode !== 'automation' || !root || !evt?.element?.objectId) return null;
    const generation = p.presentation.generation;
    const multiple = Boolean(evt.multiple);
    const frameId = evt.frameId || root.frameId;
    let record;
    const current = () => !p.closed && p.connected && !p.paused && p.visible
      && p.presentation.mode === 'automation' && p.presentation.generation === generation;
    try {
      record = this.nativeRequests.create({
        page: p, caller: actor.caller, signal: actor.signal, kind: 'file-picker',
        context: {
          frameId,
          mode: multiple ? 'selectMultiple' : 'selectSingle',
          disclosure: 'Selecting files exposes their contents to this website',
        },
        options: [],
        isCurrent: current,
        validate: async response => {
          if (response.optionRef !== undefined || response.text !== undefined) {
            fail('INVALID_NATIVE_RESPONSE', 'File picker accepts explicit file paths or cancel');
          }
          if (response.cancel) return [];
          return this.#validateFiles(response.files, multiple);
        },
        respond: async (files, caller, signal) => {
          if (!files.length) return { requestRef: record.requestRef, kind: record.kind, resolution: 'cancelled' };
          this.#owned(p.id, caller, signal, true);
          await bounded(p.driver.setFileInputFiles(frameId, evt.element.objectId, files, { signal }),
            15000, 'File picker response', signal);
          this.#invalidate(p, 'file-picker-responded');
          return { requestRef: record.requestRef, kind: record.kind, resolution: 'selected' };
        },
        withdraw: () => {
          const f = p.driver.frames.get(frameId) ?? root;
          if (f && evt.element?.objectId) p.driver.disposeObject(f, evt.element.objectId);
        },
      });
      return record;
    } catch {
      return null;
    }
  }

  #closePageRecord(p) {
    if (p.closed) return;
    if (!p.closedByAgent) this.#signal(p, { kind: 'closed', closedTabId: p.id });
    p.closed = true;
    p.connected = false;
    this.#rdp?.detachTab(p.id);
    this.nativeRequests.withdrawPage(p);
    this.#refs.retireTab(p.id);
    p.presentation.destroy();
    this.#bySessionId.delete(p.sessionId);
    this.#byTargetId.delete(p.targetId);
    this.#queue.abort(p.id, new BrowserHostError('CLOSED_TAB', 'Tab closed'));
    this.#syncControlBar();
  }

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

  async #createPage(caller, profile, url, signal) {
    const owner = caller.sessionId;
    if (this.#ownerPages(owner).length >= MAX_SESSION_TABS) {
      fail('TAB_LIMIT', `At most ${MAX_SESSION_TABS} open tabs are allowed per caller`);
    }
    const proc = await this.#ensureBrowser();
    let attachedInfo = null;
    let attachResolve;
    const attachWait = new Promise(resolve => { attachResolve = resolve; });
    this.#pendingAttach = params => { attachedInfo = params; attachResolve?.(); };
    let targetId;
    try {
      const res = await proc.send('Browser.newPage', profile.browserContextId ? { browserContextId: profile.browserContextId } : {}, undefined, { signal });
      targetId = res.targetId;
      if (!attachedInfo) await bounded(attachWait, 10000, 'Camoufox page attach', signal);
    } finally {
      this.#pendingAttach = null;
    }
    const p = this.#registerPage({
      owner, profile, sessionId: attachedInfo.sessionId, targetId,
      actor: caller.requestOwner ?? { caller, signal },
    });
    await p.driver.start();
    for (let i = 0; i < 40 && !p.driver.rootFrame(); i++) await pause(50, signal);
    const root = p.driver.rootFrame();
    if (!root) fail('ROOT_UNAVAILABLE', 'Camoufox root frame failed to initialize');
    // Attach Firefox RDP watcher BEFORE initial navigation so worker/SW
    // network resources and eager console reads are active from the first load.
    if (this.#rdp) {
      await this.#rdp.attachTab(p.id, {
        matchTab: t => t.url === 'about:blank' || t.url === url,
        onResource: (phase, rtype, item, _from, target) => {
          p.devtools.recordRdp(phase, rtype, item, target?.targetType || null);
        },
        watchResources: p.presentation.mode === 'automation',
      }).catch(() => {});
      this.#syncControlBar();
    }
    await this.#navigatePage(p, url, signal);
    return p;
  }

  async #navigatePage(p, url, signal) {
    const root = p.driver.rootFrame();
    if (!root) fail('ROOT_UNAVAILABLE', 'Root frame unavailable');
    let dclResolve;
    const dclPromise = new Promise(resolve => { dclResolve = resolve; });
    p.onDomContentLoaded = fid => { if (fid === root.frameId) dclResolve?.(); };
    try {
      await p.driver.send('Page.navigate', { frameId: root.frameId, url }, signal);
      await bounded(dclPromise, 15000, 'Page navigation', signal).catch(() => {});
      await pause(80, signal);
    } finally {
      p.onDomContentLoaded = null;
    }
    p.currentUrl = p.driver.rootFrame()?.url || url;
    if (this.#rdp) {
      this.#rdp.attachTab(p.id, {
        matchTab: t => t.url === p.currentUrl,
        onResource: (phase, rtype, item, _from, target) => {
          p.devtools.recordRdp(phase, rtype, item, target?.targetType || null);
        },
        watchResources: p.presentation.mode === 'automation',
      }).then(() => this.#syncControlBar()).catch(() => {});
    }
  }

  async #perceive(p, caller, signal, returning = false) {
    if (caller) this.#owned(p.id, caller, signal);
    else if (p.closed || this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Page closed during trusted return');
    signal?.throwIfAborted();
    p.presentation.assertObservable(returning);
    const generation = p.presentation.generation;
    const frames = await p.driver.snapshot({}, signal);
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
    for (const frameId of p.model?.frames.keys() ?? []) {
      if (!model.frames.has(frameId)) this.#refs.retireDocument(p.id, frameId);
    }
    p.model = model;
    const prevUrl = p.currentUrl, prevTitle = p.currentTitle;
    p.currentUrl = model.url || p.currentUrl;
    p.currentTitle = model.title || p.currentTitle;
    if (p.currentUrl !== prevUrl || p.currentTitle !== prevTitle) this.#syncControlBar();
    return model;
  }

  #drainSignals(p, caller, header = false) {
    if (caller?.keepSignals) return [];
    const queued = this.#signals.drain(p.owner, p.id)
      .filter(sig => !(header && sig.tabId === p.id && sig.kind === 'navigated'));
    const lines = formatSignals(queued, p.id);
    const devtools = p.devtools.since(p.cursor ?? { console: 0, network: 0 });
    p.cursor = devtools.cursor;
    if (devtools.errors) lines.push(formatSignals([{ tabId: p.id, kind: 'console', count: devtools.errors }], p.id)[0]);
    if (devtools.failed) lines.push(formatSignals([{ tabId: p.id, kind: 'network', count: devtools.failed }], p.id)[0]);
    const pending = caller ? this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller).length : 0;
    if (pending) lines.push(formatSignals([{ tabId: p.id, kind: 'requests', count: pending }], p.id)[0]);
    return lines;
  }

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
    const merge = partial => { if (base) merges.push(partial); };
    const commit = () => {
      if (nextView) {
        p.base = { view: nextView, snapshotId, rootDocument: root.documentId, generation, url: model.url, scroll: model.scroll.y };
      }
      for (const partial of merges) {
        for (const [key, line] of partial.lines) base.view.lines.set(key, line);
        for (const [key, ref] of partial.refs) base.view.refs.set(key, ref);
      }
    };
    let header = !base || base.url !== model.url || screenshot;
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
    if (!caller?.keepSignals) commit();
    const out = [...this.#drainSignals(p, caller, header), ...lines];
    if (header) out.push(renderHeader(model, { points: p.shot?.snapshotId === snapshotId }));
    else if (viewLine) out.push(renderHeader(model).split('\n')[1]);
    if (value !== undefined) out.push(`value ${clipText(JSON.stringify(value) ?? 'undefined', 4000)}`);
    if (body) out.push(body);
    return {
      ...result,
      sessionId: p.profile.id,
      sessionName: p.profile.name,
      ...(value === undefined ? {} : { value }),
      snapshotId,
      text: out.join('\n'),
    };
  }

  async #screenshot(p, model, snapshotId) {
    const shot = await p.driver.screenshot();
    const after = await p.driver.viewport();
    const checkpoint = model.frames.get(model.rootId).checkpoint;
    const { w, h } = model.viewport;
    p.shot = after?.documentId === checkpoint.documentId && after.w === w && after.h === h
      && after.x === checkpoint.x && after.y === checkpoint.y
      ? { snapshotId, buffer: shot.buffer, documentId: checkpoint.documentId, w, h, x: checkpoint.x, y: checkpoint.y, generation: p.presentation.generation }
      : null;
    return { mimeType: 'image/png', data: shot.data, width: w, height: h };
  }

  #scopeKey(p, ref) {
    const entry = this.#liveRef(p, ref);
    const key = `${entry.frameId}:${entry.documentId}:${entry.id}`;
    if (!p.model?.byKey.has(key)) fail('STALE_REF', `${ref} is not on the page now; observe again`);
    return key;
  }

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

  #staleRef(p, entry, reason) {
    const generation = p.presentation.generation;
    const now = (p.model?.items ?? []).filter(item => item.id !== undefined && item.role === entry.role && item.name === entry.name
      && !(item.frameId === entry.frameId && item.documentId === entry.documentId && item.id === entry.id))
      .slice(0, 3).map(item => this.#refs.ref({
        tabId: p.id, frameId: item.frameId, documentId: item.documentId, id: item.id,
        role: item.role, name: item.name, generation,
      }));
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
    const frameId = target.frame ? this.#frameOf(p, target.frame).frameId : undefined;
    let matches = model.items.filter(item => item.id !== undefined && ['i', 'c', 'f', 'l', 'm'].includes(item.kind)
      && matchesTarget({ role: item.role, name: item.name, frameId: item.frameId }, { ...target, frameId }));
    if (target.selector) {
      const selected = [];
      for (const item of matches) {
        const frame = p.driver.frames.get(item.frameId);
        if (!frame) continue;
        const resolved = await p.driver.resolveObject(frame.frameId, item.id, item.documentId, signal).catch(() => null);
        if (!resolved) continue;
        try {
          if (await p.driver.callOn(resolved.frame, resolved.objectId, 'function(selector){return this.matches(selector)}', [target.selector], true, signal)) {
            selected.push(item);
          }
        } finally {
          p.driver.disposeObject(resolved.frame, resolved.objectId);
        }
      }
      matches = selected;
    }
    const generation = p.presentation.generation;
    const refFor = item => this.#refs.ref({
      tabId: p.id, frameId: item.frameId, documentId: item.documentId, id: item.id,
      role: item.role, name: item.name, generation,
    });
    if (matches.length !== 1) {
      const shown = matches.slice(0, 10);
      fail(matches.length ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
        matches.length ? `${matches.length} elements match; act on one ref` : 'No element matches; observe or use find',
        { candidates: shown.map(item => `${refFor(item)} ${item.role}${item.name ? ` ${quote(clipText(item.name, 60))}` : ''}`) });
    }
    return this.#refs.lookup(refFor(matches[0]));
  }

  async #assertNoSensitive(p, frameId, signal) {
    const privateWin = this.#ownerPages(p.owner).find(q => q.profile === p.profile && q.presentation.mode !== 'automation');
    if (privateWin) {
      fail('SENSITIVE_PRESENT', `Page code is refused while ${privateWin.id} of this profile is under human control`, { requestedInputDispatched: false });
    }
    const frame = frameId ? p.driver.frames.get(frameId) : p.driver.rootFrame();
    if (!frame) fail('STALE_FRAME', 'The frame is not available; observe again');
    const origin = frame.origin || '';
    for (const q of this.#ownerPages(p.owner)) {
      if (q.profile !== p.profile) continue;
      if (!q.connected) fail('SENSITIVE_PRESENT', 'Cannot verify sibling window sensitive fields while disconnected', { requestedInputDispatched: false });
      const present = await q.driver.sensitivePresent(origin, signal);
      if (present) {
        fail('SENSITIVE_PRESENT', 'A sensitive field holds a value in a reachable same-origin document; clear it with fill text:"" or use ordinary actions', { requestedInputDispatched: false });
      }
    }
  }

  #requestLines(pending) {
    return pending.map(request => `request ${request.requestRef} ${request.kind}`
      + `${request.context?.message ? ` ${quote(clipText(String(request.context.message), 200))}` : ''}`
      + `${request.options?.length ? ` options ${request.options.map(option => `${option.optionRef}=${quote(option.label)}`).join(' ')}` : ' (respond with files or cancel)'}`);
  }

  #dialogFirst(p, caller, action) {
    const pending = this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller);
    return {
      action, tabId: p.id, disposition: 'not-executed', code: 'DIALOG_OPEN', requestedInputDispatched: false,
      dialog: { type: p.dialog.type }, pendingRequests: pending,
      sessionId: p.profile.id, sessionName: p.profile.name,
      text: [`dialog ${p.dialog.type} ${quote(clipText(p.dialog.message ?? '', 200))}: answer it first with handle_dialog or respond`,
        ...this.#requestLines(pending)].join('\n'),
    };
  }

  #pendingUncertain(p, args, state, caller, code = 'DIALOG_OPEN') {
    const parked = code === 'DIALOG_OPEN';
    const pending = parked && caller ? this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller) : [];
    return {
      action: args.action, ref: state.ref, tabId: p.id, disposition: 'uncertain', replaySafe: false, code,
      sessionId: p.profile.id, sessionName: p.profile.name,
      ...(parked ? { operationPending: true, pendingRequests: pending } : {}),
      text: [...this.#drainSignals(p, caller),
        ...(parked && p.dialog ? [`dialog ${p.dialog.type} ${quote(clipText(p.dialog.message ?? '', 200))}: answer with handle_dialog or respond`] : []),
        ...this.#requestLines(pending),
        'note the input may have been delivered in part or in full; never repeat it; observe first'].join('\n'),
    };
  }

  #unobserved(p, args, cause, state = {}, caller = null) {
    if (state.delivered) return null;
    const parked = cause === 'DIALOG_OPEN';
    const pending = parked && caller ? this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller) : [];
    return {
      action: args.action, disposition: 'executed', tabId: p.id, ref: state.ref ?? args.ref, observed: false, cause, replaySafe: false,
      sessionId: p.profile.id, sessionName: p.profile.name,
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

  #arm(p) {
    return armNavigation(listener => {
      p.navListeners.add(listener);
      return () => { p.navListeners.delete(listener); };
    });
  }

  async #validatePoint(p, args, caller, signal) {
    this.#owned(p.id, caller, signal, true);
    const shot = p.shot;
    const { x, y, snapshotId } = args.point;
    if (!shot) fail('POINTS_UNAVAILABLE', 'Points need the latest snapshot taken with screenshot:true (with points in its view line)');
    if (snapshotId !== shot.snapshotId) fail('STALE_COORDINATES', `Points come only from the tab's latest screenshot (${shot.snapshotId})`);
    if (shot.generation !== p.presentation.generation) fail('STALE_COORDINATES', 'The presentation changed since the screenshot');
    if (!(x >= 0 && y >= 0 && x < shot.w && y < shot.h)) fail('INVALID_COORDINATES', 'Coordinates are outside the screenshot viewport');
    const root = p.driver.rootFrame();
    if (!root) fail('STALE_FRAME', 'The root frame is not available; observe again');
    await p.driver.inputReady(root.frameId, signal);
    const now = await p.driver.viewport(root, signal);
    if (now?.documentId !== shot.documentId || now.w !== shot.w || now.h !== shot.h || now.x !== shot.x || now.y !== shot.y) {
      fail('STALE_COORDINATES', 'The document, viewport or scroll changed since the screenshot');
    }
    const current = await p.driver.screenshot(signal);
    if (!pngTilesEqual(shot.buffer, current.buffer, shot.w, shot.h, x, y)) {
      fail('STALE_COORDINATES', 'The pixels around the point changed since the screenshot');
    }
    const chain = await p.driver.hitChain({ x, y }, signal);
    const last = chain.hops.at(-1);
    const where = hop => `${hop.role}${hop.name ? ` ${quote(hop.name)}` : ''}${hop.src ? ` from ${quote(hostOf(hop.src))}` : ''}`
      + ` in ${quote(hostOf(hop.document?.url))}`;
    if (chain.unverified) fail('POINT_UNVERIFIED', `The point cannot be verified through its frames: ${chain.unverified}`);
    if (!last || chain.opacity < MIN_POINT_OPACITY || !last.visible) {
      fail('POINT_HIDDEN_TARGET', `The point hits ${last ? where(last) : 'nothing'}, which is transparent or hidden; act on a ref instead`);
    }
    this.#owned(p.id, caller, signal, true);
    return { frame: root, point: { x, y } };
  }

  async #handoff(p, reason = 'human-handoff', source = 'agent') {
    if (p.closed) return { tabId: p.id, mode: 'closed' };
    if (p.presentation.mode === 'native-handoff') {
      if (source === 'agent') this.#flashControlBar(p.id);
      return { tabId: p.id, mode: 'native-handoff', paused: p.paused };
    }
    const gen = p.presentation.beginDrain(reason);
    p.paused = reason;
    this.#invalidate(p, 'handoff-draining');
    try {
      await p.driver.waitForIdle();
      await p.driver.setNativeMode(true);
      p.presentation.enterNative(reason, gen);
      this.#devtoolsMode(p);
      this.#signal(p, { kind: 'state', state: 'handoff' });
      if (source === 'agent') this.#flashControlBar(p.id);
    } catch {
      p.presentation.failClosed(reason);
    }
    return { tabId: p.id, mode: p.presentation.mode, paused: p.paused };
  }

  async #resume(p) {
    if (p.closed) return;
    if (p.dialog) {
      p.returnAttempt++;
      p.returnFailure = { attempt: p.returnAttempt, stage: 'withdraw-requests', code: 'DIALOG_OPEN', retry: 'human-only' };
      p.presentation.failReturn(p.returnFailure);
      return;
    }
    const attempt = ++p.returnAttempt;
    const gen = p.presentation.beginReturn();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Return timed out')), RETURN_TIMEOUT_MS);
    let stage = 'queue';
    try {
      await this.#queue.run(p.id, async () => {
        stage = 'cleanup';
        await p.driver.waitForIdle(controller.signal);
        stage = 'automation-mode';
        await p.driver.setNativeMode(false);
        stage = 'privacy';
        const since = p.privateSince ?? 0;
        await p.driver.privatize(since, false, controller.signal);
        stage = 'observation';
        await p.driver.snapshot({}, controller.signal);
        stage = 'devtools-flush';
        p.devtools.boundary();
        stage = 'commit';
        if (p.presentation.generation !== gen || (p.paused === 'explicit-stop' && p.presentation.mode !== 'returning')) {
          throw new Error('Return superseded by newer pause');
        }
        p.privateSince = null;
        p.paused = null;
        p.returnFailure = null;
        p.presentation.finishReturn(gen);
        this.#devtoolsMode(p);
        this.#signal(p, { kind: 'state', state: 'returned' });
      }, controller.signal);
    } catch (error) {
      p.returnFailure = {
        attempt, stage,
        code: error?.code ?? (controller.signal.aborted ? 'RETURN_TIMEOUT' : 'RETURN_FAILED'),
        retry: 'human-only',
      };
      p.paused = 'return-failed';
      p.presentation.failReturn(p.returnFailure);
    } finally {
      clearTimeout(timer);
    }
  }

  async #revoke() {
    if (this.#revokeFlight) return this.#revokeFlight;
    this.#revoking = true;
    for (const p of this.#pages.values()) {
      if (!p.closed) this.#pause(p, 'permission-revocation');
    }
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

  async execute(unchecked, caller, signal) {
    try {
      const result = await this.#execute(validateArgs(unchecked), caller, signal);
      const p = this.#pages.get(result?.tabId ?? unchecked?.tabId);
      return p && result && typeof result === 'object' ? { ...result, sessionId: p.profile.id, sessionName: p.profile.name } : result;
    } catch (error) {
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
    const { action } = args;

    if (action === 'status') return this.status();
    if (action === 'revoke') return this.#revoke();

    if (action === 'create_session') {
      this.#assertSessionMutationAllowed(caller.sessionId);
      const profile = await this.#newProfile(caller.sessionId, { name: args.name, temporary: true });
      return { disposition: 'executed', ...this.#sessionInfo(profile) };
    }
    if (action === 'list_sessions') {
      await this.#defaultProfile(caller.sessionId);
      const sessions = [...this.#sessions.values()]
        .filter(s => s.owner === caller.sessionId && s.state !== 'closed')
        .map(s => this.#sessionInfo(s));
      return { sessions };
    }
    if (action === 'close_session') {
      const profile = this.#sessions.get(args.sessionId);
      if (!profile) fail('CLOSED_SESSION', `Unknown browser session ${args.sessionId}`);
      if (profile.owner !== caller.sessionId) fail('FOREIGN_SESSION', `Browser session ${args.sessionId} belongs to another caller`);
      if (profile.isDefault) fail('DEFAULT_SESSION', 'The default browser session cannot be closed');
      if (profile.state !== 'open') {
        return { disposition: 'executed', ...this.#sessionInfo(profile), closedTabIds: [], cleanupComplete: profile.state === 'closed' };
      }
      this.#assertSessionMutationAllowed(caller.sessionId, profile);
      profile.state = 'closing';
      const pages = this.#ownerPages(caller.sessionId).filter(q => q.profile === profile);
      const closedTabIds = pages.map(q => q.id);
      const failures = [];
      for (const p of pages) {
        p.closedByAgent = true;
        try { await this.#proc?.send('Page.close', {}, p.sessionId, { timeoutMs: 5000 }); }
        catch (err) { failures.push({ stage: `tab ${p.id}`, reason: err.message }); }
        this.#closePageRecord(p);
      }
      for (const dl of profile.downloads) {
        if (dl.state === 'progressing') {
          await this.#proc?.send('Browser.cancelDownload', { uuid: dl.id }, undefined, { timeoutMs: 3000 }).catch(() => {});
        }
      }
      if (profile.browserContextId && this.#proc && !this.#proc.closed) {
        try {
          await this.#proc.send('Browser.removeBrowserContext', { browserContextId: profile.browserContextId }, undefined, { timeoutMs: 5000 });
        } catch (err) {
          failures.push({ stage: 'removeBrowserContext', reason: err.message });
        }
        this.#byBrowserContext.delete(profile.browserContextId);
      }
      profile.state = failures.length ? 'cleanup-failed' : 'closed';
      return {
        disposition: failures.length ? 'failed' : 'executed',
        ...this.#sessionInfo(profile),
        closedTabIds,
        cleanupComplete: failures.length === 0,
        ...(failures.length ? { code: 'SESSION_CLEANUP_FAILED', replaySafe: false, failures } : {}),
      };
    }

    if (action === 'list_tabs') {
      const tabs = this.#ownerPages(caller.sessionId).map(p => {
        const priv = p.presentation.mode !== 'automation';
        return {
          tabId: p.id, sessionId: p.profile.id, sessionName: p.profile.name,
          url: priv ? null : p.currentUrl, title: priv ? null : p.currentTitle,
          mode: p.presentation.mode, generation: p.presentation.generation,
          paused: p.paused, visible: p.visible, connected: p.connected, busy: this.#queue.isBusy(p.id),
          automationMode: this.#automationMode,
          returnFailure: p.returnFailure,
        };
      });
      return { automationMode: this.#automationMode, engine: 'camoufox', tabs };
    }

    if (action === 'open') {
      if (args.sessionId) this.#assertSessionMutationAllowed(caller.sessionId);
      const profile = await this.#selectedSession(caller.sessionId, args.sessionId);
      const url = pageURL(args.url);
      const p = await this.#createPage(caller, profile, url, signal);
      const model = await this.#perceive(p, caller, signal);
      return this.#present(p, model, caller, { action: 'open', disposition: 'executed', tabId: p.id }, {
        snapshot: args.snapshot ?? 'full', screenshot: args.screenshot === true,
      });
    }

    if (action === 'run') {
      const initialTab = args.tabId ? this.#owned(args.tabId, caller, signal, true) : null;
      const runCaller = {
        sessionId: caller.sessionId, callId: caller.callId, signal,
        assertLive: () => caller.assertLive(),
        requestOwner: { caller, signal },
      };
      return runScript({
        script: args.script,
        tabId: initialTab?.id,
        timeoutMs: args.timeoutMs ?? RUN_BOUNDS.defaultMs,
        caller: runCaller,
        execute: (opArgs, opCaller) => this.execute(opArgs, opCaller, opCaller.signal),
        createSandbox: this.createRunnerSandbox,
        tabState: id => {
          const t = this.#pages.get(id);
          return t && !t.closed && t.owner === caller.sessionId ? { paused: t.paused, mode: t.presentation.mode } : null;
        },
        finalView: async (id, viewSignal) => {
          const both = AbortSignal.any([signal, viewSignal]);
          const t = this.#owned(id, caller, both);
          if (t.dialog) return this.#dialogFirst(t, caller, 'observe').text;
          const res = await this.#queue.run(t.id, async () => {
            const model = await this.#perceive(t, caller, both);
            return this.#present(t, model, caller, { action: 'run', disposition: 'executed', tabId: t.id }, { snapshot: 'diff' });
          }, both);
          return res.text;
        },
      });
    }

    // Immediate non-lane DevTools reads (console, network, performance)
    if (devtoolsActions.has(action) && action !== 'inspect') {
      const p = this.#owned(args.tabId, caller, signal, false);
      p.presentation.assertObservable();
      if (action === 'console' && args.expression === undefined) {
        return { disposition: 'observed', tabId: p.id, sessionId: p.profile.id, sessionName: p.profile.name, ...p.devtools.consoleRows(args) };
      }
      if (action === 'network' && args.id === undefined) {
        return { disposition: 'observed', tabId: p.id, sessionId: p.profile.id, sessionName: p.profile.name, ...p.devtools.networkRows(args) };
      }
      if (action === 'network' && !args.body) {
        const rdpActor = p.devtools.rdpActorForEnrichment(args.id);
        if (rdpActor && this.#rdp?.connected) {
          const [hdrs, reqBody] = await Promise.all([
            this.#rdp.getNetworkHeaders(rdpActor, signal).catch(() => ({})),
            this.#rdp.getNetworkPostData(rdpActor, signal).catch(() => undefined),
          ]);
          p.devtools.enrichRdp(args.id, { ...hdrs, reqBody });
        }
        return { disposition: 'observed', tabId: p.id, sessionId: p.profile.id, sessionName: p.profile.name, ...p.devtools.detail(args.id) };
      }
      if (p.dialog) return this.#dialogFirst(p, caller, action);
      if (!p.connected) fail('DEBUGGER_DISCONNECTED', 'Browser disconnected; observe again');
      const generation = p.presentation.generation;
      let result;
      if (action === 'network') {
        const detail = p.devtools.detail(args.id);
        if (detail.ty === 'websocket') {
          result = p.devtools.wsFrames(args.id, args.limit ?? L.chars);
        } else {
          result = await responseBody(p.driver, p.devtools.bodyTarget(args.id), args.limit ?? L.chars, signal);
        }
      } else if (action === 'console') {
        if (p.paused) fail('AUTOMATION_PAUSED', `Automation paused: ${p.paused}`, { requestedInputDispatched: false });
        const frameId = args.frame ? this.#frameOf(p, args.frame).frameId : undefined;
        await this.#assertNoSensitive(p, frameId, signal);
        result = await p.driver.pageRead({ expression: args.expression, frameId, limit: args.limit ?? L.chars }, signal);
      } else {
        result = await p.driver.performanceSnapshot(signal);
      }
      this.#owned(p.id, caller, signal);
      p.presentation.assertObservable();
      if (p.presentation.generation !== generation) fail('PRESENTATION_CHANGED', 'Presentation changed during the DevTools read; read again');
      return { disposition: 'observed', tabId: p.id, sessionId: p.profile.id, sessionName: p.profile.name, ...result };
    }

    if (action === 'requests') {
      const p = this.#owned(args.tabId, caller, signal, false);
      p.presentation.assertObservable();
      return {
        tabId: p.id,
        pending: this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller),
        capabilities: this.status().capabilities,
      };
    }
    if (action === 'respond') {
      const p = this.#owned(args.tabId, caller, signal, true, false, true);
      let dispatched = false;
      try {
        const request = await bounded(this.nativeRequests.respond(
          p, caller?.requestOwner?.caller ?? caller, args.requestRef, args.response,
          () => { this.#owned(p.id, caller, signal, true, false, true); dispatched = true; }, signal,
        ), 15000, 'Native response', signal);
        return {
          tabId: p.id, disposition: 'executed', request,
          pendingRequests: this.nativeRequests.list(p, caller?.requestOwner?.caller ?? caller),
        };
      } catch (error) {
        if (!dispatched) throw error;
        return { tabId: p.id, disposition: 'uncertain', replaySafe: false, reason: 'Native response or result failed; do not replay' };
      }
    }
    if (action === 'handle_dialog') {
      const p = this.#owned(args.tabId, caller, signal, true, false, true);
      if (!p.dialog) fail('NO_DIALOG', 'No page JavaScript dialog is open');
      const dlg = p.dialog;
      if (dlg.attempted) fail('DIALOG_UNCERTAIN', 'Dialog response already dispatched; never replay an uncertain response');
      dlg.attempted = true;
      const promptText = args.accept && dlg.type === 'prompt' ? String(args.promptText ?? dlg.defaultValue ?? '') : undefined;
      try {
        await bounded(p.driver.handleDialog(dlg.dialogId, args.accept, promptText), 15000, 'Dialog response', signal);
      } catch {
        return {
          action: 'handle_dialog', tabId: p.id, disposition: 'uncertain', replaySafe: false, code: 'DIALOG_UNCERTAIN',
          text: 'note the dialog response may have been delivered; never repeat it; observe first',
        };
      }
      if (p.dialog === dlg) p.dialog = null;
      if (dlg.nativeRequest) this.nativeRequests.withdraw(dlg.nativeRequest, 'Handled via handle_dialog');
      this.#invalidate(p, 'dialog-handled');
      try {
        return await this.#queue.run(p.id, async laneSignal => {
          const model = await this.#perceive(p, caller, laneSignal);
          return this.#present(p, model, caller, { action: 'handle_dialog', disposition: 'executed', tabId: p.id }, { snapshot: 'diff' });
        }, signal);
      } catch (error) {
        return this.#unobserved(p, { action: 'handle_dialog' }, error.code ?? 'OBSERVE_FAILED');
      }
    }
    if (action === 'permissions') {
      const p = this.#owned(args.tabId, caller, signal, false);
      const grants = [...this.#permissionGrants.entries()].map(([k, state]) => {
        const [origin, kind] = k.split('\0');
        return { origin, kind, state };
      });
      return { tabId: p.id, policy: this.policy.describe(), grants };
    }
    if (action === 'downloads') {
      const p = this.#owned(args.tabId, caller, signal, false);
      p.presentation.assertObservable();
      return { items: structuredClone(p.downloads.filter(d => !d.private)) };
    }
    if (action === 'handoff') {
      const p = this.#owned(args.tabId, caller, signal, false);
      const res = await this.#handoff(p, 'human-handoff', 'agent');
      return {
        disposition: res.mode === 'native-handoff' ? 'executed' : 'uncertain',
        action: 'handoff', tabId: p.id,
        text: res.mode === 'native-handoff'
          ? `mode ${res.mode}; the Control Bar flashes for the person. Only the person can return control; no tool can resume`
          : `mode ${res.mode}; handoff did not finish entering native control; the person can use Take control or Resume in the Control Bar`,
      };
    }
    if (action === 'hide' || action === 'show') {
      const p = this.#owned(args.tabId, caller, signal, false);
      p.visible = action === 'show';
      if (action === 'hide') { p.presentation.generation++; this.#refs.retireTab(p.id); }
      return {
        disposition: 'executed', action, tabId: p.id,
        text: `window ${p.visible ? 'visible' : 'hidden'}${p.paused ? `; paused: ${p.paused}` : ''}`
          + (action === 'hide' ? '; earlier refs and points of this tab are void (observe again after show)' : '; observe before acting'),
      };
    }
    if (action === 'close_tab') {
      const p = this.#owned(args.tabId, caller, signal, false);
      p.closedByAgent = true;
      await this.#proc?.send('Page.close', {}, p.sessionId, { timeoutMs: 5000 }).catch(() => {});
      this.#closePageRecord(p);
      return { disposition: 'executed', action: 'close_tab', tabId: p.id, text: 'tab closed' };
    }

    // Per-tab serialized lane actions (observe, read, inspect, navigate, click, fill, type, press, select, scroll, upload, evaluate)
    const p = this.#owned(args.tabId, caller, signal, false);
    if (p.dialog && !['handoff', 'close_tab', 'hide', 'show'].includes(action)) {
      return this.#dialogFirst(p, caller, action);
    }
    return this.#run(p, args, caller, signal);
  }

  async #run(p, args, caller, requestSignal) {
    const timeout = new AbortController();
    const signal = AbortSignal.any([requestSignal, timeout.signal]);
    const state = { sent: false, acked: false, delivered: false, preparation: 'none', ref: args.ref };
    let dialogListener;
    const mutation = inputActions.has(args.action);
    const markSent = () => { state.sent = true; };

    const decide = () => {
      if (!state.sent || state.delivered) return;
      const result = state.acked ? this.#unobserved(p, args, 'DIALOG_OPEN', state, caller) : this.#pendingUncertain(p, args, state, caller);
      state.delivered = true;
      dialogListener?.(result);
    };
    const parked = () => decide();
    const requested = () => {
      if (!state.sent || state.delivered) return;
      if (state.acked || p.dialog) decide(); else setTimeout(decide, NATIVE_REQUEST_ACK_GRACE_MS);
    };

    const actual = this.#queue.run(p.id, async laneSignal => {
      this.#owned(p.id, caller, laneSignal, mutation, args.action === 'navigate');
      await p.driver.waitForIdle(laneSignal);
      p.actor = caller.requestOwner ?? { caller, signal };
      p.actorGeneration = p.presentation.generation;
      p.driver.actorSignal = laneSignal;
      p.driver.beforeInputDispatch = () => this.#owned(p.id, caller, laneSignal, true);
      p.driver.beforeCleanupDispatch = () => {};
      let armed;
      try {
        if (!mutation) {
          return await this.#readLane(p, args, caller, laneSignal);
        }
        p.dialogOpened = parked;
        p.nativeRequestOpened = requested;
        state.wall = Date.now();

        if (args.action === 'navigate') {
          this.#owned(p.id, caller, laneSignal, true, true);
          armed = this.#arm(p);
          markSent();
          await this.#navigatePage(p, pageURL(args.url), laneSignal);
          state.acked = true;
        } else if (args.action === 'evaluate') {
          const frameId = args.frame ? this.#frameOf(p, args.frame).frameId : undefined;
          const { frame, contextId } = await p.driver.evaluationContext(frameId, args.world ?? 'isolated', laneSignal);
          await this.#assertNoSensitive(p, frame.frameId, laneSignal);
          this.#owned(p.id, caller, laneSignal, true);
          state.frameId = frame.frameId;
          armed = this.#arm(p);
          try {
            state.value = await p.driver.evaluateUser(frame, contextId, args.expression, args.world ?? 'isolated', markSent, laneSignal);
          } catch (error) {
            if (!['PAGE_SCRIPT_ERROR', 'NON_JSON_RESULT'].includes(error?.code)) throw error;
            state.code = error.code;
          }
          state.acked = true;
        } else if (args.action === 'scroll' && !args.ref && !args.target && !args.point) {
          const root = p.driver.rootFrame();
          if (!root) fail('STALE_FRAME', 'The root frame is not available; observe again');
          await p.driver.inputReady(root.frameId, laneSignal);
          this.#owned(p.id, caller, laneSignal, true);
          state.frameId = root.frameId;
          armed = this.#arm(p);
          const dx = args.deltaX ?? 0, dy = args.deltaY ?? 0;
          await p.driver.evaluate(root, `(() => {
            const scroller = document.scrollingElement || document.documentElement;
            if (!scroller) throw new Error('No document scroller');
            scroller.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' });
            return { x: scroller.scrollLeft, y: scroller.scrollTop };
          })()`, true, laneSignal, () => { this.#owned(p.id, caller, laneSignal, true); markSent(); });
          state.acked = true;
        } else {
          const target = args.point
            ? await this.#validatePoint(p, args, caller, laneSignal)
            : await this.#validateTarget(p, args, caller, laneSignal, phase => { state.preparation = phase; });
          state.ref = target.ref ?? state.ref;
          state.frameId = target.frame?.frameId;
          armed = this.#arm(p);
          try {
            await this.#perform(p, target, args, caller, laneSignal, markSent, state);
          } finally {
            if (target.objectId) p.driver.disposeObject(target.frame, target.objectId);
          }
          state.acked = true;
        }

        const interrupt = new Promise(resolve => { p.settleInterrupt = resolve; });
        await settle({
          armed, signal: laneSignal, interrupt, short: SHORT_SETTLE.has(args.action),
          quiet: (ms, cap) => p.driver.quiet(state.frameId ? [state.frameId] : [], ms, cap, laneSignal),
          pendingRequests: () => p.devtools.running(state.wall),
        }).catch(err => { if (laneSignal.aborted) throw err; });

        if (state.delivered) return null;
        if (p.dialog) return this.#unobserved(p, args, 'DIALOG_OPEN', state, caller);

        const result = {
          action: args.action, disposition: 'executed', tabId: p.id, ref: state.ref,
          ...(state.preparation !== 'none' ? { preparation: state.preparation } : {}),
          ...(state.code ? { code: state.code } : {}),
        };
        let model;
        try { model = await this.#perceive(p, caller, laneSignal); } catch (first) {
          if (laneSignal.aborted) throw first;
          try { model = await this.#perceive(p, caller, laneSignal); } catch (second) {
            if (laneSignal.aborted) throw second;
            return this.#unobserved(p, args, second.code ?? 'OBSERVE_FAILED', state, caller);
          }
        }
        return this.#present(p, model, caller, result, {
          snapshot: args.snapshot ?? 'diff', screenshot: args.screenshot === true, value: state.value, state,
        });
      } finally {
        armed?.dispose();
        p.settleInterrupt = null;
        p.driver.actorSignal = null;
        p.driver.beforeInputDispatch = null;
        p.driver.beforeCleanupDispatch = null;
        p.actorGeneration = null;
      }
    }, signal);

    const dialog = new Promise(resolve => { dialogListener = result => resolve(result); });
    try {
      return await bounded(Promise.race([actual, dialog]), 25000, 'Browser action', signal, () => {
        timeout.abort(new Error('Browser action timed out; dispatch may still be fenced'));
      });
    } catch (error) {
      const code = timeout.signal.aborted ? 'TIMEOUT' : typeof error?.code === 'string' ? error.code : signal.aborted ? 'ABORTED' : 'BROWSER_ERROR';
      if (mutation && state.acked) return this.#unobserved(p, args, code, state, caller);
      if (mutation && state.sent) return this.#pendingUncertain(p, args, state, caller, code);
      if (mutation) {
        const failure = error instanceof BrowserHostError ? error
          : new BrowserHostError(code, signal.aborted ? 'Cancelled, timed out or stopped before dispatch' : String(error?.message ?? 'Target validation failed'));
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

  async #readLane(p, args, caller, signal) {
    if (args.action === 'inspect') {
      let info, located;
      if (args.ref) {
        const entry = this.#liveRef(p, args.ref);
        const described = await p.driver.describe(entry.frameId, entry.id, entry.documentId, signal);
        if (described?.stale || described?.missing) this.#staleRef(p, entry, 'belongs to a replaced document');
        if (!described?.described) this.#staleRef(p, entry, 'was removed');
        info = await p.driver.inspectElement({ frameId: entry.frameId, id: entry.id, documentId: entry.documentId, values: args.values ?? [] }, signal);
        located = { ref: args.ref };
      } else {
        const frameId = args.target.frame ? this.#frameOf(p, args.target.frame).frameId : undefined;
        info = await p.driver.inspectElement({ frameId, selector: args.target.selector, values: args.values ?? [] }, signal);
        located = { selector: args.target.selector, frame: args.target.frame };
      }
      this.#owned(p.id, caller, signal);
      return { disposition: 'observed', tabId: p.id, sessionId: p.profile.id, sessionName: p.profile.name, ...located, ...info };
    }
    if (args.action === 'read' && (args.ref || args.target)) {
      const entry = args.ref ? this.#liveRef(p, args.ref) : await this.#targetEntry(p, args.target, caller, signal);
      const described = await p.driver.describe(entry.frameId, entry.id, entry.documentId, signal);
      if (described?.stale || described?.missing) this.#staleRef(p, entry, 'belongs to a replaced document');
      if (!described?.described) this.#staleRef(p, entry, 'was removed');
      const resolved = await p.driver.resolveObject(entry.frameId, entry.id, entry.documentId, signal);
      try {
        const value = await p.driver.callOn(resolved.frame, resolved.objectId, `function() {
          const s = globalThis.__independentState;
          if (!s || s.sensitive(this)) return { text: '', value: null, sensitive: true };
          const read = s.maskedText(this);
          return { text: read.text.slice(0, 12000), sensitive: read.masked,
            value: !read.masked && typeof this.value === 'string' ? this.value.slice(0, 12000) : null };
        }`, [], true, signal);
        const lines = [`text ${quote(value.text)}`];
        if (value.sensitive) lines.push('sensitive (value withheld)');
        else if (value.value !== null) lines.push(`value ${quote(value.value)}`);
        return {
          action: 'read', disposition: 'observed', tabId: p.id, ref: entry.ref,
          sessionId: p.profile.id, sessionName: p.profile.name,
          text: [...this.#drainSignals(p, caller), ...lines].join('\n'),
        };
      } finally {
        p.driver.disposeObject(resolved.frame, resolved.objectId);
      }
    }
    let met = true;
    if (args.wait) {
      const deadline = Date.now() + (args.wait.timeoutMs ?? 5000);
      met = false;
      for (;;) {
        this.#owned(p.id, caller, signal);
        p.presentation.assertObservable();
        const url = p.driver.rootFrame()?.url || p.currentUrl;
        const ok = args.wait.url !== undefined
          ? url.includes(args.wait.url)
          : (await p.driver.textIncludes(args.wait.text ?? args.wait.gone, signal)) === (args.wait.text !== undefined);
        if (ok) { met = true; break; }
        if (Date.now() >= deadline) break;
        await pause(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())), signal);
      }
    }
    const model = await this.#perceive(p, caller, signal);
    return this.#present(p, model, caller, {
      action: args.action, disposition: 'observed', tabId: p.id,
      ...(met ? {} : { code: 'WAIT_TIMEOUT' }),
    }, { observe: args.action === 'read' ? { mode: 'text' } : args, screenshot: args.screenshot === true });
  }

  async #validateTarget(p, args, caller, signal, onPreparation) {
    this.#owned(p.id, caller, signal, true);
    const entry = args.ref ? this.#liveRef(p, args.ref) : await this.#targetEntry(p, args.target, caller, signal);
    const frame = p.driver.frames.get(entry.frameId);
    if (!frame) this.#staleRef(p, entry, 'is in a frame that is gone');
    await p.driver.inputReady(frame.frameId, signal);
    const described = await p.driver.describe(frame.frameId, entry.id, entry.documentId, signal);
    if (described?.stale || described?.missing) {
      this.#refs.retireDocument(p.id, entry.frameId, null);
      this.#staleRef(p, entry, 'belongs to a replaced document');
    }
    if (!described?.described) {
      this.#refs.gone(p.id, entry.frameId, entry.documentId, [entry.id]);
      this.#staleRef(p, entry, 'was removed');
    }
    if (described.described.role !== entry.role || described.described.name !== entry.name) {
      this.#staleRef(p, entry, 'changed its role or name');
    }
    const resolved = await p.driver.resolveObject(frame.frameId, entry.id, entry.documentId, signal);
    try {
      const item = p.model?.byKey.get(`${entry.frameId}:${entry.documentId}:${entry.id}`);
      const now = await p.driver.inView(frame.frameId, entry.id, entry.documentId, signal);
      if (!now.inView || (frame.parentId && !item?.inView)) {
        await p.driver.prepare(frame.frameId, resolved.objectId, () => onPreparation('scrolled'),
          now.proxied ? { id: entry.id, documentId: entry.documentId } : null, signal);
      }
      this.#owned(p.id, caller, signal, true);
      const point = await p.driver.pointFor(frame.frameId, entry.id, entry.documentId, signal);
      this.#owned(p.id, caller, signal, true);
      return { frame: resolved.frame, entry, ref: entry.ref, objectId: resolved.objectId, point };
    } catch (error) {
      p.driver.disposeObject(resolved.frame, resolved.objectId);
      throw error;
    }
  }

  async #perform(p, target, args, caller, signal, markSent, state) {
    const { frame, entry, point, objectId } = target;
    const guarded = async (type, send) => {
      if (!entry) return send();
      const armed = await p.driver.armGuard(frame.frameId, entry.id, type, entry.documentId, signal);
      if (!armed?.armed) fail('STALE_REF', `${entry.ref} was replaced before dispatch`);
      let outcome;
      try { await send(); } finally {
        outcome = await p.driver.disarmGuard(frame.frameId).catch(() => null);
      }
      return outcome;
    };
    const missed = outcome => !!entry && !(outcome?.fired && outcome.inside);

    if (args.action === 'click') {
      const outcome = await guarded('pointerdown', () => p.driver.dispatchClick(point.x, point.y, { beforeDown: markSent, signal }));
      if (missed(outcome)) state.code = 'TARGET_MISMATCH';
      return;
    }
    if (args.action === 'scroll') {
      const dx = args.deltaX ?? 0, dy = args.deltaY ?? 0;
      if (!entry) {
        await p.driver.send('Page.dispatchWheelEvent', {
          x: point.x, y: point.y, deltaX: dx, deltaY: dy, deltaZ: 0, modifiers: 0,
        }, signal, () => { this.#owned(p.id, caller, signal, true); markSent(); });
        return;
      }
      await p.driver.callOn(frame, objectId, `function(dx, dy){
        let el = this;
        if (!el || !el.isConnected || el.matches('iframe,frame')) throw new Error('Explicit frame target required');
        while (el && el !== document.scrollingElement) {
          const style = getComputedStyle(el);
          if ((dy !== 0 && el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(style.overflowY))
            || (dx !== 0 && el.scrollWidth > el.clientWidth && /(auto|scroll)/.test(style.overflowX))) break;
          el = el.parentElement || el.getRootNode()?.host;
        }
        (el || document.scrollingElement || document.documentElement).scrollBy({ left: dx, top: dy, behavior: 'instant' });
      }`, [dx, dy], true, signal, () => { this.#owned(p.id, caller, signal, true); markSent(); });
      return;
    }

    const info = await p.driver.callOn(frame, objectId, `function() {
      const s = globalThis.__independentState;
      return { connected: this.isConnected, disabled: !!this.disabled, readOnly: !!this.readOnly,
        tag: this.tagName, type: this.type, multiple: !!this.multiple, editable: this.isContentEditable,
        sensitive: !!(s && s.sensitive(this)) };
    }`, [], true, signal);
    if (!info.connected || info.disabled || info.readOnly) fail('NOT_ACTIONABLE', 'Target is replaced, disabled or readonly');

    if (args.action === 'upload') {
      if (info.tag !== 'INPUT' || info.type !== 'file' || (!info.multiple && args.files.length !== 1)) {
        fail('INVALID_UPLOAD_TARGET', 'Upload requires a matching explicit file input');
      }
      const files = await this.#validateFiles(args.files, info.multiple);
      await p.driver.setFileInputFiles(frame.frameId, objectId, files, { beforeSend: markSent, signal });
      return;
    }
    if (args.action === 'select') {
      if (info.tag !== 'SELECT' || (!info.multiple && args.values.length !== 1)) {
        fail('INVALID_SELECT_TARGET', 'Target must be a select with matching multiplicity');
      }
      const valid = await p.driver.callOn(frame, objectId, 'function(values){return values.every(v=>Array.from(this.options).some(o=>o.value===v&&!o.disabled))}', [args.values], true, signal);
      if (!valid) fail('INVALID_OPTION', 'An exact enabled option is missing');
      await p.driver.callOn(frame, objectId, `function(values){
        if (!this.isConnected || this.disabled) throw new Error('changed');
        for (const option of this.options) option.selected = values.includes(option.value);
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`, [args.values], true, signal, () => { this.#owned(p.id, caller, signal, true); markSent(); });
      return;
    }

    if (['fill', 'type'].includes(args.action) && !info.editable
      && !(info.tag === 'TEXTAREA' || (info.tag === 'INPUT' && !['file', 'button', 'submit', 'reset', 'checkbox', 'radio', 'hidden'].includes(info.type)))) {
      fail('INVALID_TEXT_TARGET', 'Target is not an editable text input');
    }
    const assertSensitiveInputAllowed = () => {
      if (['fill', 'type'].includes(args.action) && info.sensitive && args.text && this.#automationMode !== 'elevated') {
        fail('SENSITIVE_INPUT_REFUSED', 'Typing into sensitive fields (passwords, OTP, verification codes) requires human handoff in standard mode; clear with text:"" or opt in with WB_AUTOMATION_MODE=elevated');
      }
    };
    assertSensitiveInputAllowed();

    // Focus the validated element cleanly before keyboard input.
    await p.driver.callOn(frame, objectId, 'function(){ this.focus({ preventScroll: true }); }', [], true, signal);
    const ensureFocused = async () => {
      const stillLive = await p.driver.callOn(frame, objectId, 'function(){return this.isConnected&&!this.disabled&&!this.readOnly&&this.getRootNode().activeElement===this}', [], true, signal);
      if (!stillLive) {
        await p.driver.dispatchClick(point.x, point.y, { beforeDown: markSent, signal });
      }
      this.#owned(p.id, caller, signal, true);
    };

    if (args.action === 'press') {
      await ensureFocused();
      const outcome = await guarded('keydown', () => p.driver.dispatchKey(keys[args.key], { beforeDown: markSent, signal }));
      if (missed(outcome)) state.code = 'TARGET_MISMATCH';
      return;
    }
    if (args.action === 'fill') {
      await ensureFocused();
      const clearOutcome = await guarded('keydown', () => p.driver.dispatchSelectAllDelete({ beforeSend: markSent, signal }));
      if (missed(clearOutcome)) { state.code = 'TARGET_MISMATCH'; return; }
      if (args.text) {
        assertSensitiveInputAllowed();
        await ensureFocused();
        const insOutcome = await guarded('beforeinput', () => p.driver.dispatchInsertText(args.text, { beforeSend: markSent, signal }));
        if (missed(insOutcome)) state.code = 'TARGET_MISMATCH';
      }
      return;
    }
    if (args.action === 'type' && args.text) {
      assertSensitiveInputAllowed();
      await ensureFocused();
      const insOutcome = await guarded('beforeinput', () => p.driver.dispatchInsertText(args.text, { beforeSend: markSent, signal }));
      if (missed(insOutcome)) state.code = 'TARGET_MISMATCH';
    }
  }

  async grantPermission(owner, origin, kind) {
    const mapped = mapPermissionKind(kind);
    if (!mapped) fail('UNSUPPORTED_PERMISSION', `Permission ${kind} is not supported on Camoufox/Firefox`);
    if (!this.policy.permits(kind)) fail('POLICY_DENIED', `Policy does not delegate ${kind}`);
    const proc = await this.#ensureBrowser();
    await proc.send('Browser.grantPermissions', { origin, permissions: [mapped] });
    this.#permissionGrants.set(`${origin}\0${kind}`, 'allow');
  }

  endSession(callerSessionId) {
    this.#signals.end(callerSessionId);
    for (const p of this.#pages.values()) {
      if (p.owner === callerSessionId) this.nativeRequests.withdrawPage(p);
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#chromeToolbar.close();
    this.#controlBar.close();
    this.#rdp?.close();
    this.nativeRequests.close();
    for (const p of this.#pages.values()) {
      if (!p.closed) { p.closedByAgent = true; this.#closePageRecord(p); }
    }
    try {
      await this.#proc?.close();
    } finally {
      await this.#releaseProfileLock();
    }
  }
}
