// The script-facing API: a strict Playwright-like subset. It runs in the
// sandbox renderer's main world next to the script and only turns calls into
// bridge ops; every rule is enforced in the main process (bridge.mjs), so a
// script that rewrites this object gains nothing. `runnerApi` must stay
// self-contained: it is serialized with Function.prototype.toString.

export function runnerApi(call, initialTabId) {
  'use strict';
  class RunnerError extends Error {
    constructor(error) {
      super(String((error && error.message) || 'Runner step failed'));
      this.name = 'RunnerError';
      // not-executed: nothing was sent (safe to handle); executed: the step ran
      // and reported a failure; observed: a read or wait failed.
      this.code = error && error.code;
      this.kind = error && error.kind;
      if (error && error.candidates) this.candidates = error.candidates;
    }
  }
  const op = async (name, args) => {
    const reply = await call(name, args);
    if (reply && reply.ok === true) return reply.value;
    throw new RunnerError(reply && reply.error);
  };
  const timeout = options => (options && options.timeout !== undefined ? { timeoutMs: options.timeout } : {});
  const named = (fields, options) => {
    const target = { ...fields };
    if (options && options.exact) target.exact = true;
    return target;
  };

  class Locator {
    #page; #loc;
    constructor(page, loc) { this.#page = page; this.#loc = loc; }
    #args(extra, options) { return { tabId: this.#page.tabId, loc: this.#loc, ...extra, ...timeout(options) }; }
    click(options) { return op('click', this.#args({}, options)); }
    fill(text, options) { return op('fill', this.#args({ text: String(text) }, options)); }
    type(text, options) { return op('type', this.#args({ text: String(text) }, options)); }
    press(key, options) { return op('press', this.#args({ key: String(key) }, options)); }
    selectOption(values, options) {
      return op('select', this.#args({ values: (Array.isArray(values) ? values : [values]).map(String) }, options));
    }
    setInputFiles(files, options) {
      return op('upload', this.#args({ files: (Array.isArray(files) ? files : [files]).map(String) }, options));
    }
    scroll(deltaY, deltaX = 0, options) { return op('scroll', this.#args({ deltaX: Number(deltaX), deltaY: Number(deltaY) }, options)); }
    async innerText(options) { return (await op('read', this.#args({}, options))).text; }
    async inputValue(options) { return (await op('read', this.#args({}, options))).value; }
    async waitFor(options) { await op('read', this.#args({}, options)); }
  }

  class Scope {
    #page; #frame;
    constructor(page, frame) { this.#page = page; this.#frame = frame; }
    #target(fields, options) {
      const target = named(fields, options);
      if (this.#frame) target.frame = this.#frame;
      return new Locator(this.#page ?? this, { target });
    }
    getByRole(role, options = {}) {
      return this.#target({ role: String(role), ...(options.name !== undefined ? { name: String(options.name) } : {}) }, options);
    }
    getByText(text, options) { return this.#target({ name: String(text) }, options); }
    getByLabel(text, options) { return this.#target({ name: String(text) }, options); }
    locator(selector) { return this.#target({ selector: String(selector) }); }
    ref(ref) { return new Locator(this.#page ?? this, { ref: String(ref) }); }
  }

  class Page extends Scope {
    constructor(tabId) { super(null, null); this.tabId = tabId; Object.freeze(this); }
    goto(url) { return op('navigate', { tabId: this.tabId, url: String(url) }); }
    frame(ref) { return new Scope(this, String(ref)); }
    find(query) { return op('find', { tabId: this.tabId, query: String(query) }); }
    async snapshot(options = {}) {
      return (await op('snapshot', { tabId: this.tabId, ...(options.mode ? { mode: String(options.mode) } : {}) })).text;
    }
    async waitForText(text, options) { await op('wait', { tabId: this.tabId, text: String(text), ...timeout(options) }); }
    async waitForTextGone(text, options) { await op('wait', { tabId: this.tabId, gone: String(text), ...timeout(options) }); }
    async waitForURL(part, options) { await op('wait', { tabId: this.tabId, url: String(part), ...timeout(options) }); }
    evaluate(expression) {
      const source = typeof expression === 'function' ? `(${expression.toString()})()` : String(expression);
      return op('evaluate', { tabId: this.tabId, expression: source });
    }
    dialog(accept, promptText) {
      return op('dialog', { tabId: this.tabId, accept: !!accept, ...(promptText !== undefined ? { promptText: String(promptText) } : {}) });
    }
    async close() { await op('close', { tabId: this.tabId }); }
    async url() { return ((await op('tabs', {})).find(tab => tab.tabId === this.tabId) || {}).url; }
    async title() { return ((await op('tabs', {})).find(tab => tab.tabId === this.tabId) || {}).title; }
  }

  const pages = new Map();
  const pageFor = tabId => {
    if (!pages.has(tabId)) pages.set(tabId, new Page(tabId));
    return pages.get(tabId);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(Number(ms) || 0, 30000))));
  return Object.freeze({
    page: initialTabId ? pageFor(initialTabId) : null,
    ctx: Object.freeze({
      open: async url => pageFor((await op('open', { url: String(url) })).tabId),
      tabs: async () => (await op('tabs', {})).map(tab => ({ ...tab, page: pageFor(tab.tabId) })),
      sleep,
      RunnerError,
    }),
  });
}

export const RUNNER_API_SOURCE = runnerApi.toString();
