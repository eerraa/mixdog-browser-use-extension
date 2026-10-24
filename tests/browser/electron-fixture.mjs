// Unit-only Electron boundary substitute. No claim of Chromium/OS behavior.
import { EventEmitter } from 'node:events';
let nextWC = 0;
let focused = null;
export const ownedWindows = [];
export const ownedViews = [];
export const profiles = [];
const image = Buffer.alloc(24);
image.writeUInt32BE(100, 16);
image.writeUInt32BE(80, 20);
export const app = { getLocale: () => 'en-US', commandLine: { appendSwitch() {} } };
export const nativeTheme = { shouldUseDarkColors: false };
// Models OS keyboard focus arriving before its focus event is handled.
export function deliverFocus(contents) { focused = contents; }
export class FixtureContents extends EventEmitter {
  constructor() {
    super();
    this.id = ++nextWC;
    this.debugger = new EventEmitter();
    this.ipc = new EventEmitter();
    this.mainFrame = { url: 'about:blank', processId: 1, routingId: this.id, owner: this };
    this.sent = [];
    this.reloads = 0;
    this.destroyed = false;
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
  }
  getURL() { return this.url ?? 'about:blank'; }
  getTitle() { return 'Unit fixture'; }
  isLoading() { return false; }
  isDestroyed() { return this.destroyed; }
  isFocused() { return focused === this; }
  focus() {
    if (this.destroyed || focused === this) return;
    focused = this;
    this.emit('focus');
  }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  setBackgroundThrottling(allowed) { this.backgroundThrottling = allowed; }
  async capturePage() { return { toPNG: () => image, isEmpty: () => false }; }
  async executeJavaScript() { return null; }
  send(channel, ...args) { this.sent.push([channel, ...args]); }
  reload() { this.reloads++; }
  stop() {}
  async loadURL(url) {
    if (this.destroyed) throw new Error('Object has been destroyed');
    this.url = url;
    this.mainFrame.url = url;
    this.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: true, frame: this.mainFrame });
    this.emit('did-navigate');
  }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (focused === this) focused = null;
    this.emit('destroyed');
  }
}
export class WebContentsView {
  constructor(options = {}) {
    this.options = options;
    this.webContents = options.webContents ?? new FixtureContents();
    this.visible = true;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    ownedViews.push(this);
  }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  getBounds() { return { ...this.bounds }; }
  setVisible(visible) { this.visible = visible; }
  getVisible() { return this.visible; }
  setBackgroundColor(color) { this.backgroundColor = color; }
}
export class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.title = options.title;
    this.visible = options.show ?? true;
    this.minimized = false;
    this.destroyed = false;
    this.webContents = new FixtureContents();
    const bounds = { x: 0, y: 0, width: options.width ?? 800, height: options.height ?? 600 };
    this.contentView = Object.assign(new EventEmitter(), {
      children: [],
      addChildView(view) { this.children.push(view); },
      getBounds: () => ({ ...bounds }),
    });
    ownedWindows.push(this);
  }
  setMenu(menu) { this.menu = menu; }
  setTitle(title) { this.title = title; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  minimize() { this.minimized = true; this.emit('minimize'); }
  restore() { if (this.minimized) { this.minimized = false; this.emit('restore'); } }
  focus() {}
  show() { this.visible = true; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  loadURL(url) { return this.webContents.loadURL(url); }
  // Child views and their contents outlive the window, as in Electron.
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.close();
    this.emit('closed');
  }
}
export const Menu = { buildFromTemplate: items => ({ items }) };
export const dialog = { showMessageBox: async () => { throw new Error('Human prompts must not run in unit tests'); } };
export const webContents = { fromFrame: frame => frame.owner };
export const session = {
  fromPath(directory) {
    const s = new EventEmitter();
    s.directory = directory;
    s.setPermissionCheckHandler = handler => { s.permissionCheck = handler; };
    s.setPermissionRequestHandler = handler => { s.permissionRequest = handler; };
    s.setDevicePermissionHandler = handler => { s.devicePermission = handler; };
    s.setDisplayMediaRequestHandler = handler => { s.displayMedia = handler; };
    profiles.push(s);
    return s;
  },
};
