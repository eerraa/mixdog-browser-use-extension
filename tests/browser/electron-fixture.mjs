// Unit-only Electron boundary substitute. No claim of Chromium/OS behavior.
import { EventEmitter } from 'node:events';
let nextWC = 0;
export const ownedWindows = [];
export const profiles = [];
const image = Buffer.alloc(24);
image.writeUInt32BE(100, 16);
image.writeUInt32BE(80, 20);
export class BrowserWindow extends EventEmitter {
  static deferFirstPaint = false;
  constructor(options) {
    super();
    this.options = options;
    this.visible = options.show ?? true;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, {
      id: ++nextWC, debugger: new EventEmitter(),
      mainFrame: { url: 'about:blank', processId: 1, routingId: nextWC },
      getURL: () => this.url ?? 'about:blank', getTitle: () => 'Unit fixture',
      setWindowOpenHandler: handler => { this.windowOpenHandler = handler; },
      capturePage: async () => ({ toPNG: () => image }),
      executeJavaScript: async () => null,
    });
    this.webContents.mainFrame.owner = this.webContents;
    ownedWindows.push(this);
  }
  setMenu(menu) { this.menu = menu; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized ?? false; }
  restore() { this.minimized = false; }
  focus() {}
  show() { this.visible = true; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  async loadURL(url) {
    this.url = url;
    this.webContents.mainFrame.url = url;
    this.webContents.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: true, frame: this.webContents.mainFrame });
    if (!this.painted && !BrowserWindow.deferFirstPaint) {
      this.painted = true;
      queueMicrotask(() => this.emit('ready-to-show'));
    }
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
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
