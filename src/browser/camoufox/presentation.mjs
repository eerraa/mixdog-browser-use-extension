// Camoufox presentation and native Firefox #nav-bar Agent Control toolbar.
// Preserves the exact handoff state machine (`automation | draining |
// native-handoff | returning`, generation counter, fail-closed transitions,
// human-only return/resume, emergency Revert, and trusted human elevation
// toggle) inside Firefox's trusted parent chrome `#nav-bar` (0px height delta
// on outerHeight-innerHeight, zero DOM injected into web content, zero
// external floating window).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
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

const PAUSE_REASONS = {
  en: {
    'unexpected-page-input': 'Direct input',
    'explicit-stop': 'Stopped',
    'human-handoff': 'Manual control',
    'inherited-native-handoff': 'Control inherited',
    'presentation-lost': 'Window closed',
    'permission-revocation': 'Revoking',
    'return-failed': 'Return failed',
  },
  ko: {
    'unexpected-page-input': '직접 입력 감지',
    'explicit-stop': '사용자 중지',
    'human-handoff': '직접 조작',
    'inherited-native-handoff': '직접 조작 상속',
    'presentation-lost': '창 연결 끊김',
    'permission-revocation': '연결 종료 중',
    'return-failed': '반환 실패',
  },
};

const ALLOWED_BAR_ACTIONS = new Set([
  'take-control',
  'resume',
  'resume-all',
  'stop-automation',
  'revert-standard',
  'set-automation-mode',
  'revoke',
]);

const ALLOWED_AUTOMATION_MODES = new Set(['standard', 'elevated']);

export function formatPausedStatus(locale, reason) {
  const isKo = String(locale).toLowerCase().startsWith('ko');
  const map = isKo ? PAUSE_REASONS.ko : PAUSE_REASONS.en;
  const strings = isKo ? STRINGS.ko : STRINGS.en;
  const mapped = reason ? map[reason] : null;
  if (!mapped) return strings.paused;
  if (isKo) return mapped;
  return reason === 'explicit-stop' || reason === 'return-failed' ? mapped : `${strings.paused}: ${mapped}`;
}

