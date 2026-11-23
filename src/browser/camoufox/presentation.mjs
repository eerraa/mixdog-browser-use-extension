// Camoufox presentation & Win32 Control Bar controller.
// Preserves the exact handoff state machine (`automation | draining |
// native-handoff | returning`, generation counter, fail-closed transitions,
// human-only return/resume, one-way elevated downgrade) without injecting any
// DOM overlay into native Camoufox Firefox windows.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
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

  barEntry({ title = '', url = '' } = {}) {
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
