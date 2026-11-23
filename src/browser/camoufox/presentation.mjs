// Camoufox presentation, native Firefox #nav-bar toolbar controller, and Win32
// Control Bar fallback.
// Preserves the exact handoff state machine (`automation | draining |
// native-handoff | returning`, generation counter, fail-closed transitions,
// human-only return/resume, one-way elevated downgrade) without injecting any
// DOM overlay into web content (controls live in Firefox parent chrome #nav-bar
// with 0px height delta on outerHeight-innerHeight).
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { fail } from '../../shared/contract.mjs';

const STRINGS = {
  en: {
    automation: 'Agent active',
    elevated: 'Elevated active',
    paused: 'Paused',
    draining: 'Switching…',
    native: 'You have control',
    returning: 'Returning…',
    returnFailed: 'Return failed',
    takeControl: 'Take control',
    returnAgent: 'Return to agent',
    resumeAgent: 'Resume agent',
    retryReturn: 'Retry return',
  },
  ko: {
    automation: '에이전트 자동화 중',
    elevated: '권한 상승 자동화 중',
    paused: '일시정지됨',
    draining: '전환 중…',
    native: '직접 조작 중',
    returning: '반환 중…',
    returnFailed: '반환 실패',
    takeControl: '직접 조작',
    returnAgent: '에이전트에게 돌려주기',
    resumeAgent: '에이전트 재개',
    retryReturn: '반환 재시도',
  },
};

export class ControlBarClient extends EventEmitter {
  #child = null;
  #buffer = '';
  #closed = false;

  constructor({ executablePath, headless = false, locale = 'ko-KR' } = {}) {
    super();
    this.executablePath = executablePath;
    this.headless = headless;
    this.locale = locale;
  }

  start() {
    if (this.headless || this.#closed || this.#child || !this.executablePath || !existsSync(this.executablePath)) return;
    const child = spawn(this.executablePath, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: false,
    });
    this.#child = child;
    child.stdout.on('data', chunk => {
      this.#buffer += chunk.toString('utf8');
      let nl;
      while ((nl = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, nl).trim();
        this.#buffer = this.#buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg?.action === 'string') this.emit('action', msg.action, msg.tabId ?? null);
        } catch { /* ignore malformed line */ }
      }
    });
    child.once('exit', () => {
      if (this.#child === child) this.#child = null;
    });
    child.on('error', () => {
      if (this.#child === child) this.#child = null;
    });
  }

  #send(object) {
    if (!this.#child || this.#closed || this.#child.stdin.destroyed) return;
    try { this.#child.stdin.write(`${JSON.stringify(object)}\n`); } catch { /* ignore */ }
  }

  sync({ elevated, activeId, tabs, visible = true, browserPid = 0 }) {
    this.start();
    this.#send({
      cmd: 'state',
      locale: this.locale,
      elevated: Boolean(elevated),
      active: activeId ?? '',
      visible,
      browserPid: Number.isInteger(browserPid) && browserPid > 0 ? browserPid : 0,
      tabs,
    });
  }

