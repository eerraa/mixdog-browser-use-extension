// Asynchronous browser events since the agent's last view, one line each.
// Queued per caller session; a result drains the session's queue, current tab
// first. Signals report; they never authorize or replay anything.

import { displayURL, quote } from './perception/render.mjs';

const MAX_QUEUED = 50;
// Kinds that carry no page content; everything else is private outside automation.
export const CONTROL_SIGNALS = new Set(['state', 'closed']);
const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const size = bytes => (!Number.isFinite(bytes) || bytes <= 0 ? ''
  : bytes < 1024 ? ` ${bytes} B` : bytes < 1048576 ? ` ${Math.round(bytes / 1024)} KB` : ` ${(bytes / 1048576).toFixed(1)} MB`);

// Kinds whose newer entry replaces an older one of the same tab (and id).
const LATEST = new Set(['navigated', 'title', 'loading', 'state', 'requests']);
const SUMMED = new Set(['console', 'network']);

export class SignalQueue {
  #queues = new Map();

  push(sessionId, signal) {
    if (!sessionId || !signal?.tabId || !signal.kind) throw new TypeError('Signal needs a session, tabId and kind');
    const queue = this.#queues.get(sessionId) ?? [];
    this.#queues.set(sessionId, queue);
    const same = entry => entry.tabId === signal.tabId && entry.kind === signal.kind;
    if (signal.kind === 'navigated') {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].tabId === signal.tabId && ['navigated', 'title', 'loading'].includes(queue[i].kind)) queue.splice(i, 1);
      }
    } else if (LATEST.has(signal.kind)) {
      const at = queue.findIndex(same);
      if (at >= 0) queue.splice(at, 1);
    } else if (signal.kind === 'download') {
      const at = queue.findIndex(entry => same(entry) && entry.id === signal.id);
      if (at >= 0) queue.splice(at, 1);
    } else if (SUMMED.has(signal.kind)) {
      const existing = queue.find(same);
      if (existing) { existing.count += signal.count; return; }
    }
    queue.push({ ...signal });
    if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
  }
  /** Removes and returns the session's signals, those of `tabId` first. */
  drain(sessionId, tabId) {
    const queue = this.#queues.get(sessionId) ?? [];
    this.#queues.delete(sessionId);
    return [...queue.filter(entry => entry.tabId === tabId), ...queue.filter(entry => entry.tabId !== tabId)];
  }
  end(sessionId) { this.#queues.delete(sessionId); }
  /** Drops a tab's queued page-content signals (a handoff began). */
  purge(sessionId, tabId) {
    const queue = this.#queues.get(sessionId);
    if (!queue) return;
    const kept = queue.filter(entry => entry.tabId !== tabId || CONTROL_SIGNALS.has(entry.kind));
    if (kept.length) this.#queues.set(sessionId, kept); else this.#queues.delete(sessionId);
  }
}

const STATES = {
  stopped: 'stopped by person: only the person can resume',
  handoff: 'handoff active: the person controls this page',
  returned: 'returned to agent',
};
export function formatSignal(signal, currentTabId) {
  const prefix = signal.tabId === currentTabId ? 'signal' : `signal ${signal.tabId}`;
  switch (signal.kind) {
    case 'popup': return `${prefix} popup ${signal.popupTabId} ${quote(clip(signal.title, 80))} ${quote(clip(displayURL(signal.url), 200))}`;
    case 'closed': return `signal tab ${signal.closedTabId ?? signal.tabId} closed`;
    case 'download': return `${prefix} download ${quote(clip(signal.name, 80))} ${signal.state}${size(signal.bytes)}`;
    case 'dialog': return `${prefix} dialog ${signal.type} ${quote(clip(signal.message, 200))}${signal.requestRef ? ` request=${signal.requestRef}` : ''}`;
    case 'navigated': return `${prefix} navigated ${quote(clip(displayURL(signal.url), 300))} ${quote(clip(signal.title, 80))}`;
    case 'title': return `${prefix} title ${quote(clip(signal.title, 80))}`;
    case 'loading': return `${prefix} loading ${quote(clip(displayURL(signal.url), 300))}`;
    case 'state': return `${prefix} ${STATES[signal.state] ?? signal.state}`;
    case 'requests': return `${prefix} pending requests ${signal.count} (use requests)`;
    case 'console': return `${prefix} console ${signal.count} error${signal.count === 1 ? '' : 's'} (use console)`;
    case 'network': return `${prefix} network ${signal.count} failed (use network)`;
    default: return `${prefix} ${signal.kind}`;
  }
}
export const formatSignals = (signals, currentTabId) => signals.map(signal => formatSignal(signal, currentTabId));
