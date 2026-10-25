import { app, BrowserWindow, nativeTheme, WebContentsView } from 'electron';
import { addressURL, fail, freshId } from '../shared/contract.mjs';

// Owned pages must keep producing frames while their window is covered.
// Windows occlusion tracking stops frames for a window that is occluded before
// its first frame, so observation could never capture it. Hosts load this
// module before app ready, the only time the switch applies.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

export const TOOLBAR_HEIGHT = 44;
const APP_TITLE = 'Independent Browser';
const TOOLBAR_ACTION = 'independent-browser:toolbar';
const TOOLBAR_STATE = 'independent-browser:state';

const STRINGS = {
  en: {
    lang: 'en', back: 'Back', forward: 'Forward', reload: 'Reload', stopLoading: 'Stop loading',
    address: 'Address', addressHint: 'Enter an http(s) address',
    secure: 'Secure connection (HTTPS)', insecure: 'Not secure (HTTP)',
    takeControl: 'Take control', returnControl: 'Return to agent', resume: 'Resume agent', stopAgent: 'Stop agent',
    chipAgent: 'Agent in control', chipUser: 'You are in control', chipSwitching: 'Switching…',
    chipReturning: 'Returning…', chipStopped: 'Agent stopped', chipPaused: 'Agent paused',
    agentHint: 'The agent is using this page. Click the page to take control.',
    userHint: 'The agent cannot read or control this page until you return control.',
    badge: 'Agent in control · click to take over',
    stopped: 'The agent is stopped. Take control to use the page, or resume the agent.',
    paused: reason => `The agent is paused (${reason}). Take control to use the page, or resume the agent.`,
    draining: 'Waiting for the agent’s current action to finish. Release any held mouse button or key.',
    wheel: 'Scrolling cannot be handed over safely. Choose Take control in the toolbar.',
    drainFailed: 'Still switching: the agent’s action or a page dialog has not finished. Choose Take control again in a moment.',
    dialogBeforeResume: 'Answer the page’s dialog before returning control.',
    dialogUncertain: 'The dialog response is uncertain and will not be repeated. The agent stays paused.',
    returning: 'Returning control to the agent. It checks the page again before acting.',
    invalidAddress: 'Enter an http:// or https:// address.',
    loadFailed: code => `Could not open the page (${code}).`,
  },
  ko: {
    lang: 'ko', back: '뒤로', forward: '앞으로', reload: '새로고침', stopLoading: '로딩 중지',
    address: '주소', addressHint: 'http(s) 주소 입력',
    secure: '보안 연결(HTTPS)', insecure: '보안 연결 아님(HTTP)',
    takeControl: '직접 조작', returnControl: '에이전트에게 돌려주기', resume: '에이전트 재개', stopAgent: '에이전트 중지',
    chipAgent: '에이전트 조작 중', chipUser: '직접 조작 중', chipSwitching: '전환 중…',
    chipReturning: '돌려주는 중…', chipStopped: '에이전트 중지됨', chipPaused: '에이전트 일시정지',
    agentHint: '에이전트가 이 페이지를 사용하고 있습니다. 페이지를 클릭하면 직접 조작으로 전환합니다.',
    userHint: '돌려주기 전까지 에이전트는 이 페이지를 읽거나 조작할 수 없습니다.',
    badge: '에이전트 조작 중 · 클릭하면 직접 조작',
    stopped: '에이전트가 중지되었습니다. 페이지를 쓰려면 직접 조작을 누르거나 에이전트를 재개하세요.',
    paused: reason => `에이전트가 일시정지되었습니다(${reason}). 페이지를 쓰려면 직접 조작을 누르거나 에이전트를 재개하세요.`,
    draining: '에이전트의 진행 중인 동작이 끝나기를 기다리는 중입니다. 누르고 있는 마우스 버튼이나 키를 놓아 주세요.',
    wheel: '스크롤 입력은 안전하게 넘길 수 없습니다. 툴바의 직접 조작을 눌러 주세요.',
    drainFailed: '아직 전환하지 못했습니다. 에이전트 동작이나 페이지 대화상자가 끝나지 않았습니다. 잠시 뒤 직접 조작을 다시 누르세요.',
    dialogBeforeResume: '돌려주기 전에 페이지 대화상자에 먼저 응답해 주세요.',
    dialogUncertain: '대화상자 응답 결과가 불확실해 다시 보내지 않습니다. 에이전트는 일시정지 상태로 유지됩니다.',
    returning: '에이전트에게 제어권을 돌려주는 중입니다. 에이전트는 페이지를 다시 확인한 뒤 동작합니다.',
    invalidAddress: 'http:// 또는 https:// 주소를 입력하세요.',
    loadFailed: code => `페이지를 열 수 없습니다(${code}).`,
  },
};
const escape = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const dataURL = html => 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
const sameBounds = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
// Plugin chrome documents run no page script; the toolbar's controller is its
// isolated preload world. Neither document loads any external resource.
const head = t => `<!doctype html><html lang="${t.lang}"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${APP_TITLE}</title>`;
const icon = paths => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

