// Pure bounded linear redaction for URLs, headers, free text, and bodies.
// Zero protocol/DOM/Electron dependencies so pure perception (`render.mjs`),
// DevTools recorders, and Camoufox/Electron drivers can share one source.

const REDACT_LIMITS = Object.freeze({
  storedURL: 2000,
  header: 256,
  headerBytes: 2048,
  jsonParse: 1024 * 1024,
});

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
const REDACTED = '[redacted]';
const ALREADY_REDACTED = new Set([REDACTED, encodeURIComponent(REDACTED), `"${REDACTED}"`, `'${REDACTED}'`]);
const RELATIVE = 'http://relative.invalid';

export const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max})`;
};

// Redacts at most 2×max characters of page text, then clips to max.
export function redactClip(value, max, redact = redactText) {
  const text = String(value ?? '');
  const out = redact(text.length > max * 2 ? text.slice(0, max * 2) : text);
  return out.length <= max && text.length <= max * 2 ? out : `${out.slice(0, max)}…(+${Math.max(1, text.length - max)})`;
}

const secretValue = value => JWT_SHAPE.test(value) || /^(?:Bearer|Basic|Digest|Negotiate)\s/i.test(value);

// Query or fragment parameters: sensitive names and token-shaped values.
function redactParams(params) {
  let changed = false;
  for (const [key, value] of [...params]) {
    if (value !== REDACTED && (SENSITIVE_FIELD.test(key) || secretValue(value))) {
      params.set(key, REDACTED);
      changed = true;
    }
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
  let budget = REDACT_LIMITS.headerBytes, omitted = 0;
  for (const [name, raw] of Object.entries(headers)) {
    const value = SENSITIVE_HEADER.test(name) ? REDACTED
      : URL_HEADER.test(name) ? clip(redactURL(String(raw).slice(0, REDACT_LIMITS.storedURL), true), REDACT_LIMITS.header)
        : /^refresh$/i.test(name) ? redactClip(raw, REDACT_LIMITS.header, text => text.replace(/(url\s{0,8}=\s{0,8}['"]?)([^'"\s]{1,2048})/i,
          (_match, prefix, url) => `${prefix}${redactURL(url, true)}`))
          : redactClip(raw, REDACT_LIMITS.header);
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
  const trimmed = value.length <= REDACT_LIMITS.jsonParse ? value.trim() : '';
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
