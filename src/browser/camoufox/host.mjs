// Camoufox-backed BrowserHost (pure Node.js, zero Electron dependency).
// Preserves the full browse contract, token-saving perception pipeline
// (walker, composeModel, persistent e<n> refs, diffs, find, budgets),
// complete Juggler + WebSocket + Firefox RDP network/DevTools debugging with
// privacy windows, isolated temporary sessions via Firefox BrowserContexts,
// named persistent on-disk profiles (`default`, `work`, `personal`, plus
// validated slugs) each backed by its own locked Camoufox process, native
// alert/confirm/prompt dialogs, standard vs elevated automation mode with
// persisted user preference, native Firefox #nav-bar Agent Control toolbar,
// and hardened Camoufox `run` sandboxes.
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
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
import { quote, renderDiff, renderFind, renderHeader, renderSnapshot, renderText } from '../perception/render.mjs';
import { armNavigation, settle } from '../settle.mjs';
import { CONTROL_SIGNALS, formatSignals, SignalQueue } from '../signals.mjs';
import { runScript } from '../runner/run.mjs';
import {
  BrowserHostError, devtoolsActions, fail, freshId, inputActions, keys, matchesTarget, pageURL, RUN_BOUNDS, validateArgs,
} from '../../shared/contract.mjs';
import { isProtectedInternalPath, saveUserPreferences } from '../../shared/preferences.mjs';
import { CamoufoxProcess } from './juggler.mjs';
import { FirefoxRdpClient } from './rdp.mjs';
import { CamoufoxFrameDriver } from './driver.mjs';
import { CamoufoxPresentation, ChromeToolbarClient } from './presentation.mjs';
import { createCamoufoxRunnerSandboxFactory } from './runner-sandbox.mjs';
import { acquireProfileLock, inspectProfiles, releaseProfileLock, slugFromDirName } from './profile-lock.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const hostOf = url => { try { return new URL(url).host || String(url).slice(0, 40); } catch { return ''; } };
const clipText = (value, max) => { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const WAIT_POLL_MS = 100;
const SHORT_SETTLE = new Set(['scroll', 'evaluate']);
const SHORT_PROBE_ACTIONS = new Set(['scroll', 'fill', 'type', 'select', 'upload']);
const MIN_POINT_OPACITY = 0.1;
const TILE = 32;
const MAX_SESSION_TABS = 32;
const MAX_TEMPORARY_SESSIONS = 16;
const MAX_PERSISTENT_PROFILES = 8;
const DEFAULT_IDLE_PROFILE_TIMEOUT_MS = 120000;
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

function pngTilesEqual(aBuf, bBuf, w, h, x, y, aDecoded = null) {
  const a = aDecoded ?? decodePngPixels(aBuf), b = decodePngPixels(bBuf);
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

export function pngClipMatchesTile(baseBuf, clipBuf, baseW, baseH, left, top, tileW, tileH, baseDecoded = null) {
  const a = baseDecoded ?? decodePngPixels(baseBuf);
  const b = decodePngPixels(clipBuf);
  if (!a || !b) return baseBuf.equals(clipBuf);
  if (a.bpp !== b.bpp) return false;
  // Fallback when a full-viewport screenshot was returned instead of a clipped tile.
  if (b.width === a.width && b.height === a.height) {
    return pngTilesEqual(baseBuf, clipBuf, baseW, baseH, left + tileW / 2, top + tileH / 2, a);
  }
  const sx = a.width / baseW, sy = a.height / baseH;
  const x0 = Math.max(0, Math.round(left * sx));
  const y0 = Math.max(0, Math.round(top * sy));
  const cmpW = Math.min(b.width, a.width - x0);
  const cmpH = Math.min(b.height, a.height - y0);
  if (cmpW <= 0 || cmpH <= 0) return false;
  const aStride = a.width * a.bpp;
  const bStride = b.width * b.bpp;
  const rowBytes = cmpW * a.bpp;
  for (let row = 0; row < cmpH; row++) {
    const aStart = (y0 + row) * aStride + x0 * a.bpp;
    const bStart = row * bStride;
    if (!a.pixels.subarray(aStart, aStart + rowBytes).equals(b.pixels.subarray(bStart, bStart + rowBytes))) {
      return false;
    }
  }
  return true;
}

function mapPermissionKind(kind) {
  return kind === 'notifications' ? 'notifications' : kind === 'geolocation' ? 'geolocation' : null;
}

export class CamoufoxHost {
  #pages = new Map();
  #profiles = new Map();           // callerSessionId → default profile
  #sessions = new Map();           // ctx<n> → profile
  #runtimes = new Map();           // 'default' | 'profile:<slug>' → runtime
  #runtimeStartFlights = new Map();// runtimeKey → Promise<runtime>
  #slugCoords = new Map();         // non-default persistent slug → lifecycle coordinator
  #profileBindFlights = new Map(); // `${owner}\0${slug}` → Promise<profile>
  #sessionSequence = 0;
  #queue = new FenceQueue();
  #closed = false;
  #revoking = false;
  #revokeFlight;
  #automationMode = 'standard';
  #configuredAutomationMode = 'standard';
  #automationModeSource = 'default';
  #automationModePinned = false;
  #automationPreferenceReason = null;
  #revertedThisConnection = false;
  #refs = new RefRegistry();
  #signals = new SignalQueue();
  #tabSequence = 0;
  #snapshotSequence = 0;
  #permissionGrants = new Map();   // `${origin}\0${kind}` → 'allow' | 'deny'
  #activeTabId = null;
  #defaultProfilePersistence = 'ephemeral';

  constructor({
    dataDir, dataRoot = null, profilesRoot = null, persistentProfileDir = null,
    persistentProfilesEnabled = undefined, authorityMode = 'connection',
    executablePath, camoufoxVersion = '158.0.1-beta.41',
    onRevokeConnection, policy = new BrowserPolicy(),
    automationMode = policy.automationMode ?? 'standard',
    automationModeSource = policy.explicitAutomationMode ? 'policy' : 'default',
    automationModePinned = undefined,
    automationPreferenceReason = null,
    headless = false, enableRdp = true, locale = 'ko-KR',
    idleProfileTimeoutMs = undefined,
    createProcess = null, createRdp = null, createRunnerSandbox = null,
  }) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof onRevokeConnection !== 'function') {
      throw new TypeError('Absolute dataDir and onRevokeConnection are required');
    }
    if (automationMode !== 'standard' && automationMode !== 'elevated') {
      throw new TypeError('automationMode must be standard or elevated');
    }
    this.dataDir = path.resolve(dataDir);
    this.dataRoot = typeof dataRoot === 'string' && path.isAbsolute(dataRoot) ? path.resolve(dataRoot) : null;
    this.authorityMode = authorityMode;
    this.defaultProfileSlug = 'default';
    if (typeof profilesRoot === 'string' && path.isAbsolute(profilesRoot)) {
      this.profilesRoot = path.resolve(profilesRoot);
      this.persistentProfilesEnabled = persistentProfilesEnabled !== false;
    } else if (typeof persistentProfileDir === 'string' && path.isAbsolute(persistentProfileDir)) {
      const resolved = path.resolve(persistentProfileDir);
      this.profilesRoot = path.dirname(resolved);
      this.defaultProfileSlug = slugFromDirName(path.basename(resolved)) ?? 'default';
      this.persistentProfilesEnabled = persistentProfilesEnabled !== false;
    } else {
      this.profilesRoot = null;
      this.persistentProfilesEnabled = false;
    }
    this.#defaultProfilePersistence = this.persistentProfilesEnabled ? 'persistent-pending' : 'ephemeral';
    this.executablePath = executablePath;
    this.camoufoxVersion = camoufoxVersion;
    this.headless = headless;
    this.enableRdp = enableRdp;
    this.locale = locale;
    const envIdle = process.env.WB_PROFILE_IDLE_MS !== undefined ? Number(process.env.WB_PROFILE_IDLE_MS) : NaN;
    const configuredIdle = idleProfileTimeoutMs !== undefined ? Number(idleProfileTimeoutMs)
      : Number.isFinite(envIdle) && envIdle >= 0 ? envIdle : DEFAULT_IDLE_PROFILE_TIMEOUT_MS;
    this.idleProfileTimeoutMs = Number.isFinite(configuredIdle) && configuredIdle >= 0 ? configuredIdle : DEFAULT_IDLE_PROFILE_TIMEOUT_MS;
    this.connectionId = freshId();
    this.onRevokeConnection = onRevokeConnection;
    this.policy = policy;
    this.#automationMode = automationMode;
    this.#configuredAutomationMode = automationMode;
    this.#automationModeSource = automationModeSource;
    this.#automationModePinned = automationModePinned ?? ['env', 'policy', 'policy-invalid'].includes(automationModeSource);
    this.#automationPreferenceReason = automationPreferenceReason;
    this.nativeRequests = new BrowserRequests();
    this.createProcess = createProcess;
    this.createRdp = createRdp;
    this.createRunnerSandbox = createRunnerSandbox ?? (executablePath ? createCamoufoxRunnerSandboxFactory({ executablePath }) : null);
  }

  #canElevate() {
    return !this.#closed
      && !this.#revoking
      && this.#automationMode === 'standard'
      && !this.#automationModePinned
      && !this.#revertedThisConnection
      && Boolean(this.dataRoot);
  }

  status() {
    const elevated = this.#automationMode === 'elevated';
    const rdpActive = [...this.#runtimes.values()].some(r => !r.closed && r.rdp?.connected);
    const namedPersistentSupported = Boolean(this.persistentProfilesEnabled && this.profilesRoot);
    return {
      state: this.#closed ? 'closed' : this.#revoking ? 'terminating-revocation' : 'connected',
      engine: 'camoufox',
      runtime: `Camoufox ${this.camoufoxVersion}`,
      connectionId: this.connectionId,
      automationMode: this.#automationMode,
      profilePersistence: this.#defaultProfilePersistence,
      tabCount: [...this.#pages.values()].filter(p => !p.closed).length,
      pausedCount: [...this.#pages.values()].filter(p => !p.closed && p.paused).length,
      capabilities: {
        engine: 'camoufox',
        fallbackEngine: 'electron (set WB_ENGINE=electron or browser-policy.json engine:"electron" for WebHID/WebUSB)',
        automation: {
          mode: this.#automationMode,
          configuredMode: this.#configuredAutomationMode,
          source: this.#automationModeSource,
          pinned: this.#automationModePinned,
          canElevate: this.#canElevate(),
          persistentPreference: Boolean(this.dataRoot),
          ...(this.#automationPreferenceReason ? { preferenceReason: this.#automationPreferenceReason } : {}),
          scope: elevated
            ? 'connection-wide opt-in: login and sensitive fill/type/click/observe permitted; user-revocable via #nav-bar'
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
        sessions: {
          temporary: true,
          namedPersistentProfiles: namedPersistentSupported,
          maxCreatedPerCaller: MAX_TEMPORARY_SESSIONS,
          maxActivePersistentProfiles: MAX_PERSISTENT_PROFILES,
          defaultClosable: false,
        },
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
          ? ['OS identity', 'CAPTCHA', 'human Resume in the #nav-bar after Stop/handoff']
          : ['OS identity', 'passwords', 'CAPTCHA', '2FA', 'human Resume in the #nav-bar after Stop/handoff'],
        delegation: this.policy.describe('camoufox'),
      },
    };
  }

  #activePersistentCount() {
    const def = this.#runtimes.get('default');
    const defCount = def && !def.closed && def.persistence === 'persistent' ? 1 : 0;
    return defCount + this.#slugCoords.size;
  }

  #enqueueCoord(coord, fn) {
    const next = coord.transition.then(fn, fn);
    coord.transition = next.then(() => {}, () => {});
    return next;
  }

  #cancelProfileIdle(coord) {
    if (coord?.idleTimer) {
      clearTimeout(coord.idleTimer);
      coord.idleTimer = null;
    }
  }

  #isProfileIdle(profile) {
    if (!profile || this.#closed || this.#revoking) return false;
    if (profile.isDefault || profile.persistence !== 'persistent' || profile.state !== 'open') return false;
    const coord = profile.coord;
    if (!coord || coord.closing || coord.activeOps > 0) return false;
    const rt = profile.runtime;
    if (!rt || rt.closed) return false;
    if ([...this.#pages.values()].some(p => !p.closed && p.profile === profile)) return false;
    if (rt.attachWaiters.size > 0 || rt.bufferedAttaches.size > 0) return false;
    if ([...rt.downloadsByUuid.values()].some(d => d.item?.state === 'progressing')) return false;
    return true;
  }

  #scheduleProfileIdle(profile) {
    if (!profile?.coord || !(this.idleProfileTimeoutMs > 0)) return;
    const coord = profile.coord;
    this.#cancelProfileIdle(coord);
    if (!this.#isProfileIdle(profile)) return;
    const expectedGen = coord.runtimeGen;
    coord.idleTimer = setTimeout(() => {
      coord.idleTimer = null;
      this.#retireIdleProfile(profile, expectedGen).catch(() => {});
    }, this.idleProfileTimeoutMs);
    coord.idleTimer.unref?.();
  }

  async #retireIdleProfile(profile, expectedGen) {
    const coord = profile?.coord;
    if (!coord || this.#closed || this.#revoking) return false;
    return this.#enqueueCoord(coord, async () => {
      if (coord.runtimeGen !== expectedGen || !this.#isProfileIdle(profile)) return false;
      coord.runtimeGen++;
      const rt = profile.runtime;
      const disposed = await this.#disposeRuntime(rt, { keepLock: true });
      if (!disposed.clean) {
        // Affirmative exit was not confirmed; do not declare dormancy or release lock.
        return false;
      }
      profile.runtime = null;
      coord.runtime = null;
      profile.runtimeState = 'dormant';
      return true;
    });
  }

  async #withProfileRuntime(profile, fn) {
    const coord = profile?.coord;
    if (!coord) {
      return fn(profile.runtime);
    }
    if (this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Browser connection is closed or terminating revocation');
    if (profile.state !== 'open' || coord.closing) fail('CLOSED_SESSION', `Browser session ${profile.id} is ${profile.state}`);
    // Synchronously acquire usage ref and cancel idle retirement before any await.
    coord.activeOps++;
    this.#cancelProfileIdle(coord);
    try {
      const rt = await this.#enqueueCoord(coord, async () => {
        if (this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Browser connection is closed or terminating revocation');
        if (profile.state !== 'open' || coord.closing) fail('CLOSED_SESSION', `Browser session ${profile.id} is ${profile.state}`);
        if (profile.runtime && !profile.runtime.closed && profile.runtime.proc && !profile.runtime.proc.closed) {
          return profile.runtime;
        }
        if (!coord.lockHandle) fail('CLOSED_SESSION', `Persistent profile "${profile.profileSlug}" lock is no longer held`);
        const woken = await this.#startRuntime({
          key: `profile:${profile.profileSlug}`,
          profileSlug: profile.profileSlug,
          strictPersistent: true,
          existingLockHandle: coord.lockHandle,
        });
        const dlRes = await woken.proc.send('Browser.setDownloadOptions', {
          downloadOptions: { behavior: 'saveToDisk', downloadsDir: profile.downloadDir },
        }).catch(err => ({ error: err?.message ?? String(err) }));
        profile.downloadSetupError = dlRes?.error ?? null;
        profile.runtime = woken;
        coord.runtime = woken;
        profile.runtimeState = 'running';
        coord.runtimeGen++;
        // Replay only permission grants scoped to this exact owner, profile, and active policy.
        const grantPrefix = `${profile.owner}\0${profile.id}\0`;
        for (const [k, state] of this.#permissionGrants) {
          if (state !== 'allow' || !k.startsWith(grantPrefix)) continue;
          const rest = k.slice(grantPrefix.length);
          const sep = rest.lastIndexOf('\0');
          if (sep < 0) continue;
          const origin = rest.slice(0, sep);
          const kind = rest.slice(sep + 1);
          const mapped = mapPermissionKind(kind);
          if (!mapped || !this.policy.permits(kind)) continue;
          await woken.proc.send('Browser.grantPermissions', { origin, permissions: [mapped] }).catch(() => {});
        }
        return woken;
      });
      return await fn(rt);
    } finally {
      coord.activeOps--;
      this.#scheduleProfileIdle(profile);
    }
  }

  async #startRuntime({ key, profileSlug = null, strictPersistent = false, existingLockHandle = null }) {
    if (this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Browser connection is closed or terminating revocation');
    const connProfilesRoot = path.join(this.dataDir, 'profiles');
    await mkdir(connProfilesRoot, { recursive: true });

    let lockHandle = null;
    let ownsLockOnFailure = true;
    let profileDir = null;
    let persistence = 'ephemeral';
    let boundSlug = null;

    if (existingLockHandle) {
      lockHandle = existingLockHandle;
      ownsLockOnFailure = false; // Retained by coordinator until explicit close_session / host.close.
      profileDir = existingLockHandle.profileDir;
      persistence = 'persistent';
      boundSlug = profileSlug ?? existingLockHandle.slug;
    } else if (strictPersistent) {
      if (!this.persistentProfilesEnabled || !this.profilesRoot) {
        fail('PERSISTENT_PROFILES_DISABLED', 'Persistent profiles are disabled for this connection');
      }
      const acquired = await acquireProfileLock(this.profilesRoot, profileSlug, { connectionId: this.connectionId });
      if (!acquired.ok) {
        if (acquired.reason === 'busy') {
          fail('PROFILE_IN_USE', `Persistent profile "${profileSlug}" is currently held by another live browser process`);
        }
        fail('PROFILE_IO_ERROR', `Unable to acquire persistent profile "${profileSlug}": ${acquired.error?.message ?? 'I/O error'}`);
      }
      lockHandle = acquired;
      profileDir = acquired.profileDir;
      persistence = 'persistent';
      boundSlug = profileSlug;
      if (key === 'default') this.#defaultProfilePersistence = 'persistent';
    } else if (this.persistentProfilesEnabled && this.profilesRoot) {
      const acquired = await acquireProfileLock(this.profilesRoot, this.defaultProfileSlug, { connectionId: this.connectionId });
      if (acquired.ok) {
        lockHandle = acquired;
        profileDir = acquired.profileDir;
        persistence = 'persistent';
        boundSlug = this.defaultProfileSlug;
        this.#defaultProfilePersistence = 'persistent';
        await writeFile(path.join(connProfilesRoot, 'camoufox.persistent.json'),
          JSON.stringify({ profileDir, profile: boundSlug, persistent: true }), 'utf8').catch(() => {});
      } else if (acquired.reason === 'busy') {
        profileDir = path.join(connProfilesRoot, 'camoufox');
        await mkdir(profileDir, { recursive: true });
        persistence = 'ephemeral-busy';
        boundSlug = null;
        this.#defaultProfilePersistence = 'ephemeral-busy';
      } else {
        fail('PROFILE_IO_ERROR', `Unable to acquire persistent default profile: ${acquired.error?.message ?? 'I/O error'}`);
      }
    } else {
      profileDir = path.join(connProfilesRoot, 'camoufox');
      await mkdir(profileDir, { recursive: true });
      persistence = 'ephemeral';
      boundSlug = null;
      this.#defaultProfilePersistence = 'ephemeral';
    }

    const runtime = {
      key,
      profileSlug: boundSlug,
      profileDir,
      persistence,
      lockHandle,
      proc: null,
      rdp: null,
      toolbar: null,
      bySessionId: new Map(),
      byTargetId: new Map(),
      byBrowserContext: new Map(),
      earlyMessages: new Map(),
      downloadsByUuid: new Map(),
      attachWaiters: new Map(),
      bufferedAttaches: new Map(),
      activeTabId: null,
      closed: false,
      closeFlight: null,
    };

    try {
      const proc = this.createProcess
        ? await this.createProcess({
          profileDir, profileSlug: boundSlug, enableRdp: this.enableRdp, headless: this.headless, locale: this.locale,
        })
        : new CamoufoxProcess({
          executablePath: this.executablePath, profileDir, headless: this.headless,
          enableRdp: this.enableRdp, locale: this.locale,
        });
      runtime.proc = proc;
      proc.on('message', (method, params, sessionId) => this.#onJugglerMessage(runtime, method, params, sessionId));
      proc.on('close', () => {
        for (const p of this.#pages.values()) {
          if (!p.closed && p.runtime === runtime) {
            p.connected = false;
            this.#pause(p, 'presentation-lost');
          }
        }
      });
      await proc.start();
      if (this.#closed || this.#revoking) {
        const res = await proc.close().catch(() => ({ exited: false }));
        if (ownsLockOnFailure && res?.exited !== false) await releaseProfileLock(lockHandle);
        fail('CONNECTION_CLOSED', 'Browser connection closed during startup');
      }
      if (this.enableRdp && proc.rdpPort) {
        runtime.rdp = this.createRdp ? this.createRdp(proc.rdpPort) : new FirefoxRdpClient(proc.rdpPort);
      }
      runtime.toolbar = new ChromeToolbarClient({
        getRdp: () => runtime.rdp,
        getExpectedNonce: () => runtime.proc?.launchNonce ?? '',
        headless: this.headless || !this.enableRdp,
        locale: this.locale,
        onAction: (action, tabId, mode) => this.#onControlBarAction(action, tabId, mode, runtime),
      });
      this.#runtimes.set(key, runtime);
      return runtime;
    } catch (error) {
      runtime.closed = true;
      runtime.toolbar?.close();
      runtime.rdp?.close();
      const res = await runtime.proc?.close?.().catch(() => ({ exited: false }));
      if (ownsLockOnFailure && res?.exited !== false) await releaseProfileLock(lockHandle);
      throw error;
    }
  }

  async #ensureRuntime(key, opts = {}) {
    if (this.#closed || this.#revoking) fail('CONNECTION_CLOSED', 'Browser connection is closed or terminating revocation');
    const existing = this.#runtimes.get(key);
    if (existing && !existing.closed && existing.proc && !existing.proc.closed) return existing;
    if (this.#runtimeStartFlights.has(key)) return this.#runtimeStartFlights.get(key);
    const flight = this.#startRuntime({ key, ...opts }).finally(() => {
      if (this.#runtimeStartFlights.get(key) === flight) this.#runtimeStartFlights.delete(key);
    });
    this.#runtimeStartFlights.set(key, flight);
    return flight;
  }

  async #ensureDefaultRuntime({ strictPersistent = false } = {}) {
    const existing = this.#runtimes.get('default');
    if (existing && !existing.closed && existing.proc && !existing.proc.closed) {
      if (strictPersistent && existing.persistence !== 'persistent') {
        fail('PROFILE_IN_USE', `Persistent profile "${this.defaultProfileSlug}" is currently held by another live browser process`);
      }
      return existing;
    }
    return this.#ensureRuntime('default', { profileSlug: this.defaultProfileSlug, strictPersistent });
  }

  async #disposeRuntime(runtime, { keepLock = false } = {}) {
    if (!runtime) return { clean: true, failures: [], exited: true };
    if (runtime.closeFlight) {
      const res = await runtime.closeFlight;
      if (!keepLock && runtime.lockHandle && res.exited) {
        const released = await releaseProfileLock(runtime.lockHandle);
        if (released) runtime.lockHandle = null;
        else return { clean: false, exited: res.exited, failures: [...res.failures, { stage: 'lock-release', reason: 'Profile lock token mismatch or unlink failed' }] };
      }
      return res;
    }
    runtime.closed = true;
    runtime.closeFlight = (async () => {
      const failures = [];
      let exited = true;
      try { runtime.toolbar?.close(); } catch (err) { failures.push({ stage: 'toolbar', reason: err.message }); }
      try { runtime.rdp?.close(); } catch (err) { failures.push({ stage: 'rdp', reason: err.message }); }
      if (runtime.proc) {
        try {
          const closeRes = await bounded(Promise.resolve(runtime.proc.close()), 8000, `Camoufox process close (${runtime.key})`);
          if (closeRes?.exited === false || (typeof runtime.proc.exited === 'boolean' && !runtime.proc.exited)) {
            exited = false;
            failures.push({ stage: 'process-exit', reason: 'Camoufox process exit was not confirmed; lock retained' });
          }
        } catch (err) {
          exited = false;
          failures.push({ stage: 'process-exit', reason: err.message });
        }
      }
      // Only release the cross-process lock after affirmative process exit.
      if (!keepLock && runtime.lockHandle && exited && failures.every(f => f.stage !== 'process-exit')) {
        const released = await releaseProfileLock(runtime.lockHandle);
        if (released) {
          runtime.lockHandle = null;
        } else {
          failures.push({ stage: 'lock-release', reason: 'Profile lock token mismatch or unlink failed' });
        }
      }
      if (this.#runtimes.get(runtime.key) === runtime) this.#runtimes.delete(runtime.key);
      return { clean: failures.length === 0, failures, exited };
    })();
    return runtime.closeFlight;
  }

  #profileBadgeLabel(runtime) {
    if (runtime.profileSlug) return runtime.profileSlug;
    if (runtime.persistence === 'ephemeral-busy') {
      return String(this.locale).toLowerCase().startsWith('ko') ? '임시' : 'temp';
    }
    return '';
  }

  #syncControlBar(targetRuntime = null) {
    if (this.#closed) return;
    const targets = targetRuntime ? [targetRuntime] : [...this.#runtimes.values()];
    const elevated = this.#automationMode === 'elevated';
    const canElevate = this.#canElevate();
    for (const runtime of targets) {
      if (!runtime || runtime.closed || !runtime.toolbar) continue;
      const tabs = [...this.#pages.values()]
        .filter(p => !p.closed && p.runtime === runtime)
        .map(p => p.presentation.barEntry({
          title: p.currentTitle,
          url: p.currentUrl,
          browsingContextId: runtime.rdp?.browsingContextId?.(p.id) ?? null,
        }));
      const browserPid = runtime.proc?.pid ?? 0;
      const profileLabel = this.#profileBadgeLabel(runtime);
      const profilePersistent = runtime.persistence === 'persistent';
      const payload = !tabs.length
        ? { elevated, canElevate, profileLabel, profilePersistent, activeId: '', tabs: [], visible: false, browserPid }
        : (() => {
          const activePage = runtime.activeTabId ? this.#pages.get(runtime.activeTabId) : null;
          if (!activePage || activePage.closed || activePage.runtime !== runtime) {
            runtime.activeTabId = tabs.at(-1).id;
          }
          return {
            elevated,
            canElevate,
            profileLabel,
            profilePersistent,
            activeId: runtime.activeTabId,
            tabs,
            visible: true,
            browserPid,
          };
        })();
      runtime.toolbar.sync(payload);
    }
  }

  #flashControlBar(tabId = '') {
    const p = tabId ? this.#pages.get(tabId) : null;
    if (p && !p.closed && p.runtime?.toolbar) {
      p.runtime.toolbar.flash(tabId);
      return;
    }
    for (const runtime of this.#runtimes.values()) {
      if (!runtime.closed) runtime.toolbar?.flash(tabId);
    }
  }

  // Exposed for live/unit tests that simulate a person clicking a Control Bar button.
  triggerControlBarAction(action, tabId = null, mode = null) {
    return this.#onControlBarAction(action, tabId, mode, null);
  }

  #onControlBarAction(action, tabId, mode = null, sourceRuntime = null) {
    if (this.#closed || this.#revoking) return false;
    if (action === 'revoke') { this.#revoke().catch(() => {}); return true; }
    if (action === 'revert-standard') { return this.#revertToStandard(); }
    if (action === 'set-automation-mode') {
      if (mode === 'standard') return this.#revertToStandard();
      if (mode === 'elevated') return this.#elevateByPerson();
      return false;
    }
    if (action === 'resume-all') {
      for (const q of this.#pages.values()) {
        if (!q.closed && (q.presentation.mode !== 'automation' || q.paused)) {
          this.#resume(q).catch(() => {});
        }
      }
      return true;
    }
    let p = null;
    if (tabId) {
      p = this.#pages.get(tabId) ?? null;
      if (!p || p.closed || (sourceRuntime && p.runtime !== sourceRuntime)) return false;
    } else {
      const candidateId = sourceRuntime?.activeTabId ?? this.#activeTabId;
      p = candidateId ? this.#pages.get(candidateId) : null;
      if (p && (p.closed || (sourceRuntime && p.runtime !== sourceRuntime))) p = null;
    }
    if (!p || p.closed) return false;
    if (action === 'stop-automation') {
      this.#pause(p, 'explicit-stop');
      p.presentation.pauseInAutomation('explicit-stop');
      this.#signal(p, { kind: 'state', state: 'stopped' });
      return true;
    }
    if (action === 'take-control') {
      this.#handoff(p, 'human-handoff', 'human').catch(() => {});
      return true;
    }
    if (action === 'resume') {
      this.#resume(p).catch(() => {});
      return true;
    }
    return false;
  }

  #revertToStandard() {
    if (this.#closed || this.#revoking) return false;
    const wasElevated = this.#automationMode === 'elevated';
    this.#revertedThisConnection = true;
    if (wasElevated) {
      // Synchronous downgrade takes effect immediately BEFORE any disk I/O.
      this.#automationMode = 'standard';
      this.#automationModeSource = 'revoked-by-user';
      for (const q of this.#pages.values()) {
        if (q.closed) continue;
        q.presentation.refresh();
        this.#signal(q, { kind: 'state', state: 'automation mode reverted to standard by person' });
      }
      this.#syncControlBar();
    }
    if (!this.#automationModePinned && this.dataRoot) {
      return saveUserPreferences(this.dataRoot, { automationMode: 'standard' })
        .then(() => true)
        .catch(() => false);
    }
    return true;
  }

  async #elevateByPerson() {
    if (!this.#canElevate()) return false;
    try {
      await saveUserPreferences(this.dataRoot, { automationMode: 'elevated' });
    } catch {
      return false;
    }
    // Re-check after disk write in case Revert or Revoke intervened.
    if (!this.#canElevate()) return false;
    this.#automationMode = 'elevated';
    this.#automationModeSource = 'user-preference';
    this.#automationPreferenceReason = null;
    for (const q of this.#pages.values()) {
      if (q.closed) continue;
      q.presentation.refresh();
      this.#signal(q, { kind: 'state', state: 'automation mode elevated by person (saved)' });
    }
    this.#syncControlBar();
    return true;
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
    if (input && p.paused) fail('AUTOMATION_PAUSED', `Automation paused: ${p.paused}; only the person can resume it from the #nav-bar`, { paused: p.paused });
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
    if (p.runtime?.rdp?.connected) p.runtime.rdp.setWatching(p.id, allow).catch(() => {});
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
    if (p.presentation.mode === 'automation' && p.presentation.pausedReason !== reason) {
      p.presentation.pauseInAutomation(reason);
    }
    this.#invalidate(p, reason);
    this.#syncControlBar(p.runtime);
  }

  #ownerPages(owner) { return [...this.#pages.values()].filter(p => !p.closed && p.owner === owner); }

  #assertSessionMutationAllowed(owner, targetProfile = null) {
    const pages = targetProfile ? this.#ownerPages(owner).filter(p => p.profile === targetProfile) : this.#ownerPages(owner);
    const blocked = pages.find(p => p.paused || p.presentation.mode !== 'automation');
    if (blocked) {
      fail('AUTOMATION_PAUSED', `Cannot change browser sessions while ${blocked.id} is paused or under human control (${blocked.paused ?? blocked.presentation.mode})`);
    }
  }

  async #newProfile(owner, { name, temporary, runtime = null, profileSlug = null, isDefault = !temporary, coord = null }) {
    const rt = runtime ?? await this.#ensureDefaultRuntime();
    if (temporary) {
      const created = [...this.#sessions.values()].filter(s => s.owner === owner && s.temporary).length;
      if (created >= MAX_TEMPORARY_SESSIONS) fail('SESSION_LIMIT', `At most ${MAX_TEMPORARY_SESSIONS} temporary browser sessions may be created per caller`);
    }
    const id = `ctx${++this.#sessionSequence}`;
    const downloadDir = path.join(this.dataDir, 'downloads', hash(temporary ? `${owner}\0${id}` : profileSlug ? `${owner}\0profile:${profileSlug}` : owner));
    await mkdir(downloadDir, { recursive: true });

    // Under hook authority, distinct callers sharing one companion must never
    // share the underlying Firefox default BrowserContext (C8 caller isolation).
    const needIsolatedContext = temporary || (isDefault && this.#profiles.size > 0);
    let browserContextId = undefined;
    if (needIsolatedContext) {
      const created = await rt.proc.send('Browser.createBrowserContext', { removeOnDetach: true });
      browserContextId = created.browserContextId;
    }
    const dlRes = await rt.proc.send('Browser.setDownloadOptions', {
      ...(browserContextId ? { browserContextId } : {}),
      downloadOptions: { behavior: 'saveToDisk', downloadsDir: downloadDir },
    }).catch(err => ({ error: err?.message ?? String(err) }));
    const effectivePersistence = temporary || needIsolatedContext ? 'ephemeral' : rt.persistence;
    const effectiveSlug = temporary || needIsolatedContext ? null : (profileSlug ?? rt.profileSlug ?? null);
    const profile = {
      id,
      owner,
      name: name?.trim() || (temporary ? `Session ${id}` : effectiveSlug && !isDefault ? effectiveSlug : 'Default'),
      temporary,
      isDefault,
      profileSlug: effectiveSlug,
      persistence: effectivePersistence,
      runtime: rt,
      runtimeState: 'running',
      coord,
      state: 'open',
      browserContextId,
      downloadDir,
      downloadSetupError: dlRes?.error ?? null,
      downloads: [],
      closeFlight: null,
      devtoolsPrivacy: new PrivacyWindows(() => this.#ownerPages(owner).filter(p => p.profile === profile)
        .every(p => p.presentation.mode === 'automation')),
    };
    this.#sessions.set(id, profile);
    if (browserContextId) rt.byBrowserContext.set(browserContextId, profile);
    return profile;
  }

  async #defaultProfile(owner, { strictPersistent = false } = {}) {
    let profile = this.#profiles.get(owner);
    if (profile) {
      if (strictPersistent && profile.persistence !== 'persistent') {
        fail('PROFILE_IN_USE', `Persistent profile "${this.defaultProfileSlug}" is currently held by another live browser process`);
      }
      return profile;
    }
    const rt = await this.#ensureDefaultRuntime({ strictPersistent });
    profile = await this.#newProfile(owner, {
      name: 'Default',
      temporary: false,
      runtime: rt,
      profileSlug: rt.profileSlug,
      isDefault: true,
    });
    this.#profiles.set(owner, profile);
    return profile;
  }

  async #bindPersistentProfile(owner, slug, displayName) {
    if (!this.persistentProfilesEnabled || !this.profilesRoot) {
      fail('PERSISTENT_PROFILES_DISABLED', 'Named persistent profiles are disabled (set WB_PERSISTENT_PROFILE=1 or use connection authority)');
    }
    if (slug === this.defaultProfileSlug) {
      const existingOwn = [...this.#sessions.values()].find(
        s => s.owner === owner && s.state === 'open' && s.persistence === 'persistent' && s.profileSlug === slug,
      );
      if (existingOwn) return existingOwn;
      const existingOther = [...this.#sessions.values()].find(
        s => s.owner !== owner && s.state === 'open' && s.persistence === 'persistent' && s.profileSlug === slug,
      );
      if (existingOther || (this.authorityMode === 'hook' && this.#profiles.size > 0 && !this.#profiles.has(owner))) {
        fail('PROFILE_IN_USE', `Persistent profile "${slug}" is currently in use by another caller`);
      }
      const flightKey = `${owner}\0${slug}`;
      if (this.#profileBindFlights.has(flightKey)) return this.#profileBindFlights.get(flightKey);
      const flight = this.#defaultProfile(owner, { strictPersistent: true }).finally(() => {
        if (this.#profileBindFlights.get(flightKey) === flight) this.#profileBindFlights.delete(flightKey);
      });
      this.#profileBindFlights.set(flightKey, flight);
      return flight;
    }

    // Synchronous per-slug reservation & capacity check before any await
    // prevents cross-caller races and concurrent capacity-limit bypass.
    const existingCoord = this.#slugCoords.get(slug);
    if (existingCoord) {
      if (existingCoord.owner !== owner) {
        fail('PROFILE_IN_USE', `Persistent profile "${slug}" is currently in use by another caller`);
      }
      if (existingCoord.closing) {
        fail('PROFILE_IN_USE', `Persistent profile "${slug}" is currently closing; wait and retry`);
      }
      if (existingCoord.profile && existingCoord.profile.state === 'open') {
        return existingCoord.profile;
      }
      if (existingCoord.bindFlight) {
        return existingCoord.bindFlight;
      }
    }
    if (this.#activePersistentCount() >= MAX_PERSISTENT_PROFILES) {
      fail('PROFILE_LIMIT', `At most ${MAX_PERSISTENT_PROFILES} persistent profiles may be open simultaneously in one connection`);
    }

    const coord = {
      slug,
      owner,
      profile: null,
      lockHandle: null,
      runtime: null,
      runtimeGen: 0,
      activeOps: 0,
      idleTimer: null,
      closing: false,
      bindFlight: null,
      transition: Promise.resolve(),
    };
    this.#slugCoords.set(slug, coord);

    const flight = this.#enqueueCoord(coord, async () => {
      let rt = null;
      try {
        rt = await this.#startRuntime({ key: `profile:${slug}`, profileSlug: slug, strictPersistent: true });
        coord.lockHandle = rt.lockHandle;
        coord.runtime = rt;
        coord.runtimeGen++;
        const profile = await this.#newProfile(owner, {
          name: displayName?.trim() || slug,
          temporary: false,
          runtime: rt,
          profileSlug: slug,
          isDefault: false,
          coord,
        });
        coord.profile = profile;
        this.#scheduleProfileIdle(profile);
        return profile;
      } catch (error) {
        if (rt) {
          const disposed = await this.#disposeRuntime(rt, { keepLock: false });
          if (disposed.clean) coord.lockHandle = null;
        } else if (coord.lockHandle) {
          await releaseProfileLock(coord.lockHandle);
          coord.lockHandle = null;
        }
        if (!coord.lockHandle && this.#slugCoords.get(slug) === coord) {
          this.#slugCoords.delete(slug);
        }
        throw error;
      } finally {
        if (coord.bindFlight === flight) coord.bindFlight = null;
      }
    });
    coord.bindFlight = flight;
    return flight;
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
    const runtimeState = profile.state !== 'open'
      ? 'closed'
      : profile.runtime && !profile.runtime.closed ? 'running' : 'dormant';
    return {
      sessionId: profile.id,
      name: profile.name,
      profile: profile.profileSlug ?? null,
      persistent: profile.persistence === 'persistent',
      persistence: profile.persistence,
      runtimeState,
      temporary: profile.temporary,
      isolated: true,
      isDefault: profile.isDefault,
      state: profile.state,
      tabCount: [...this.#pages.values()].filter(p => !p.closed && p.profile === profile).length,
    };
  }

  #onJugglerMessage(runtime, method, params, sessionId) {
    if (method === 'Browser.attachedToTarget') {
      const info = params.targetInfo ?? {};
      const targetId = info.targetId;
      if (runtime.bySessionId.has(params.sessionId)) return;
      const opener = info.openerId ? runtime.byTargetId.get(info.openerId) : null;
      if (opener && !opener.closed && opener.profile.state === 'open') {
        const popup = this.#registerPage({
          owner: opener.owner, profile: opener.profile, runtime,
          sessionId: params.sessionId, targetId,
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
      if (targetId) {
        const waiter = runtime.attachWaiters.get(targetId);
        if (waiter) {
          runtime.attachWaiters.delete(targetId);
          waiter(params);
        } else {
          runtime.bufferedAttaches.set(targetId, params);
        }
      }
      return;
    }
    if (method === 'Browser.detachedFromTarget') {
      const p = runtime.bySessionId.get(params.sessionId) ?? runtime.byTargetId.get(params.targetId);
      if (p && !p.closed) this.#closePageRecord(p);
      return;
    }
    if (method === 'Browser.downloadCreated') {
      const p = runtime.byTargetId.get(params.pageTargetId);
      if (!p || p.closed) return;
      const isPrivate = p.presentation.mode !== 'automation';
      const safeName = path.basename(String(params.suggestedFileName || 'download')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'download';
      const item = {
        id: params.uuid, tabId: p.id, url: params.url,
        filename: safeName,
        path: path.join(p.profile.downloadDir, params.uuid),
        state: 'progressing', receivedBytes: 0, totalBytes: 0, private: isPrivate,
      };
      runtime.downloadsByUuid.set(params.uuid, { item, page: p });
      if (!isPrivate) {
        p.downloads.push(item);
        p.profile.downloads.push(item);
        this.#signal(p, { kind: 'download', id: item.id, name: safeName, state: 'started', bytes: 0 });
      }
      return;
    }
    if (method === 'Browser.downloadFinished') {
      const record = runtime.downloadsByUuid.get(params.uuid);
      if (!record) return;
      const { item, page: p } = record;
      item.state = params.canceled ? 'cancelled' : params.error ? 'interrupted' : 'completed';
      if (params.error) item.error = params.error;
      if (!item.private && !p.closed) {
        this.#signal(p, { kind: 'download', id: item.id, name: item.filename, state: item.state, bytes: item.receivedBytes });
      }
      this.#scheduleProfileIdle(p.profile);
      return;
    }
    if (sessionId) {
      const p = runtime.bySessionId.get(sessionId);
      if (p && !p.closed) p.driver.onMessage(method, params);
      else if (!p) {
        let queue = runtime.earlyMessages.get(sessionId);
        if (!queue) { queue = []; runtime.earlyMessages.set(sessionId, queue); }
        if (queue.length < 256) queue.push({ method, params });
      }
    }
  }

  #registerPage({ owner, profile, runtime, sessionId, targetId, actor = null }) {
    const id = `t${++this.#tabSequence}`;
    const navListeners = new Set();
    const p = {
      id, owner, profile, runtime, sessionId, targetId, actor,
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
      onSync: () => this.#syncControlBar(runtime),
    });
    p.devtools = new DevToolsRecorder(
      () => p.presentation.mode,
      sid => (typeof sid === 'string' && sid.startsWith('rdp:service_worker') ? 'service_worker'
        : typeof sid === 'string' && sid.startsWith('rdp:shared_worker') ? 'shared_worker'
          : typeof sid === 'string' && (sid.startsWith('worker:') || sid.startsWith('rdp:worker')) ? 'worker' : 'iframe'),
      profile.devtoolsPrivacy,
    );
    p.driver = new CamoufoxFrameDriver({
      page: p, process: runtime.proc, sessionId, rdp: runtime.rdp,
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
    runtime.bySessionId.set(sessionId, p);
    runtime.byTargetId.set(targetId, p);
    const early = runtime.earlyMessages.get(sessionId);
    if (early) {
      runtime.earlyMessages.delete(sessionId);
      for (const msg of early) p.driver.onMessage(msg.method, msg.params);
    }
    runtime.activeTabId = id;
    this.#activeTabId = id;
    this.#syncControlBar(runtime);
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
    p.runtime?.rdp?.detachTab(p.id);
    this.nativeRequests.withdrawPage(p);
    this.#refs.retireTab(p.id);
    p.presentation.destroy();
    p.runtime?.bySessionId.delete(p.sessionId);
    p.runtime?.byTargetId.delete(p.targetId);
    this.#queue.abort(p.id, new BrowserHostError('CLOSED_TAB', 'Tab closed'));
    this.#syncControlBar(p.runtime);
    this.#scheduleProfileIdle(p.profile);
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
      if (isProtectedInternalPath(resolved, { dataRoot: this.dataRoot, connectionDataDir: this.dataDir })) {
        fail('INVALID_UPLOAD_FILE', 'Uploading internal browser profile, preference, or connection control files is refused');
      }
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
    return this.#withProfileRuntime(profile, async runtime => {
      if (!runtime || runtime.closed || !runtime.proc || runtime.proc.closed) {
        fail('CLOSED_SESSION', `Browser runtime for session ${profile.id} is closed`);
      }
      const res = await runtime.proc.send('Browser.newPage', profile.browserContextId ? { browserContextId: profile.browserContextId } : {}, undefined, { signal });
      const targetId = res.targetId;
      if (!targetId) fail('BROWSER_ERROR', 'Camoufox did not return a targetId for Browser.newPage');

      let attachedInfo = runtime.bufferedAttaches.get(targetId) ?? null;
      if (attachedInfo) {
        runtime.bufferedAttaches.delete(targetId);
      } else {
        const waitAttach = new Promise(resolve => { runtime.attachWaiters.set(targetId, resolve); });
        try {
          attachedInfo = await bounded(waitAttach, 10000, 'Camoufox page attach', signal);
        } finally {
          runtime.attachWaiters.delete(targetId);
        }
      }
      if (profile.state !== 'open' || runtime.closed || this.#closed || this.#revoking) {
        await runtime.proc.send('Page.close', {}, attachedInfo.sessionId, { timeoutMs: 3000 }).catch(() => {});
        fail('CLOSED_SESSION', 'Browser session closed during page creation');
      }
      const p = this.#registerPage({
        owner, profile, runtime, sessionId: attachedInfo.sessionId, targetId,
        actor: caller.requestOwner ?? { caller, signal },
      });
      await p.driver.start();
      const root = await p.driver.waitForRootFrame(2000, signal);
      if (!root) fail('ROOT_UNAVAILABLE', 'Camoufox root frame failed to initialize');
      // Attach Firefox RDP watcher BEFORE initial navigation so worker/SW
      // network resources and eager console reads are active from the first load.
      if (runtime.rdp) {
        await runtime.rdp.attachTab(p.id, {
          matchTab: t => t.url === 'about:blank' || t.url === url,
          onResource: (phase, rtype, item, _from, target) => {
            p.devtools.recordRdp(phase, rtype, item, target?.targetType || null);
          },
          watchResources: p.presentation.mode === 'automation',
        }).catch(() => {});
        this.#syncControlBar(runtime);
      }
      await this.#navigatePage(p, url, signal);
      return p;
    });
  }

  async #navigatePage(p, url, signal, { settleFollows = false } = {}) {
    const root = p.driver.rootFrame();
    if (!root) fail('ROOT_UNAVAILABLE', 'Root frame unavailable');
    let dclResolve;
    const dclPromise = new Promise(resolve => { dclResolve = resolve; });
    p.onDomContentLoaded = fid => { if (fid === root.frameId) dclResolve?.(); };
    try {
      await p.driver.send('Page.navigate', { frameId: root.frameId, url }, signal);
      await bounded(dclPromise, 15000, 'Page navigation', signal).catch(() => {});
      if (!settleFollows) await pause(80, signal);
    } finally {
      p.onDomContentLoaded = null;
    }
    p.currentUrl = p.driver.rootFrame()?.url || url;
    if (p.runtime?.rdp) {
      p.runtime.rdp.attachTab(p.id, {
        matchTab: t => t.url === p.currentUrl,
        onResource: (phase, rtype, item, _from, target) => {
          p.devtools.recordRdp(phase, rtype, item, target?.targetType || null);
        },
        watchResources: p.presentation.mode === 'automation',
      }).then(() => this.#syncControlBar(p.runtime)).catch(() => {});
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
    if (p.currentUrl !== prevUrl || p.currentTitle !== prevTitle) this.#syncControlBar(p.runtime);
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
    const left = Math.max(0, Math.min(shot.w - TILE, Math.floor(x - TILE / 2)));
    const top = Math.max(0, Math.min(shot.h - TILE, Math.floor(y - TILE / 2)));
    const tileW = Math.max(1, Math.min(TILE, shot.w - left));
    const tileH = Math.max(1, Math.min(TILE, shot.h - top));
    const current = typeof p.driver.screenshotClip === 'function'
      ? await p.driver.screenshotClip({ x: now.x + left, y: now.y + top, width: tileW, height: tileH }, signal)
      : await p.driver.screenshot(signal);
    shot.decoded ??= decodePngPixels(shot.buffer);
    if (!pngClipMatchesTile(shot.buffer, current.buffer, shot.w, shot.h, left, top, tileW, tileH, shot.decoded)) {
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

  async #closeProfileSession(caller, profile) {
    if (profile.closeFlight) return profile.closeFlight;
    if (profile.state !== 'open') {
      return {
        disposition: 'executed',
        ...this.#sessionInfo(profile),
        ...(profile.persistence === 'persistent' ? { storagePreserved: true } : {}),
        closedTabIds: [],
        cleanupComplete: profile.state === 'closed',
      };
    }
    this.#assertSessionMutationAllowed(caller.sessionId, profile);
    profile.state = 'closing';
    const coord = profile.coord;
    if (coord) {
      coord.closing = true;
      this.#cancelProfileIdle(coord);
    }
    const pages = this.#ownerPages(caller.sessionId).filter(q => q.profile === profile);
    const closedTabIds = pages.map(q => q.id);

    const runClose = async () => {
      const failures = [];
      const rt = profile.runtime;
      for (const p of pages) {
        p.closedByAgent = true;
        if (rt?.proc && !rt.proc.closed) {
          try { await rt.proc.send('Page.close', {}, p.sessionId, { timeoutMs: 5000 }); }
          catch (err) { failures.push({ stage: `tab ${p.id}`, reason: err.message }); }
        }
        this.#closePageRecord(p);
      }
      if (rt?.proc && !rt.proc.closed) {
        for (const dl of profile.downloads) {
          if (dl.state === 'progressing') {
            await rt.proc.send('Browser.cancelDownload', { uuid: dl.id }, undefined, { timeoutMs: 3000 }).catch(() => {});
          }
        }
      }
      if (profile.temporary) {
        if (profile.browserContextId && rt?.proc && !rt.proc.closed) {
          try {
            await rt.proc.send('Browser.removeBrowserContext', { browserContextId: profile.browserContextId }, undefined, { timeoutMs: 5000 });
          } catch (err) {
            failures.push({ stage: 'removeBrowserContext', reason: err.message });
          }
          rt.byBrowserContext.delete(profile.browserContextId);
        }
      } else {
        // Named persistent profile: shut down its live Camoufox process (if awake)
        // and release its lock ONLY after affirmative exit (or directly if dormant),
        // preserving all on-disk login storage.
        if (rt && !rt.closed) {
          const disposed = await this.#disposeRuntime(rt, { keepLock: false });
          failures.push(...disposed.failures);
          if (coord && disposed.clean) coord.lockHandle = null;
        } else if (coord?.lockHandle) {
          const released = await releaseProfileLock(coord.lockHandle);
          if (released) coord.lockHandle = null;
          else failures.push({ stage: 'lock-release', reason: 'Profile lock token mismatch or unlink failed' });
        }
        profile.runtime = null;
        if (coord) {
          coord.runtime = null;
          if (!coord.lockHandle && this.#slugCoords.get(coord.slug) === coord) {
            this.#slugCoords.delete(coord.slug);
          }
        }
      }
      profile.runtimeState = 'closed';
      profile.state = failures.length ? 'cleanup-failed' : 'closed';
      return {
        disposition: failures.length ? 'failed' : 'executed',
        ...this.#sessionInfo(profile),
        ...(!profile.temporary ? { storagePreserved: true } : {}),
        closedTabIds,
        cleanupComplete: failures.length === 0,
        ...(failures.length ? { code: 'SESSION_CLEANUP_FAILED', replaySafe: false, failures } : {}),
      };
    };

    profile.closeFlight = coord ? this.#enqueueCoord(coord, runClose) : runClose();
    return profile.closeFlight;
  }

  async #execute(args, caller, requestSignal) {
    this.#assertCaller(caller, requestSignal);
    const signal = requestSignal ? AbortSignal.any([caller.signal, requestSignal]) : caller.signal;
    const { action } = args;

    if (action === 'status') return this.status();
    if (action === 'revoke') return this.#revoke();

    if (action === 'list_profiles') {
      const activeBySlug = new Map();
      for (const s of this.#sessions.values()) {
        if (s.state !== 'open' || s.persistence !== 'persistent' || !s.profileSlug) continue;
        if (s.owner === caller.sessionId) {
          activeBySlug.set(s.profileSlug, {
            sessionId: s.id,
            sessionName: s.name,
            runtimeState: s.runtime && !s.runtime.closed ? 'running' : 'dormant',
            tabCount: this.#ownerPages(caller.sessionId).filter(p => p.profile === s).length,
          });
        }
      }
      const profiles = await inspectProfiles(this.profilesRoot, {
        activeBySlug,
        persistenceEnabled: Boolean(this.persistentProfilesEnabled && this.profilesRoot),
      });
      // Mark profiles held or reserved by another caller inside this same companion as in-use-other without leaking their handles.
      for (const s of this.#sessions.values()) {
        if (s.state !== 'open' || s.persistence !== 'persistent' || !s.profileSlug || s.owner === caller.sessionId) continue;
        const entry = profiles.find(row => row.profile === s.profileSlug);
        if (entry) entry.state = 'in-use-other';
      }
      for (const [slug, coord] of this.#slugCoords) {
        if (coord.owner === caller.sessionId) continue;
        const entry = profiles.find(row => row.profile === slug);
        if (entry) entry.state = 'in-use-other';
      }
      return {
        supported: true,
        engine: 'camoufox',
        persistenceEnabled: Boolean(this.persistentProfilesEnabled && this.profilesRoot),
        profiles,
      };
    }

    if (action === 'create_session') {
      this.#assertSessionMutationAllowed(caller.sessionId);
      const profile = args.profile !== undefined
        ? await this.#bindPersistentProfile(caller.sessionId, args.profile, args.name)
        : await this.#newProfile(caller.sessionId, { name: args.name, temporary: true });
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
      return this.#closeProfileSession(caller, profile);
    }

    if (action === 'list_tabs') {
      const tabs = this.#ownerPages(caller.sessionId).map(p => {
        const priv = p.presentation.mode !== 'automation';
        return {
          tabId: p.id, sessionId: p.profile.id, sessionName: p.profile.name,
          profile: p.profile.profileSlug ?? null,
          persistent: p.profile.persistence === 'persistent',
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
        const rdp = p.runtime?.rdp;
        if (rdpActor && rdp?.connected) {
          const [hdrs, reqBody] = await Promise.all([
            rdp.getNetworkHeaders(rdpActor, signal).catch(() => ({})),
            rdp.getNetworkPostData(rdpActor, signal).catch(() => undefined),
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
      const prefix = `${p.owner}\0${p.profile.id}\0`;
      const defaultPrefix = `${p.owner}\0default\0`;
      const grants = [];
      for (const [k, state] of this.#permissionGrants.entries()) {
        const matchedPrefix = k.startsWith(prefix) ? prefix : (p.profile.isDefault && k.startsWith(defaultPrefix) ? defaultPrefix : null);
        if (!matchedPrefix) continue;
        const rest = k.slice(matchedPrefix.length);
        const sep = rest.lastIndexOf('\0');
        if (sep < 0) continue;
        grants.push({ origin: rest.slice(0, sep), kind: rest.slice(sep + 1), state });
      }
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
          ? `mode ${res.mode}; the #nav-bar flashes for the person. Only the person can return control; no tool can resume`
          : `mode ${res.mode}; handoff did not finish entering native control; the person can use Take control or Resume in the #nav-bar`,
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
      await p.runtime?.proc?.send('Page.close', {}, p.sessionId, { timeoutMs: 5000 }).catch(() => {});
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
          await this.#navigatePage(p, pageURL(args.url), laneSignal, { settleFollows: true });
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
          bounds: SHORT_PROBE_ACTIONS.has(args.action) ? { probeMs: 20 } : undefined,
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
    const inspected = await p.driver.inspectTarget(frame.frameId, entry.id, entry.documentId, signal);
    if (inspected?.stale || inspected?.missing) {
      this.#refs.retireDocument(p.id, entry.frameId, null);
      this.#staleRef(p, entry, 'belongs to a replaced document');
    }
    if (!inspected?.described) {
      this.#refs.gone(p.id, entry.frameId, entry.documentId, [entry.id]);
      this.#staleRef(p, entry, 'was removed');
    }
    if (inspected.described.role !== entry.role || inspected.described.name !== entry.name) {
      this.#staleRef(p, entry, 'changed its role or name');
    }
    const item = p.model?.byKey.get(`${entry.frameId}:${entry.documentId}:${entry.id}`);
    const now = inspected.view ?? await p.driver.inView(frame.frameId, entry.id, entry.documentId, signal);
    const needsScroll = !now.inView || (frame.parentId && !item?.inView);
    const keepObject = args.action !== 'click';
    let resolved = null;
    if (needsScroll || keepObject) {
      resolved = await p.driver.resolveObject(frame.frameId, entry.id, entry.documentId, signal);
    }
    try {
      if (needsScroll) {
        await p.driver.prepare(frame.frameId, resolved.objectId, () => onPreparation('scrolled'),
          now.proxied ? { id: entry.id, documentId: entry.documentId } : null, signal);
        if (!keepObject) {
          p.driver.disposeObject(resolved.frame, resolved.objectId);
          resolved = null;
        }
      }
      this.#owned(p.id, caller, signal, true);
      const point = await p.driver.pointFor(frame.frameId, entry.id, entry.documentId, signal);
      this.#owned(p.id, caller, signal, true);
      return {
        frame: resolved?.frame ?? frame,
        entry,
        ref: entry.ref,
        objectId: resolved?.objectId ?? null,
        point,
        info: inspected.info ?? null,
      };
    } catch (error) {
      if (resolved?.objectId) p.driver.disposeObject(resolved.frame, resolved.objectId);
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
        outcome = await p.driver.disarmGuard(frame.frameId, type !== 'pointerdown').catch(() => null);
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

    const info = target.info ?? await p.driver.callOn(frame, objectId, `function() {
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
        fail('SENSITIVE_INPUT_REFUSED', 'Typing into sensitive fields (passwords, OTP, verification codes) requires human handoff in standard mode; clear with text:"" or enable elevated mode');
      }
    };
    assertSensitiveInputAllowed();

    // Focus and verify the validated element in one RPC before keyboard input.
    const ensureFocused = async () => {
      const stillLive = await p.driver.callOn(frame, objectId, `function(){
        if (!this.isConnected || this.disabled || this.readOnly) return false;
        if (this.getRootNode().activeElement !== this) this.focus({ preventScroll: true });
        return this.isConnected && !this.disabled && !this.readOnly && this.getRootNode().activeElement === this;
      }`, [], true, signal);
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
    // Check effective automationMode synchronously right at the final text send
    // boundary so an intervening Revert prevents any characters from dispatching.
    const beforeSensitiveInsert = () => {
      assertSensitiveInputAllowed();
      markSent();
    };
    if (args.action === 'fill') {
      await ensureFocused();
      const clearOutcome = await guarded('keydown', () => p.driver.dispatchSelectAllDelete({
        beforeSend: () => { if (args.text) assertSensitiveInputAllowed(); markSent(); },
        signal,
      }));
      if (missed(clearOutcome)) { state.code = 'TARGET_MISMATCH'; return; }
      if (args.text) {
        assertSensitiveInputAllowed();
        await ensureFocused();
        const insOutcome = await guarded('beforeinput', () => p.driver.dispatchInsertText(args.text, { beforeSend: beforeSensitiveInsert, signal }));
        if (missed(insOutcome)) state.code = 'TARGET_MISMATCH';
      }
      return;
    }
    if (args.action === 'type' && args.text) {
      assertSensitiveInputAllowed();
      await ensureFocused();
      const insOutcome = await guarded('beforeinput', () => p.driver.dispatchInsertText(args.text, { beforeSend: beforeSensitiveInsert, signal }));
      if (missed(insOutcome)) state.code = 'TARGET_MISMATCH';
    }
  }

  async grantPermission(owner, origin, kind, targetProfile = null) {
    const mapped = mapPermissionKind(kind);
    if (!mapped) fail('UNSUPPORTED_PERMISSION', `Permission ${kind} is not supported on Camoufox/Firefox`);
    if (!this.policy.permits(kind)) fail('POLICY_DENIED', `Policy does not delegate ${kind}`);
    if (targetProfile?.coord) {
      if (targetProfile.owner !== owner) fail('FOREIGN_SESSION', 'Cannot grant permissions on another caller session');
      await this.#withProfileRuntime(targetProfile, async runtime => {
        await runtime.proc.send('Browser.grantPermissions', { origin, permissions: [mapped] });
      });
      this.#permissionGrants.set(`${owner}\0${targetProfile.id}\0${origin}\0${kind}`, 'allow');
      return;
    }
    const runtime = targetProfile?.runtime ?? await this.#ensureDefaultRuntime();
    await runtime.proc.send('Browser.grantPermissions', {
      origin, permissions: [mapped],
      ...(targetProfile?.browserContextId ? { browserContextId: targetProfile.browserContextId } : {}),
    });
    this.#permissionGrants.set(`${owner}\0${targetProfile?.id ?? 'default'}\0${origin}\0${kind}`, 'allow');
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
    this.nativeRequests.close();
    for (const coord of this.#slugCoords.values()) {
      coord.closing = true;
      this.#cancelProfileIdle(coord);
    }
    for (const p of this.#pages.values()) {
      if (!p.closed) { p.closedByAgent = true; this.#closePageRecord(p); }
    }
    // Wait for any in-flight runtime startups, profile binds, or slug transitions so nothing leaks.
    await Promise.allSettled([
      ...this.#runtimeStartFlights.values(),
      ...this.#profileBindFlights.values(),
      ...[...this.#slugCoords.values()].map(c => c.transition),
    ]);
    await Promise.allSettled([
      ...this.#runtimes.values().map(runtime => this.#disposeRuntime(runtime)),
      Promise.resolve(this.createRunnerSandbox?.close?.()),
    ]);
    // Release any locks still held by dormant named persistent profiles.
    await Promise.allSettled([...this.#slugCoords.values()].map(async coord => {
      if (coord.lockHandle && (!coord.runtime || coord.runtime.closed)) {
        const released = await releaseProfileLock(coord.lockHandle);
        if (released) coord.lockHandle = null;
      }
    }));
    this.#slugCoords.clear();
  }
}
