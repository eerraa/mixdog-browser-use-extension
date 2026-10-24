// Agent DevTools over the page's own CDP session (decisions D11, D12).
// Bounded per-page records of console calls, uncaught exceptions, browser log
// entries and network activity, plus page-world reads with V8's best-effort
// side-effect check,
// element inspection and a performance snapshot. Outputs are compact rows:
// they never carry observations or screenshots and never invalidate refs.
// Nothing produced while the person controls the page is recorded or exposed.
import { fail } from './contract.mjs';

export const DEVTOOLS_LIMITS = Object.freeze({
  console: 500, network: 1000, rows: 30, maxRows: 100, chars: 8192, maxChars: 65536,
  message: 300, url: 200, storedURL: 2000, header: 256, headerBytes: 2048, requestBody: 2048,
  stack: 3, privateWindows: 32, frozenKeys: 5000, styleSheets: 2000, rules: 8, declarations: 200, listeners: 20,
  // Network.enable buffers per page: the main session first, then each
  // iframe or worker session, until the page total is spent.
  totalBuffer: 10 * 1024 * 1024, mainBuffer: 6 * 1024 * 1024, sessionBuffer: 1024 * 1024,
  resourceBuffer: 1024 * 1024, postData: 65536, jsonParse: 1024 * 1024,
  discardEvery: 200, evaluationMs: 2000, commandMs: 5000, enableMs: 2000, flushMs: 1000,
});
const L = DEVTOOLS_LIMITS;
// One object group per read: releasing it can never free an object that a
// concurrent read (a console expression beside an inspect) still uses.
let groupSequence = 0;
const objectGroup = () => `independent-browser-devtools-${++groupSequence}`;
const LOG = ['Log.enable', {}];
const RUNTIME = ['Runtime.enable', {}];
const PERFORMANCE = ['Performance.enable', {}];
const CONSOLE_LEVELS = { debug: 'debug', info: 'info', error: 'error', assert: 'error', warning: 'warn' };
const LOG_LEVELS = { verbose: 'debug', info: 'info', warning: 'warn', error: 'error' };
const FILTERS = {
  console: { level: ['error', 'warn', 'warning', 'info', 'log', 'debug'] },
  network: { status: null, type: null, method: null, is: ['failed', 'running', 'cached'] },
};
// Every pattern below runs on page-controlled text that is first cut to a
// bounded length, and every pattern is linear: no nested or overlapping
// quantifiers, and scans that can fail start only at token boundaries.
const SENSITIVE_HEADER = /^(?:cookie|set-cookie|authorization|proxy-authorization|dpop)$|token|secret|api[-_]?key|key$|session|passw|credential|csrf|xsrf|auth|signature|ticket|jwt|assertion|saml/i;
const SENSITIVE_FIELD = /pass|pwd|^pw$|secret|token|auth|session|otp|cvv|cvc|card.?(?:num|no)|credential|api.?key|access.?key|private.?key|signature|ssn|jwt|assertion|saml|ticket|(?:^|[-_.])(?:key|code|state|sig|nonce)$|^(?:key|code|state|sig|nonce)[-_.]/i;
const URL_HEADER = /^(?:location|content-location|referer)$/i;
const SECRET_VALUE = /\b(Bearer|Basic|Digest|Negotiate)[ \t]{1,8}[\w.~+/=-]{1,4096}|(?<![\w.-])eyJ[\w-]{1,4096}\.[\w-]{1,4096}\.[\w-]{0,4096}/gi;
const JWT_SHAPE = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const TEXT_URL = /(?<![\w.+-])(?:https?|wss?):\/\/[^\s"'<>\\^`{|}]{1,2048}/gi;
const KEY_VALUE = /(?<![\w.-])(["']?)([\w.-]{1,128})\1\s{0,16}[:=]\s{0,16}/g;
const VALUE_END = new Set(['&', ',', ';', '}', ']', ')', '<', '>', '"', "'", ' ', '\t', '\r', '\n']);
const TEXT_MIME = /^text\/|json|javascript|ecmascript|xml|html|css|svg|x-www-form-urlencoded|graphql|csv/i;
const REDACTED = '[redacted]';
const ALREADY_REDACTED = new Set([REDACTED, encodeURIComponent(REDACTED), `"${REDACTED}"`, `'${REDACTED}'`]);
const RELATIVE = 'http://relative.invalid';

export const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max})`;
};
// Redacts at most 2×max characters of page text, then clips to max.
function redactClip(value, max, redact = redactText) {
  const text = String(value ?? '');
  const out = redact(text.length > max * 2 ? text.slice(0, max * 2) : text);
  return out.length <= max && text.length <= max * 2 ? out : `${out.slice(0, max)}…(+${Math.max(1, text.length - max)})`;
}
const compact = object => Object.fromEntries(Object.entries(object)
  .filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)));
const sessionKey = sessionId => sessionId ?? '';
const firstLine = text => String(text ?? '').split('\n', 1)[0];

const secretValue = value => JWT_SHAPE.test(value) || /^(?:Bearer|Basic|Digest|Negotiate)\s/i.test(value);
// Query or fragment parameters: sensitive names and token-shaped values.
function redactParams(params) {
  let changed = false;
  for (const [key, value] of [...params]) {
    if (value !== REDACTED && (SENSITIVE_FIELD.test(key) || secretValue(value))) { params.set(key, REDACTED); changed = true; }
  }
  return changed;
}
function redactFragment(fragment) {
  const at = fragment.indexOf('?');
  const [route, query] = at >= 0 ? [fragment.slice(0, at + 1), fragment.slice(at + 1)]
    : fragment.includes('=') ? ['', fragment] : [fragment, ''];
  if (!query) return JWT_SHAPE.test(route) ? REDACTED : route;
  const params = new URLSearchParams(query);
  return redactParams(params) ? `${route}${params}` : fragment;
}
// Credentials, sensitive query and fragment parameters, token-shaped values.
// `relative` also accepts header values such as Location: /callback?code=…
export function redactURL(value, relative = false) {
  const text = String(value ?? '');
  let url, base = false;
  try { url = new URL(text); } catch {
    if (!relative || !text) return text;
    try { url = new URL(text, `${RELATIVE}/`); base = true; } catch { return text; }
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return url.href;
  url.username = '';
  url.password = '';
  redactParams(url.searchParams);
  if (url.hash.length > 1) url.hash = redactFragment(url.hash.slice(1));
  return base ? url.href.slice(RELATIVE.length) : url.href;
}
// Sensitive `name: value` / `name=value` pairs. Non-sensitive values are not
// skipped, so names nested in them are still found; each scan is linear.
function redactPairs(text) {
  let out = '', last = 0, match;
  KEY_VALUE.lastIndex = 0;
  while ((match = KEY_VALUE.exec(text))) {
    if (!SENSITIVE_FIELD.test(match[2])) continue;
    const start = KEY_VALUE.lastIndex;
    const quote = text[start] === '"' || text[start] === "'" ? text[start] : '';
    let end = start + (quote ? 1 : 0);
    if (quote) {
      while (end < text.length && text[end] !== quote) end += text[end] === '\\' ? 2 : 1;
      end = Math.min(text.length, end + 1);
    } else while (end < text.length && !VALUE_END.has(text[end])) end++;
    if (end === start || ALREADY_REDACTED.has(text.slice(start, end))) continue;
    out += `${text.slice(last, start)}${quote}${REDACTED}${quote}`;
    last = KEY_VALUE.lastIndex = end;
  }
  return out + text.slice(last);
}
// Free text (console messages, header values, unparsed bodies): URLs inside
// the text, Bearer/Basic/JWT-shaped values and sensitive name/value pairs.
export function redactText(value) {
  return redactPairs(String(value ?? '')
    .replace(TEXT_URL, url => {
      // Rewrite only URLs that held something to redact; keep the text as written otherwise.
      const out = redactURL(url);
      try { return out === new URL(url).href ? url : out; } catch { return url; }
    })
    .replace(SECRET_VALUE, (_match, scheme) => scheme ? `${scheme} ${REDACTED}` : REDACTED));
}
export function redactHeaders(headers = {}) {
  const out = {};
  let budget = L.headerBytes, omitted = 0;
  for (const [name, raw] of Object.entries(headers)) {
    const value = SENSITIVE_HEADER.test(name) ? REDACTED
      : URL_HEADER.test(name) ? clip(redactURL(String(raw).slice(0, L.storedURL), true), L.header)
        : /^refresh$/i.test(name) ? redactClip(raw, L.header, text => text.replace(/(url\s{0,8}=\s{0,8}['"]?)([^'"\s]{1,2048})/i,
          (_match, prefix, url) => `${prefix}${redactURL(url, true)}`))
          : redactClip(raw, L.header);
    if (name.length + value.length > budget) { omitted++; continue; }
    budget -= name.length + value.length;
    out[name] = value;
  }
  if (omitted) out['…'] = `+${omitted} headers`;
  return out;
}
const redactValue = value => typeof value === 'string' ? redactText(value)
  : Array.isArray(value) ? value.map(redactValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, SENSITIVE_FIELD.test(key) ? REDACTED : redactValue(item)]))
      : value;
// Multipart: a sensitive part's value lines up to the next boundary.
function redactMultipart(text) {
  const lines = text.split('\n');
  let state = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (line.startsWith('--')) { state = null; continue; }
    if (state === 'value') { lines[i] = lines[i].endsWith('\r') ? `${REDACTED}\r` : REDACTED; continue; }
    if (state === 'headers') { if (!line) state = 'value'; continue; }
    if (/^content-disposition:/i.test(line)) {
      const name = /(?:^|[;\s])name="([^"]{0,256})"/i.exec(line.slice(0, 1024))?.[1];
      if (name !== undefined && SENSITIVE_FIELD.test(name)) state = 'headers';
    }
  }
  return lines.join('\n');
}
// Best effort for request and response bodies: JSON (parsed when at most
// 1 MiB), form and multipart field names, then the free-text rules on at most
// 2×max characters. The result is clipped to max.
export function redactBody(text, max) {
  const value = String(text ?? '');
  const trimmed = value.length <= L.jsonParse ? value.trim() : '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return clip(JSON.stringify(redactValue(JSON.parse(trimmed))), max); } catch { /* not JSON or too deep: text rules */ }
  }
  return redactClip(value, max, head => {
    const pairs = head.split('&');
    if (head.includes('=') && !/\s/.test(head) && pairs.every(pair => pair.indexOf('=') > 0)) {
      return pairs.map(pair => {
        const key = pair.slice(0, pair.indexOf('='));
        let name = key;
        try { name = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { /* keep the raw name */ }
        return SENSITIVE_FIELD.test(name) ? `${key}=${REDACTED}` : `${key}=${redactText(pair.slice(key.length + 1))}`;
      }).join('&');
    }
    return redactText(/content-disposition:/i.test(head) ? redactMultipart(head) : head);
  });
}
const location = frame => `${clip(redactURL(frame.url) || '<anonymous>', L.url)}:${(frame.lineNumber ?? 0) + 1}`
  + (frame.columnNumber === undefined ? '' : `:${frame.columnNumber + 1}`);

function previewText(preview) {
  const value = item => item.type === 'string' ? JSON.stringify(item.value ?? '') : item.value ?? item.subtype ?? item.type;
  const items = [
    ...(preview.properties ?? []).map(item => preview.subtype === 'array' ? value(item) : `${item.name}: ${value(item)}`),
    ...(preview.entries ?? []).map(entry => `${entry.key ? `${previewText(entry.key)} => ` : ''}${previewText(entry.value)}`),
  ];
  if (!items.length && !preview.overflow) return preview.description ?? preview.type;
  if (preview.overflow) items.push('…');
  return preview.subtype === 'array' ? `${preview.description} [${items.join(', ')}]` : `${preview.description} {${items.join(', ')}}`;
}
function remoteText(object) {
  if (!object) return '';
  if (object.type === 'string') return object.value;
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.type === 'undefined') return 'undefined';
  if (object.subtype === 'null') return 'null';
  if (object.type !== 'object' && object.type !== 'function' && object.value !== undefined) return String(object.value);
  return object.preview ? previewText(object.preview) : object.description ?? object.className ?? object.type;
}
function consoleText(args = []) {
  const part = object => remoteText(object).slice(0, L.message * 2);
  const values = args.slice(0, 50);
  const parts = [];
  if (values[0]?.type === 'string' && /%[sdifoOc]/.test(values[0].value.slice(0, L.message * 2))) {
    parts.push(values.shift().value.slice(0, L.message * 2).replace(/%([sdifoOc%])/g, (match, kind) => kind === '%' ? '%'
      : !values.length ? match : kind === 'c' ? (values.shift(), '') : part(values.shift())));
  }
  return [...parts, ...values.map(part)].join(' ');
}
function initiator(value) {
  const frame = value?.stack?.callFrames?.[0];
  if (frame) return `${value.type} ${location(frame)}`;
  if (value?.url) return `${value.type} ${clip(redactURL(value.url), L.url)}${value.lineNumber === undefined ? '' : `:${value.lineNumber + 1}`}`;
  return value?.type;
}
function parseFilter(filter, kind) {
  const terms = { text: [] };
  for (const token of String(filter ?? '').trim().split(/\s+/).filter(Boolean)) {
    const match = /^([a-z]+):(.+)$/i.exec(token);
    const key = match?.[1].toLowerCase();
    if (!match || !Object.hasOwn(FILTERS[kind], key)) { terms.text.push(token.toLowerCase()); continue; }
    const values = match[2].toLowerCase().split(',').filter(Boolean);
    const allowed = FILTERS[kind][key];
    if (allowed && values.some(value => !allowed.includes(value))) fail('INVALID_ARGUMENT', `${kind} filter ${key}: accepts ${allowed.join('|')}`);
    if (key === 'status' && values.some(value => !/^\d(?:\d\d|xx)$/.test(value))) fail('INVALID_ARGUMENT', 'network filter status: accepts a code such as 404 or a class such as 4xx');
    (terms[key] ??= []).push(...values);
  }
  return terms;
}
function collapse(rows) {
  const out = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last && ['lv', 'k', 'msg', 'at', 'in', 'req'].every(key => last[key] === row[key])) {
      last.n = (last.n ?? 1) + 1;
      last.i = row.i;
    } else out.push({ ...row });
  }
  return out;
}
function page(rows, since, limit, cursor, position) {
  const size = limit ?? L.rows;
  const selected = since === undefined ? rows.slice(-size) : rows.slice(0, size);
  return {
    selected,
    next: since !== undefined && selected.length < rows.length ? position(selected.at(-1)) : cursor,
    omitted: rows.length - selected.length || undefined,
  };
}

/**
 * Private windows: wall-clock spans in which recording was not allowed.
 * `update()` opens a window when `allowed()` turns false and closes it when it
 * turns true again; late events whose timestamps fall inside are dropped.
 * Bounded by merging the oldest windows, which only ever drops more.
 */
export class PrivacyWindows {
  #windows = [];
  constructor(allowed) { this.allowed = allowed; }
  update() {
    const allowed = this.allowed();
    const now = Date.now();
    const open = this.#windows.at(-1);
    if (open && open.end === undefined) {
      // A clock step while private widens the window, never narrows it.
      open.start = Math.min(open.start, now);
      open.latest = Math.max(open.latest, now);
      if (allowed) open.end = open.latest;
    } else if (!allowed) {
      this.#windows.push({ start: now, latest: now });
      if (this.#windows.length > L.privateWindows) {
        const [first, second] = this.#windows.splice(0, 2);
        this.#windows.unshift({ start: Math.min(first.start, second.start), end: Math.max(first.end, second.end) });
      }
    }
    return allowed;
  }
  holds(time) {
    return time !== undefined && this.#windows.some(window => time >= window.start && time <= (window.end ?? Infinity));
  }
}

// Targets that belong to one page; every other target type may serve several.
const PAGE_TARGETS = new Set(['iframe', 'worker']);

/**
 * Per-page recorder. `mode()` is the presentation mode; recording is allowed
 * only in `automation`. `shared` holds the profile's private windows: service
 * and shared workers serve every page of the profile, so their events are
 * dropped whenever any page of the profile is not in automation.
 * `boundary()` must run on every mode transition so that requests in flight
 * when recording stops end as incomplete.
 */
export class DevToolsRecorder {
  #console = [];
  #network = [];
  #requests = new Map();
  #ids = new Map();
  #running = new Set();
  #frozen = new Set();
  // Page-world execution contexts (`session:contextId` → frameId) and the
  // main session's subframes, so same-process iframe rows carry `in` too.
  #contexts = new Map();
  #childFrames = new Set();
  #cutoffs = new Map();
  #buffers = new Map();
  #seq = 0;
  #rev = 0;
  #nextId = 0;
  #dropped = { console: 0, network: 0 };
  #withheld = { console: 0, network: 0 };
  #windows;
  #sharedAllowed = true;
  #attached = false;

  constructor(mode, targetType, shared) {
    this.mode = mode;
    this.targetType = targetType;
    this.#windows = new PrivacyWindows(() => mode() === 'automation');
    this.shared = shared ?? this.#windows;
    this.sheets = new Map();
    this.css = new Set();
  }
  // Called before a session enables Runtime or Log. Those replay stored entries
  // when the target ran before this attach (`replays`), or on a re-attached
  // main session; replayed entries were recorded already or were private, so
  // they are cut off. Returns the commands that start recording; Network
  // buffers come from the page budget (DEVTOOLS_LIMITS).
  attach(sessionId, type, replays = false) {
    const key = sessionKey(sessionId);
    if (sessionId === undefined) { replays ||= this.#attached; this.#attached = true; }
    if (replays) this.#cutoffs.set(key, Date.now()); else this.#cutoffs.delete(key);
    this.css.delete(key);
    this.#buffers.delete(key);
    let used = 0;
    for (const size of this.#buffers.values()) used += size;
    const total = Math.max(0, Math.min(sessionId === undefined ? L.mainBuffer : L.sessionBuffer, L.totalBuffer - used));
    this.#buffers.set(key, total);
    const network = ['Network.enable', {
      maxTotalBufferSize: total, maxResourceBufferSize: Math.min(L.resourceBuffer, total), maxPostDataSize: L.postData,
    }];
    return type === 'page' ? [network, LOG, PERFORMANCE] : type === 'iframe' ? [network, LOG] : [RUNTIME, network, LOG];
  }
  detach(sessionId) {
    const key = sessionKey(sessionId);
    this.#buffers.delete(key);
    this.#cutoffs.delete(key);
    this.css.delete(key);
    for (const context of this.#contexts.keys()) if (context.startsWith(`${key}:`)) this.#contexts.delete(context);
    for (const sheet of this.sheets.keys()) if (sheet.startsWith(`${key}:`)) this.sheets.delete(sheet);
  }
  /** Console errors and failed requests recorded after `cursor` (result signals). */
  since(cursor = {}) {
    const errors = this.#console.filter(row => row.i > (cursor.console ?? Infinity) && row.lv === 'error').length;
    const failed = this.#network.filter(entry => entry.rev > (cursor.network ?? Infinity)
      && (entry.st === 'fail' || entry.s >= 400)).length;
    return { errors, failed, cursor: { console: this.#seq, network: this.#rev } };
  }
  /** Requests still loading that started at or after `wallMs` (settle). */
  running(wallMs) {
    let count = 0;
    for (const entry of this.#running) if (entry.wall >= wallMs && ['fetch', 'xhr'].includes(entry.ty)) count++;
    return count;
  }
  boundary() {
    const page = this.#windows.update();
    this.#sharedAllowed = this.shared === this.#windows ? page : this.shared.update();
    if (!page || !this.#sharedAllowed) {
      for (const entry of this.#running) if (!page || entry.shared) this.#freeze(entry);
    }
    return page;
  }
  #freeze(entry) {
    entry.st = 'incomplete';
    entry.rev = ++this.#rev;
    this.#running.delete(entry);
    this.#remember(entry.key);
  }
  // Keys whose request was withheld or frozen: later hops stay private.
  #remember(key) {
    this.#frozen.delete(key);
    this.#frozen.add(key);
    if (this.#frozen.size > L.frozenKeys) this.#frozen.delete(this.#frozen.values().next().value);
  }
  #isShared(sessionId) {
    return sessionId !== undefined && !PAGE_TARGETS.has(this.targetType(sessionId));
  }
  #admit(kind, time, sessionId) {
    if (kind === 'console' && time !== undefined && time < (this.#cutoffs.get(sessionKey(sessionId)) ?? -Infinity)) return false;
    const page = this.boundary();
    const shared = this.#isShared(sessionId);
    if (!page || this.#windows.holds(time) || (shared && (!this.#sharedAllowed || this.shared.holds(time)))) {
      this.#withheld[kind]++;
      return false;
    }
    return true;
  }
  // Console output from the agent's own isolated worlds is not page output.
  #pageWorld(sessionId, contextId) {
    if (contextId === undefined || (sessionId !== undefined && this.targetType(sessionId) !== 'iframe')) return true;
    return this.#contexts.has(`${sessionKey(sessionId)}:${contextId}`);
  }
  #target(sessionId, frameId) {
    if (sessionId === undefined) return frameId !== undefined && this.#childFrames.has(frameId) ? 'iframe' : undefined;
    return this.targetType(sessionId) ?? 'target';
  }
  #contextFrame(sessionId, contextId) {
    return contextId === undefined ? undefined : this.#contexts.get(`${sessionKey(sessionId)}:${contextId}`);
  }
  #log(row) {
    row.i = ++this.#seq;
    row.msg = redactClip(row.msg, L.message);
    this.#console.push(compact(row));
    if (this.#console.length > L.console) { this.#console.shift(); this.#dropped.console++; }
  }
  // Request IDs are browser-wide: a frame document or worker script starts on
  // its parent's session and finishes on its own, so entries key by ID alone.
  #live(sessionId, requestId) {
    const page = this.boundary();
    const entry = this.#requests.get(requestId);
    if (!page || entry?.st !== 'run') return null;
    if (this.#isShared(sessionId)) {
      entry.shared = true;
      if (!this.#sharedAllowed) { this.#freeze(entry); return null; }
    }
    entry.session = sessionId;
    return entry;
  }
  #respond(entry, response) {
    Object.assign(entry, {
      s: response.status, statusText: clip(response.statusText, 100), mt: response.mimeType,
      resHeaders: redactHeaders(response.headers),
      c: response.fromDiskCache ? 'disk' : response.fromServiceWorker ? 'sw' : response.fromPrefetchCache ? 'prefetch' : entry.c,
      proto: response.protocol, ip: response.remoteIPAddress,
    });
  }
  #finish(entry, timestamp) {
    if (timestamp !== undefined && entry.t0 !== undefined) entry.ms = Math.round((timestamp - entry.t0) * 1000);
    entry.rev = ++this.#rev;
  }

  record(method, params, sessionId) {
    if (method === 'Runtime.executionContextCreated') {
      if (params.context?.auxData?.isDefault) this.#contexts.set(`${sessionKey(sessionId)}:${params.context.id}`, params.context.auxData.frameId);
    } else if (method === 'Runtime.executionContextDestroyed') {
      this.#contexts.delete(`${sessionKey(sessionId)}:${params.executionContextId}`);
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const context of this.#contexts.keys()) if (context.startsWith(`${sessionKey(sessionId)}:`)) this.#contexts.delete(context);
    } else if (sessionId === undefined && (method === 'Page.frameAttached' || method === 'Page.frameDetached')) {
      if (method === 'Page.frameAttached' && params.parentFrameId) this.#childFrames.add(params.frameId);
      else this.#childFrames.delete(params.frameId);
    } else if (method === 'Runtime.consoleAPICalled') {
      const frame = params.stackTrace?.callFrames?.[0];
      // Electron's own renderer warnings are runtime noise, not page output.
      if (params.type === 'endGroup' || frame?.url?.startsWith('node:electron/')) return;
      if (!this.#pageWorld(sessionId, params.executionContextId) || !this.#admit('console', params.timestamp, sessionId)) return;
      this.#log({ lv: CONSOLE_LEVELS[params.type] ?? 'log', msg: consoleText(params.args),
        at: frame && location(frame), in: this.#target(sessionId, this.#contextFrame(sessionId, params.executionContextId)) });
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails;
      if (!this.#pageWorld(sessionId, details.executionContextId) || !this.#admit('console', params.timestamp, sessionId)) return;
      const frames = details.stackTrace?.callFrames ?? [];
      const thrown = details.exception?.description ?? details.exception?.value;
      this.#log({ lv: 'error', k: 'exception',
        msg: thrown === undefined ? details.text : `${details.text} ${firstLine(String(thrown).slice(0, L.message * 2))}`.trim(),
        at: details.url ? location(details) : frames[0] && location(frames[0]),
        stack: frames.length > 1 ? frames.slice(0, L.stack).map(f => `${String(f.functionName || '(anonymous)').slice(0, 100)}@${location(f)}`) : undefined,
        in: this.#target(sessionId, this.#contextFrame(sessionId, details.executionContextId)) });
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry;
      // Worker console calls arrive from their own recorded worker sessions.
      if (entry.source === 'worker' || !this.#admit('console', entry.timestamp, sessionId)) return;
      this.#log({ lv: LOG_LEVELS[entry.level] ?? 'log', k: entry.source, msg: entry.text,
        at: entry.url && location({ url: entry.url, lineNumber: entry.lineNumber }),
        req: entry.networkRequestId && this.#requests.get(entry.networkRequestId)?.id,
        in: this.#target(sessionId) });
    } else if (method === 'Network.requestWillBeSent') {
      const key = params.requestId;
      const previous = this.#requests.get(key);
      // A redirect ends the previous hop; Chromium keeps one requestId per chain
      // and replaces its response data, so that hop's body is never served.
      if (params.redirectResponse && previous?.st === 'run') {
        const hop = this.#live(sessionId, key);
        if (hop) {
          this.#respond(hop, params.redirectResponse);
          hop.st = 'redirected';
          this.#running.delete(hop);
          this.#finish(hop, params.timestamp);
        }
      } else if (previous?.st === 'run' && previous.session !== sessionId
        && previous.url === clip(redactURL(params.request.url), L.storedURL)) {
        // The same request reported again by the target that now owns it (an
        // out-of-process frame document): one row, now on that session.
        const entry = this.#live(sessionId, key);
        if (entry) { entry.in = this.#target(sessionId, params.frameId) ?? entry.in; entry.rev = ++this.#rev; }
        return;
      } else if (previous?.st === 'run') {
        // The id was reused without a redirect: the earlier entry never ends.
        previous.st = 'incomplete';
        previous.rev = ++this.#rev;
        this.#running.delete(previous);
      }
      // A chain withheld or frozen while recording was off stays private.
      if (this.#frozen.has(key)) { this.boundary(); this.#withheld.network++; return; }
      if (!this.#admit('network', params.wallTime === undefined ? undefined : params.wallTime * 1000, sessionId)) {
        this.#remember(key);
        return;
      }
      const request = params.request;
      const entry = {
        id: `n${++this.#nextId}`, key, session: sessionId, requestId: params.requestId,
        url: clip(redactURL(request.url), L.storedURL), m: clip(request.method, 20), ty: params.type?.toLowerCase(),
        st: 'run', t0: params.timestamp, wall: params.wallTime === undefined ? Date.now() : params.wallTime * 1000,
        reqHeaders: redactHeaders(request.headers),
        body: request.postData === undefined ? undefined : redactBody(request.postData, L.requestBody),
        hasBody: request.hasPostData, init: initiator(params.initiator), in: this.#target(sessionId, params.frameId),
        shared: this.#isShared(sessionId) || undefined,
      };
      entry.rev = ++this.#rev;
      this.#network.push(entry);
      this.#requests.set(key, entry);
      this.#ids.set(entry.id, entry);
      this.#running.add(entry);
      if (this.#network.length > L.network) {
        const evicted = this.#network.shift();
        this.#ids.delete(evicted.id);
        this.#running.delete(evicted);
        if (this.#requests.get(evicted.key) === evicted) this.#requests.delete(evicted.key);
        this.#dropped.network++;
      }
    } else if (method === 'Network.requestServedFromCache') {
      const entry = this.#live(sessionId, params.requestId);
      if (entry) { entry.c = 'memory'; entry.rev = ++this.#rev; }
    } else if (method === 'Network.responseReceived') {
      const entry = this.#live(sessionId, params.requestId);
      if (!entry) return;
      this.#respond(entry, params.response);
      entry.ty = params.type?.toLowerCase() ?? entry.ty;
      entry.rev = ++this.#rev;
    } else if (method === 'Network.loadingFinished') {
      const entry = this.#live(sessionId, params.requestId);
      if (!entry) return;
      entry.st = 'done';
      entry.sz = params.encodedDataLength;
      this.#running.delete(entry);
      this.#finish(entry, params.timestamp);
    } else if (method === 'Network.loadingFailed') {
      const entry = this.#live(sessionId, params.requestId);
      if (!entry) return;
      entry.st = 'fail';
      entry.err = clip(params.blockedReason ? `blocked:${params.blockedReason}`
        : params.corsErrorStatus ? `cors:${params.corsErrorStatus.corsError}` : params.canceled ? 'canceled' : params.errorText, 100);
      this.#running.delete(entry);
      this.#finish(entry, params.timestamp);
    } else if (method === 'CSS.styleSheetAdded') {
      const header = params.header;
      this.sheets.set(`${sessionKey(sessionId)}:${header.styleSheetId}`, {
        url: header.sourceURL, line: header.startLine ?? 0, frameId: header.frameId,
      });
      // At the cap the oldest sheet is forgotten; its rules then show no source.
      if (this.sheets.size > L.styleSheets) this.sheets.delete(this.sheets.keys().next().value);
    } else if (method === 'CSS.styleSheetRemoved') {
      this.sheets.delete(`${sessionKey(sessionId)}:${params.styleSheetId}`);
    } else if (method === 'Page.frameNavigated') {
      if (sessionId === undefined && params.frame?.parentId) this.#childFrames.add(params.frame.id);
      const prefix = `${sessionKey(sessionId)}:`;
      for (const [key, sheet] of this.sheets) if (key.startsWith(prefix) && sheet.frameId === params.frame?.id) this.sheets.delete(key);
    }
  }

  consoleRows({ since, filter, limit }) {
    const terms = parseFilter(filter, 'console');
    const levels = terms.level?.map(level => level === 'warning' ? 'warn' : level);
    const rows = collapse(this.#console.filter(row => (since === undefined || row.i > since)
      && (!levels || levels.includes(row.lv))
      && terms.text.every(text => `${row.msg} ${row.at ?? ''} ${row.k ?? ''}`.toLowerCase().includes(text))));
    const { selected, next, omitted } = page(rows, since, limit, this.#seq, row => row.i);
    return compact({
      rows: selected.map(row => compact({ ...row, lv: row.lv === 'log' ? undefined : row.lv })),
      next, omitted, withheld: this.#withheld.console || undefined, dropped: this.#dropped.console || undefined,
    });
  }
  networkRows({ since, filter, limit }) {
    const terms = parseFilter(filter, 'network');
    const rows = this.#network.filter(entry => (since === undefined || entry.rev > since)
      && (!terms.status || terms.status.some(code => code.endsWith('xx') ? Math.floor(entry.s / 100) === Number(code[0]) : entry.s === Number(code)))
      && (!terms.type || terms.type.includes(entry.ty))
      && (!terms.method || terms.method.includes(entry.m.toLowerCase()))
      && (!terms.is || terms.is.every(is => is === 'failed' ? entry.st === 'fail' || entry.s >= 400
        : is === 'running' ? entry.st === 'run' : !!entry.c))
      && terms.text.every(text => entry.url.toLowerCase().includes(text)));
    if (since !== undefined) rows.sort((a, b) => a.rev - b.rev);
    const { selected, next, omitted } = page(rows, since, limit, this.#rev, entry => entry.rev);
    return compact({
      rows: selected.map(entry => compact({
        id: entry.id, m: entry.m === 'GET' ? undefined : entry.m, u: clip(entry.url, L.url), ty: entry.ty, s: entry.s,
        mt: entry.mt, sz: entry.sz, ms: entry.ms, err: entry.err, c: entry.c,
        st: ['run', 'incomplete'].includes(entry.st) ? entry.st : undefined, in: entry.in,
      })),
      next, omitted, withheld: this.#withheld.network || undefined, dropped: this.#dropped.network || undefined,
    });
  }
  #entry(id) {
    const entry = this.#ids.get(id);
    if (!entry) fail('UNKNOWN_ENTRY', 'Unknown or evicted network id; list network rows again');
    return entry;
  }
  detail(id) {
    const e = this.#entry(id);
    return compact({
      id, url: e.url, m: e.m, ty: e.ty, s: e.s, statusText: e.statusText, mt: e.mt,
      st: e.st === 'done' ? undefined : e.st, err: e.err, c: e.c, sz: e.sz, ms: e.ms, proto: e.proto, ip: e.ip,
      init: e.init, in: e.in, reqHeaders: e.reqHeaders, resHeaders: e.resHeaders, reqBody: e.body,
      reqBodyOmitted: e.hasBody && e.body === undefined ? `over ${L.postData} bytes; not captured` : undefined,
    });
  }
  bodyTarget(id) {
    const entry = this.#entry(id);
    if (entry.st === 'incomplete') fail('BODY_UNAVAILABLE', 'The response was still loading when recording stopped (person in control); it is withheld');
    if (entry.st === 'redirected') fail('BODY_UNAVAILABLE', 'This hop ended in a redirect; its body is not kept. Read the final hop');
    if (entry.st !== 'done') fail('BODY_UNAVAILABLE', `The request has not finished successfully (${entry.st === 'run' ? 'running' : entry.err})`);
    // Chromium serves the body of the latest hop for a requestId.
    if (this.#requests.get(entry.key) !== entry || this.#frozen.has(entry.key)) {
      fail('BODY_UNAVAILABLE', 'A later request reused this id; the browser no longer holds this body');
    }
    return entry;
  }
}

