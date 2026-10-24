// The main-process side of the script runner bridge. Every op is one browse
// call through the same host pipeline (ownership, pause and handoff gates,
// validation, dispatch once, settle) under the run's caller. The op allowlist
// and argument shapes are checked here; the sandbox is never trusted.
//
// Outcomes (decision recorded in docs at integration):
// - not-executed: nothing was sent; the script gets a catchable error.
// - executed with a code: the step ran and reported a failure (catchable).
// - uncertain: the bridge seals (every later op refused) and the run ends.
// - Stop, handoff, cancellation and the deadline end the run.
import { pause } from '../../async.mjs';
import { validateArgs } from '../contract.mjs';

const TAB = /^t[1-9]\d{0,9}$/;
const REF = /^e[1-9]\d{0,9}$/;
// The host's wait bounds (contract.mjs validateArgs): at most 10 s, 500 characters.
export const RUNNER_WAIT = Object.freeze({ defaultMs: 5000, maxMs: 10000, pollMs: 100, textChars: 500 });
// Floods: ops per run (refused ones included), ops in flight at once.
export const RUNNER_FLOOD = Object.freeze({ ops: 2000, inFlight: 4 });
// Host refusals that mean the tab was never accepted as the run's own.
const UNACCEPTED = new Set(['CLOSED_TAB', 'FOREIGN_TAB', 'INVALID_ARGUMENT', 'UNAUTHENTICATED_CALLER']);
// Codes worth waiting out: the element is not there yet or not actionable yet.
const RETRY = new Set(['TARGET_NOT_FOUND', 'NOT_ACTIONABLE']);
// Codes that end the run: the person or the caller took control.
const TERMINAL = { AUTOMATION_PAUSED: 'paused', PRIVATE_HANDOFF: 'handoff' };
/** Run status for a tab's pause reason (host `paused`): Stop, handoff, or another pause. */
export const pauseStatus = reason => (reason === 'explicit-stop' ? 'stopped'
  : /handoff|intervention/.test(String(reason ?? '')) ? 'handoff' : 'paused');

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const str = (value, max, min = 1) => typeof value === 'string' && value.length >= min && value.length <= max;
const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_RUNNER_OP' }); };

function locator(loc, frameOnly = false) {
  if (!plain(loc)) invalid('loc must be { ref } or { target }');
  const keys = Object.keys(loc);
  if (keys.length === 1 && keys[0] === 'ref' && !frameOnly) {
    if (!REF.test(loc.ref)) invalid('ref must be e<n>');
    return { ref: loc.ref };
  }
  if (keys.length !== 1 || keys[0] !== 'target' || !plain(loc.target)) invalid('loc must be { ref } or { target }');
  const target = {};
  for (const [key, value] of Object.entries(loc.target)) {
    if (['role', 'name', 'selector'].includes(key) && str(value, 1000)) target[key] = value;
    else if (key === 'exact' && value === true) target.exact = true;
    else if (key === 'frame' && REF.test(value)) target.frame = value;
    else invalid(`target.${key} is not allowed`);
  }
  if (!target.role && target.name === undefined && !target.selector) invalid('target needs role, name or selector');
  return { target };
}
const timeoutMs = value => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > RUNNER_WAIT.maxMs) invalid(`timeoutMs must be 0..${RUNNER_WAIT.maxMs}`);
  return value;
};