function toolbarHTML(t) {
  const button = (id, label, body) => `<button id="${id}" title="${escape(label)}" aria-label="${escape(label)}" disabled>${body}</button>`;
  return `${head(t)}<style>
:root{color-scheme:light dark;--bg:#f1f3f4;--fg:#1f1f1f;--muted:#5f6368;--field:#fff;--line:#dadce0;--hover:rgba(60,64,67,.1);
--agent:#1a73e8;--user:#188038;--wait:#b06000;--stop:#c5221f;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#202124;--fg:#e8eaed;--muted:#9aa0a6;--field:#303134;--line:#3c4043;
--hover:rgba(232,234,237,.1);--agent:#8ab4f8;--user:#81c995;--wait:#fdd663;--stop:#f28b82;--on-accent:#202124}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--fg);
font:13px/1 "Segoe UI","Malgun Gothic",system-ui,sans-serif;user-select:none}
#bar{position:fixed;inset:0 0 auto 0;height:${TOOLBAR_HEIGHT}px;display:flex;align-items:center;gap:4px;padding:0 8px;border-bottom:1px solid var(--line)}
button{flex:none;height:32px;min-width:32px;padding:0 10px;border:1px solid transparent;border-radius:16px;background:none;color:inherit;
font:inherit;font-weight:600;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
#back,#forward,#reload{padding:0}
button:hover:not(:disabled){background:var(--hover)}
button:disabled{opacity:.38}
button:focus-visible,#omnibox:focus-within{outline:2px solid var(--agent);outline-offset:-1px}
[hidden]{display:none!important}
svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#omnibox{flex:1;min-width:140px;height:32px;display:flex;align-items:center;gap:6px;padding:0 12px;margin:0 4px;
border-radius:16px;background:var(--field);border:1px solid var(--line)}
#omnibox.invalid{border-color:var(--stop)}
#security{display:inline-flex;color:var(--muted)}
#security svg{width:14px;height:14px}
#security[data-secure=false]{color:var(--stop)}
#address{flex:1;min-width:0;height:30px;border:0;outline:0;background:none;color:inherit;font:inherit}
#address:read-only{color:var(--muted)}
#notice{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--stop);font-size:12px}
#chip{flex:none;padding:5px 10px;border-radius:12px;border:1px solid currentColor;font-size:12px;font-weight:600;white-space:nowrap}
#chip[data-tone=agent]{color:var(--agent)}#chip[data-tone=user]{color:var(--user)}
#chip[data-tone=wait]{color:var(--wait)}#chip[data-tone=stop]{color:var(--stop)}
#primary{background:var(--agent);color:var(--on-accent)}
#primary:hover:not(:disabled){background:var(--agent);filter:brightness(1.08)}
#secondary{border-color:var(--line)}
#secondary[data-action=stop-automation]{color:var(--stop)}
#progress{position:fixed;left:0;right:0;top:${TOOLBAR_HEIGHT - 2}px;height:2px;background:var(--agent);opacity:0;transform-origin:left}
body.loading #progress{opacity:1;animation:load 1.4s ease-in-out infinite}
@keyframes load{0%{transform:scaleX(.08)}60%{transform:scaleX(.7)}100%{transform:scaleX(.96)}}
</style><div id="bar">
${button('back', t.back, icon('<path d="M15 18l-6-6 6-6"/>'))}
${button('forward', t.forward, icon('<path d="M9 18l6-6-6-6"/>'))}
${button('reload', t.reload, `<svg id="reload-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>`
    + `<svg id="stop-icon" viewBox="0 0 24 24" aria-hidden="true" hidden><path d="M6 6l12 12M18 6L6 18"/></svg>`)}
