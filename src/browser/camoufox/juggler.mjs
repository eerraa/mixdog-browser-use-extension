// Pure-Node Juggler pipe transport for Camoufox (patched Firefox 158).
// Talks directly to `camoufox.exe -juggler-pipe -silent` over stdio fds 3/4
// using NUL-delimited JSON-RPC, with zero Python or Playwright dependencies.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { bounded } from '../../shared/async.mjs';

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }, () => resolve());
    });
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  return Promise.resolve();
}

const READY_MARKER = 'Juggler listening to the pipe';
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 20000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const CHUNK_SIZE = 2048;

export async function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

// Split JSON env payload into CAMOU_CONFIG_1..N / CAMOU_PREFS_1..N chunks
// matching Camoufox's camoufox.cfg / MaskConfig loader (Windows env value cap).
export function chunkCamouEnv(prefix, object) {
  const raw = JSON.stringify(object);
  const out = {};
  for (let i = 0, n = 1; i < raw.length; i += CHUNK_SIZE, n++) {
    out[`${prefix}_${n}`] = raw.slice(i, i + CHUNK_SIZE);
  }
  return out;
}

export function defaultCamouConfig({ version = '158.0', locale = 'ko-KR' } = {}) {
  const major = String(version).split('.')[0] || '158';
  const [lang = 'ko', region = 'KR'] = String(locale).split(/[-_]/);
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`;
  const acceptLang = lang.toLowerCase() === 'ko'
    ? 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    : `${locale},${lang};q=0.9,en-US;q=0.8,en;q=0.7`;
  return {
    'navigator.userAgent': ua,
    'navigator.platform': 'Win32',
    'navigator.oscpu': 'Windows NT 10.0; Win64; x64',
    'navigator.language': locale,
    'headers.User-Agent': ua,
    'headers.Accept-Language': acceptLang,
    'locale:language': lang.toLowerCase(),
    'locale:region': region.toUpperCase(),
  };
}

export function defaultCamouPrefs({ enableRdp = true, hardenedRunner = false } = {}) {
  const prefs = {
    'devtools.debugger.remote-enabled': Boolean(enableRdp),
    'devtools.debugger.prompt-connection': false,
    'devtools.debugger.force-local': true,
    'devtools.chrome.enabled': Boolean(enableRdp),
    'focusmanager.testmode': true,
    // Keep new windows/tabs from grabbing foreground focus away from the user's active app.
    'browser.tabs.loadDivertedInBackground': true,
    'browser.tabs.loadInBackground': true,
    'dom.disable_window_flip': true,
    'browser.startup.preXulSkeletonUI': false,
    // Block unsolicited persistent-storage doorhangers by default (SitePermissions
    // DENY_ACTION = 2); explicit per-origin user decisions and normal cookies /
    // localStorage / IndexedDB persistence remain intact.
    'permissions.default.persistent-storage': 2,
  };
  if (hardenedRunner) {
    Object.assign(prefs, {
      'media.peerconnection.enabled': false,
      'network.dns.disablePrefetch': true,
      'network.dns.disablePrefetchFromHTTPS': true,
      'network.http.speculative-parallel-limit': 0,
      'network.predictor.enabled': false,
      'devtools.debugger.remote-enabled': false,
      'devtools.chrome.enabled': false,
    });
  }
  return prefs;
}

/**
 * Low-level NUL-delimited JSON-RPC transport over a pair of readable/writable
 * streams (Camoufox's Juggler pipe fds 3 and 4, or an in-memory mock in tests).
 */
export class JugglerTransport extends EventEmitter {
  #write;
  #read;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  constructor(writeStream, readStream) {
    super();
    this.#write = writeStream;
    this.#read = readStream;
    this.#read.on('data', chunk => this.#onData(chunk));
    this.#read.on('error', error => this.close(error));
    this.#read.on('end', () => this.close());
    this.#write.on('error', error => this.close(error));
  }

  get closed() { return this.#closed; }

  #onData(chunk) {
    if (this.#closed) return;
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      this.close(new Error('Juggler frame exceeded size limit'));
      return;
    }
    let idx;
    while ((idx = this.#buffer.indexOf(0)) !== -1) {
      const raw = this.#buffer.subarray(0, idx).toString('utf8');
      this.#buffer = this.#buffer.subarray(idx + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); }
      catch (error) { this.close(new Error(`Malformed Juggler JSON: ${error.message}`)); return; }
      if (msg.id !== undefined) {
        const entry = this.#pending.get(msg.id);
        if (!entry) continue;
        this.#pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          const text = msg.error.message || JSON.stringify(msg.error);
          entry.reject(Object.assign(new Error(text), { jugglerError: msg.error }));
        } else {
          entry.resolve(msg.result ?? {});
        }
      } else if (typeof msg.method === 'string') {
        this.emit('message', msg.method, msg.params ?? {}, msg.sessionId);
      }
    }
  }

  /**
   * Send a Juggler command. Like CDP's execution fence, caller abort settles
   * the caller promise immediately while returning/tracking the actual browser
   * promise separately when requested via `sendRaw`.
   */
  sendRaw(method, params = {}, sessionId = undefined, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    if (this.#closed) return Promise.reject(new Error(`Juggler transport closed before ${method}`));
    const id = this.#nextId++;
    const payload = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error(`Juggler ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write.write(`${JSON.stringify(payload)}\0`);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  send(method, params = {}, sessionId = undefined, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
    const actual = this.sendRaw(method, params, sessionId, timeoutMs);
    if (!signal) return actual;
    return bounded(actual, timeoutMs, `Juggler ${method}`, signal);
  }

  close(reason) {
    if (this.#closed) return;
    this.#closed = true;
    const error = reason instanceof Error ? reason : new Error(reason ? String(reason) : 'Juggler transport closed');
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
    try { this.#write.end(); } catch { /* ignore */ }
    try { this.#read.destroy(); } catch { /* ignore */ }
    this.emit('close', error);
  }
}

/**
 * Owns one Camoufox process launched with `-juggler-pipe -silent` and optional
 * `--start-debugger-server <loopbackPort>` for read-only Firefox RDP DevTools.
 */
export class CamoufoxProcess extends EventEmitter {
  #child = null;
  #transport = null;
  #exited = Promise.resolve({ code: 0, signal: null });
  #closing = false;
  #closeFlight = null;
  #processExited = false;
  #rdpPort = null;

  constructor({ executablePath, profileDir, headless = false, enableRdp = true, hardenedRunner = false,
    locale = 'ko-KR', camouConfig = null, extraPrefs = null, env = process.env, spawnImpl = spawn }) {
    super();
    this.executablePath = executablePath;
    this.profileDir = profileDir;
    this.headless = headless;
    this.enableRdp = enableRdp && !hardenedRunner;
    this.hardenedRunner = hardenedRunner;
    this.locale = locale;
    this.camouConfig = camouConfig;
    this.extraPrefs = extraPrefs;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.info = null;
    this.launchNonce = randomBytes(24).toString('base64url');
  }

  get transport() { return this.#transport; }
  get rdpPort() { return this.#rdpPort; }
  get pid() { return this.#child?.pid ?? null; }
  get exited() { return this.#processExited; }
  get closed() { return this.#closing || this.#processExited || !this.#transport || this.#transport.closed; }

  async start(signal = null) {
    signal?.throwIfAborted();
    mkdirSync(this.profileDir, { recursive: true });
    this.#rdpPort = this.enableRdp ? await allocateLoopbackPort() : null;
    signal?.throwIfAborted();
    const args = ['-no-remote', ...(process.platform === 'win32' ? ['-wait-for-browser'] : []), '-profile', this.profileDir, '-juggler-pipe', '-silent'];
    if (this.#rdpPort) args.push('--start-debugger-server', String(this.#rdpPort));
    if (this.headless) args.push('-headless');

    const config = this.camouConfig ?? (this.hardenedRunner ? {} : defaultCamouConfig({ locale: this.locale }));
    const prefs = { ...defaultCamouPrefs({ enableRdp: this.enableRdp, hardenedRunner: this.hardenedRunner }), ...(this.extraPrefs ?? {}) };
    const env = {
      ...this.env,
      MOZ_NO_REMOTE: '1',
      // Prevent Windows Shift key held in another app at launch from opening Safe Mode.
      MOZ_DISABLE_SAFE_MODE_KEY: '1',
      // Unforgeable per-launch nonce inherited across Windows -wait-for-browser
      // launcher→browser process handoff so RDP toolbar mount verifies ownership.
      WB_LAUNCH_NONCE: this.launchNonce,
      ...(Object.keys(config).length ? chunkCamouEnv('CAMOU_CONFIG', config) : {}),
      ...chunkCamouEnv('CAMOU_PREFS', prefs),
    };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = this.spawnImpl(this.executablePath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: this.headless,
    });
    this.#child = child;
    this.#processExited = false;

    let stdout = '', stderr = '';
    const exit = new Promise(resolve => {
      let settled = false;
      const done = info => {
        if (!settled) {
          settled = true;
          this.#processExited = true;
          resolve(info);
        }
      };
      child.once('exit', (code, sig) => done({ code, signal: sig }));
      child.once('error', error => done({ code: null, signal: null, error: error?.message }));
    });
    this.#exited = exit;

    const rdpMarker = this.#rdpPort ? `Started devtools server on ${this.#rdpPort}` : null;
    let rdpResolved = !rdpMarker;
    let resolveRdp;
    const rdpReady = rdpMarker ? new Promise(resolve => { resolveRdp = () => { rdpResolved = true; resolve(true); }; }) : Promise.resolve(true);

    const ready = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, sig) => {
        if (!rdpResolved) { rdpResolved = true; resolveRdp?.(false); }
        reject(new Error(`Camoufox exited before Juggler ready (${code ?? sig})${stderr ? `\n${stderr}` : ''}`));
      });
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
        if (stdout.includes(READY_MARKER)) resolve();
        if (rdpMarker && !rdpResolved && stdout.includes(rdpMarker)) resolveRdp?.();
        if (stdout.length > 65536) stdout = stdout.slice(-16384);
      });
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString('utf8')).slice(-16384);
      });
    });

    try {
      await bounded(ready, STARTUP_TIMEOUT_MS, 'Camoufox Juggler startup', signal ?? undefined, () => {
        killProcessTree(child.pid).catch(() => {});
        try { child.kill(); } catch { /* ignore */ }
      });
      const transport = new JugglerTransport(child.stdio[3], child.stdio[4]);
      this.#transport = transport;
      transport.on('message', (method, params, sessionId) => this.emit('message', method, params, sessionId));
      transport.on('close', error => this.emit('close', error));
      child.once('exit', (code, sig) => {
        transport.close(new Error(`Camoufox process exited (${code ?? sig})`));
        this.emit('exit', { code, signal: sig });
      });
      this.info = await transport.send('Browser.getInfo', {}, undefined, signal ? { signal } : undefined);
      await transport.send('Browser.enable', { attachToDefaultContext: true }, undefined, signal ? { signal } : undefined);
      if (rdpMarker && !rdpResolved) {
        await bounded(rdpReady, 2000, 'Camoufox RDP listener startup', signal ?? undefined).catch(() => false);
      }
      return this;
    } catch (error) {
      await this.close({ force: true });
      throw error;
    }
  }

  send(method, params, sessionId, options) {
    if (!this.#transport) return Promise.reject(new Error('Camoufox process has not started'));
    return this.#transport.send(method, params, sessionId, options);
  }

  sendRaw(method, params, sessionId, timeoutMs) {
    if (!this.#transport) return Promise.reject(new Error('Camoufox process has not started'));
    return this.#transport.sendRaw(method, params, sessionId, timeoutMs);
  }

  async close({ force = false } = {}) {
    if (force && this.#child && !this.#processExited) {
      this.#transport?.close('Camoufox process force-closing');
      killProcessTree(this.#child.pid).catch(() => {});
      try { this.#child.kill('SIGKILL'); } catch { try { this.#child.kill(); } catch { /* ignore */ } }
    }
    if (this.#closeFlight) return this.#closeFlight;
    this.#closing = true;
    this.#closeFlight = (async () => {
      try {
        if (!force && this.#transport && !this.#transport.closed) {
          await this.#transport.send('Browser.close', {}, undefined, { timeoutMs: 2500 }).catch(() => {});
        }
      } finally {
        this.#transport?.close('Camoufox process closing');
        if (this.#child && !this.#processExited) {
          const graceful = force
            ? null
            : await bounded(this.#exited, 3000, 'Camoufox graceful exit').catch(() => null);
          if (!graceful && !this.#processExited) {
            await killProcessTree(this.#child.pid);
            try { this.#child.kill('SIGKILL'); } catch { try { this.#child.kill(); } catch { /* ignore */ } }
            await bounded(this.#exited, 2500, 'Camoufox forced exit').catch(() => null);
          }
        }
      }
      return { exited: this.#processExited || !this.#child };
    })();
    return this.#closeFlight;
  }
}
