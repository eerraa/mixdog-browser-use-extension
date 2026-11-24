// Agent DevTools over the page's own CDP session (decisions D11, D12).
// Bounded per-page records of console calls, uncaught exceptions, browser log
// entries and network activity, plus page-world reads with V8's best-effort
// side-effect check,
// element inspection and a performance snapshot. Outputs are compact rows:
// they never carry observations or screenshots and never invalidate refs.
// Nothing produced while the person controls the page is recorded or exposed.
import { fail } from '../shared/contract.mjs';
import { clip, redactBody, redactClip, redactHeaders, redactText, redactURL } from './redact.mjs';

export const DEVTOOLS_LIMITS = Object.freeze({
  console: 500, network: 1000, rows: 30, maxRows: 100, chars: 8192, maxChars: 65536,
  message: 300, url: 200, storedURL: 2000, header: 256, headerBytes: 2048, requestBody: 2048,
  wsFrames: 50, wsFrameChars: 512,
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
const TEXT_MIME = /^text\/|json|javascript|ecmascript|xml|html|css|svg|x-www-form-urlencoded|graphql|csv/i;
const compact = object => Object.fromEntries(Object.entries(object)
  .filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)));
const sessionKey = sessionId => sessionId ?? '';
const firstLine = text => String(text ?? '').split('\n', 1)[0];
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
  #websockets = new Map();
  #rdpActors = new Map();
  #rdpByResourceId = new Map();
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
    const cAfter = cursor.console ?? Infinity;
    const nAfter = cursor.network ?? Infinity;
    let errors = 0;
    if (cAfter < this.#seq) {
      for (let i = this.#console.length - 1; i >= 0; i--) {
        const row = this.#console[i];
        if (row.i <= cAfter) break;
        if (row.lv === 'error') errors++;
      }
    }
    let failed = 0;
    if (nAfter < this.#rev) {
      for (const entry of this.#network) {
        if (entry.rev > nAfter && (entry.st === 'fail' || entry.s >= 400)) failed++;
      }
    }
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
    if (entry.wsid) this.#websockets.delete(entry.wsid);
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
      this.#pushNetwork(entry);
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
  #pushNetwork(entry) {
    entry.rev = ++this.#rev;
    this.#network.push(entry);
    this.#requests.set(entry.key, entry);
    this.#ids.set(entry.id, entry);
    if (entry.st === 'run') this.#running.add(entry);
    if (this.#network.length > L.network) {
      const evicted = this.#network.shift();
      this.#ids.delete(evicted.id);
      this.#running.delete(evicted);
      if (this.#requests.get(evicted.key) === evicted) this.#requests.delete(evicted.key);
      if (evicted.wsid && this.#websockets.get(evicted.wsid) === evicted) this.#websockets.delete(evicted.wsid);
      if (evicted.rdpActor && this.#rdpActors.get(evicted.rdpActor) === evicted) this.#rdpActors.delete(evicted.rdpActor);
      if (evicted.rdpResourceId !== undefined && this.#rdpByResourceId.get(evicted.rdpResourceId) === evicted) {
        this.#rdpByResourceId.delete(evicted.rdpResourceId);
      }
      this.#dropped.network++;
    }
  }

  /**
   * Record Camoufox/Firefox Juggler protocol events into the exact same bounded
   * console/network rings, privacy windows, and linear redaction pipeline.
   */
  recordJuggler(method, params = {}, sessionId) {
    if (method === 'Runtime.executionContextCreated') {
      if (!params.auxData?.name) {
        this.#contexts.set(`${sessionKey(sessionId)}:${params.executionContextId}`, params.auxData?.frameId);
      }
      return;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      this.#contexts.delete(`${sessionKey(sessionId)}:${params.executionContextId}`);
      return;
    }
    if (method === 'Runtime.executionContextsCleared') {
      for (const context of this.#contexts.keys()) if (context.startsWith(`${sessionKey(sessionId)}:`)) this.#contexts.delete(context);
      return;
    }
    if (method === 'Page.frameAttached' || method === 'Page.frameDetached') {
      if (method === 'Page.frameAttached' && params.parentFrameId) this.#childFrames.add(params.frameId);
      else this.#childFrames.delete(params.frameId);
      return;
    }
    if (method === 'Runtime.console') {
      if (params.type === 'endGroup') return;
      if (!this.#pageWorld(sessionId, params.executionContextId) || !this.#admit('console', Date.now(), sessionId)) return;
      const loc = params.location;
      this.#log({
        lv: CONSOLE_LEVELS[params.type] ?? 'log',
        msg: consoleText(params.args),
        at: loc?.url ? location(loc) : undefined,
        in: this.#target(sessionId, this.#contextFrame(sessionId, params.executionContextId)),
      });
      return;
    }
    if (method === 'Page.uncaughtError') {
      if (!this.#admit('console', Date.now(), sessionId)) return;
      const loc = params.location;
      const stackLines = String(params.stack ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      this.#log({
        lv: 'error', k: 'exception',
        msg: firstLine(String(params.message ?? 'Uncaught error').slice(0, L.message * 2)),
        at: loc?.url ? location(loc) : undefined,
        stack: stackLines.length ? stackLines.slice(0, L.stack).map(line => clip(redactText(line), 160)) : undefined,
        in: this.#target(sessionId, params.frameId),
      });
      return;
    }
    if (method === 'Page.dispatchMessageFromWorker') {
      let parsed;
      try { parsed = JSON.parse(params.message); } catch { return; }
      if (parsed?.method === 'Runtime.console' || parsed?.method === 'runtime.runtimeConsole' || parsed?.method === 'runtimeConsole') {
        const msg = parsed.params ?? {};
        if (msg.type === 'endGroup') return;
        if (!this.#admit('console', Date.now(), `worker:${params.workerId}`)) return;
        const loc = msg.location;
        this.#log({
          lv: CONSOLE_LEVELS[msg.type] ?? 'log',
          msg: consoleText(msg.args),
          at: loc?.url ? location(loc) : undefined,
          in: 'worker',
        });
      }
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const key = params.requestId;
      const redirectedFrom = params.redirectedFrom ? this.#requests.get(params.redirectedFrom) : null;
      if (this.#frozen.has(key) || (params.redirectedFrom && this.#frozen.has(params.redirectedFrom))) {
        this.boundary();
        this.#remember(key);
        this.#withheld.network++;
        return;
      }
      const now = Date.now();
      if (!this.#admit('network', now, sessionId)) {
        this.#remember(key);
        return;
      }
      if (redirectedFrom && redirectedFrom.st === 'run') {
        redirectedFrom.st = 'redirected';
        this.#running.delete(redirectedFrom);
        redirectedFrom.rev = ++this.#rev;
      }
      const headers = Object.fromEntries((params.headers ?? []).map(h => [h.name, h.value]));
      const rawPost = params.postData === undefined ? undefined : Buffer.from(params.postData, 'base64').toString('utf8');
      const entry = {
        id: `n${++this.#nextId}`, key, source: 'juggler', session: sessionId, requestId: key,
        url: clip(redactURL(params.url), L.storedURL),
        m: clip(params.method || 'GET', 20),
        ty: mapJugglerCause(params.cause, params.internalCause),
        st: 'run', t0: now / 1000, wall: now,
        reqHeaders: redactHeaders(headers),
        body: rawPost === undefined ? undefined : redactBody(rawPost, L.requestBody),
        hasBody: rawPost !== undefined,
        in: this.#target(sessionId, params.frameId),
        redirectFrom: redirectedFrom?.id,
      };
      if (redirectedFrom) redirectedFrom.redirectTo = entry.id;
      this.#pushNetwork(entry);
      return;
    }
    if (method === 'Network.responseReceived') {
      const entry = this.#live(sessionId, params.requestId);
      if (!entry) return;
      const headers = Object.fromEntries((params.headers ?? []).map(h => [h.name, h.value]));
      const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
      const mt = ct.split(';')[0].trim();
      const t = params.timing;
      const timing = t ? compact({
        dnsMs: t.domainLookupStart >= 0 && t.domainLookupEnd >= t.domainLookupStart ? Math.round((t.domainLookupEnd - t.domainLookupStart) / 1000) : undefined,
        tcpMs: t.connectStart >= 0 && t.connectEnd >= t.connectStart ? Math.round((t.connectEnd - t.connectStart) / 1000) : undefined,
        tlsMs: t.secureConnectionStart >= 0 && t.connectEnd >= t.secureConnectionStart ? Math.round((t.connectEnd - t.secureConnectionStart) / 1000) : undefined,
        ttfbMs: t.requestStart >= 0 && t.responseStart >= t.requestStart ? Math.round((t.responseStart - t.requestStart) / 1000) : undefined,
      }) : undefined;
      const tls = params.securityDetails ? compact({
        protocol: params.securityDetails.protocol,
        subject: clip(params.securityDetails.subjectName, 120),
        issuer: clip(params.securityDetails.issuer, 120),
      }) : undefined;
      Object.assign(entry, {
        s: params.status,
        statusText: clip(params.statusText, 100),
        mt: mt || entry.mt,
        resHeaders: redactHeaders(headers),
        c: params.fromServiceWorker ? 'sw' : params.fromCache ? 'cache' : entry.c,
        ip: params.remoteIPAddress ? (params.remotePort ? `${params.remoteIPAddress}:${params.remotePort}` : params.remoteIPAddress) : entry.ip,
        timing: timing && Object.keys(timing).length ? timing : entry.timing,
        tls: tls && Object.keys(tls).length ? tls : entry.tls,
        jugglerStartUs: t?.startTime,
      });
      entry.rev = ++this.#rev;
      return;
    }
    if (method === 'Network.requestFinished') {
      const entry = this.#requests.get(params.requestId);
      if (!entry || !this.boundary() || (entry.st !== 'run' && entry.st !== 'redirected')) return;
      if (entry.st !== 'redirected') entry.st = entry.redirectTo ? 'redirected' : 'done';
      entry.sz = params.encodedBodySize ?? params.transferSize ?? entry.sz;
      entry.transferSize = params.transferSize;
      if (params.protocolVersion) entry.proto = params.protocolVersion;
      this.#running.delete(entry);
      if (typeof params.responseEndTime === 'number' && typeof entry.jugglerStartUs === 'number' && params.responseEndTime >= entry.jugglerStartUs) {
        entry.ms = Math.round((params.responseEndTime - entry.jugglerStartUs) / 1000);
      } else {
        this.#finish(entry, Date.now() / 1000);
        return;
      }
      entry.rev = ++this.#rev;
      return;
    }
    if (method === 'Network.requestFailed') {
      const entry = this.#live(sessionId, params.requestId);
      if (!entry) return;
      // Firefox Juggler emits NS_ERROR_DOM_NETWORK_ERR when closing keepalive
      // 204/2xx beacons even after the HTTP response succeeded.
      if (entry.ty === 'beacon' && typeof entry.s === 'number' && entry.s >= 200 && entry.s < 400) {
        entry.st = 'done';
        this.#running.delete(entry);
        this.#finish(entry, Date.now() / 1000);
        return;
      }
      entry.st = 'fail';
      entry.err = clip(params.errorCode || 'failed', 100);
      this.#running.delete(entry);
      this.#finish(entry, Date.now() / 1000);
      return;
    }
    if (method === 'Page.webSocketCreated' || method === 'Page.webSocketOpened' || method === 'Page.webSocketClosed'
      || method === 'Page.webSocketFrameSent' || method === 'Page.webSocketFrameReceived') {
      this.recordWebSocket(method.slice('Page.webSocket'.length).toLowerCase(), params, sessionId);
    }
  }

  recordWebSocket(event, params = {}, sessionId) {
    const wsid = params.wsid;
    if (!wsid) return;
    const key = `ws:${wsid}`;
    const wall = typeof params.timestamp === 'number' && params.timestamp > 1e11 ? params.timestamp
      : typeof params.timestamp === 'number' ? params.timestamp * 1000 : Date.now();
    if (event === 'created') {
      if (this.#frozen.has(key)) { this.boundary(); this.#withheld.network++; return; }
      if (!this.#admit('network', wall, sessionId)) { this.#remember(key); return; }
      const entry = {
        id: `n${++this.#nextId}`, key, source: 'websocket', session: sessionId, wsid,
        url: clip(redactURL(params.requestURL), L.storedURL),
        m: 'WS', ty: 'websocket', st: 'run', t0: wall / 1000, wall,
        in: this.#target(sessionId, params.frameId),
        ws: { sent: 0, recv: 0, sentBytes: 0, recvBytes: 0, dropped: 0, frames: [] },
      };
      this.#websockets.set(wsid, entry);
      this.#pushNetwork(entry);
      return;
    }
    const entry = this.#websockets.get(wsid);
    if (!entry) {
      if (this.#frozen.has(key)) { this.boundary(); this.#withheld.network++; }
      return;
    }
    if (!this.#admit('network', wall, sessionId)) {
      this.#freeze(entry);
      return;
    }
    if (event === 'opened') {
      if (params.effectiveURL) entry.url = clip(redactURL(params.effectiveURL), L.storedURL);
      entry.s = 101;
      entry.statusText = 'Switching Protocols';
      if (params.requestId) {
        const hs = this.#requests.get(params.requestId);
        if (hs) {
          entry.handshakeRequestId = hs.id;
          if (!entry.reqHeaders && hs.reqHeaders) entry.reqHeaders = hs.reqHeaders;
          if (!entry.resHeaders && hs.resHeaders) entry.resHeaders = hs.resHeaders;
          if (!entry.timing && hs.timing) entry.timing = hs.timing;
          if (!entry.tls && hs.tls) entry.tls = hs.tls;
          if (!entry.ip && hs.ip) entry.ip = hs.ip;
        }
      }
      entry.rev = ++this.#rev;
      return;
    }
    if (event === 'framesent' || event === 'framereceived') {
      const dir = event === 'framesent' ? 'out' : 'in';
      const raw = String(params.data ?? '');
      const bytes = Buffer.byteLength(raw, 'utf8');
      if (dir === 'out') { entry.ws.sent++; entry.ws.sentBytes += bytes; }
      else { entry.ws.recv++; entry.ws.recvBytes += bytes; }
      const binary = params.opcode !== undefined && params.opcode !== 1;
      const frame = compact({
        dir, op: params.opcode, sz: bytes,
        data: binary ? `[binary ${bytes} bytes]` : redactBody(raw, L.wsFrameChars),
      });
      entry.ws.frames.push(frame);
      if (entry.ws.frames.length > L.wsFrames) {
        entry.ws.frames.shift();
        entry.ws.dropped++;
      }
      entry.sz = entry.ws.sentBytes + entry.ws.recvBytes;
      entry.rev = ++this.#rev;
      return;
    }
    if (event === 'closed') {
      entry.st = params.error ? 'fail' : 'done';
      if (params.error) entry.err = clip(params.error, 100);
      this.#running.delete(entry);
      this.#websockets.delete(wsid);
      this.#finish(entry, wall / 1000);
    }
  }

  /**
   * Record Firefox RDP worker/service-worker network & console resources under
   * the same privacy-window gate, deduplicated against Juggler main/iframe entries.
   */
  recordRdp(phase, resourceType, item, targetType = null) {
    if (!item) return;
    const isShared = targetType === 'service_worker' || targetType === 'shared_worker';
    const wall = typeof item.timeStamp === 'number' ? item.timeStamp
      : typeof item.startedDateTime === 'string' ? Date.parse(item.startedDateTime) || Date.now() : Date.now();
    if (resourceType === 'console-message' && phase === 'available') {
      // Main, iframe, and dedicated-worker console are already captured via Juggler.
      if (!isShared) return;
      const rdpSession = `rdp:${targetType}`;
      if (!this.#admit('console', wall, rdpSession)) return;
      const args = (item.arguments ?? []).map(a => (typeof a === 'string' ? a : a?.initial ?? a?.class ?? String(a ?? '')));
      this.#log({
        lv: CONSOLE_LEVELS[item.level] ?? 'log',
        msg: args.join(' '),
        at: item.filename ? location({ url: item.filename, lineNumber: Math.max(0, (item.lineNumber ?? 1) - 1), columnNumber: Math.max(0, (item.columnNumber ?? 1) - 1) }) : undefined,
        in: targetType,
      });
      return;
    }
    if (resourceType !== 'network-event') return;
    if (phase === 'available') {
      const actor = item.actor;
      if (!actor) return;
      const resId = item.resourceId;
      const fromWorker = item.innerWindowId === null || targetType === 'worker' || isShared;
      // Frame/iframe requests (non-null innerWindowId) are already captured with
      // full headers, bodies, and timing by Juggler (whose requestId equals String(resourceId)).
      if (!fromWorker) return;
      if (resId !== undefined && this.#requests.has(String(resId))) {
        const existing = this.#requests.get(String(resId));
        if (existing && !existing.rdpActor) existing.rdpActor = actor;
        return;
      }
      const redactedUrl = clip(redactURL(item.url), L.storedURL);
      const method = clip(item.method || 'GET', 20);
      const dup = this.#network.findLast(e => e.source === 'juggler' && e.url === redactedUrl && e.m === method && Math.abs(e.wall - wall) < 2500);
      if (dup) {
        if (!dup.rdpActor) dup.rdpActor = actor;
        return;
      }
      const rdpSession = isShared ? `rdp:${targetType}` : 'rdp:worker:dedicated';
      const key = `rdp:${actor}`;
      if (this.#frozen.has(key)) { this.boundary(); this.#withheld.network++; return; }
      if (!this.#admit('network', wall, rdpSession)) { this.#remember(key); return; }
      const entry = {
        id: `n${++this.#nextId}`, key, source: 'rdp', rdpActor: actor, rdpResourceId: resId, session: rdpSession,
        url: redactedUrl, m: method, ty: String(item.cause?.type || 'other').toLowerCase(),
        st: 'run', t0: wall / 1000, wall,
        in: isShared ? targetType : 'worker',
        shared: isShared || undefined,
      };
      this.#rdpActors.set(actor, entry);
      if (resId !== undefined) this.#rdpByResourceId.set(resId, entry);
      this.#pushNetwork(entry);
      return;
    }
    if (phase === 'updated') {
      const entry = (item.actor ? this.#rdpActors.get(item.actor) : null)
        ?? (item.resourceId !== undefined ? this.#rdpByResourceId.get(item.resourceId) : null);
      if (!entry) return;
      if (!this.#admit('network', Date.now(), entry.session)) { this.#freeze(entry); return; }
      const u = item.resourceUpdates ?? item;
      if (u.status !== undefined) entry.s = Number(u.status);
      if (u.statusText !== undefined) entry.statusText = clip(u.statusText, 100);
      if (u.mimeType !== undefined) entry.mt = String(u.mimeType).split(';')[0].trim();
      if (u.httpVersion) entry.proto = u.httpVersion;
      if (u.remoteAddress) entry.ip = u.remotePort ? `${u.remoteAddress}:${u.remotePort}` : u.remoteAddress;
      if (u.contentSize !== undefined) entry.sz = u.contentSize;
      if (u.transferredSize !== undefined) entry.transferSize = u.transferredSize;
      if (u.totalTime !== undefined) entry.ms = Math.round(u.totalTime);
      if (u.blockedReason) { entry.st = 'fail'; entry.err = clip(String(u.blockedReason), 100); this.#running.delete(entry); }
      else if (u.eventTimingsAvailable || u.responseContentAvailable || u.responseEndAvailable) {
        entry.st = entry.s >= 300 && entry.s < 400 ? 'redirected' : 'done';
        this.#running.delete(entry);
      }
      entry.rev = ++this.#rev;
    }
  }

  rdpActorForEnrichment(id) {
    const e = this.#entry(id);
    if (e.source === 'rdp' && e.rdpActor && !e.rdpEnriched && e.st !== 'incomplete') return e.rdpActor;
    return null;
  }
  enrichRdp(id, { reqHeaders, resHeaders, reqBody } = {}) {
    const e = this.#ids.get(id);
    if (!e || e.st === 'incomplete') return;
    if (reqHeaders && !e.reqHeaders) e.reqHeaders = redactHeaders(reqHeaders);
    if (resHeaders && !e.resHeaders) e.resHeaders = redactHeaders(resHeaders);
    if (reqBody !== undefined && e.body === undefined) {
      e.body = redactBody(reqBody, L.requestBody);
      e.hasBody = true;
    }
    e.rdpEnriched = true;
  }
  detail(id) {
    const e = this.#entry(id);
    return compact({
      id, url: e.url, m: e.m, ty: e.ty, s: e.s, statusText: e.statusText, mt: e.mt,
      st: e.st === 'done' ? undefined : e.st, err: e.err, c: e.c, sz: e.sz, transferSize: e.transferSize,
      ms: e.ms, timing: e.timing, proto: e.proto, ip: e.ip, tls: e.tls,
      redirectFrom: e.redirectFrom, redirectTo: e.redirectTo, handshake: e.handshakeRequestId,
      init: e.init, in: e.in, reqHeaders: e.reqHeaders, resHeaders: e.resHeaders, reqBody: e.body,
      reqBodyOmitted: e.hasBody && e.body === undefined ? `over ${L.postData} bytes; not captured` : undefined,
      ws: e.ws ? compact({
        sent: e.ws.sent, recv: e.ws.recv, sentBytes: e.ws.sentBytes, recvBytes: e.ws.recvBytes,
        dropped: e.ws.dropped || undefined, frames: e.ws.frames.slice(-10),
      }) : undefined,
    });
  }
  wsFrames(id, limit = L.chars) {
    const e = this.#entry(id);
    if (!e.ws) fail('BODY_UNAVAILABLE', 'Entry is not a WebSocket');
    let used = 0;
    const frames = [];
    for (const frame of e.ws.frames) {
      const size = JSON.stringify(frame).length + 2;
      if (used + size > limit && frames.length) break;
      frames.push(frame);
      used += size;
    }
    return compact({
      id: e.id, ty: 'websocket', sent: e.ws.sent, recv: e.ws.recv,
      dropped: e.ws.dropped || undefined, omitted: Math.max(0, e.ws.frames.length - frames.length) || undefined,
      frames,
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
  if (entry.source === 'juggler') {
    let reply;
    try { reply = await driver.jugglerResponseBody(entry.requestId, signal); }
    catch (error) {
      signal?.throwIfAborted();
      fail('BODY_UNAVAILABLE', `The browser no longer holds this response body (bounded buffer, redirect or empty body): ${error.message}`);
    }
    if (reply.evicted) fail('BODY_UNAVAILABLE', 'The response body was evicted from the browser buffer');
    const bytes = Buffer.from(reply.base64body ?? '', 'base64');
    if (bytes.length && !TEXT_MIME.test(String(entry.mt ?? '').slice(0, 200))) {
      return compact({ id: entry.id, mt: entry.mt, size: bytes.length, binary: true });
    }
    return compact({ id: entry.id, mt: entry.mt, size: bytes.length, body: redactBody(bytes.toString('utf8'), limit) });
  }
  if (entry.source === 'rdp' && entry.rdpActor) {
    const reply = await driver.rdpResponseBody(entry.rdpActor, limit, signal);
    const bytes = reply.base64Encoded ? Buffer.from(reply.text ?? '', 'base64') : null;
    const size = reply.size ?? (bytes ? bytes.length : Buffer.byteLength(reply.text ?? ''));
    const mt = entry.mt ?? reply.mimeType;
    if (bytes && !TEXT_MIME.test(String(mt ?? '').slice(0, 200))) return compact({ id: entry.id, mt, size, binary: true });
    return compact({ id: entry.id, mt, size, body: redactBody(bytes ? bytes.toString('utf8') : reply.text, limit) });
  }
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

function mapJugglerCause(cause, internalCause) {
  const c = String(cause || internalCause || '').toUpperCase();
  if (c.includes('SUBDOCUMENT')) return 'iframe';
  if (c.includes('DOCUMENT')) return 'document';
  if (c.includes('FETCH')) return 'fetch';
  if (c.includes('XMLHTTPREQUEST') || c.includes('XHR')) return 'xhr';
  if (c.includes('SCRIPT')) return 'script';
  if (c.includes('STYLESHEET')) return 'stylesheet';
  if (c.includes('IMAGE') || c.includes('IMAGESET')) return 'image';
  if (c.includes('FONT')) return 'font';
  if (c.includes('MEDIA')) return 'media';
  if (c.includes('WEBSOCKET')) return 'ws-handshake';
  if (c.includes('BEACON')) return 'beacon';
  return c.replace(/^TYPE_/, '').toLowerCase() || 'other';
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
