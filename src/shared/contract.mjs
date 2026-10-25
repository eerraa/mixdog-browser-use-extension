import { randomUUID } from 'node:crypto';

export class BrowserHostError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BrowserHostError';
    this.code = code;
    Object.assign(this, details);
  }
}
export const fail = (code, message, details) => { throw new BrowserHostError(code, message, details); };
export const freshId = () => randomUUID();
const text = (value, max = 65536) => typeof value === 'string' && value.length > 0 && value.length <= max;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const filePaths = value => Array.isArray(value) && value.length > 0 && value.length <= 32
  && value.every(file => text(file, 32768));
// Page-changing actions also choose their result: snapshot diff|full|none, screenshot.
const R = ['screenshot', 'snapshot'];
const fields = {
  status: [], open: ['url', ...R], navigate: ['url', ...R],
  observe: ['mode', 'find', 'scope', 'depth', 'screenshot', 'wait'], list_tabs: [],
  close_tab: [], hide: [], show: [], click: ['ref', 'target', 'point', ...R],
  fill: ['ref', 'target', 'text', ...R], type: ['ref', 'target', 'text', ...R],
  press: ['ref', 'target', 'key', ...R], select: ['ref', 'target', 'values', ...R],
  scroll: ['ref', 'target', 'point', 'deltaX', 'deltaY', ...R],
  read: ['ref', 'target'], evaluate: ['expression', 'frame', 'world', ...R],
  upload: ['ref', 'target', 'files', ...R], downloads: [], handle_dialog: ['accept', 'promptText'],
  handoff: [], permissions: [], requests: [], respond: ['requestRef', 'response'], revoke: [],
  console: ['since', 'filter', 'limit', 'expression', 'frame'], network: ['since', 'filter', 'limit', 'id', 'body'],
  inspect: ['ref', 'target', 'values'], performance: [],
  // Script runner (runner/): tabId is optional; the script may open tabs.
  run: ['script', 'timeoutMs'],
};
// Bounds of one script run (runner/run.mjs RUN_LIMITS).
export const RUN_BOUNDS = Object.freeze({ scriptChars: 100000, minMs: 1000, defaultMs: 60000, maxMs: 100000 });
// Refs (`e<n>`) are connection-wide and never recycled (D14); `frame`
// arguments are iframe refs.
export const REF = /^e[1-9]\d{0,9}$/;
const ref = value => typeof value === 'string' && REF.test(value);
// DevTools reads: compact rows, never an observation (devtools.mjs).
export const devtoolsActions = new Set(['console', 'network', 'inspect', 'performance']);
export const actions = Object.freeze(Object.keys(fields));
export const inputActions = new Set(['navigate', 'click', 'fill', 'type', 'press', 'select', 'scroll', 'evaluate', 'upload', 'handle_dialog', 'respond']);
export const keys = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
});

export function pageURL(value) {
  if (!text(value, 8192)) fail('INVALID_ARGUMENT', 'An HTTP(S) URL is required');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_ARGUMENT', 'Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('UNSAFE_URL', 'Only credential-free HTTP(S) navigation is supported');
  }
  return url.href;
}

// Human address-bar text: an explicit http(s) URL, or a bare host that
// defaults to https (http for loopback). Anything else is not navigated.
export function addressURL(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input || input.length > 8192 || /\s/.test(input)) return null;
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `${loopback ? 'http' : 'https'}://${input}`;
  try { return pageURL(candidate); } catch { return null; }
}

export function validateNativeResponse(value) {
  if (!record(value) || Object.keys(value).some(key => !['optionRef', 'files', 'text', 'cancel'].includes(key))
    || [value.optionRef, value.files, value.cancel].filter(item => item !== undefined).length !== 1
    || (value.optionRef !== undefined && !text(value.optionRef, 128))
    || (value.files !== undefined && !filePaths(value.files))
    || (value.cancel !== undefined && value.cancel !== true)
    || (value.text !== undefined && (value.optionRef === undefined || typeof value.text !== 'string' || value.text.length > 100000))) {
    fail('INVALID_ARGUMENT', 'Invalid native response: choose one offered option, explicit files, or cancel');
  }
  return value;
}