const command = (driver, signal) => (method, params = {}, sessionId) => driver.devtoolsCommand(method, params, sessionId, signal);

export async function responseBody(driver, entry, limit, signal) {
  let reply;
  try { reply = await driver.devtoolsCommand('Network.getResponseBody', { requestId: entry.requestId }, entry.session, signal); }
  catch (error) {
    signal?.throwIfAborted();
    fail('BODY_UNAVAILABLE', `The browser no longer holds this response body (bounded buffer, redirect or empty body): ${error.message}`);
  }
  const bytes = reply.base64Encoded ? Buffer.from(reply.body, 'base64') : null;
  const size = bytes ? bytes.length : Buffer.byteLength(reply.body);
  if (bytes && !TEXT_MIME.test(String(entry.mt ?? '').slice(0, 200))) return compact({ id: entry.id, mt: entry.mt, size, binary: true });
  // The same bounded redaction as request bodies (JSON, form, free text).
  return compact({ id: entry.id, mt: entry.mt, size, body: redactBody(bytes ? bytes.toString('utf8') : reply.body, limit) });
}

function remoteValue(object, limit) {
  if (object.type === 'string') return { type: 'string', value: clip(object.value, limit) };
  // BigInt and similar values can be arbitrarily long (10n ** 100000n).
  if (object.unserializableValue !== undefined) return { type: object.type, value: clip(object.unserializableValue, limit) };
  if (object.type === 'undefined') return { type: 'undefined' };
  if (object.subtype === 'null') return { type: 'null', value: null };
  if (object.type === 'number' || object.type === 'boolean') return { type: object.type, value: object.value };
  return compact({ type: object.subtype ?? object.type, class: object.className === undefined ? undefined : clip(object.className, limit),
    preview: clip(object.preview ? previewText(object.preview) : object.description, limit) });
}
// The DevTools Console equivalent. V8's throwOnSideEffect is a best-effort
// check, not a security boundary: page-defined functions and getters that V8
// judges side-effect-free still run, so the result is reported by the page.
// Objects come back as V8 previews.
export async function pageRead(driver, { expression, frameId, limit = L.chars }, signal) {
  const world = frameId === undefined ? undefined : driver.pageContext(frameId);
  if (frameId !== undefined && !world) fail('STALE_FRAME', 'The frame has no current page world; observe for current frames');
  const group = objectGroup();
  let reply;
  try {
    reply = await driver.devtoolsCommand('Runtime.evaluate', {
      expression, ...(world ? { contextId: world.contextId } : {}), throwOnSideEffect: true,
      timeout: L.evaluationMs, silent: true, returnByValue: false, generatePreview: true, objectGroup: group,
    }, world?.sessionId, signal);
  } catch (error) {
    signal?.throwIfAborted();
    // V8 ends an evaluation past its timeout with this protocol error, not
    // with exceptionDetails.
    if (/Execution was terminated/.test(String(error?.message ?? ''))) {
      fail('SCRIPT_TIMEOUT', `The page-world read exceeded ${L.evaluationMs} ms and was terminated`);
    }
    throw error;
  } finally {
    // Releasing a temporary object group is cleanup, not part of the result.
    driver.devtoolsCommand('Runtime.releaseObjectGroup', { objectGroup: group }, world?.sessionId).catch(() => {});
  }
  const { result, exceptionDetails } = reply;
  if (exceptionDetails) {
    const text = String(exceptionDetails.exception?.description ?? exceptionDetails.exception?.value ?? exceptionDetails.text ?? '').slice(0, L.message * 2);
    if (/side-effect/i.test(text)) {
      fail('SIDE_EFFECT', 'The expression may have side effects, so this read-only evaluation refused it. Use evaluate with world:"page" (a mutation) only when the side effect is intended.');
    }
    return { exception: clip(firstLine(text), L.message) };
  }
  return remoteValue(result, limit);
}