<label id="omnibox"><span id="security" hidden>${icon('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>')}</span>
<input id="address" aria-label="${escape(t.address)}" placeholder="${escape(t.addressHint)}" spellcheck="false" autocomplete="off" readonly>
<span id="notice" role="alert"></span></label>
<span id="chip" role="status"></span>
<button id="primary" hidden></button><button id="secondary" hidden></button>
</div><div id="progress"></div>`;
}

function shieldHTML(t) {
  return `${head(t)}<style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;user-select:none;
font:13px/1.5 "Segoe UI","Malgun Gothic",system-ui,sans-serif}
#veil{position:fixed;inset:0;display:flex;align-items:flex-end;justify-content:flex-end;padding:12px;box-sizing:border-box}
body.agent #veil{box-shadow:inset 0 0 0 2px rgba(26,115,232,.65)}
body.blocked #veil{align-items:center;justify-content:center;background:rgba(15,17,21,.5)}
#message{max-width:min(560px,calc(100% - 24px));padding:7px 14px;border-radius:999px;background:rgba(32,33,36,.92);color:#fff;
box-shadow:0 2px 12px rgba(0,0,0,.3)}
body.blocked #message{padding:16px 22px;border-radius:12px;font-size:14px;text-align:center}
</style><body class="agent"><div id="veil"><div id="message" role="status">${escape(t.badge)}</div></div>`;
}

/**
 * One window per owned page. Its own contents are the trusted toolbar; the
 * page is a separate view below it, covered by a trusted input shield while
 * automation owns the page. Every OS pointer event lands on the shield and is
 * never forwarded, and keyboard focus stays in plugin chrome. Debugger key
 * dispatch neither focuses the page nor emits before-input-event, so a page
 * keystroke during automation can only be a person's and fails closed.
 * Native handoff removes the shield from the same live page; only the person
 * can return control, from the toolbar or the native menu.
 */
export class PagePresentation {
  constructor(view, callbacks, { preloadPath, actions, width = 1120, height = 820, useContentSize = false }) {
    this.view = view;
    this.contents = view.webContents;
    this.callbacks = callbacks;
    this.actions = actions;
    this.mode = 'automation';
    this.generation = 0;
    this.closed = false;
    this.ready = false;
    this.toolbarReady = false;
    this.shieldKeys = new Set();
    this.shieldButtons = new Set();
    this.nativeKeys = new Set();
    this.nativeButtons = new Set();
    this.unknownGesture = false;
    this.releaseWaiters = new Set();
    this.notice = null;
    this.addressError = false;
    this.loadError = null;
    this.text = STRINGS[app.getLocale().toLowerCase().startsWith('ko') ? 'ko' : 'en'];
    this.toolbarURL = dataURL(toolbarHTML(this.text));
    this.shieldURL = dataURL(shieldHTML(this.text));
    // A private in-memory partition per window; never the page profile.
    const chrome = {
      partition: `independent-chrome-${freshId()}`, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, navigateOnDragDrop: false, webviewTag: false, spellcheck: false, backgroundThrottling: false,
    };
    this.frame = new BrowserWindow({
      width, height, useContentSize, show: false, title: APP_TITLE, autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#202124' : '#f1f3f4',
      webPreferences: { ...chrome, preload: preloadPath },
    });
    this.toolbar = this.frame.webContents;
    this.shieldView = new WebContentsView({ webPreferences: chrome });
    this.shieldView.setBackgroundColor('#00000000');
    this.shield = this.shieldView.webContents;
    this.frame.contentView.addChildView(view);
    this.frame.contentView.addChildView(this.shieldView);
    this.#layout();
    for (const [contents, url] of [[this.toolbar, this.toolbarURL], [this.shield, this.shieldURL]]) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.on('will-navigate', event => { event.preventDefault(); this.failClosed('presentation-navigation-blocked'); });
      contents.on('will-frame-navigate', event => {
        if (event.url !== url) {
          event.preventDefault();
          this.failClosed('presentation-navigation-blocked');
        }
      });
      contents.on('render-process-gone', () => {
        // A gone toolbar renderer can no longer receive state.
        if (contents === this.toolbar) this.toolbarReady = false;
        this.failClosed('presentation-renderer-lost');
      });
    }
    this.shield.on('destroyed', () => { if (!this.closed) this.failClosed('presentation-lost'); });
    // The shield never keeps keyboard focus; chrome keeps it (and the Alt menu).
    this.shield.on('focus', () => this.toolbar.focus());
    this.shield.on('before-input-event', (event, input) => this.shieldKeyboard(event, input));
    this.shield.on('before-mouse-event', (event, input) => this.shieldMouse(event, input));
    this.toolbar.ipc.on(TOOLBAR_ACTION, (event, message) => this.#toolbarAction(event, message));
    this.frame.on('page-title-updated', event => event.preventDefault());
    this.frame.on('resize', () => this.#relayout());
    this.frame.contentView.on('bounds-changed', () => this.#relayout());
    this.frame.on('hide', () => {
      this.callbacks.visibility(this.logicalVisible());
      if (!this.intentionalHide && this.mode === 'automation') this.failClosed('presentation-hidden');
    });
    this.frame.on('minimize', () => {
      this.callbacks.visibility(this.logicalVisible());
      if (this.mode !== 'native-handoff') this.failClosed('presentation-minimized');
    });
    for (const event of ['show', 'restore']) this.frame.on(event, () => this.callbacks.visibility(this.logicalVisible()));
    this.contents.on('before-input-event', (event, input) => this.nativeKeyboard(event, input));
    this.contents.on('before-mouse-event', (event, input) => this.nativeMouse(event, input));
    this.contents.on('focus', () => { if (this.mode !== 'native-handoff') this.toolbar.focus(); });
    // A page closed by script or by its opener closes its window as well.
    this.contents.on('destroyed', () => { if (!this.frame.isDestroyed()) this.frame.destroy(); });
    this.contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) this.loadError = null;
    });
    this.contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { this.loadError = description || String(code); this.#publish(); }
    });
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
      this.contents.on(event, () => this.#publish());
    }
  }
  async start() {
    await Promise.all([this.toolbar.loadURL(this.toolbarURL), this.shield.loadURL(this.shieldURL)]);
    if (this.closed) throw new Error('Presentation closed during initialization');
    this.ready = true;
    this.refresh();
    // Agent windows never take focus (D19): focus emulation lets the page
    // behave as focused, and the person activates the window by clicking it.
    this.frame.showInactive();
    if (this.contents.isFocused()) this.toolbar.focus();
  }
  logicalVisible() {
    return !this.closed && !this.frame.isDestroyed() && this.frame.isVisible() && !this.frame.isMinimized();
  }
  shielded() {
    if (this.closed || this.frame.isDestroyed() || this.shield.isDestroyed() || this.contents.isDestroyed()) return false;
    return this.shieldView.getVisible() && sameBounds(this.shieldView.getBounds(), this.view.getBounds())
      && !this.contents.isFocused();
  }
  assertShielded() {
    if (!this.shielded()) {
      this.failClosed('page-not-shielded');
      fail('UNSAFE_PRESENTATION', 'The page is not safely shielded from human input');
    }
  }
  assertAutomation(generation = this.generation) {
    this.assertShielded();
    if (this.mode !== 'automation' || this.generation !== generation || !this.healthy()) {
      fail('AUTOMATION_PAUSED', 'Automation paused: presentation mode, visibility or generation changed');
    }
  }
  healthy() {
    return this.ready && !this.closed && !this.frame.isDestroyed() && this.frame.isVisible() && !this.frame.isMinimized()
      && !this.shield.isDestroyed() && this.shieldView.getVisible()
      && this.toolbar.getURL() === this.toolbarURL && this.shield.getURL() === this.shieldURL;
  }
  assertObservable(returning = false) {
    if (!(this.mode === 'automation' || (returning && this.mode === 'returning'))) {
      fail('PRIVATE_HANDOFF', 'Page observations are paused during native human handoff/drain/return');
    }
    if (!this.healthy()) fail('PRESENTATION_UNAVAILABLE', 'Browser window is not ready, visible and current');
    this.assertShielded();
  }
  failClosed(reason) {
    if (this.closed) return;
    this.mode = 'draining';
    this.generation++;
    this.#cover();
    this.callbacks.interrupt(reason);
    this.clear('paused', reason);
  }
  clear(key, detail) {
    this.notice = key ? { key, detail } : null;
    this.refresh();
  }
  refresh() {
    this.#renderShield();
    this.#publish();
  }
  shieldKeyboard(event, input) {
    event.preventDefault();
    const key = input.code || input.key;
    const held = this.shieldKeys.has(key);
    if (input.type === 'keyDown') this.shieldKeys.add(key);
    if (input.type === 'keyUp') this.shieldKeys.delete(key);
    if ((input.type === 'keyDown' || (input.type === 'keyUp' && !held && this.mode === 'automation'))
      && this.mode !== 'native-handoff') this.callbacks.handoff('shell-keyboard-intervention');
    this.releaseIfSafe();
  }
  shieldMouse(event, input) {
    if (['mouseMove', 'mouseEnter', 'mouseLeave'].includes(input.type)) return;
    event.preventDefault();
    const held = this.shieldButtons.has(input.button);
    if (input.type === 'mouseDown') this.shieldButtons.add(input.button);
    if (input.type === 'mouseUp') this.shieldButtons.delete(input.button);
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
    if (this.mode !== 'native-handoff') {
      if (this.contents.isFocused()) {
        event.preventDefault();
        this.failClosed('unexpected-page-input');
      }
      return;
    }
    const key = input.code || input.key;
    if (!this.#allowNativeInput(event)) {
      if (input.type === 'keyUp') this.nativeKeys.delete(key);
      return;
    }
    // Drop a repeat or release whose press never reached this page.
    if ((input.isAutoRepeat || input.type === 'keyUp') && !this.nativeKeys.has(key)) { event.preventDefault(); return; }
    if (input.type === 'keyDown') this.nativeKeys.add(key);
    if (input.type === 'keyUp') this.nativeKeys.delete(key);
  }
  nativeMouse(event, input) {
    // Debugger mouse dispatch emits this event too. While shielded, no OS
    // pointer event can reach the page, so automation input passes untouched.
    if (this.mode !== 'native-handoff') return;
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
    // A wheel has no release edge. Only an explicit trusted request can resolve
    // that route; never infer the absence of a physical input.
    if (fromMenu) this.unknownGesture = false;
    this.#cover();
    this.callbacks.invalidate('handoff-draining');
    this.clear(this.unknownGesture ? 'wheel' : 'draining');
    return this.generation;
  }
  releaseIfSafe() {
    if (this.shieldKeys.size || this.shieldButtons.size || this.unknownGesture) return;
    for (const resolve of this.releaseWaiters) resolve();
    this.releaseWaiters.clear();
  }
  waitForRelease() {
    if (!this.shieldKeys.size && !this.shieldButtons.size && !this.unknownGesture) return Promise.resolve();
    return new Promise(resolve => this.releaseWaiters.add(resolve));
  }
  // activate: false for an agent-requested handoff. The window then only
  // flashes and never takes focus, so keystrokes the person meant for another
  // app cannot reach it; the person activates it by clicking (D19).
  enterNative(generation, { activate = true } = {}) {
    if (this.closed || this.mode !== 'draining' || this.generation !== generation
      || this.shieldKeys.size || this.shieldButtons.size || this.unknownGesture) fail('HANDOFF_CHANGED', 'Handoff changed or initiating controls are still held');
    this.mode = 'native-handoff';
    this.notice = null;
    this.addressError = false;
    if (activate && this.frame.isMinimized()) this.frame.restore();
    if (!this.frame.isVisible()) { if (activate) this.frame.show(); else this.frame.showInactive(); }
    this.shieldView.setVisible(false);
    if (this.shieldView.getVisible()) fail('HANDOFF_FAILED', 'Could not reveal the live page');
    if (activate || this.frame.isFocused()) this.contents.focus();
    else {
      this.frame.flashFrame(true);
      this.frame.once('focus', () => { if (!this.frame.isDestroyed()) this.frame.flashFrame(false); });
    }
    this.refresh();
    this.callbacks.visibility(this.logicalVisible());
  }
  beginReturn() {
    if (this.nativeKeys.size || this.nativeButtons.size || this.shieldKeys.size || this.shieldButtons.size || this.unknownGesture) {
      fail('CONTROLS_HELD', 'Release all initiating/native controls before choosing Resume');
    }
    if (this.frame.isDestroyed()) fail('PRESENTATION_LOST', 'Browser window was closed');
    this.mode = 'returning';
    this.generation++;
    if (this.frame.isMinimized()) this.frame.restore();
    if (!this.frame.isVisible()) this.frame.show();
    this.#cover();
    this.assertShielded();
    this.clear('returning');
    this.callbacks.invalidate('returning-to-automation');
    return this.generation;
  }
  finishReturn(generation) {
    this.assertObservable(true);
    if (this.generation !== generation || this.mode !== 'returning') fail('RETURN_CHANGED', 'Return was interrupted');
    this.mode = 'automation';
    this.notice = null;
    this.refresh();
    this.callbacks.visibility(this.logicalVisible());
  }
  hide() {
    this.generation++;
    this.intentionalHide = true;
    try { this.frame.hide(); } finally { this.intentionalHide = false; }
    this.callbacks.visibility(false);
    this.callbacks.invalidate('logical-hidden');
  }
  show() {
    this.frame.showInactive();
    this.callbacks.visibility(this.logicalVisible());
    this.callbacks.invalidate('logical-shown');
  }
  close() {
    this.closed = true;
    this.generation++;
    for (const resolve of this.releaseWaiters) resolve();
    this.releaseWaiters.clear();
    if (!this.frame.isDestroyed()) this.frame.destroy();
    // Views are not destroyed with their window; release both renderers.
    for (const contents of [this.shield, this.contents]) if (!contents.isDestroyed()) contents.close();
  }
  #layout() {
    if (this.frame.isDestroyed()) return;
    const { width, height } = this.frame.contentView.getBounds();
    const bounds = { x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) };
    this.view.setBounds(bounds);
    this.shieldView.setBounds(bounds);
  }
  #relayout() {
    this.#layout();
    this.callbacks.invalidate('viewport-resized');
  }
  #cover() {
    if (this.frame.isDestroyed() || this.shield.isDestroyed()) return;
    this.shieldView.setVisible(true);
    if (!this.contents.isDestroyed() && this.contents.isFocused()) this.toolbar.focus();
  }
  #message() {
    const t = this.text, paused = this.callbacks.paused();
    if (this.notice) return this.notice.key === 'paused' ? t.paused(this.notice.detail) : t[this.notice.key];
    if (this.mode === 'returning') return t.returning;
    if (this.mode === 'draining') return this.unknownGesture ? t.wheel : t.draining;
    if (paused === 'explicit-stop') return t.stopped;
    return paused ? t.paused(paused) : null;
  }
  #renderShield() {
    if (!this.ready || this.closed || this.shield.isDestroyed() || this.mode === 'native-handoff') return;
    const message = this.#message();
    void this.shield.executeJavaScript(`document.body.className=${JSON.stringify(message ? 'blocked' : 'agent')};`
      + `document.getElementById('message').textContent=${JSON.stringify(message ?? this.text.badge)}`)
      .catch(() => { /* A lost shield already blocks all admissions. */ });
  }
  #publish() {
    if (this.closed || this.frame.isDestroyed() || this.contents.isDestroyed()) return;
    const title = this.contents.getTitle(), url = this.contents.getURL();
    const label = url === 'about:blank' ? '' : title && title !== url ? title : url;
    this.frame.setTitle(label ? `${label} - ${APP_TITLE}` : APP_TITLE);
    if (this.toolbarReady && !this.toolbar.isDestroyed()) this.toolbar.send(TOOLBAR_STATE, this.#state());
  }
  #state() {
    const t = this.text, native = this.mode === 'native-handoff', paused = this.callbacks.paused();
    const url = this.contents.getURL(), loading = this.contents.isLoading(), history = this.contents.navigationHistory;
    const take = { text: t.takeControl, action: 'take-control' }, resume = { text: t.resume, action: 'resume' };
    const [chip, primary, secondary] = native
      ? [{ text: t.chipUser, tone: 'user', title: t.userHint }, { text: t.returnControl, action: 'resume' }, null]
      : this.mode === 'returning' ? [{ text: t.chipReturning, tone: 'wait' }, null, null]
        : this.mode === 'draining' ? [{ text: t.chipSwitching, tone: 'wait' }, take, resume]
          : paused ? [{ text: paused === 'explicit-stop' ? t.chipStopped : t.chipPaused, tone: 'stop', title: paused }, take, resume]
            : [{ text: t.chipAgent, tone: 'agent', title: t.agentHint }, take, { text: t.stopAgent, action: 'stop-automation' }];
    return {
      url: url === 'about:blank' ? '' : url, secure: url.startsWith('https:'),
      securityTitle: url.startsWith('https:') ? t.secure : t.insecure,
      editable: native, navigable: native, loading,
      canGoBack: native && history.canGoBack(), canGoForward: native && history.canGoForward(),
      reloadTitle: loading ? t.stopLoading : t.reload, invalid: this.addressError,
      notice: this.addressError ? t.invalidAddress : this.loadError ? t.loadFailed(this.loadError)
        : native && this.notice ? this.#message() : null,
      chip, primary, secondary,
    };
  }
  #toolbarAction(event, message) {
    // Only this window's own toolbar document; the main process enforces every
    // mode rule, so a toolbar message can never resume a page by itself.
    if (this.closed || event.senderFrame !== this.toolbar.mainFrame || this.toolbar.getURL() !== this.toolbarURL
      || !message || typeof message !== 'object' || typeof message.action !== 'string') return;
    const native = this.mode === 'native-handoff', history = this.contents.navigationHistory;
    switch (message.action) {
      case 'ready': this.toolbarReady = true; this.#publish(); return;
      case 'back': if (native && history.canGoBack()) history.goBack(); return;
      case 'forward': if (native && history.canGoForward()) history.goForward(); return;
      case 'reload': if (native) this.contents.reload(); return;
      case 'stop-loading': if (native) this.contents.stop(); return;
      case 'navigate': if (native) this.#navigate(message.value); return;
      case 'take-control': if (!native && this.mode !== 'returning') void this.actions.handoff(); return;
      case 'resume': if (native || this.mode === 'draining' || this.callbacks.paused()) void this.actions.resume(); return;
      case 'stop-automation': if (!native) this.actions.stop(); return;
      default:
    }
  }
  #navigate(value) {
    const url = addressURL(value);
    this.addressError = !url;
    if (url) {
      this.loadError = null;
      this.contents.focus();
      // Failures surface through did-fail-load; never repeat a navigation.
      this.contents.loadURL(url).catch(() => {});
    }
    this.#publish();
  }
}
