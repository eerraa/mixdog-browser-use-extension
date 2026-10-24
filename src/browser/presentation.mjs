import { BrowserWindow } from 'electron';
import { fail, freshId } from './contract.mjs';

const shellHTML = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Independent Browser — presentation</title>
<style>body{margin:0;background:#20242b;color:#fff;font:14px system-ui}header{padding:12px}
img{display:block;max-width:100%;max-height:calc(100vh - 56px);margin:auto;object-fit:contain}</style>
<header id="status">Automation presentation. Interact here to pause and enter the native browser.</header><img id="page">`;

/**
 * A normal, hidden native guest and a separate, trusted bitmap-only shell.
 * Shell gestures are never forwarded. Source separation—not event provenance,
 * event.isTrusted or an in-flight counter—makes hidden CDP input distinguishable.
 */
export class PagePresentation {
  constructor(guest, { interrupt, handoff, invalidate, visibility, close, guardNativeInput }) {
    this.guest = guest;
    this.callbacks = { interrupt, handoff, invalidate, visibility, close, guardNativeInput };
    this.mode = 'automation';
    this.generation = 0;
    this.closed = false;
    this.ready = false;
    this.shellKeys = new Set();
    this.shellButtons = new Set();
    this.nativeKeys = new Set();
    this.nativeButtons = new Set();
    this.unknownGesture = false;
    this.releaseWaiters = new Set();
    this.shellURL = 'data:text/html;charset=utf-8,' + encodeURIComponent(shellHTML);
    this.shell = new BrowserWindow({
      width: 1120, height: 820, show: false, title: 'Independent Browser — presentation',
      webPreferences: {
        partition: `independent-presentation-${freshId()}`,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        backgroundThrottling: false, webviewTag: false, navigateOnDragDrop: false,
      },
    });
    const shellWC = this.shell.webContents;
    shellWC.setWindowOpenHandler(() => ({ action: 'deny' }));
    shellWC.on('will-attach-webview', event => event.preventDefault());
    shellWC.on('will-navigate', event => { event.preventDefault(); this.failClosed('presentation-navigation-blocked'); });
    shellWC.on('will-frame-navigate', event => {
      if (event.url !== this.shellURL) {
        event.preventDefault();
        this.failClosed('presentation-navigation-blocked');
      }
    });
    shellWC.on('render-process-gone', () => this.failClosed('presentation-renderer-lost'));
    shellWC.on('destroyed', () => { if (!this.closed) this.failClosed('presentation-lost'); });
    shellWC.on('before-input-event', (event, input) => this.shellKeyboard(event, input));
    shellWC.on('before-mouse-event', (event, input) => this.shellMouse(event, input));
    this.shell.on('hide', () => {
      this.callbacks.visibility(this.logicalVisible());
      if (!this.intentionalHide && this.mode === 'automation') this.failClosed('presentation-hidden');
    });
    this.shell.on('minimize', () => this.failClosed('presentation-minimized'));
    this.shell.on('show', () => this.callbacks.visibility(this.logicalVisible()));
    this.shell.on('closed', () => { if (!this.closed) this.callbacks.close(); });
    guest.on('show', () => {
      if (this.mode !== 'native-handoff') {
        guest.hide();
        this.failClosed('unexpected-native-exposure');
      } else this.callbacks.visibility(this.logicalVisible());
    });
    guest.on('hide', () => this.callbacks.visibility(this.logicalVisible()));
    guest.on('minimize', () => this.callbacks.visibility(this.logicalVisible()));
    guest.webContents.on('before-input-event', (event, input) => this.nativeKeyboard(event, input));
    guest.webContents.on('before-mouse-event', (event, input) => this.nativeMouse(event, input));
  }
  async start() {
    await this.shell.loadURL(this.shellURL);
    if (this.closed) throw new Error('Presentation closed during initialization');
    this.ready = true;
    this.shell.show();
  }
  logicalVisible() {
    const window = this.mode === 'native-handoff' ? this.guest : this.shell;
    return !this.closed && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  }
  assertHidden() {
    if (this.closed || this.guest.isDestroyed() || this.guest.isVisible()) {
      if (!this.closed && !this.guest.isDestroyed()) this.guest.hide();
      this.failClosed('guest-not-hidden');
      fail('UNSAFE_PRESENTATION', 'Native guest is not safely hidden');
    }
  }
  assertAutomation(generation = this.generation) {
    this.assertHidden();
    if (this.mode !== 'automation' || this.generation !== generation || !this.healthy()) {
      fail('AUTOMATION_PAUSED', 'Automation paused: presentation mode, visibility or generation changed');
    }
  }
  healthy() {
    return this.ready && !this.closed && !this.shell.isDestroyed() && this.shell.isVisible()
      && !this.shell.isMinimized() && this.shell.webContents.getURL() === this.shellURL;
  }
  assertObservable(returning = false) {
    if (!(this.mode === 'automation' || (returning && this.mode === 'returning'))) {
      fail('PRIVATE_HANDOFF', 'Page observations are paused during native human handoff/drain/return');
    }
    if (!this.healthy()) fail('PRESENTATION_UNAVAILABLE', 'Presentation shell is not ready, visible and current');
    this.assertHidden();
  }
  failClosed(reason) {
    if (this.closed) return;
    this.mode = 'draining';
    this.generation++;
    if (!this.guest.isDestroyed() && this.guest.isVisible()) this.guest.hide();
    this.callbacks.interrupt(reason);
    this.clear(`Paused: ${reason}. Use the native menu after releasing controls.`);
  }
  clear(message) {
    if (!this.ready || this.closed || this.shell.isDestroyed()) return;
    void this.shell.webContents.executeJavaScript(`document.getElementById('page').removeAttribute('src');document.getElementById('status').textContent=${JSON.stringify(message)}`)
      .catch(() => { /* A lost shell already blocks all admissions. */ });
  }
  async publish(base64, generation, returning = false) {
    this.assertObservable(returning);
    if (generation !== this.generation) fail('PRESENTATION_CHANGED', 'Presentation generation changed');
    await this.shell.webContents.executeJavaScript(`document.getElementById('page').src=${JSON.stringify(`data:image/png;base64,${base64}`)};document.getElementById('status').textContent='Automation presentation. Interact here for native human handoff.'`);
    this.assertObservable(returning);
    if (generation !== this.generation) fail('PRESENTATION_CHANGED', 'Presentation generation changed');
  }
  shellKeyboard(event, input) {
    event.preventDefault();
    const key = input.code || input.key;
    const held = this.shellKeys.has(key);
    if (input.type === 'keyDown') this.shellKeys.add(key);
    if (input.type === 'keyUp') this.shellKeys.delete(key);
    if ((input.type === 'keyDown' || (input.type === 'keyUp' && !held && this.mode === 'automation'))
      && this.mode !== 'native-handoff') this.callbacks.handoff('shell-keyboard-intervention');
    this.releaseIfSafe();
  }
  shellMouse(event, input) {
    if (['mouseMove', 'mouseEnter', 'mouseLeave'].includes(input.type)) return;
    event.preventDefault();
    const held = this.shellButtons.has(input.button);
    if (input.type === 'mouseDown') this.shellButtons.add(input.button);
    if (input.type === 'mouseUp') this.shellButtons.delete(input.button);
    if (input.type === 'mouseWheel') this.unknownGesture = true;
    if ((input.type !== 'mouseUp' || (!held && this.mode === 'automation'))
      && this.mode !== 'native-handoff') this.callbacks.handoff('shell-pointer-intervention');
    this.releaseIfSafe();
  }
  #allowNativeInput(event) {
    try { this.callbacks.guardNativeInput(); return true; }
    catch { event.preventDefault(); return false; }
  }
  nativeKeyboard(event, input) {
    if (this.mode === 'automation' && !this.guest.isVisible()) return;
    if (this.mode === 'automation' && this.guest.isVisible()) {
      event.preventDefault(); this.failClosed('unexpected-native-exposure'); return;
    }
    if (this.mode !== 'native-handoff') { event.preventDefault(); return; }
    const key = input.code || input.key;
    if (!this.#allowNativeInput(event)) {
      if (input.type === 'keyUp') this.nativeKeys.delete(key);
      return;
    }
    if (input.isAutoRepeat || (input.type === 'keyUp' && !this.nativeKeys.has(key))) { event.preventDefault(); return; }
    if (input.type === 'keyDown') this.nativeKeys.add(key);
    if (input.type === 'keyUp') this.nativeKeys.delete(key);
  }
  nativeMouse(event, input) {
    if (this.mode === 'automation' && !this.guest.isVisible()) return;
    if (this.mode === 'automation' && this.guest.isVisible()) {
      event.preventDefault(); this.failClosed('unexpected-native-exposure'); return;
    }
    if (this.mode !== 'native-handoff') { event.preventDefault(); return; }
    if (!this.#allowNativeInput(event)) {
      if (input.type === 'mouseUp') this.nativeButtons.delete(input.button);
      return;
    }
    if (input.type === 'mouseUp' && !this.nativeButtons.has(input.button)) { event.preventDefault(); return; }
    if (input.type === 'mouseDown') this.nativeButtons.add(input.button);
    if (input.type === 'mouseUp') this.nativeButtons.delete(input.button);
  }
  beginDrain(fromMenu = false) {
    if (this.mode !== 'draining') { this.mode = 'draining'; this.generation++; }
    // A wheel has no release edge. Only an explicit native-menu request can
    // resolve that route; never infer the absence of a physical input.
    if (fromMenu) this.unknownGesture = false;
    this.callbacks.invalidate('handoff-draining');
    this.clear(this.unknownGesture
      ? 'Paused: wheel input has no release edge. After releasing controls, choose the native Human handoff menu. No gesture is forwarded.'
      : 'Automation paused. Waiting for actual dispatch cleanup and control release. Native menus can resolve an outstanding page dialog.');
    return this.generation;
  }
  releaseIfSafe() {
    if (this.shellKeys.size || this.shellButtons.size || this.unknownGesture) return;
    for (const resolve of this.releaseWaiters) resolve();
    this.releaseWaiters.clear();
  }
  waitForRelease() {
    if (!this.shellKeys.size && !this.shellButtons.size && !this.unknownGesture) return Promise.resolve();
    return new Promise(resolve => this.releaseWaiters.add(resolve));
  }
  enterNative(generation) {
    if (this.closed || this.mode !== 'draining' || this.generation !== generation
      || this.shellKeys.size || this.shellButtons.size || this.unknownGesture) fail('HANDOFF_CHANGED', 'Handoff changed or initiating controls are still held');
    this.mode = 'native-handoff';
    this.clear('Native human handoff. No page images or reads are captured. Resume only from the native menu.');
    this.intentionalHide = true;
    try { this.shell.hide(); } finally { this.intentionalHide = false; }
    this.guest.show();
    if (!this.guest.isVisible()) fail('HANDOFF_FAILED', 'Could not show the native guest');
    this.callbacks.visibility(this.logicalVisible());
  }
  beginReturn() {
    if (this.nativeKeys.size || this.nativeButtons.size || this.shellKeys.size || this.shellButtons.size || this.unknownGesture) {
      fail('CONTROLS_HELD', 'Release all initiating/native controls before choosing Resume');
    }
    this.mode = 'returning';
    this.generation++;
    this.guest.hide();
    this.assertHidden();
    if (this.shell.isDestroyed()) fail('PRESENTATION_LOST', 'Presentation shell was closed');
    if (this.shell.isMinimized()) this.shell.restore();
    this.shell.show();
    this.callbacks.invalidate('returning-to-automation');
    return this.generation;
  }
  finishReturn(generation) {
    this.assertObservable(true);
    if (this.generation !== generation || this.mode !== 'returning') fail('RETURN_CHANGED', 'Return was interrupted');
    this.mode = 'automation';
    this.callbacks.visibility(this.logicalVisible());
  }
  hide() {
    this.generation++;
    this.intentionalHide = true;
    try { this.shell.hide(); this.guest.hide(); } finally { this.intentionalHide = false; }
    this.callbacks.visibility(false);
    this.callbacks.invalidate('logical-hidden');
  }
  show() {
    if (this.mode === 'native-handoff') this.guest.show();
    else this.shell.show();
    this.callbacks.visibility(this.logicalVisible());
    this.callbacks.invalidate('logical-shown');
  }
  close() {
    this.closed = true;
    this.generation++;
    for (const resolve of this.releaseWaiters) resolve();
    this.releaseWaiters.clear();
    if (!this.shell.isDestroyed()) this.shell.destroy();
  }
}