const NAVIGATION_TIMING = `(() => {
  const n = performance.getEntriesByType('navigation')[0];
  if (!n) return null;
  const r = value => value > 0 ? Math.round(value) : undefined;
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  return { type: n.type, ttfb: r(n.responseStart), dcl: r(n.domContentLoadedEventEnd), load: r(n.loadEventEnd),
    fcp: fcp && r(fcp.startTime), transfer: n.transferSize, decoded: n.decodedBodySize,
    resources: performance.getEntriesByType('resource').length };
})()`;
const METRICS = { nodes: 'Nodes', docs: 'Documents', frames: 'Frames', listeners: 'JSEventListeners',
  layoutObjects: 'LayoutObjects', layouts: 'LayoutCount', recalcs: 'RecalcStyleCount' };
const DURATIONS = { layoutMs: 'LayoutDuration', recalcMs: 'RecalcStyleDuration', scriptMs: 'ScriptDuration', taskMs: 'TaskDuration' };
export async function performanceSnapshot(driver, signal) {
  const send = command(driver, signal);
  const { metrics } = await send('Performance.getMetrics');
  const { frameTree } = await send('Page.getFrameTree');
  // A private world: page scripts cannot replace the Performance API it reads.
  const { executionContextId } = await send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: driver.devtoolsWorldName, grantUniveralAccess: false,
  });
  const nav = await send('Runtime.evaluate', {
    expression: NAVIGATION_TIMING, contextId: executionContextId, returnByValue: true, timeout: L.evaluationMs,
  });
  const value = Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
  const mb = bytes => bytes === undefined ? undefined : Math.round(bytes / 104857.6) / 10;
  return compact({
    url: clip(redactURL(frameTree.frame.url), L.url),
    m: compact({
      ...Object.fromEntries(Object.entries(METRICS).map(([key, name]) => [key, value[name]])),
      ...Object.fromEntries(Object.entries(DURATIONS).map(([key, name]) => [key, value[name] === undefined ? undefined : Math.round(value[name] * 1000)])),
      heapMB: mb(value.JSHeapUsedSize), heapTotalMB: mb(value.JSHeapTotalSize),
    }),
    nav: nav.exceptionDetails ? undefined : nav.result?.value ?? undefined,
  });
}