  flash() {
    this.#send({ cmd: 'flash' });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#send({ cmd: 'quit' });
    try { this.#child?.stdin.end(); } catch { /* ignore */ }
    try { this.#child?.kill(); } catch { /* ignore */ }
    this.#child = null;
  }
}

const ALLOWED_BAR_ACTIONS = new Set([
  'take-control',
  'resume',
  'resume-all',
  'stop-automation',
  'revert-standard',
  'revoke',
]);

function sameToken(supplied, expected) {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function buildChromeToolbarBootstrap({ port, token, locale }) {
  const isKo = String(locale).toLowerCase().startsWith('ko');
  const labels = isKo
    ? {
      stop: '중지',
      stopTitle: '에이전트 자동화 중지',
      revert: '권한 해제',
      revertTitle: '권한 상승 모드를 기본(standard)으로 즉시 되돌립니다',
      revoke: '종료',
      revokeTitle: '이 브라우저 연결을 종료합니다',
      returnAll: '모두 반환',
      pendingReturn: '반환 대기',
      idle: '대기 중',
    }
    : {
      stop: 'Stop',
      stopTitle: 'Stop agent automation',
      revert: 'Revert',
      revertTitle: 'Revert connection to standard mode',
      revoke: 'Revoke',
      revokeTitle: 'Close this browser connection',
      returnAll: 'Return all',
      pendingReturn: 'Return needed',
      idle: 'Idle',
    };
  return `(() => {
    const PORT = ${Number(port)};
    const TOKEN = ${JSON.stringify(token)};
    const L = ${JSON.stringify(labels)};
    const HTML_NS = 'http://www.w3.org/1999/xhtml';
    const BAR_ID = 'wb-agent-nav-bar';
    const STYLE_ID = 'wb-agent-nav-style';

    if (globalThis.__wbNavToolbar) {
      try { globalThis.__wbNavToolbar.destroy(); } catch {}
    }

    const browserIdToTabId = new Map();
    const mountedWins = new Set();
    let lastState = { elevated: false, activeId: '', visible: false, tabs: [] };

    function postAction(win, action, tabId) {
      try {
        const fn = win?.fetch ?? globalThis.fetch;
        if (typeof fn !== 'function') return;
        fn('http://127.0.0.1:' + PORT + '/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WB-Token': TOKEN },
          body: JSON.stringify({ action, tabId: tabId || '' }),
        }).catch(() => {});
      } catch {}
    }

    function indexBrowsingContexts(win, tabs) {
      if (!win || !Array.isArray(tabs)) return;
      const BC = win.BrowsingContext;
      for (const t of tabs) {
        if (typeof t.browsingContextId === 'number' && BC && typeof BC.get === 'function') {
          try {
            const bc = BC.get(t.browsingContextId);
            if (bc && typeof bc.browserId === 'number') browserIdToTabId.set(bc.browserId, t.id);
          } catch {}
        }
      }
    }

    function resolveTabForWindow(win, state) {
      const tabs = Array.isArray(state.tabs) ? state.tabs : [];
      if (!tabs.length) return null;
      const sel = win?.gBrowser?.selectedBrowser;
      if (sel) {
        if (typeof sel.browserId === 'number') {
          const mappedId = browserIdToTabId.get(sel.browserId);
          if (mappedId) {
            const hit = tabs.find(t => t.id === mappedId);
            if (hit) return hit;
          }
        }
        const bcId = sel.browsingContext?.id;
        if (typeof bcId === 'number') {
          const hit = tabs.find(t => t.browsingContextId === bcId);
          if (hit) {
            if (typeof sel.browserId === 'number') browserIdToTabId.set(sel.browserId, hit.id);
            return hit;
          }
        }
        const spec = sel.currentURI?.spec || '';
        if (spec && spec !== 'about:blank') {
          const exact = tabs.find(t => t.url === spec);
          if (exact) {
            if (typeof sel.browserId === 'number') browserIdToTabId.set(sel.browserId, exact.id);
            return exact;
          }
        }
      }
      return tabs.find(t => t.id === state.activeId) || tabs.find(t => t.needsReturn) || tabs[0];
    }

    function makeBtn(doc, text, title, onClick) {
      const btn = doc.createElementNS(HTML_NS, 'button');
      btn.type = 'button';
      btn.textContent = text;
      if (title) btn.title = title;
      btn.style.cssText = 'appearance:none;height:22px;padding:0 8px;border-radius:5px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);background:color-mix(in srgb,currentColor 8%,transparent);color:inherit;font:inherit;font-size:11.5px;line-height:20px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;-moz-window-dragging:no-drag;';
      btn.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); onClick(); });
      return btn;
    }

    function renderWindow(win) {
      if (!win || win.closed) { mountedWins.delete(win); return; }
      const doc = win.document;
      if (!doc) return;
      const bar = doc.getElementById(BAR_ID);
      if (!bar) return;
      const state = lastState;
      indexBrowsingContexts(win, state.tabs);
      if (!state.visible || !state.tabs?.length) {
        bar.style.display = 'none';
        return;
      }
      bar.style.display = 'flex';
      const entry = resolveTabForWindow(win, state);
      const pendingTabs = state.tabs.filter(t => t.needsReturn);
      const otherPending = pendingTabs.filter(t => !entry || t.id !== entry.id);

      const dot = bar._wbDot;
      const statusEl = bar._wbStatus;
      const primaryBtn = bar._wbPrimary;
      const returnAllBtn = bar._wbReturnAll;
      const stopBtn = bar._wbStop;
      const revertBtn = bar._wbRevert;

      const isHandoff = entry?.mode === 'native-handoff';
      const isFailed = Boolean(entry?.needsReturn && !isHandoff);
      const isPaused = Boolean(entry?.paused && !isHandoff);

      if (isHandoff) {
        bar.style.borderColor = 'rgba(59,130,246,0.65)';
        bar.style.background = 'rgba(37,99,235,0.16)';
        dot.style.background = '#3b82f6';
      } else if (state.elevated) {
        bar.style.borderColor = 'rgba(245,158,11,0.7)';
        bar.style.background = 'rgba(217,119,6,0.16)';
        dot.style.background = '#f59e0b';
      } else if (isFailed || isPaused) {
        bar.style.borderColor = 'rgba(239,68,68,0.6)';
        bar.style.background = 'rgba(220,38,38,0.14)';
        dot.style.background = '#ef4444';
      } else {
        bar.style.borderColor = 'color-mix(in srgb,currentColor 20%,transparent)';
        bar.style.background = 'color-mix(in srgb,currentColor 6%,transparent)';
        dot.style.background = '#22c55e';
      }

      statusEl.textContent = entry ? entry.status : L.idle;
      statusEl.title = entry ? (entry.label + ' — ' + entry.status) : '';

      bar._wbTabId = entry?.id || '';
      bar._wbPrimaryAction = entry?.primaryAction || '';
      primaryBtn.textContent = entry?.primaryText || '';
      primaryBtn.disabled = !entry || !entry.primaryAction;
      primaryBtn.style.opacity = primaryBtn.disabled ? '0.5' : '1';
      if (isHandoff || isFailed) {
        primaryBtn.style.background = '#2563eb';
        primaryBtn.style.borderColor = '#3b82f6';
        primaryBtn.style.color = '#ffffff';
        primaryBtn.style.fontWeight = '600';
      } else {
        primaryBtn.style.background = 'color-mix(in srgb,currentColor 10%,transparent)';
        primaryBtn.style.borderColor = 'color-mix(in srgb,currentColor 26%,transparent)';
        primaryBtn.style.color = 'inherit';
        primaryBtn.style.fontWeight = '500';
      }

      if (pendingTabs.length >= 2) {
        returnAllBtn.style.display = 'inline-flex';
        returnAllBtn.textContent = L.returnAll + ' (' + pendingTabs.length + ')';
        returnAllBtn._wbMode = 'resume-all';
      } else if (otherPending.length === 1) {
        returnAllBtn.style.display = 'inline-flex';
        returnAllBtn.textContent = L.pendingReturn + ' ' + otherPending[0].id;
        returnAllBtn._wbMode = 'resume-other';
        returnAllBtn._wbOtherId = otherPending[0].id;
      } else {
        returnAllBtn.style.display = 'none';
      }

      stopBtn.disabled = !entry || !entry.stopEnabled;
      stopBtn.style.opacity = stopBtn.disabled ? '0.45' : '1';

      revertBtn.style.display = state.elevated ? 'inline-flex' : 'none';
    }

    function mountWindow(win) {
      if (!win || win.closed) return false;
      const doc = win.document;
      if (!doc) return false;
      const existing = doc.getElementById(BAR_ID);
      if (existing) {
        mountedWins.add(win);
        renderWindow(win);
        return true;
      }
      const nav = doc.getElementById('nav-bar');
      if (!nav) return false;
      const panelBtn = doc.getElementById('PanelUI-button');

      if (!doc.getElementById(STYLE_ID)) {
        const st = doc.createElementNS(HTML_NS, 'style');
        st.id = STYLE_ID;
        st.textContent = '#' + BAR_ID + ' button:not(:disabled):hover{filter:brightness(1.14);}'
          + '#' + BAR_ID + ' button:not(:disabled):active{transform:translateY(0.5px);}';
        (doc.head || doc.documentElement).appendChild(st);
      }

      const bar = doc.createElementNS(HTML_NS, 'div');
      bar.id = BAR_ID;
      bar.style.cssText = 'display:none;align-items:center;gap:5px;height:26px;padding:0 6px;margin-inline:4px;border-radius:7px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:color-mix(in srgb,currentColor 6%,transparent);color:inherit;font-size:11.5px;box-sizing:border-box;flex-shrink:0;-moz-window-dragging:no-drag;transition:border-color 120ms ease,background-color 120ms ease;';

      const dot = doc.createElementNS(HTML_NS, 'span');
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#22c55e;flex-shrink:0;';
      const statusEl = doc.createElementNS(HTML_NS, 'span');
      statusEl.style.cssText = 'max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;padding-right:2px;';

      const primaryBtn = makeBtn(doc, '', '', () => {
        if (bar._wbPrimaryAction && bar._wbTabId) postAction(win, bar._wbPrimaryAction, bar._wbTabId);
      });
      const returnAllBtn = makeBtn(doc, L.returnAll, L.returnAll, () => {
        if (returnAllBtn._wbMode === 'resume-other' && returnAllBtn._wbOtherId) {
          postAction(win, 'resume', returnAllBtn._wbOtherId);
        } else {
          postAction(win, 'resume-all', '');
        }
      });
      returnAllBtn.style.background = '#1d4ed8';
      returnAllBtn.style.borderColor = '#3b82f6';
      returnAllBtn.style.color = '#ffffff';
      returnAllBtn.style.fontWeight = '600';
      returnAllBtn.style.display = 'none';

      const stopBtn = makeBtn(doc, L.stop, L.stopTitle, () => {
        if (bar._wbTabId) postAction(win, 'stop-automation', bar._wbTabId);
      });
      const revertBtn = makeBtn(doc, L.revert, L.revertTitle, () => postAction(win, 'revert-standard', ''));
      revertBtn.style.background = '#d97706';
      revertBtn.style.borderColor = '#f59e0b';
      revertBtn.style.color = '#ffffff';
      revertBtn.style.fontWeight = '600';
      revertBtn.style.display = 'none';

      const revokeBtn = makeBtn(doc, L.revoke, L.revokeTitle, () => postAction(win, 'revoke', ''));

      bar.append(dot, statusEl, primaryBtn, returnAllBtn, stopBtn, revertBtn, revokeBtn);
      bar._wbDot = dot;
      bar._wbStatus = statusEl;
      bar._wbPrimary = primaryBtn;
      bar._wbReturnAll = returnAllBtn;
      bar._wbStop = stopBtn;
      bar._wbRevert = revertBtn;

      nav.insertBefore(bar, panelBtn || null);
      const onTabSelect = () => renderWindow(win);
      bar._wbOnTabSelect = onTabSelect;
      try { win.gBrowser?.tabContainer?.addEventListener('TabSelect', onTabSelect); } catch {}
      mountedWins.add(win);
      renderWindow(win);
      return true;
    }

    function mountAll() {
      let count = 0;
      const en = Services.wm.getEnumerator('navigator:browser');
      while (en.hasMoreElements()) {
        if (mountWindow(en.getNext())) count++;
      }
      return count;
    }

    const wmListener = {
      onOpenWindow(xulWin) {
        try {
          const domWin = xulWin.docShell.domWindow;
          domWin.addEventListener('load', () => {
            if (domWin.document.documentElement.getAttribute('windowtype') === 'navigator:browser') {
              mountWindow(domWin);
            }
          }, { once: true });
        } catch {}
      },
      onCloseWindow() {},
    };
    Services.wm.addListener(wmListener);

    const api = {
      sync(state) {
        lastState = state || lastState;
        mountAll();
        for (const win of [...mountedWins]) renderWindow(win);
        return mountedWins.size;
      },
      flash(tabId) {
        mountAll();
        for (const win of [...mountedWins]) {
          if (!win || win.closed) continue;
          const entry = resolveTabForWindow(win, lastState);
          if (!tabId || !entry || entry.id === tabId || mountedWins.size === 1) {
            try { win.getAttention(); } catch {}
            const bar = win.document?.getElementById(BAR_ID);
            if (bar) {
              bar.style.boxShadow = '0 0 0 2px rgba(59,130,246,0.75)';
              win.setTimeout(() => { try { bar.style.boxShadow = ''; } catch {} }, 1200);
            }
          }
        }
      },
      destroy() {
        try { Services.wm.removeListener(wmListener); } catch {}
        for (const win of [...mountedWins]) {
          try {
            const bar = win.document?.getElementById(BAR_ID);
            if (bar?._wbOnTabSelect) win.gBrowser?.tabContainer?.removeEventListener('TabSelect', bar._wbOnTabSelect);
            bar?.remove();
            win.document?.getElementById(STYLE_ID)?.remove();
          } catch {}
        }
        mountedWins.clear();
        delete globalThis.__wbNavToolbar;
      },
    };
    globalThis.__wbNavToolbar = api;
    return mountAll();
  })()`;
}

export class ChromeToolbarClient extends EventEmitter {
  #getRdp;
  #server = null;
  #port = 0;
  #token = randomBytes(32).toString('base64url');
  #installed = false;
  #failed = false;
  #closed = false;
  #inFlight = null;
  #pendingState = null;
  #pendingFlash = null;
  #lastState = null;

  constructor({ getRdp, headless = false, locale = 'ko-KR' } = {}) {
    super();
    this.#getRdp = getRdp;
    this.headless = headless;
    this.locale = locale;
  }

  get active() { return !this.headless && !this.#failed && !this.#closed; }

  async #ensureServer() {
    if (this.#server) return this.#port;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/action' || !sameToken(req.headers['x-wb-token'], this.#token)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      let body = '';
      let tooLarge = false;
      req.on('data', chunk => {
        body += chunk.toString('utf8');
        if (body.length > 4096) { tooLarge = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          const parsed = JSON.parse(body);
          const action = typeof parsed?.action === 'string' ? parsed.action : '';
          const tabId = typeof parsed?.tabId === 'string' && /^t[1-9]\d{0,9}$/.test(parsed.tabId) ? parsed.tabId : null;
          if (!ALLOWED_BAR_ACTIONS.has(action)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end('{"ok":false}');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          this.emit('action', action, tabId);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
        }
      });
    });
    server.unref();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.#server = server;
    this.#port = server.address().port;
    return this.#port;
  }

  #schedule() {
    if (this.#inFlight || this.#closed || this.#failed || this.headless) return;
    this.#inFlight = this.#drain().finally(() => {
      this.#inFlight = null;
      if ((this.#pendingState || this.#pendingFlash !== null) && !this.#closed && !this.#failed) {
        this.#schedule();
      }
    });
  }

  async #drain() {
    const rdp = this.#getRdp?.();
    if (!rdp || rdp.closed) return;
    if (!(await rdp.ensureConnected().catch(() => false))) return;
    if (!this.#installed) {
      try {
        const port = await this.#ensureServer();
        const script = buildChromeToolbarBootstrap({ port, token: this.#token, locale: this.locale });
        await rdp.chromeEval(script, 4000);
        this.#installed = true;
      } catch (error) {
        this.#failed = true;
        this.emit('fallback', error, this.#lastState);
        return;
      }
    }
    while (!this.#closed && !this.#failed) {
      const nextState = this.#pendingState;
      const nextFlash = this.#pendingFlash;
      this.#pendingState = null;
      this.#pendingFlash = null;
      if (!nextState && nextFlash === null) break;
      try {
        if (nextState) {
          await rdp.chromeEval(`globalThis.__wbNavToolbar?.sync(${JSON.stringify(nextState)})`, 3000);
        }
        if (nextFlash !== null) {
          await rdp.chromeEval(`globalThis.__wbNavToolbar?.flash(${JSON.stringify(nextFlash)})`, 3000);
        }
      } catch {
        // If chrome reloaded or disconnected mid-sync, allow re-mount on next sync unless closed.
        this.#installed = false;
        break;
      }
    }
  }

  sync(state) {
    this.#lastState = state;
    if (this.headless || this.#closed || this.#failed) return;
    this.#pendingState = state;
    this.#schedule();
  }

  flash(tabId = '') {
    if (this.headless || this.#closed || this.#failed) return;
    this.#pendingFlash = tabId ?? '';
    this.#schedule();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    const rdp = this.#getRdp?.();
    if (this.#installed && rdp?.connected) {
      rdp.chromeEval('globalThis.__wbNavToolbar?.destroy()', 1000).catch(() => {});
    }
    try { this.#server?.close(); } catch { /* ignore */ }
    this.#server = null;
  }
}

export class CamoufoxPresentation {
  constructor({ id, sessionLabel = 'Default (ctx1)', locale = 'ko-KR', isElevated = () => false, onSync = () => {} }) {
    this.id = id;
    this.sessionLabel = sessionLabel;
    this.locale = locale;
    this.strings = String(locale).toLowerCase().startsWith('ko') ? STRINGS.ko : STRINGS.en;
    this.isElevated = isElevated;
    this.onSync = onSync;
    this.mode = 'automation';
    this.generation = 1;
    this.pausedReason = null;
    this.returnFailure = null;
    this.closed = false;
  }

  assertObservable() {
    if (this.mode !== 'automation') {
      fail('PRIVATE_HANDOFF', 'Page observation is blocked while the person controls this tab or a handoff transition is in progress');
    }
  }

  assertAutomation(expectedGeneration) {
    if (this.mode !== 'automation') {
      fail('PRIVATE_HANDOFF', 'Automation input is blocked outside automation mode');
    }
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) {
      fail('STALE_REF', 'Control generation changed during handoff/return; observe this tab again');
    }
  }

  beginDrain(reason) {
    if (this.closed) return this.generation;
    this.mode = 'draining';
    this.pausedReason = reason;
    this.generation++;
    this.refresh();
    return this.generation;
  }

  enterNative(reason, expectedGeneration) {
    if (this.closed || (expectedGeneration !== undefined && expectedGeneration !== this.generation)) return false;
    this.mode = 'native-handoff';
    this.pausedReason = reason ?? this.pausedReason ?? 'human-handoff';
    this.returnFailure = null;
    this.refresh();
    return true;
  }

  beginReturn() {
    if (this.closed) return this.generation;
    this.mode = 'returning';
    this.generation++;
    this.refresh();
    return this.generation;
  }

  finishReturn(expectedGeneration) {
    if (this.closed || (expectedGeneration !== undefined && expectedGeneration !== this.generation)) return false;
    this.mode = 'automation';
    this.pausedReason = null;
    this.returnFailure = null;
    this.generation++;
    this.refresh();
    return true;
  }

  failReturn(failure) {
    if (this.closed) return;
    this.mode = 'draining';
    this.pausedReason = 'return-failed';
    this.returnFailure = failure;
    this.generation++;
    this.refresh();
  }

  pauseInAutomation(reason) {
    if (this.closed) return;
    this.pausedReason = reason;
    this.refresh();
  }

  failClosed(reason) {
    if (this.closed) return;
    this.mode = 'draining';
    this.pausedReason = reason;
    this.generation++;
    this.refresh();
  }

  refresh() {
    this.onSync();
  }

  barEntry({ title = '', url = '', browsingContextId = null } = {}) {
    const s = this.strings;
    const elevated = this.isElevated();
    let status = elevated ? s.elevated : s.automation;
    let primaryText = s.takeControl;
    let primaryAction = 'take-control';
    let stopEnabled = true;

    if (this.mode === 'native-handoff') {
      status = s.native;
      primaryText = s.returnAgent;
      primaryAction = 'resume';
    } else if (this.mode === 'returning') {
      status = s.returning;
      primaryText = s.returning;
      primaryAction = '';
    } else if (this.mode === 'draining') {
      if (this.returnFailure) {
        status = `${s.returnFailed} (${this.returnFailure.stage})`;
        primaryText = s.retryReturn;
        primaryAction = 'resume';
      } else {
        status = this.pausedReason ? `${s.paused}: ${this.pausedReason}` : s.draining;
        primaryText = s.resumeAgent;
        primaryAction = 'resume';
      }
    } else if (this.pausedReason) {
      status = `${s.paused}: ${this.pausedReason}`;
      primaryText = s.resumeAgent;
      primaryAction = 'resume';
      stopEnabled = this.pausedReason !== 'explicit-stop';
    }

    const cleanTitle = String(title ?? '').replace(/\s+/g, ' ').trim();
    let host = '';
    try { host = url && url !== 'about:blank' ? new URL(url).host : ''; } catch { host = ''; }
    const pageTag = cleanTitle || host || this.sessionLabel;
    const clippedTag = pageTag.length > 26 ? `${pageTag.slice(0, 25)}…` : pageTag;
    const isCustomSession = !/^Default\b/.test(this.sessionLabel);
    const label = isCustomSession ? `${this.id} · ${clippedTag} [${this.sessionLabel}]` : `${this.id} · ${clippedTag}`;

    return {
      id: this.id,
      label,
      url: typeof url === 'string' ? url : '',
      browsingContextId: typeof browsingContextId === 'number' ? browsingContextId : null,
      mode: this.mode,
      paused: Boolean(this.pausedReason),
      status,
      primaryText,
      primaryAction,
      stopEnabled,
      needsReturn: this.mode === 'native-handoff' || Boolean(this.returnFailure),
    };
  }

  destroy() {
    this.closed = true;
    this.refresh();
  }
}
