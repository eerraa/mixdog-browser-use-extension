import { BrowserWindow, Menu } from 'electron';
import { showManualMessageBox } from './dialogs.mjs';
import { spawn } from 'node:child_process';
import { bounded } from '../shared/async.mjs';

// Trusted native surface: deliberately has no page ID, debugger, preload or IPC.
// Web input and a native-dialog click are NOT approval evidence. Windows-owned
// UserConsentVerifier must verify the immutable displayed descriptor as well.
export class ConsentSurface {
  constructor(helperPath) {
    this.helperPath = helperPath;
    this.prompts = new Map();
    this.closed = false;
  }
  dismiss(id) {
    const prompt = this.prompts.get(id);
    if (!prompt) return;
    this.prompts.delete(id);
    prompt.cancelled = true;
    prompt.child?.kill();
    if (!prompt.window.isDestroyed()) prompt.window.destroy();
  }
  async prompt(descriptor, revalidate, decide) {
    if (this.closed) throw new Error('Consent surface is closed');
    const prompt = { cancelled: false };
    const window = new BrowserWindow({
      width: 560, height: 260, show: false, title: 'Independent Browser — permission',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    prompt.window = window;
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    this.prompts.set(descriptor.id, prompt);
    window.on('closed', () => {
      if (!prompt.cancelled) decide(descriptor.id, 'cancel');
    });
    const message = [
      'Authorize automation for this browser connection only.',
      `Origin: ${descriptor.origin}`, `Embedding origin: ${descriptor.embeddingOrigin}`,
      `Permission: ${descriptor.kind}`, `Exact scope: ${JSON.stringify(descriptor.scope)}`,
      `Connection/request: ${descriptor.id}`,
      'Decline/cancel is final for this scope in this connection.',
      'Revoke closes ALL plugin windows in this connection and terminates its companion process.',
    ].join('\n');
    try {
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Permission authorization</title><p>Use the native permission dialog. Approval additionally requires Windows verification.</p>'));
      if (prompt.cancelled) return;
      window.show();
      const choice = await showManualMessageBox(window, {
        type: 'question', title: 'Independent Browser permission', message: 'Allow this exact scope?',
        detail: message, buttons: ['Decline', 'Verify with Windows'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (prompt.cancelled) return;
      if (choice.response !== 1 || !revalidate()) { decide(descriptor.id, 'deny'); return; }
      const handle = window.getNativeWindowHandle();
      const hwnd = `0x${(handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(16)}`;
      const result = await this.verify(prompt, hwnd, message);
      if (prompt.cancelled) return;
      // Late result, navigation, Stop, revoke, removed device or lost requester
      // must fail closed, even if Windows verified the previous descriptor.
      decide(descriptor.id, result.verified === true && result.mode === 'verify'
        && result.result === 0 && result.hresult === '0x00000000' && revalidate() ? 'approve' : 'deny');
    } catch {
      if (!prompt.cancelled) decide(descriptor.id, 'deny');
    } finally {
      this.dismiss(descriptor.id);
    }
  }
  async verify(prompt, hwnd, message) {
    const child = spawn(this.helperPath, ['--verify', hwnd, String(process.pid)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    prompt.child = child;
    let output = '', bytes = 0;
    const result = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.stdout.on('data', data => {
        bytes += data.length;
        if (bytes > 8192) { child.kill(); reject(new Error('Invalid consent response')); }
        else output += data.toString('utf8');
      });
      // Consume without logging: helper stderr must never leak user data.
      child.stderr.resume();
      child.on('close', code => {
        if (code !== 0) reject(new Error('Windows verification unavailable or failed'));
        else {
          try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid consent response')); }
        }
      });
      child.stdin.end(message, 'utf8');
    });
    try { return await bounded(result, 90000, 'Windows consent', undefined, () => child.kill()); }
    finally { prompt.child = undefined; }
  }
  close() {
    this.closed = true;
    for (const id of this.prompts.keys()) this.dismiss(id);
  }
}

export function installPageMenu(window, { stop, resume, handoff, revoke, acceptDialog, dismissDialog, openDevTools }) {
  const menu = Menu.buildFromTemplate([
    { label: 'Stop automation', click: stop },
    { label: 'Resume automation', click: resume },
    { label: 'Human handoff', click: handoff },
    { label: 'Accept pending page dialog', click: acceptDialog },
    { label: 'Dismiss pending page dialog', click: dismissDialog },
    // Enabled only in native handoff; the host refuses it in every other mode.
    { id: 'open-devtools', label: 'Open DevTools (while you have control)', enabled: false, click: openDevTools },
    { label: 'Revoke permissions and close connection', click: async () => {
      const result = await showManualMessageBox(window, {
        type: 'warning', message: 'Close all plugin browser windows in this connection?',
        detail: 'This stops automation and terminates this connection’s companion process to remove Chromium device grants. Profiles/cookies remain recoverable. It does not change external accounts.',
        buttons: ['Cancel', 'Revoke and close'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response === 1) revoke();
    } },
  ]);
  window.setMenu(menu);
  return menu;
}