// op → { action, input, wait (auto-wait on RETRY codes), keys, build(args) → browse args }.
const at = (args, extra) => ({ tabId: args.tabId, ...extra });
const withLoc = args => (args.loc === undefined ? {} : locator(args.loc));
export const RUNNER_OPS = Object.freeze({
  open: { action: 'open', input: true, keys: ['url'], build: a => ({ url: a.url }) },
  navigate: { action: 'navigate', input: true, keys: ['tabId', 'url'], build: a => at(a, { url: a.url }) },
  click: { action: 'click', input: true, wait: true, loc: true, keys: ['tabId', 'loc', 'timeoutMs'], build: a => at(a, withLoc(a)) },
  fill: { action: 'fill', input: true, wait: true, loc: true, keys: ['tabId', 'loc', 'text', 'timeoutMs'], build: a => at(a, { ...withLoc(a), text: a.text }) },
  type: { action: 'type', input: true, wait: true, loc: true, keys: ['tabId', 'loc', 'text', 'timeoutMs'], build: a => at(a, { ...withLoc(a), text: a.text }) },
  press: { action: 'press', input: true, wait: true, loc: true, keys: ['tabId', 'loc', 'key', 'timeoutMs'], build: a => at(a, { ...withLoc(a), key: a.key }) },
  select: { action: 'select', input: true, wait: true, loc: true, keys: ['tabId', 'loc', 'values', 'timeoutMs'], build: a => at(a, { ...withLoc(a), values: a.values }) },
  upload: { action: 'upload', input: true, wait: true, loc: true, keys: ['tabId', 'loc', 'files', 'timeoutMs'], build: a => at(a, { ...withLoc(a), files: a.files }) },
  scroll: { action: 'scroll', input: true, wait: true, loc: true, keys: ['tabId', 'loc', 'deltaX', 'deltaY', 'timeoutMs'],
    build: a => at(a, { ...withLoc(a), deltaX: a.deltaX, deltaY: a.deltaY }) },
  evaluate: { action: 'evaluate', input: true, keys: ['tabId', 'expression'], build: a => at(a, { expression: a.expression }) },
  dialog: { action: 'handle_dialog', input: true, mutates: true, keys: ['tabId', 'accept', 'promptText'],
    build: a => at(a, { accept: a.accept, ...(a.promptText === undefined ? {} : { promptText: a.promptText }) }) },
  read: { action: 'read', wait: true, loc: true, keys: ['tabId', 'loc', 'timeoutMs'], build: a => at(a, withLoc(a)) },
  find: { action: 'observe', keys: ['tabId', 'query'], build: a => at(a, { find: a.query }) },
  snapshot: { action: 'observe', keys: ['tabId', 'mode'], build: a => at(a, a.mode ? { mode: a.mode } : {}) },
  wait: { action: 'observe', keys: ['tabId', 'text', 'gone', 'url', 'timeoutMs'],
    build: a => at(a, { wait: { ...(a.text !== undefined ? { text: a.text } : a.gone !== undefined ? { gone: a.gone } : { url: a.url }),
      ...(a.timeoutMs === undefined ? {} : { timeoutMs: Math.max(1, a.timeoutMs) }) } }) },
  tabs: { action: 'list_tabs', keys: [], build: () => ({}) },
  // mutates: the accepted op changed the browser, so the run is not replay-safe.
  close: { action: 'close_tab', mutates: true, keys: ['tabId'], build: a => at(a, {}) },
});