function sameToken(supplied, expected) {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function toolbarLabels(locale) {
  const isKo = String(locale).toLowerCase().startsWith('ko');
  return isKo
    ? {
      stop: '중지',
      stopTitle: '에이전트 자동화 중지',
      elevate: '권한 상승',
      elevateTitle: '권한 상승 자동화(elevated)로 전환하고 저장합니다 (비밀번호/OTP 자동 입력 허용, CAPTCHA는 직접 처리)',
      revert: '권한 해제',
      revertTitle: '권한 상승 모드를 기본(standard)으로 즉시 해제합니다',
      revoke: '연결 종료',
      revokeTitle: '이 연결의 모든 브라우저 창을 닫습니다. 다시 사용하려면 MCP 호스트에서 새로 연결하세요. 이 창만 닫으려면 창 오른쪽 위의 ×를 누르세요.',
      returnAll: '모두 반환',
      pendingReturn: '반환 대기',
      idle: '대기 중',
      persistentProfileTitle: '영구 프로필 (로그인 유지)',
      ephemeralProfileTitle: '임시 프로필 (종료 시 초기화)',
      saveFailed: '설정 저장 실패',
    }
    : {
      stop: 'Stop',
      stopTitle: 'Stop agent automation',
      elevate: 'Elevate',
      elevateTitle: 'Switch to elevated automation and remember preference (CAPTCHA stays manual)',
      revert: 'Revert',
      revertTitle: 'Revert connection to standard mode',
      revoke: 'Disconnect',
      revokeTitle: 'Close every browser window on this connection (reconnect from the MCP host to use again). To close only this window, click × at the top right.',
      returnAll: 'Return all',
      pendingReturn: 'Return needed',
      idle: 'Idle',
      persistentProfileTitle: 'Persistent profile (logins kept)',
      ephemeralProfileTitle: 'Temporary profile (cleared on close)',
      saveFailed: 'Failed to save preference',
    };
}

function buildChromeToolbarBootstrap({ port, token, locale, initialState, expectedNonce = '' }) {
  const labels = toolbarLabels(locale);
  return `(() => {
    const EXPECTED_NONCE = ${JSON.stringify(expectedNonce || '')};
    try {
      if (EXPECTED_NONCE && Services.env?.get('WB_LAUNCH_NONCE') !== EXPECTED_NONCE) return -1;
    } catch { if (EXPECTED_NONCE) return -1; }
    const PORT = ${Number(port)};
    const TOKEN = ${JSON.stringify(token)};
    const L = ${JSON.stringify(labels)};
    const INITIAL_STATE = ${JSON.stringify(initialState ?? { elevated: false, canElevate: false, profileLabel: '', profilePersistent: false, activeId: '', visible: false, tabs: [] })};
    const HTML_NS = 'http://www.w3.org/1999/xhtml';
    const BAR_ID = 'wb-agent-nav-bar';
    const STYLE_ID = 'wb-agent-nav-style';

    if (globalThis.__wbNavToolbar) {
      try { globalThis.__wbNavToolbar.destroy(); } catch {}
    }

    const browserIdToTabId = new Map();
    const mountedWins = new Set();
    let lastState = INITIAL_STATE;
    let destroyed = false;
    let streamAbort = null;
    let reconnectTimer = null;

    function getChromeWindow() {
      for (const win of mountedWins) {
        if (win && !win.closed) return win;
      }
      try { return Services.wm.getMostRecentWindow('navigator:browser'); } catch { return null; }
    }

    function postAction(win, action, tabId, mode, onFail) {
      try {
        const fn = win?.fetch ?? globalThis.fetch;
        if (typeof fn !== 'function') return;
        const payload = { action, tabId: tabId || '' };
        if (mode) payload.mode = mode;
        fn('http://127.0.0.1:' + PORT + '/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WB-Token': TOKEN },
          body: JSON.stringify(payload),
        }).then(res => {
          if (!res.ok && typeof onFail === 'function') onFail();
        }).catch(() => {
          if (typeof onFail === 'function') onFail();
        });
      } catch {
        if (typeof onFail === 'function') onFail();
      }
    }

    function indexBrowsingContexts(win, tabs) {
      if (!win || !Array.isArray(tabs)) return;
      const validIds = new Set(tabs.map(t => t.id));
      for (const [bid, tid] of [...browserIdToTabId.entries()]) {
        if (!validIds.has(tid)) browserIdToTabId.delete(bid);
      }
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
          const exactMatches = tabs.filter(t => t.url === spec);
          if (exactMatches.length === 1) {
            if (typeof sel.browserId === 'number') browserIdToTabId.set(sel.browserId, exactMatches[0].id);
            return exactMatches[0];
          }
        }
      }
      return tabs.find(t => t.id === state.activeId) || tabs.find(t => t.needsReturn) || tabs[0];
    }

    function makeBtn(doc, text, title, onClick, { requireTrusted = false } = {}) {
      const btn = doc.createElementNS(HTML_NS, 'button');
      btn.type = 'button';
      btn.textContent = text;
      if (title) btn.title = title;
      btn.style.cssText = 'appearance:none;height:22px;padding:0 8px;border-radius:5px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);background:color-mix(in srgb,currentColor 8%,transparent);color:inherit;font:inherit;font-size:11.5px;line-height:20px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;-moz-window-dragging:no-drag;';
      btn.addEventListener('click', e => {
        if (requireTrusted && (!e.isTrusted || (typeof e.mozInputSource === 'number' && e.mozInputSource === 0))) return;
        e.stopPropagation();
        e.preventDefault();
        onClick(e);
      });
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

      const profileEl = bar._wbProfile;
      const dot = bar._wbDot;
      const statusEl = bar._wbStatus;
      const primaryBtn = bar._wbPrimary;
      const returnAllBtn = bar._wbReturnAll;
      const stopBtn = bar._wbStop;
      const elevateBtn = bar._wbElevate;
      const revertBtn = bar._wbRevert;

      if (state.profileLabel) {
        profileEl.style.display = 'inline-flex';
        profileEl.textContent = state.profileLabel;
        profileEl.title = state.profilePersistent
          ? (L.persistentProfileTitle + ': ' + state.profileLabel)
          : L.ephemeralProfileTitle;
        profileEl.style.borderColor = state.profilePersistent
          ? 'color-mix(in srgb,currentColor 26%,transparent)'
          : 'rgba(148,163,184,0.45)';
      } else {
        profileEl.style.display = 'none';
      }

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
      const rawNote = entry?.rawPausedReason ? (' [' + entry.rawPausedReason + ']') : '';
      statusEl.title = entry ? (entry.label + ' — ' + entry.status + rawNote) : '';

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

      elevateBtn.style.display = (!state.elevated && state.canElevate) ? 'inline-flex' : 'none';
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

      const profileEl = doc.createElementNS(HTML_NS, 'span');
      profileEl.style.cssText = 'display:none;align-items:center;height:18px;padding:0 5px;border-radius:4px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);background:color-mix(in srgb,currentColor 8%,transparent);font-size:10.5px;font-weight:600;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;';

      const dot = doc.createElementNS(HTML_NS, 'span');
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#22c55e;flex-shrink:0;';
      const statusEl = doc.createElementNS(HTML_NS, 'span');
      statusEl.style.cssText = 'max-width:136px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;padding-right:2px;';

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
      const elevateBtn = makeBtn(doc, L.elevate, L.elevateTitle, () => {
        postAction(win, 'set-automation-mode', '', 'elevated', () => {
          statusEl.textContent = L.saveFailed;
        });
      }, { requireTrusted: true });
      elevateBtn.style.display = 'none';

      const revertBtn = makeBtn(doc, L.revert, L.revertTitle, () => postAction(win, 'revert-standard', ''));
      revertBtn.style.background = '#d97706';
      revertBtn.style.borderColor = '#f59e0b';
      revertBtn.style.color = '#ffffff';
      revertBtn.style.fontWeight = '600';
      revertBtn.style.display = 'none';

      const revokeBtn = makeBtn(doc, L.revoke, L.revokeTitle, () => postAction(win, 'revoke', ''));

      bar.append(profileEl, dot, statusEl, primaryBtn, returnAllBtn, stopBtn, elevateBtn, revertBtn, revokeBtn);
      bar._wbProfile = profileEl;
      bar._wbDot = dot;
      bar._wbStatus = statusEl;
      bar._wbPrimary = primaryBtn;
      bar._wbReturnAll = returnAllBtn;
      bar._wbStop = stopBtn;
      bar._wbElevate = elevateBtn;
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
            if (!destroyed && domWin.document.documentElement.getAttribute('windowtype') === 'navigator:browser') {
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
        if (destroyed) return 0;
        lastState = state || lastState;
        mountAll();
        for (const win of [...mountedWins]) renderWindow(win);
        return mountedWins.size;
      },
      flash(tabId) {
        if (destroyed) return;
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
        destroyed = true;
        try { streamAbort?.abort(); } catch {}
        streamAbort = null;
        if (reconnectTimer) {
          try { getChromeWindow()?.clearTimeout(reconnectTimer); } catch {}
          reconnectTimer = null;
        }
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

    function scheduleReconnect() {
      if (destroyed) return;
      const win = getChromeWindow();
      const setT = win?.setTimeout?.bind(win) ?? globalThis.setTimeout;
      if (typeof setT !== 'function') return;
      reconnectTimer = setT(() => { reconnectTimer = null; connectStream(); }, 500);
    }

    async function connectStream() {
      if (destroyed) return;
      const win = getChromeWindow();
      const fetchFn = win?.fetch?.bind(win) ?? globalThis.fetch;
      const AC = win?.AbortController ?? globalThis.AbortController;
      const TD = win?.TextDecoder ?? globalThis.TextDecoder;
      if (typeof fetchFn !== 'function' || typeof AC !== 'function' || typeof TD !== 'function') {
        scheduleReconnect();
        return;
      }
      const ctrl = new AC();
      streamAbort = ctrl;
      try {
        const res = await fetchFn('http://127.0.0.1:' + PORT + '/events', {
          method: 'GET',
          headers: { 'X-WB-Token': TOKEN },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) { scheduleReconnect(); return; }
        const reader = res.body.getReader();
        const decoder = new TD();
        let buf = '';
        while (!destroyed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf('\\n\\n')) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            for (const line of block.split('\\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                const msg = JSON.parse(line.slice(5).trim());
                if (msg?.type === 'state') api.sync(msg.state);
                else if (msg?.type === 'flash') api.flash(msg.tabId || '');
                else if (msg?.type === 'destroy') { api.destroy(); return; }
              } catch {}
            }
          }
        }
      } catch {}
      if (!destroyed) scheduleReconnect();
    }

    globalThis.__wbNavToolbar = api;
    const count = mountAll();
    connectStream();
    return count;
  })()`;
}

export class ChromeToolbarClient extends EventEmitter {
  #getRdp;
  #getExpectedNonce;
  #onAction;
  #server = null;
  #port = 0;
  #token = randomBytes(32).toString('base64url');
  #eventClients = new Set();
  #pingTimer = null;
  #installed = false;
  #closed = false;
  #mountFlight = null;
  #retryTimer = null;
  #lastState = null;

  constructor({ getRdp, getExpectedNonce = null, onAction = null, headless = false, locale = 'ko-KR' } = {}) {
    super();
    this.#getRdp = getRdp;
    this.#getExpectedNonce = getExpectedNonce;
    this.#onAction = onAction;
    this.headless = headless;
    this.locale = locale;
  }

  get active() { return !this.headless && !this.#closed; }

  #broadcast(payload) {
    if (!this.#eventClients.size) return;
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of [...this.#eventClients]) {
      try {
        if (res.destroyed || res.writableEnded) { this.#eventClients.delete(res); continue; }
        res.write(frame);
      } catch {
        this.#eventClients.delete(res);
      }
    }
  }

  async #ensureServer() {
    if (this.#server) return this.#port;
    const server = http.createServer((req, res) => {
      if (!sameToken(req.headers['x-wb-token'], this.#token)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      if (req.method === 'GET' && req.url === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.flushHeaders?.();
        if (this.#eventClients.size >= 4) {
          const oldest = this.#eventClients.values().next().value;
          this.#eventClients.delete(oldest);
          try { oldest.end(); } catch { /* ignore */ }
        }
        this.#eventClients.add(res);
        req.on('close', () => this.#eventClients.delete(res));
        if (this.#lastState) {
          try { res.write(`data: ${JSON.stringify({ type: 'state', state: this.#lastState })}\n\n`); } catch { /* ignore */ }
        }
        return;
      }
      if (req.method !== 'POST' || req.url !== '/action') {
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
        let parsed;
        try { parsed = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
          return;
        }
        const action = typeof parsed?.action === 'string' ? parsed.action : '';
        const tabId = typeof parsed?.tabId === 'string' && /^t[1-9]\d{0,9}$/.test(parsed.tabId) ? parsed.tabId : null;
        const mode = typeof parsed?.mode === 'string' ? parsed.mode : null;
        if (!ALLOWED_BAR_ACTIONS.has(action)
          || (action === 'set-automation-mode' && !ALLOWED_AUTOMATION_MODES.has(mode))
          || (action !== 'set-automation-mode' && mode !== null)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
          return;
        }
        if (this.#onAction) {
          Promise.resolve().then(() => this.#onAction(action, tabId, mode)).then(outcome => {
            if (outcome === false) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end('{"ok":false}');
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end('{"ok":true}');
            }
          }).catch(() => {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end('{"ok":false}');
            }
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        this.emit('action', action, tabId, mode);
      });
    });
    server.unref();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.#server = server;
    this.#port = server.address().port;
    this.#pingTimer = setInterval(() => {
      for (const res of [...this.#eventClients]) {
        try {
          if (res.destroyed || res.writableEnded) { this.#eventClients.delete(res); continue; }
          res.write(': ping\n\n');
        } catch {
          this.#eventClients.delete(res);
        }
      }
    }, 25000);
    this.#pingTimer.unref?.();
    return this.#port;
  }

  #ensureMounted() {
    if (this.headless || this.#closed || this.#installed || this.#mountFlight) return;
    this.#mountFlight = (async () => {
      const rdp = this.#getRdp?.();
      if (!rdp || rdp.closed) return;
      if (!(await rdp.ensureConnected().catch(() => false))) return;
      const port = await this.#ensureServer();
      const expectedNonce = String(this.#getExpectedNonce?.() ?? '');
      const script = buildChromeToolbarBootstrap({
        port,
        token: this.#token,
        locale: this.locale,
        initialState: this.#lastState,
        expectedNonce,
      });
      const res = await rdp.chromeEval(script, 6000);
      if (res === -1) throw new Error('Refused toolbar mount: Firefox RDP process launch nonce mismatch');
      this.#installed = true;
      if (this.#lastState) this.#broadcast({ type: 'state', state: this.#lastState });
    })().catch(() => {
      if (!this.#closed && !this.#installed && !this.#retryTimer) {
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = null;
          this.#ensureMounted();
        }, 750);
        this.#retryTimer.unref?.();
      }
    }).finally(() => {
      this.#mountFlight = null;
    });
  }

  sync(state) {
    this.#lastState = state;
    if (this.headless || this.#closed) return;
    if (!this.#installed) this.#ensureMounted();
    this.#broadcast({ type: 'state', state });
  }

  flash(tabId = '') {
    if (this.headless || this.#closed) return;
    if (!this.#installed) this.#ensureMounted();
    this.#broadcast({ type: 'flash', tabId: tabId ?? '' });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = null; }
    if (this.#pingTimer) { clearInterval(this.#pingTimer); this.#pingTimer = null; }
    this.#broadcast({ type: 'destroy' });
    for (const res of [...this.#eventClients]) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.#eventClients.clear();
    const rdp = this.#getRdp?.();
    if (this.#installed && rdp?.connected) {
      rdp.chromeEval('globalThis.__wbNavToolbar?.destroy()', 1000).catch(() => {});
    }
    try { this.#server?.close(); this.#server?.closeAllConnections?.(); } catch { /* ignore */ }
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
        status = this.pausedReason ? formatPausedStatus(this.locale, this.pausedReason) : s.draining;
        primaryText = s.resumeAgent;
        primaryAction = 'resume';
      }
    } else if (this.pausedReason) {
      status = formatPausedStatus(this.locale, this.pausedReason);
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
      rawPausedReason: this.pausedReason || null,
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
