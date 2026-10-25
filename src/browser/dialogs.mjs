import { dialog } from 'electron';
import { fail } from '../shared/contract.mjs';

const adapters = new Set();
let installation;

// Application-owned consent surfaces are explicit native UI, not page dialogs.
export function showManualMessageBox(...args) {
  const native = installation && dialog.showMessageBox === installation.route
    ? installation.delegate : dialog.showMessageBox;
  return native.apply(dialog, args);
}

/**
 * Pinned Electron 44.9.1 compatibility integration, NOT a documented dialog
 * interception API. Only this companion's public module function is wrapped.
 * No Electron/Mixdog installation, private event, renderer binding or preload
 * is modified. Association uses the owned native window and actual CDP event,
 * never message contents, button labels or renderer-supplied approval.
 */
export class BrowserDialogs {
  #pending = new Map();
  #closed = false;
  constructor({ pageForWindow, onReady, note, pairingMs = 5000 }) {
    this.pageForWindow = pageForWindow;
    this.onReady = onReady;
    this.note = note;
    this.pairingMs = pairingMs;
    if (!installation) {
      const delegate = dialog.showMessageBox;
      const route = (...args) => {
        for (const adapter of adapters) {
          const page = adapter.pageForWindow(args[0]);
          if (page && page.presentation.mode !== 'native-handoff') return adapter.#capture(page, args[1]);
        }
        return delegate.apply(dialog, args);
      };
      installation = { delegate, route };
      dialog.showMessageBox = route;
    }
    adapters.add(this);
  }
  #pair(page) {
    let pair = this.#pending.get(page);
    if (pair) return pair;
    pair = { page, event: null, invocation: null, decision: null, published: false, ended: false };
    pair.closed = new Promise(resolve => { pair.finish = resolve; });
    this.#pending.set(page, pair);
    pair.timer = setTimeout(() => {
      this.note(page, 'Native JavaScript dialog association timed out; no response was approved');
      this.withdraw(page);
    }, this.pairingMs);
    pair.timer.unref();
    return pair;
  }
  #capture(page, options) {
    if (this.#closed || page.closed || page.contents.isDestroyed()) return Promise.resolve({ response: 1, checkboxChecked: false });
    const pair = this.#pair(page);
    if (pair.invocation) {
      this.note(page, 'Ambiguous native JavaScript dialog invocation; requests cancelled');
      this.withdraw(page);
      return Promise.resolve({ response: 1, checkboxChecked: false });
    }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pair.invocation = { resolve, signal: options.signal };
    // The real close event, not resolution of this message-box promise, is the
    // actual cleanup fence. Cancellation/timeout cannot release it.
    page.driver.trackNativeResponse(pair.closed);
    pair.abort = () => this.withdraw(page);
    options.signal.addEventListener('abort', pair.abort, { once: true });
    if (options.signal.aborted || page.paused || pair.decision === false) this.withdraw(page);
    else this.#publish(pair);
    return promise;
  }
  opened(page, event) {
    if (page.presentation.mode === 'native-handoff') return false;
    const pair = this.#pair(page);
    if (pair.event && pair.event !== event) {
      this.note(page, 'Ambiguous native JavaScript dialog event; requests cancelled');
      this.withdraw(page);
      return true;
    }
    pair.event = event;
    this.#publish(pair);
    return true;
  }
  #publish(pair) {
    if (!pair.event || !pair.invocation || pair.published || pair.decision !== null) return;
    clearTimeout(pair.timer);
    if (!['alert', 'confirm'].includes(pair.event.type) || pair.invocation.signal.aborted
      || pair.page.closed || pair.page.paused || pair.page.presentation.mode !== 'automation') {
      this.withdraw(pair.page);
      return;
    }
    pair.published = true;
    if (!this.onReady(pair.page, pair.event)) {
      this.note(pair.page, 'Native dialog has no current authenticated owner; dismissed without approval');
      this.withdraw(pair.page);
    }
  }
  ready(page, event) {
    const pair = this.#pending.get(page);
    return !!pair && pair.event === event && pair.published && pair.invocation
      && !pair.invocation.signal.aborted && pair.decision === null && !pair.ended;
  }
  answer(page, event, accept) {
    const pair = this.#pending.get(page);
    if (!this.ready(page, event)) fail('STALE_NATIVE_REQUEST', 'Native dialog is unassociated, already answered or withdrawn');
    pair.decision = accept;
    pair.invocation.resolve({ response: accept ? 0 : 1, checkboxChecked: false });
    return pair.closed;
  }
  withdraw(page) {
    const pair = this.#pending.get(page);
    if (!pair || pair.ended) return;
    clearTimeout(pair.timer);
    if (pair.decision === null) pair.decision = false;
    pair.invocation?.resolve({ response: pair.decision ? 0 : 1, checkboxChecked: false });
  }
  closed(page, event) {
    const pair = this.#pending.get(page);
    if (!pair || (event && pair.event && pair.event !== event)) return;
    this.#finish(pair);
  }
  destroyed(page) {
    const pair = this.#pending.get(page);
    if (pair) this.#finish(pair);
  }
  #finish(pair) {
    this.withdraw(pair.page);
    pair.ended = true;
    clearTimeout(pair.timer);
    pair.invocation?.signal.removeEventListener('abort', pair.abort);
    this.#pending.delete(pair.page);
    pair.finish();
  }
  close() {
    this.#closed = true;
    for (const pair of this.#pending.values()) this.#finish(pair);
    adapters.delete(this);
    if (!adapters.size && installation) {
      if (dialog.showMessageBox === installation.route) dialog.showMessageBox = installation.delegate;
      installation = undefined;
    }
  }
}
