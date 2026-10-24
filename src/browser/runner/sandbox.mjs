// The script runner's sandbox: one hidden, sandboxed renderer per run with no
// Node, the shared in-memory runner partition (cleared after every run) behind
// a dead fixed proxy, a strict CSP, every request cancelled except the
// bootstrap page, WebRTC limited to proxied UDP, and navigation, popups,
// permissions, downloads, dialogs and webviews denied. The script can
// reach the browser only through routeOp (nonce, sender and frame checked)
// and the bridge allowlist. Electron main only.
import { BrowserWindow, ipcMain, session } from 'electron';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const RUNNER_CHANNEL = 'wb-runner:op';
export const RUNNER_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; style-src 'none'; "
  + "font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; "
  + "manifest-src 'none'; base-uri 'none'; form-action 'none'";
// x-dns-prefetch-control off cannot be turned back on by the document.
export const BOOTSTRAP_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${RUNNER_CSP}">`
  + '<meta http-equiv="x-dns-prefetch-control" content="off"><title>script runner</title>')}`;
// Every connection the runner session would make outside request
// interception (preconnect, WebRTC) goes to this dead proxy, loopback too.
export const RUNNER_PROXY = Object.freeze({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' });
export const RUNNER_PARTITION = 'wb-runner';

const runs = new Map();
let routed = false;
let runnerSession = null;
// One in-memory partition for every run, set up once and cleared after each.
function sharedSession() {
  runnerSession ??= (async () => {
    const ses = session.fromPartition(RUNNER_PARTITION, { cache: false });
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.setSpellCheckerEnabled(false);
    ses.on('will-download', event => event.preventDefault());
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: details.url !== BOOTSTRAP_URL }));
    await ses.setProxy(RUNNER_PROXY);
    return ses;
  })();
  return runnerSession;
}
const refused = message => ({ ok: false, error: { code: 'RUNNER_REFUSED', kind: 'not-executed', message } });

/** ipcMain handler: only the run's own sandbox main frame with its nonce reaches its bridge. */
export async function routeOp(event, nonce, op, args) {
  const run = runs.get(event?.sender?.id);
  const frame = event?.senderFrame;
  if (!run || run.contents !== event.sender || run.contents.isDestroyed()) return refused('Not a script runner sandbox');
  const main = run.contents.mainFrame;
  if (!frame || frame.processId !== main.processId || frame.routingId !== main.routingId || run.contents.getURL() !== BOOTSTRAP_URL) {
    return refused('Only the runner document may call the bridge');
  }
  const given = Buffer.from(typeof nonce === 'string' ? nonce : '');
  const expected = Buffer.from(run.nonce);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return refused('Bad runner nonce');
  return run.onOp(op, args);
}

/** One sandbox per run; destroy() ends its renderer even inside a CPU loop. */
// preloadPath: absolute path of runner/preload.cjs (shipped as app/runner-preload.cjs).
export async function createRunnerSandbox({ onOp, onConsole = () => {}, preloadPath }) {
  if (typeof preloadPath !== 'string' || !path.isAbsolute(preloadPath)) {
    throw Object.assign(new Error('The script runner preload is not configured'), { code: 'RUNNER_UNAVAILABLE' });
  }
  if (!routed) { ipcMain.handle(RUNNER_CHANNEL, routeOp); routed = true; }
  const nonce = randomBytes(32).toString('base64url');
  const ses = await sharedSession();
  const window = new BrowserWindow({
    show: false, width: 320, height: 200, skipTaskbar: true, focusable: false,
    webPreferences: {
      session: ses, preload: preloadPath, additionalArguments: [`--wb-runner-nonce=${nonce}`],
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false, devTools: false,
      spellcheck: false, backgroundThrottling: false, disableDialogs: true, navigateOnDragDrop: false,
      enableWebSQL: false, images: false, webgl: false, plugins: false, autoplayPolicy: 'document-user-activation-required',
    },
  });
  const contents = window.webContents;
  const id = contents.id;
  let loaded = false;
  // No UDP except through the (dead) proxy: ICE cannot reach STUN or peers.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) contents.on(name, event => event.preventDefault());
  contents.on('will-frame-navigate', event => { if (loaded) event.preventDefault(); });
  contents.on('console-message', (event, level, message) => {
    const text = typeof event?.message === 'string' ? event.message : message;
    const kind = typeof event?.level === 'string' ? event.level : ['verbose', 'info', 'warning', 'error'][level] ?? 'log';
    onConsole(kind, text);
  });
  runs.set(id, { nonce, onOp, contents });
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    runs.delete(id);
    try {
      // Crashing a renderer another run still uses would end that run too;
      // then destroying the window ends this run's document.
      const pid = contents.isDestroyed() ? 0 : contents.getOSProcessId();
      const shared = [...runs.values()].some(other => !other.contents.isDestroyed() && other.contents.getOSProcessId() === pid);
      if (pid && !shared) contents.forcefullyCrashRenderer();
    } catch { /* already gone */ }
    if (!window.isDestroyed()) window.destroy();
    ses.clearStorageData().catch(() => {});
    ses.clearCache().catch(() => {});
  };
  try {
    await contents.loadURL(BOOTSTRAP_URL);
    loaded = true;
  } catch (error) { destroy(); throw error; }
  return {
    contents,
    evaluate: source => contents.executeJavaScript(source, false),
    destroy,
  };
}
