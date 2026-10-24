// Unit-only Electron boundary substitute. No claim of Chromium/OS behavior.
import { EventEmitter } from 'node:events';
let nextWC = 0;
let focused = null;
export const ownedWindows = [];
export const ownedViews = [];
export const profiles = [];
// A 100×80 native image whose pixels a test can change (fixtureImage.pixels).
export const fixtureImage = { width: 100, height: 80, pixels: Buffer.alloc(100 * 80 * 4) };
const nativeImage = (width = fixtureImage.width, height = fixtureImage.height, pixels = Buffer.from(fixtureImage.pixels), crop = null) => ({
  isEmpty: () => false,
  getSize: () => ({ width, height }),
  toBitmap: () => {
    if (!crop) return Buffer.from(pixels);
    const rows = [];
    for (let y = crop.y; y < crop.y + crop.height; y++) rows.push(pixels.subarray((y * width + crop.x) * 4, (y * width + crop.x + crop.width) * 4));
    return Buffer.concat(rows);
  },
  crop: rect => nativeImage(width, height, pixels, rect),
  resize: ({ width: w, height: h }) => nativeImage(w, h, Buffer.alloc(w * h * 4)),
  toPNG: () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(width, 16);
    png.writeUInt32BE(height, 20);
    return png;
  },
});
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
  async capturePage() { this.captures = (this.captures ?? 0) + 1; return nativeImage(); }
  async executeJavaScript() { return null; }
  send(channel, ...args) { this.sent.push([channel, ...args]); }
  reload() { this.reloads++; }
  stop() {}
  // Human DevTools: models only the opened state and its events. With
  // devToolsDelay the front end loads first; like Electron, it is not yet
  // "opened" then, and a close request during that load has no effect.
  // devToolsDelay 'manual' loads until finishDevToolsLoad(), however long.
  openDevTools(options) {
    this.devToolsOptions = options;
    if (this.devTools || this.devToolsLoading) return;
    const open = () => { this.devToolsLoading = null; this.devTools = true; this.emit('devtools-opened'); };
    if (this.devToolsDelay === 'manual') this.devToolsLoading = this.finishDevToolsLoad = open;
    else if (this.devToolsDelay) this.devToolsLoading = setTimeout(open, this.devToolsDelay);
    else open();
  }
  closeDevTools() { if (this.devTools) { this.devTools = false; this.emit('devtools-closed'); } }
  isDevToolsOpened() { return !!this.devTools; }
  async loadURL(url) {
    if (this.destroyed) throw new Error('Object has been destroyed');
    this.url = url;
    this.mainFrame.url = url;
    this.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: true, frame: this.mainFrame });
    this.emit('did-navigate');
    this.emit('dom-ready');
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
  // Models OS activation: show() activates the window, showInactive() never does.
  focus() { this.activated = true; }
  isFocused() { return !!this.activated; }
  flashFrame(flag) { this.flashing = flag; }
  show() { this.visible = true; this.activated = true; this.emit('show'); }
  showInactive() { this.visible = true; this.emit('show'); }
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
export const ipcMain = { handle() {}, removeHandler() {} };
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