export function validateArgs(args) {
  if (!record(args) || !Object.hasOwn(fields, args.action)) fail('INVALID_ARGUMENT', 'Unknown browser action');
  const allowed = new Set(['action', ...(args.action === 'status' || args.action === 'list_tabs' || args.action === 'open' || args.action === 'revoke' ? [] : ['tabId']), ...fields[args.action]]);
  for (const key of Object.keys(args)) if (!allowed.has(key)) fail('INVALID_ARGUMENT', `Unexpected argument: ${key}`);
  if (allowed.has('tabId') && !(args.action === 'run' && args.tabId === undefined) && !text(args.tabId, 128)) fail('INVALID_ARGUMENT', 'tabId is required');
  if (args.action === 'run') {
    if (typeof args.script !== 'string' || !args.script.trim() || args.script.length > RUN_BOUNDS.scriptChars) {
      fail('INVALID_ARGUMENT', `script must be 1–${RUN_BOUNDS.scriptChars} characters`);
    }
    if (args.timeoutMs !== undefined && !(Number.isSafeInteger(args.timeoutMs) && args.timeoutMs >= RUN_BOUNDS.minMs && args.timeoutMs <= RUN_BOUNDS.maxMs)) {
      fail('INVALID_ARGUMENT', `timeoutMs is ${RUN_BOUNDS.minMs}–${RUN_BOUNDS.maxMs}`);
    }
  }
  if (args.action === 'open' || args.action === 'navigate') pageURL(args.url);
  if (args.ref !== undefined && !ref(args.ref)) fail('INVALID_ARGUMENT', 'ref must be an e<n> ref from a result');
  if (args.frame !== undefined && !ref(args.frame)) fail('INVALID_ARGUMENT', 'frame must be an iframe ref (e<n>)');
  if (args.target !== undefined) {
    const t = args.target;
    if (!record(t) || Object.keys(t).some(k => !['role', 'name', 'exact', 'selector', 'frame'].includes(k))
      || !['role', 'name', 'selector'].some(k => text(t[k]))
      || ['role', 'name', 'selector'].some(k => t[k] !== undefined && !text(t[k], 4096))
      || (t.frame !== undefined && !ref(t.frame))
      || (t.exact !== undefined && typeof t.exact !== 'boolean')) fail('INVALID_ARGUMENT', 'Invalid semantic target');
  }
  if (args.point !== undefined) {
    const p = args.point;
    if (!record(p) || Object.keys(p).some(k => !['x', 'y', 'snapshotId'].includes(k))
      || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !text(p.snapshotId, 128)) {
      fail('INVALID_ARGUMENT', 'point requires finite x/y and the snapshotId of a screenshot');
    }
  }
  if (args.screenshot !== undefined && typeof args.screenshot !== 'boolean') fail('INVALID_ARGUMENT', 'screenshot must be a boolean');
  if (args.snapshot !== undefined && !['diff', 'full', 'none'].includes(args.snapshot)) fail('INVALID_ARGUMENT', 'snapshot must be diff, full or none');
  if (args.action === 'observe') {
    if (args.mode !== undefined && !['default', 'full', 'text'].includes(args.mode)) fail('INVALID_ARGUMENT', 'mode must be default, full or text');
    if (args.find !== undefined && (!text(args.find, 500) || !args.find.trim())) fail('INVALID_ARGUMENT', 'find must be a nonempty string of at most 500 characters');
    // The matcher would compile /…/ as a regular expression in the browser
    // host process, where a catastrophic pattern could freeze Stop; words only.
    if (args.find !== undefined && /^\/.+\/[a-z]*$/s.test(args.find.trim())) fail('INVALID_ARGUMENT', 'find takes words, not regular expressions');
    if (args.scope !== undefined && !ref(args.scope)) fail('INVALID_ARGUMENT', 'scope must be a ref');
    if (args.depth !== undefined && !(Number.isSafeInteger(args.depth) && args.depth >= 0 && args.depth <= 20)) fail('INVALID_ARGUMENT', 'depth is 0–20');
    if ([args.find, args.scope, args.mode === 'text' ? true : undefined].filter(value => value !== undefined).length > 1) {
      fail('INVALID_ARGUMENT', 'Use one of find, scope or mode:text');
    }
    if (args.wait !== undefined) {
      const w = args.wait;
      if (!record(w) || Object.keys(w).some(k => !['text', 'gone', 'url', 'timeoutMs'].includes(k))
        || [w.text, w.gone, w.url].filter(value => value !== undefined).length !== 1
        || [w.text, w.gone, w.url].some(value => value !== undefined && !text(value, 500))
        || (w.timeoutMs !== undefined && !(Number.isSafeInteger(w.timeoutMs) && w.timeoutMs >= 1 && w.timeoutMs <= 10000))) {
        fail('INVALID_ARGUMENT', 'wait takes exactly one of text, gone or url, and optional timeoutMs of at most 10000');
      }
    }
  }
  const targets = [args.ref, args.target, args.point].filter(v => v !== undefined).length;
  if (targets > 1 || (['click', 'fill', 'type', 'press', 'select', 'scroll', 'upload', 'inspect'].includes(args.action) && targets !== 1)) {
    fail('INVALID_ARGUMENT', 'Supply exactly one ref, target, or supported point');
  }
  if (['fill', 'type'].includes(args.action) && (typeof args.text !== 'string' || args.text.length > 100000)) {
    fail('INVALID_ARGUMENT', 'text must be a string of at most 100000 characters');
  }
  if (args.action === 'press' && !Object.hasOwn(keys, args.key)) fail('INVALID_ARGUMENT', 'Unsupported key');
  if (args.action === 'select' && (!Array.isArray(args.values) || !args.values.length || args.values.some(v => !text(v, 4096)))) {
    fail('INVALID_ARGUMENT', 'values must be a nonempty string array');
  }
  if (args.action === 'scroll' && (!Number.isFinite(args.deltaX) || !Number.isFinite(args.deltaY)
    || Math.abs(args.deltaX) > 10000 || Math.abs(args.deltaY) > 10000)) fail('INVALID_ARGUMENT', 'Bounded deltaX and deltaY are required');
  if (args.action === 'evaluate' && !text(args.expression)) fail('INVALID_ARGUMENT', 'expression is required; frame is optional');
  if (args.world !== undefined && !['isolated', 'page'].includes(args.world)) fail('INVALID_ARGUMENT', 'world must be isolated or page');
  if (args.action === 'console' || args.action === 'network') {
    const single = args.action === 'console' ? args.expression !== undefined : args.id !== undefined;
    const characters = args.action === 'console' ? single : args.body === true;
    if (args.action === 'console' && single && !text(args.expression)) fail('INVALID_ARGUMENT', 'expression must be nonempty; frame is optional');
    if (args.action === 'console' && !single && args.frame !== undefined) fail('INVALID_ARGUMENT', 'frame applies only with expression');
    if (args.action === 'network' && args.id !== undefined && !text(args.id, 64)) fail('INVALID_ARGUMENT', 'Invalid network id');
    if (args.body !== undefined && (typeof args.body !== 'boolean' || !single)) fail('INVALID_ARGUMENT', 'body is a boolean for one network id');
    if (single && (args.since !== undefined || args.filter !== undefined)) {
      fail('INVALID_ARGUMENT', 'since and filter apply to row lists, not to one expression or network id');
    }
    if (args.since !== undefined && !(Number.isSafeInteger(args.since) && args.since >= 0)) fail('INVALID_ARGUMENT', 'since must be a returned next cursor');
    if (args.filter !== undefined && (typeof args.filter !== 'string' || args.filter.length > 500)) fail('INVALID_ARGUMENT', 'filter must be a string of at most 500 characters');
    if (args.limit !== undefined && (single && !characters)) fail('INVALID_ARGUMENT', 'limit applies to row lists and bodies');
    if (args.limit !== undefined && !(Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= (characters ? 65536 : 100))) {
      fail('INVALID_ARGUMENT', characters ? 'limit is 1–65536 characters' : 'limit is 1–100 rows');
    }
  }
  if (args.action === 'inspect' && args.target && (!text(args.target.selector, 4096)
    || Object.keys(args.target).some(key => !['selector', 'frame'].includes(key)))) {
    fail('INVALID_ARGUMENT', 'inspect takes a ref, or target.selector with optional target.frame');
  }
  if (args.action === 'inspect' && args.values !== undefined && (!Array.isArray(args.values) || !args.values.length
    || args.values.length > 40 || args.values.some(name => typeof name !== 'string' || !/^-{0,2}[a-zA-Z][\w-]{0,63}$/.test(name)))) {
    fail('INVALID_ARGUMENT', 'values must list 1–40 CSS property names');
  }
  if (args.action === 'upload' && !filePaths(args.files)) {
    fail('INVALID_ARGUMENT', 'files must contain 1–32 absolute regular-file paths');
  }
  if (args.action === 'handle_dialog' && (typeof args.accept !== 'boolean'
    || (args.promptText !== undefined && typeof args.promptText !== 'string'))) fail('INVALID_ARGUMENT', 'accept must be boolean; promptText must be a string');
  if (args.action === 'respond') {
    if (!text(args.requestRef, 128)) fail('INVALID_ARGUMENT', 'requestRef is required');
    validateNativeResponse(args.response);
  }
  return args;
}

// target.frameId is the CDP frame resolved from target.frame by the host.
export function matchesTarget(element, target) {
  if (target.frameId && target.frameId !== element.frameId) return false;
  const match = (a, b) => target.exact === true ? a === b : a.toLocaleLowerCase().includes(b.toLocaleLowerCase());
  return (!target.role || element.role === target.role) && (!target.name || match(element.name, target.name));
}
