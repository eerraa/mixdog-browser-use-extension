import { BrowserHostError, fail, freshId, validateNativeResponse } from '../shared/contract.mjs';

// Reference/lifecycle registry only. Each adapter supplies its own native-state,
// policy and typed-response validation; option refs are not approval tokens.
export class BrowserRequests {
  #records = new Map();
  #closed = false;
  constructor({ now = Date.now, ttlMs = 120000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
  }
  create({ page, caller, signal = caller.signal, kind, context, options, isCurrent, validate, respond, withdraw }) {
    caller.assertLive();
    caller.signal.throwIfAborted();
    if (this.#closed || page.owner !== caller.sessionId) fail('FOREIGN_NATIVE_REQUEST', 'Native request is not owned by this caller');
    const controller = new AbortController();
    const sourceSignal = AbortSignal.any([caller.signal, signal]);
    const record = {
      requestRef: freshId(), revision: 0, state: 'pending', page, caller, kind,
      context: structuredClone(context), isCurrent, validate, onRespond: respond, onWithdraw: withdraw,
      controller, sourceSignal, signal: AbortSignal.any([sourceSignal, controller.signal]),
      expiresAt: this.now() + this.ttlMs,
    };
    record.closed = new Promise(resolve => { record.close = resolve; });
    this.#setOptions(record, options);
    this.#records.set(record.requestRef, record);
    record.abort = () => this.withdraw(record, 'Initiating caller cancelled or ended');
    sourceSignal.addEventListener('abort', record.abort, { once: true });
    record.timer = setTimeout(() => this.withdraw(record, 'Native request expired'), this.ttlMs);
    record.timer.unref();
    if (sourceSignal.aborted) this.withdraw(record, 'Initiating caller cancelled or ended');
    if (this.#records.has(record.requestRef)) page.nativeRequestOpened?.();
    return record;
  }
  #setOptions(record, options) {
    record.revision++;
    record.options = new Map(options.map(option => {
      const optionRef = freshId();
      return [optionRef, {
        optionRef, label: option.label, metadata: structuredClone(option.metadata), value: option.value,
      }];
    }));
  }
  replaceOptions(record, options) {
    if (this.#records.get(record.requestRef) !== record) return false;
    if (record.state !== 'pending') {
      this.withdraw(record, 'Native options changed during response');
      return false;
    }
    this.#setOptions(record, options);
    return true;
  }
  active(record) {
    return !this.#closed && this.#records.get(record.requestRef) === record
      && !record.signal.aborted && this.now() < record.expiresAt && record.isCurrent();
  }
  isResponding(record) { return record.state === 'responding' && this.active(record); }
  #owned(page, caller, requestRef) {
    const record = this.#records.get(requestRef);
    if (!record) fail('STALE_NATIVE_REQUEST', 'Native request is no longer pending');
    if (record.page !== page || record.caller.sessionId !== caller.sessionId || record.caller.signal !== caller.signal) {
      fail('FOREIGN_NATIVE_REQUEST', 'Native request belongs to another page or caller generation');
    }
    caller.assertLive();
    caller.signal.throwIfAborted();
    if (!this.active(record)) {
      this.withdraw(record, 'Native request context changed');
      fail('STALE_NATIVE_REQUEST', 'Native request context changed');
    }
    return record;
  }
  list(page, caller) {
    this.prune(page);
    return [...this.#records.values()].filter(record => record.page === page
      && record.caller.sessionId === caller.sessionId && record.caller.signal === caller.signal).map(record => ({
      requestRef: record.requestRef, revision: record.revision, kind: record.kind, state: record.state,
      context: structuredClone(record.context), expiresAt: record.expiresAt,
      options: record.state === 'pending' ? [...record.options.values()].map(({ optionRef, label, metadata }) => ({
        optionRef, label, metadata: structuredClone(metadata),
      })) : [],
    }));
  }
  async respond(page, caller, requestRef, response, beforeDispatch, responseSignal = caller.signal) {
    let record, option, decoded;
    try {
      validateNativeResponse(response);
      record = this.#owned(page, caller, requestRef);
      if (record.state !== 'pending') fail('NATIVE_RESPONSE_PENDING', 'A response was already dispatched; do not replay it');
      option = response.optionRef === undefined ? undefined : record.options.get(response.optionRef);
      if (response.optionRef !== undefined && !option) fail('STALE_NATIVE_OPTION', 'Option is not in the current native request');
      decoded = await record.validate(response, option?.value);
      this.#owned(page, caller, requestRef);
      if (record.state !== 'pending') fail('NATIVE_RESPONSE_PENDING', 'A response was already dispatched; do not replay it');
      if (option && record.options.get(response.optionRef) !== option) fail('STALE_NATIVE_OPTION', 'Native options changed during validation');
    } catch (error) {
      if (error instanceof BrowserHostError) Object.assign(error, { tabId: page.id, requestedInputDispatched: false });
      throw error;
    }
    record.state = 'responding';
    const cancel = () => this.withdraw(record, 'Response caller cancelled');
    responseSignal.addEventListener('abort', cancel, { once: true });
    try {
      responseSignal.throwIfAborted();
      beforeDispatch();
      return await record.onRespond(decoded, caller, AbortSignal.any([record.signal, responseSignal]));
    } catch (error) {
      this.withdraw(record, 'Native response failed or was cancelled');
      throw error;
    } finally {
      responseSignal.removeEventListener('abort', cancel);
      if (this.#records.get(requestRef) === record) {
        record.state = 'resolved';
        this.#remove(record);
      }
    }
  }
  #remove(record) {
    this.#records.delete(record.requestRef);
    clearTimeout(record.timer);
    record.sourceSignal.removeEventListener('abort', record.abort);
    record.close(record.state);
  }
  withdraw(record, reason = 'Native request withdrawn') {
    if (this.#records.get(record.requestRef) !== record) return false;
    this.#remove(record);
    record.state = 'withdrawn';
    record.controller.abort(new Error(reason));
    record.onWithdraw(reason);
    return true;
  }
  withdrawPage(page) {
    for (const record of [...this.#records.values()]) if (record.page === page) this.withdraw(record);
  }
  prune(page) {
    for (const record of [...this.#records.values()]) {
      if (record.page === page && !this.active(record)) this.withdraw(record, 'Native request context changed or expired');
    }
  }
  close() {
    this.#closed = true;
    for (const record of [...this.#records.values()]) this.withdraw(record, 'Browser connection closed');
  }
}
