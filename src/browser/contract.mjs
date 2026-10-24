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
const fields = {
  status: [], open: ['url'], navigate: ['url'], observe: [], list_tabs: [],
  close_tab: [], hide: [], show: [], click: ['ref', 'target', 'point'],
  fill: ['ref', 'target', 'text'], type: ['ref', 'target', 'text'],
  press: ['ref', 'target', 'key'], select: ['ref', 'target', 'values'],
  scroll: ['ref', 'target', 'point', 'deltaX', 'deltaY'],
  read: ['ref', 'target'], evaluate: ['expression', 'frameId'],
  upload: ['ref', 'target', 'files'], downloads: [], handle_dialog: ['accept', 'promptText'],
  handoff: [], permissions: [], requests: [], respond: ['requestRef', 'response'], revoke: [],
};
export const actions = Object.freeze(Object.keys(fields));
export const inputActions = new Set(['navigate', 'click', 'fill', 'type', 'press', 'select', 'scroll', 'evaluate', 'upload', 'handle_dialog', 'respond']);
export const keys = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
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
  if (allowed.has('tabId') && !text(args.tabId, 128)) fail('INVALID_ARGUMENT', 'tabId is required');
  if (args.action === 'open' || args.action === 'navigate') pageURL(args.url);
  if (args.ref !== undefined && !text(args.ref, 256)) fail('INVALID_ARGUMENT', 'Invalid ref');
  if (args.target !== undefined) {
    const t = args.target;
    if (!record(t) || Object.keys(t).some(k => !['role', 'name', 'exact', 'selector', 'frameId'].includes(k))
      || !['role', 'name', 'selector'].some(k => text(t[k]))
      || ['role', 'name', 'selector', 'frameId'].some(k => t[k] !== undefined && !text(t[k], 4096))
      || (t.exact !== undefined && typeof t.exact !== 'boolean')) fail('INVALID_ARGUMENT', 'Invalid semantic target');
  }
  if (args.point !== undefined) {
    const p = args.point;
    if (!record(p) || Object.keys(p).some(k => !['x', 'y', 'snapshotId'].includes(k))
      || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !text(p.snapshotId, 128)) {
      fail('INVALID_ARGUMENT', 'point requires finite x/y and combined snapshotId');
    }
  }
  const targets = [args.ref, args.target, args.point].filter(v => v !== undefined).length;
  if (targets > 1 || (['click', 'fill', 'type', 'press', 'select', 'scroll', 'upload'].includes(args.action) && targets !== 1)) {
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
  if (args.action === 'evaluate' && (!text(args.expression) || (args.frameId !== undefined && !text(args.frameId, 128)))) {
    fail('INVALID_ARGUMENT', 'expression and optional frameId are required');
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

export function matchesTarget(element, target) {
  if (target.frameId && target.frameId !== element.frameId) return false;
  const match = (a, b) => target.exact === true ? a === b : a.toLocaleLowerCase().includes(b.toLocaleLowerCase());
  return (!target.role || element.role === target.role) && (!target.name || match(element.name, target.name));
}

export function sameCheckpoint(a, b) {
  return !!a && !!b && a.documentId === b.documentId && a.revision === b.revision
    && a.width === b.width && a.height === b.height && a.x === b.x && a.y === b.y;
}