// Runs in the observation's isolated world on the ref's element: computed
// layout and visibility only, no page globals and no DOM mutation.
export const INSPECT_ELEMENT = `function(extra) {
  const cs = getComputedStyle(this), rect = this.getBoundingClientRect();
  const round = value => Math.round(value * 10) / 10;
  const name = el => ((el.localName || el.nodeName.toLowerCase()) + (el.id ? '#' + el.id : '')
    + Array.from(el.classList || []).slice(0, 2).map(c => '.' + c).join('')).slice(0, 80);
  const sides = pattern => {
    const values = ['top', 'right', 'bottom', 'left'].map(side => round(parseFloat(cs.getPropertyValue(pattern.replace('*', side))) || 0));
    return values.some(Boolean) ? values : undefined;
  };
  const optional = { 'z-index': 'auto', overflow: 'visible', 'pointer-events': 'auto', transform: 'none', 'clip-path': 'none', 'content-visibility': 'visible' };
  const style = {};
  for (const key of ['display', 'visibility', 'opacity', 'position', 'width', 'height', ...Object.keys(optional)]) {
    const value = cs.getPropertyValue(key);
    if (optional[key] !== value) style[key] = value.slice(0, 200);
  }
  for (const key of extra) style[key] = cs.getPropertyValue(key).slice(0, 200);
  const visible = this.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
  let hiddenBy;
  if (!visible) {
    if (cs.visibility !== 'visible') hiddenBy = name(this) + ' visibility:' + cs.visibility;
    for (let el = this; el && !hiddenBy; el = el.parentElement || el.parentNode?.host) {
      const s = getComputedStyle(el);
      if (s.display === 'none') hiddenBy = name(el) + ' display:none';
      else if (s.opacity === '0') hiddenBy = name(el) + ' opacity:0';
      else if (el !== this && s.contentVisibility === 'hidden') hiddenBy = name(el) + ' content-visibility:hidden';
    }
  }
  return { tag: name(this), box: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
    margin: sides('margin-*'), border: sides('border-*-width'), padding: sides('padding-*'), style, visible, hiddenBy };
}`;