/** Strict op and argument check; returns the browse arguments. Throws INVALID_RUNNER_OP. */
export function validateOp(op, args) {
  if (typeof op !== 'string' || !Object.hasOwn(RUNNER_OPS, op)) invalid(`Unknown or disallowed runner op ${JSON.stringify(String(op)).slice(0, 80)}`);
  const spec = RUNNER_OPS[op];
  if (!plain(args)) invalid('Op arguments must be a plain object');
  for (const key of Object.keys(args)) if (!spec.keys.includes(key)) invalid(`${op}: argument ${key} is not allowed`);
  if (spec.keys.includes('tabId') && !TAB.test(args.tabId ?? '')) invalid(`${op}: tabId must be t<n>`);
  if (spec.loc && args.loc === undefined) invalid(`${op}: a locator is required`);
  if ('url' in args && op !== 'wait' && !str(args.url, 8192)) invalid('url must be a string');
  if ('text' in args && !str(args.text, 100000, op === 'wait' ? 1 : 0)) invalid('text must be a string');
  if ('key' in args && !str(args.key, 64)) invalid('key must be a string');
  if ('values' in args && !(Array.isArray(args.values) && args.values.length <= 100 && args.values.every(v => str(v, 1000, 0)))) invalid('values must be strings');
  if ('files' in args && !(Array.isArray(args.files) && args.files.length >= 1 && args.files.length <= 32 && args.files.every(f => str(f, 32768)))) invalid('files must be paths');
  for (const key of ['deltaX', 'deltaY']) {
    if (key in args && !(Number.isFinite(args[key]) && Math.abs(args[key]) <= 10000)) invalid(`${key} must be a number within ±10000`);
  }
  if ('query' in args && !str(args.query, 500)) invalid('query must be a string');
  if ('mode' in args && !['default', 'full', 'text'].includes(args.mode)) invalid('mode must be default, full or text');
  if ('expression' in args && !str(args.expression, 100000)) invalid('expression must be a string');
  if ('accept' in args && typeof args.accept !== 'boolean') invalid('accept must be a boolean');
  if ('promptText' in args && !str(args.promptText, 10000, 0)) invalid('promptText must be a string');
  if (op === 'dialog' && typeof args.accept !== 'boolean') invalid('dialog: accept is required');
  if (op === 'wait') {
    const kinds = ['text', 'gone', 'url'].filter(key => key in args);
    if (kinds.length !== 1 || !str(args[kinds[0]], RUNNER_WAIT.textChars)) invalid(`wait needs exactly one of text, gone or url (1–${RUNNER_WAIT.textChars} characters)`);
  }
  if (['fill', 'type'].includes(op) && typeof args.text !== 'string') invalid(`${op}: text is required`);
  if (op === 'press' && typeof args.key !== 'string') invalid('press: key is required');
  if (op === 'select' && !Array.isArray(args.values)) invalid('select: values are required');
  if (op === 'upload' && !Array.isArray(args.files)) invalid('upload: files are required');
  if (op === 'scroll' && !(Number.isFinite(args.deltaX) && Number.isFinite(args.deltaY))) invalid('scroll: deltaX and deltaY are required');
  if (['open', 'navigate'].includes(op) && typeof args.url !== 'string') invalid(`${op}: url is required`);
  if (op === 'evaluate' && typeof args.expression !== 'string') invalid('evaluate: expression is required');
  timeoutMs(args.timeoutMs);
  const browse = { action: spec.action, ...spec.build(args), ...(spec.input && spec.action !== 'handle_dialog' ? { snapshot: 'none' } : {}) };
  // The host's own argument rules decide last: whatever the host would refuse
  // is refused here, before anything runs (catchable, never sealing).
  try { validateArgs(browse); } catch (error) { invalid(`${op}: ${error.message}`); }
  return browse;
}