// Elements that observations omit (hidden, non-interactive) are reached by an
// exact CSS selector in the frame's isolated world. Like refresh() during
// checkpoints, this never observes, so the latest refs stay valid.
export async function selectElement(driver, { selector, frameId }) {
  const frames = await driver.refresh();
  const frame = frameId === undefined ? frames.find(item => !item.parentId) : driver.frames.get(frameId);
  if (!frame) fail('STALE_FRAME', 'Unknown frameId; observe for current frames');
  const found = await driver.evaluate(frame, `(() => {
    let all;
    try { all = document.querySelectorAll(${JSON.stringify(selector)}); } catch { return 'invalid'; }
    return all.length === 1 ? all[0] : String(all.length);
  })()`, false);
  if (found.type === 'string') {
    if (found.value === 'invalid') fail('INVALID_ARGUMENT', 'Invalid CSS selector');
    fail(found.value === '0' ? 'TARGET_NOT_FOUND' : 'AMBIGUOUS_TARGET', `The selector matches ${found.value} elements in this frame's document; it must match exactly one`);
  }
  return { frame, objectId: found.objectId };
}

// Matched author/user-agent rules (highest precedence first) and listener
// types. Runs in the per-tab lane like read; never observes or mutates.
export async function inspectNode(driver, recorder, frame, objectId) {
  const session = frame.sessionId;
  const key = sessionKey(session);
  const { node } = await driver.send('DOM.describeNode', { objectId }, session);
  if (!recorder.css.has(key)) {
    await driver.send('CSS.enable', {}, session);
    recorder.css.add(key);
  }
  await driver.send('DOM.getDocument', { depth: 0 }, session);
  const { nodeIds } = await driver.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [node.backendNodeId] }, session);
  const matched = await driver.send('CSS.getMatchedStylesForNode', { nodeId: nodeIds[0] }, session);
  // Listeners belong to the page's main world, so resolve the node there.
  const group = objectGroup();
  const { object } = await driver.send('DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: group }, session);
  let listeners;
  try {
    ({ listeners } = await driver.send('DOMDebugger.getEventListeners', { objectId: object.objectId }, session));
  } finally {
    await driver.send('Runtime.releaseObjectGroup', { objectGroup: group }, session);
  }
  const rules = [];
  const inline = matched.inlineStyle?.cssText?.trim();
  if (inline) rules.push({ s: 'element.style', d: clip(inline.replace(/\s+/g, ' '), L.declarations) });
  for (const { rule, matchingSelectors = [] } of [...(matched.matchedCSSRules ?? [])].reverse()) {
    const selectors = rule.selectorList?.selectors ?? [];
    const selector = matchingSelectors.map(index => selectors[index]?.text).filter(Boolean).join(', ') || rule.selectorList?.text;
    const declarations = rule.style?.cssText?.trim() || (rule.style?.cssProperties ?? [])
      .filter(property => !property.implicit && !property.disabled && property.value)
      .map(property => `${property.name}: ${property.value}${property.important ? ' !important' : ''}`).join('; ');
    const sheet = recorder.sheets.get(`${key}:${rule.styleSheetId}`);
    const line = selectors[0]?.range?.startLine ?? rule.style?.range?.startLine;
    const src = rule.origin === 'user-agent' ? 'user-agent' : sheet
      ? `${clip(redactURL(sheet.url) || '<inline>', L.url)}${line === undefined ? '' : `:${sheet.line + line + 1}`}` : undefined;
    rules.push(compact({ s: clip(selector, L.url), d: clip(declarations.replace(/\s+/g, ' '), L.declarations), src }));
  }
  const counts = {};
  for (const listener of listeners ?? []) counts[listener.type] = (counts[listener.type] ?? 0) + 1;
  return compact({
    rules: rules.slice(0, L.rules), rulesOmitted: Math.max(0, rules.length - L.rules) || undefined,
    listeners: Object.keys(counts).length ? Object.fromEntries(Object.entries(counts).slice(0, L.listeners)) : undefined,
  });
}