// Short step label; never echoes typed text or file contents.
function label(op, args) {
  const loc = args.loc?.ref ?? (args.loc?.target ? [args.loc.target.role, args.loc.target.name !== undefined ? JSON.stringify(args.loc.target.name.slice(0, 40)) : null,
    args.loc.target.selector ? `css=${JSON.stringify(args.loc.target.selector.slice(0, 40))}` : null,
    args.loc.target.frame ? `in ${args.loc.target.frame}` : null].filter(Boolean).join(' ') : '');
  const parts = [args.tabId, loc];
  if (op === 'open' || op === 'navigate') parts.push(String(args.url).slice(0, 120));
  if (op === 'fill' || op === 'type') parts.push(`text(${args.text.length})`);
  if (op === 'press') parts.push(args.key);
  if (op === 'select') parts.push(`values(${args.values.length})`);
  if (op === 'upload') parts.push(`files(${args.files.length})`);
  if (op === 'find') parts.push(JSON.stringify(args.query.slice(0, 40)));
  if (op === 'wait') parts.push(args.text !== undefined ? 'text' : args.gone !== undefined ? 'gone' : 'url');
  return parts.filter(Boolean).join(' ');
}
const quoted = line => { try { return JSON.parse(line); } catch { return null; } };
function shape(op, result) {
  switch (op) {
    case 'open': return { tabId: result.tabId };
    case 'read': {
      const lines = String(result.text ?? '').split('\n');
      const text = lines.find(line => line.startsWith('text '));
      const value = lines.find(line => line.startsWith('value '));
      return { text: text ? quoted(text.slice(5)) ?? '' : '', value: value ? quoted(value.slice(6)) : null,
        sensitive: lines.includes('sensitive (value withheld)') };
    }
    case 'find': {
      const lines = String(result.text ?? '').split('\n');
      const at = lines.findIndex(line => line.startsWith('find '));
      const matches = at < 0 ? [] : lines.slice(at + 1).filter(line => /^(e\d+ |text ")/.test(line)).slice(0, 20)
        .map(line => { const ref = line.match(/^(e\d+) /)?.[1] ?? null; return { ref, line: ref ? line.slice(ref.length + 1) : line }; });
      return { count: Number(lines[at]?.match(/: (\d+) match/)?.[1] ?? matches.length), matches };
    }
    case 'snapshot': return { text: String(result.text ?? '').slice(0, 12000) };
    case 'wait': return { met: true };
    case 'evaluate': return result.value ?? null;
    case 'tabs': return (result.tabs ?? []).map(({ tabId, url, title, mode, paused }) => ({ tabId, url, title, mode, paused }));
    case 'dialog': case 'close': return null;
    default: return { ref: result.ref ?? null, ...(result.observed === false ? { observed: false } : {}) };
  }
}

export class RunnerBridge {
  #execute; #caller; #deadline; #now; #ended; #onEnd; #inFlight = new Set();
  #ops = 0;
  #active = 0;
  steps = [];
  touched = new Set();
  executedAny = false;
  sealed = null;

  // onEnd(outcome) aborts the run at once, so ops already in flight are
  // refused before they dispatch (the host checks the run caller's signal).
  constructor({ execute, caller, deadline, tabs = [], now = Date.now, onEnd = () => {} }) {
    this.#execute = execute;
    this.#caller = caller;
    this.#deadline = deadline;
    this.#now = now;
    this.#onEnd = onEnd;
    for (const tabId of tabs) if (tabId) this.touched.add(tabId);
    this.ended = new Promise(resolve => { this.#ended = resolve; });
  }
  /** Seals the bridge and ends the run; the first end wins. */
  end(outcome) {
    if (this.sealed) return this.sealed;
    this.sealed = outcome;
    this.#ended(outcome);
    this.#onEnd(outcome);
    return outcome;
  }
  /** Settles when no op is in flight (bounded by the caller). */
  settled() { return Promise.allSettled([...this.#inFlight]); }

  async handle(op, args) {
    if (this.sealed) return this.#refuse('RUN_SEALED', `The run has ended (${this.sealed.status}); no further operations`);
    if (++this.#ops > RUNNER_FLOOD.ops) {
      this.end({ status: 'limit', code: 'RUN_LIMIT', message: `More than ${RUNNER_FLOOD.ops} operations` });
      return this.#refuse('RUN_LIMIT', `A run makes at most ${RUNNER_FLOOD.ops} operations`);
    }
    const started = this.#now();
    const refused = (code, message) => {
      if (this.steps.length < RUNNER_FLOOD.ops) this.steps.push({ op: String(op).slice(0, 40), what: '', outcome: 'refused', code, ms: 0 });
      return this.#refuse(code, message);
    };
    let browse;
    try { browse = validateOp(op, args); } catch (error) { return refused(error.code ?? 'INVALID_RUNNER_OP', error.message); }
    if (this.#active >= RUNNER_FLOOD.inFlight) return refused('RUN_BUSY', `At most ${RUNNER_FLOOD.inFlight} operations run at once; await them`);
    this.#active++;
    try { return await this.#perform(op, args, browse, started); } finally { this.#active--; }
  }
  async #perform(op, args, browse, started) {
    const spec = RUNNER_OPS[op];
    // A tab joins the run (final view, interruption watch) once the host
    // accepted it as the caller's own.
    const accept = code => { if (browse.tabId && !UNACCEPTED.has(code)) this.touched.add(browse.tabId); };
    const step = { op, what: label(op, args), outcome: 'pending', ms: 0, input: !!spec.input };
    this.steps.push(step);
    const waitUntil = Math.min(this.#deadline, started + (args.timeoutMs ?? RUNNER_WAIT.defaultMs));
    const finish = (outcome, code) => { step.outcome = outcome; if (code) step.code = code; step.ms = Math.round(this.#now() - started); };
    for (;;) {
      if (this.sealed) { finish('refused', 'RUN_SEALED'); return this.#refuse('RUN_SEALED', `The run has ended (${this.sealed.status})`); }
      let result;
      const flight = (async () => { this.#caller.assertLive(); return this.#execute(browse, this.#caller); })();
      this.#inFlight.add(flight);
      try {
        result = await flight;
        accept(null);
      } catch (error) {
        const code = String(error?.code ?? 'BROWSER_ERROR');
        accept(code);
        if (this.#caller.signal.aborted) {
          // The run is ending (deadline, interruption, cancellation). An input
          // the host may have sent is classified by its own disposition.
          finish(spec.input && error?.requestedInputDispatched !== false ? 'uncertain' : 'aborted', code);
          if (step.outcome === 'uncertain') this.executedAny = true;
          this.end(this.#caller.signal.reason?.runStatus ? { status: this.#caller.signal.reason.runStatus } : { status: 'cancelled' });
          return this.#refuse('RUN_ENDED', 'The run has ended');
        }
        if (TERMINAL[code]) {
          finish('not-executed', code);
          const status = code === 'AUTOMATION_PAUSED' && error.paused !== undefined ? pauseStatus(error.paused) : TERMINAL[code];
          this.end({ status, code: status === 'handoff' ? 'PRIVATE_HANDOFF' : code, message: error.message });
          return this.#refuse(code, error.message);
        }
        if (spec.input && error?.requestedInputDispatched !== false) {
          // The host never throws after a dispatch; anything else is unknown.
          finish('uncertain', code);
          this.executedAny = true;
          this.end({ status: 'uncertain', code, message: error?.message });
          return { ok: false, error: { code, kind: 'uncertain', message: 'Outcome unknown; the run is sealed and ends' } };
        }
        if (spec.wait && RETRY.has(code) && this.#now() + RUNNER_WAIT.pollMs < waitUntil) {
          try { await pause(RUNNER_WAIT.pollMs, this.#caller.signal); } catch { /* the next pass sees the abort */ }
          continue;
        }
        finish('not-executed', code);
        return { ok: false, error: { code, kind: 'not-executed', message: String(error?.message ?? code).slice(0, 500),
          ...(error?.candidates ? { candidates: error.candidates.slice(0, 10) } : {}) } };
      } finally { this.#inFlight.delete(flight); }
      return this.#settle(op, spec, result, finish);
    }
  }
  #settle(op, spec, result, finish) {
    const disposition = result?.disposition;
    if (op === 'open' && result?.tabId) this.touched.add(result.tabId);
    if (disposition === 'uncertain') {
      finish('uncertain', result.code ?? 'UNCERTAIN');
      this.executedAny = true;
      this.end({ status: 'uncertain', code: result.code ?? 'UNCERTAIN', message: result.reason });
      return { ok: false, error: { code: result.code ?? 'UNCERTAIN', kind: 'uncertain', message: 'Outcome unknown; the run is sealed and ends' } };
    }
    if (disposition === 'not-executed') {
      finish('not-executed', result.code);
      return { ok: false, error: { code: result.code ?? 'NOT_EXECUTED', kind: 'not-executed', message: String(result.text ?? 'Not executed').split('\n')[0].slice(0, 300) } };
    }
    // An accepted close or dialog answer changed the browser whatever its result says.
    const executed = !!spec.mutates || (disposition === 'executed' && spec.input);
    if (executed) this.executedAny = true;
    // tabs and close return JSON objects without a page disposition.
    finish(executed ? 'executed' : disposition === 'observed' ? 'observed' : 'done', result?.code);
    if (result?.code) {
      return { ok: false, error: { code: result.code, kind: executed ? 'executed' : 'observed', message: executed
        ? `The step ran and reported ${result.code}; it is not repeated` : `The read reported ${result.code}` } };
    }
    return { ok: true, value: shape(op, result) };
  }
  #refuse(code, message) {
    return { ok: false, error: { code, kind: 'not-executed', message: String(message).slice(0, 300) } };
  }
}
