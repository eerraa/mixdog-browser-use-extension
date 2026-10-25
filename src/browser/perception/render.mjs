// Agent-facing text projection of the page model (decision D13): snapshot,
// diff, find, text and the result status line. Grammar: docs/agents/contracts.md.
import { subtree } from './model.mjs';
import { redactURL } from '../devtools.mjs';

export const BUDGETS = Object.freeze({ default: 6000, full: 30000, scope: 12000, text: 12000 });
const TEXT_CHARS = { default: { root: 1500, frame: 200, line: 100 }, full: { root: 12000, frame: 2000, line: 200 } };
const NAME_CHARS = { default: 80, full: 120 };
const VALUE_CHARS = 60;
const LIVE_CHARS = 160;
const DIFF_LINES = 60;
const REFERABLE = new Set(['i', 'c', 'f', 'l', 'm']);

/** Token estimate: ASCII chars / 3.7 + 1.1 per non-ASCII char. */
export function estimateTokens(text) {
  let ascii = 0, other = 0;
  for (const char of text) (char.charCodeAt(0) < 128 ? ascii++ : other++);
  return Math.round(ascii / 3.7 + other * 1.1);
}
// Page text is always a JSON string literal. Line and paragraph separators,
// NEL and bidi controls are escaped too, so page text can never start a new
// line or visually reorder a line of the result.
const UNSAFE = /[\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export const quote = value => JSON.stringify(String(value ?? ''))
  .replace(UNSAFE, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const host = url => { try { return new URL(url).host; } catch { return ''; } };
const withoutHash = url => url.split('#', 1)[0];
// Roles and states are walker vocabulary; anything else prints as generic.
const safeRole = role => (/^[a-z][a-z0-9-]{0,30}$/.test(role) ? role : 'generic');
const safeState = state => /^[a-z][a-z0-9=_-]{0,30}$/i.test(state);
/** URL for display: credentials, sensitive parameters and fragments redacted. */
export const displayURL = url => redactURL(String(url ?? ''));
// Same-document fragment links say nothing a name does not; same-origin links
// are shown as a path.
function shortHref(href, page, max) {
  if (!href || /^javascript:/i.test(href) || withoutHash(href) === withoutHash(page ?? '')) return '';
  try {
    const url = new URL(displayURL(href));
    const path = url.pathname + url.search;
    return clip(url.origin === new URL(page).origin ? path : url.host + path, max);
  } catch { return ''; }
}

/** One line without indentation or ref. */
export function formatItem(item, { mode = 'default', model, showHref = false } = {}) {
  const full = mode === 'full';
  const name = item.name ? ` ${quote(clip(item.name, NAME_CHARS[full ? 'full' : 'default']))}` : '';
  if (item.kind === 't') return `text ${quote(clip(item.name, TEXT_CHARS[full ? 'full' : 'default'].line))}`;
  if (item.kind === 'h') return `h${item.level ?? 2}${name}`;
  if (item.kind === 'f') {
    const frame = item.childFrameId && model?.frames.get(item.childFrameId);
    const where = host(frame?.url ?? '');
    return `iframe${name}${where ? ` ${where}` : ''}${item.frameStatus === 'unavailable' ? ' unavailable' : ''}${item.covered ? ' covered' : ''}`;
  }
  const states = item.states.filter(safeState);
  if (item.sensitive) states.push('sensitive');
  if (full && item.covered && !states.includes('covered')) states.push('covered');
  if (full && !item.inView && item.kind !== 'l') states.push('offscreen');
  const max = item.kind === 'l' ? LIVE_CHARS : VALUE_CHARS;
  const value = item.value && !item.sensitive ? ` =${quote(clip(item.value, max))}` : '';
  const href = (showHref || full) && item.role === 'link' ? shortHref(item.href, model?.url, full ? 80 : 40) : '';
  return `${safeRole(item.role)}${name}${states.length ? ` ${states.join(' ')}` : ''}${value}${href ? ` ${href}` : ''}`;
}
// What a diff compares: the default-mode line without href, so a change in
// how a line was printed (mode, duplicate-name hrefs) is never a page change.
const canonical = (item, model) => formatItem(item, { mode: 'default', model });

// Which items a view prints. Default: what is on screen and uncovered, plus
// live regions and the focused control wherever they are.
function selection(model, { mode, scopeKey, depth }) {
  const items = scopeKey ? subtree(model, scopeKey) : model.items;
  const full = mode === 'full' || !!scopeKey;
  const limits = TEXT_CHARS[full ? 'full' : 'default'];
  const textLeft = new Map();
  const printed = new Set();
  for (const item of items) {
    let show;
    if (item.kind === 't') {
      const frameKey = item.frameId === model.rootId ? 'root' : 'frame';
      const left = textLeft.get(item.frameId) ?? limits[frameKey];
      show = (full || (item.inView && !item.covered)) && left > 0;
      if (show) textLeft.set(item.frameId, left - Math.min(item.name.length, limits.line));
    } else if (item.kind === 'l') show = true;
    else if (item.kind === 'i') show = full || (item.inView && !item.covered) || item.states.includes('focused');
    else if (item.kind === 'h') show = full || item.inView;
    else if (item.kind === 'm') show = full;
    else if (item.kind === 'f') show = item.frameStatus === 'unavailable' && (full || item.inView);
    else show = false;
    if (show) printed.add(item.key);
  }
  // Containers and iframes print when something inside them prints.
  const inSelection = new Set(items.map(item => item.key));
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (printed.has(item.key) && item.parentKey && inSelection.has(item.parentKey)) {
      const parent = model.byKey.get(item.parentKey);
      if (['c', 'f', 'l', 'i'].includes(parent.kind)) printed.add(parent.key);
    }
  }
  const indent = new Map();
  const rootKey = scopeKey ?? null;
  const indentOf = item => {
    if (indent.has(item.key)) return indent.get(item.key);
    let value = 0;
    const parent = item.key !== rootKey && item.parentKey && model.byKey.get(item.parentKey);
    if (parent) value = indentOf(parent) + (printed.has(parent.key) ? 1 : 0);
    indent.set(item.key, value);
    return value;
  };
  let deeper = 0;
  if (Number.isInteger(depth)) {
    for (const item of items) if (printed.has(item.key) && indentOf(item) > depth) { printed.delete(item.key); deeper++; }
  }
  return { items, printed, indentOf, deeper, full };
}
function summaries(model, items, printed, full) {
  const perFrame = new Map();
  const of = frameId => {
    if (!perFrame.has(frameId)) perFrame.set(frameId, { above: 0, below: 0, samples: [], covered: 0, outline: [] });
    return perFrame.get(frameId);
  };
  for (const item of items) {
    if (printed.has(item.key) || full) continue;
    const summary = of(item.frameId);
    const frame = model.frames.get(item.frameId);
    if (item.kind === 'i') {
      if (item.inView && item.covered) summary.covered++;
      else if (!item.inView) {
        if (frame?.clip && item.rect.b <= frame.clip.t) summary.above++; else summary.below++;
        if (summary.samples.length < 3 && item.name && item.role !== 'generic') summary.samples.push(`${item.role} ${quote(clip(item.name, 20))}`);
      }
    } else if (item.kind === 'h' && !item.inView && summary.outline.length < 8) {
      summary.outline.push(`h${item.level ?? 2} ${quote(clip(item.name, 30))}`);
    }
  }
  const lines = new Map();
  for (const [frameId, s] of perFrame) {
    const out = [];
    const off = s.above + s.below;
    if (off) {
      const where = [s.above && `${s.above} above`, s.below && `${s.below} below`].filter(Boolean).join(', ');
      out.push(`+${off} offscreen (${where})${s.samples.length ? `: ${s.samples.join(', ')}` : ''}`);
    }
    if (s.covered) out.push(`+${s.covered} covered`);
    if (s.outline.length) out.push(`outline: ${s.outline.join(' · ')}`);
    if (out.length) lines.set(frameId, out);
  }
  return lines;
}

/**
 * Snapshot body. refFor(item) issues the item's ref; it is called only for
 * lines that survive the budget. Returns the text and the agent view used as
 * the next diff base.
 */
export function renderSnapshot(model, { mode = 'default', scopeKey, depth, budget, refFor = () => null } = {}) {
  const { items, printed, indentOf, deeper, full } = selection(model, { mode, scopeKey, depth });
  const names = new Map();
  for (const item of items) if (printed.has(item.key) && item.role === 'link') names.set(item.name, (names.get(item.name) ?? 0) + 1);
  const rows = [];
  for (const item of items) {
    if (!printed.has(item.key)) continue;
    const content = formatItem(item, { mode: full ? 'full' : 'default', model,
      showHref: !item.name || names.get(item.name) > 1 });
    const sub = item.frameId !== model.rootId;
    rows.push({ item, content, indent: indentOf(item), prio: item.kind === 't' ? (sub ? 3 : 2) : (sub ? 1 : 0) });
  }
  // Summary lines go after the last row of their frame.
  const summary = summaries(model, items, printed, full);
  const out = [];
  const lastRow = new Map();
  rows.forEach((row, index) => lastRow.set(row.item.frameId, index));
  rows.forEach((row, index) => {
    out.push(row);
    for (const [frameId, last] of lastRow) {
      if (last === index && frameId !== model.rootId && summary.has(frameId)) {
        for (const text of summary.get(frameId)) out.push({ summary: true, content: text, indent: row.indent });
        summary.delete(frameId);
      }
    }
  });
  for (const [frameId, texts] of summary) {
    const indent = frameId === model.rootId ? 0 : 1;
    for (const text of texts) out.push({ summary: true, content: text, indent });
  }
  if (deeper) out.push({ summary: true, content: `+${deeper} deeper (raise depth or scope)`, indent: 0 });
  if (!scopeKey && model.hidden.length) {
    const hosts = [...new Set(model.hidden.map(frame => host(frame.url)).filter(Boolean))].slice(0, 5);
    out.push({ summary: true, content: `hidden frames ${model.hidden.length}${hosts.length ? `: ${hosts.join(', ')}` : ''}`, indent: 0 });
  }
  if (model.capped) out.push({ summary: true, content: 'partial page: element scan capped', indent: 0 });

  // Budget: drop the least important rows from the end, never a partial line.
  const limit = budget ?? BUDGETS[scopeKey ? 'scope' : full ? 'full' : 'default'];
  const cost = row => estimateTokens(`${' '.repeat(row.indent)}${row.summary || !REFERABLE.has(row.item.kind) ? '' : 'e1000 '}${row.content}\n`);
  const costs = out.map(cost);
  let total = costs.reduce((sum, value) => sum + value, 0);
  let dropped = 0;
  // Mark, then filter once: linear in the number of rows.
  const drop = new Uint8Array(out.length);
  for (let prio = 3; prio >= 0 && total > limit; prio--) {
    for (let index = out.length - 1; index >= 0 && total > limit; index--) {
      const row = out[index];
      if (drop[index] || row.summary || row.prio !== prio) continue;
      total -= costs[index];
      drop[index] = 1;
      dropped++;
    }
  }
  if (dropped) {
    const kept = out.filter((_row, index) => !drop[index]);
    out.length = 0;
    out.push(...kept, { summary: true, content: `+${dropped} more lines (over budget; use find or scope)`, indent: 0 });
  }

  const view = { known: new Set(model.items.map(item => item.key)), lines: new Map(), refs: new Map() };
  const text = out.map(row => {
    let ref = null;
    if (!row.summary) {
      if (REFERABLE.has(row.item.kind)) ref = refFor(row.item);
      view.lines.set(row.item.key, canonical(row.item, model));
      if (ref) view.refs.set(row.item.key, ref);
    }
    return `${' '.repeat(row.indent)}${ref ? `${ref} ` : ''}${row.content}`;
  }).join('\n');
  return { text, view, lines: out.length };
}

/** Header lines after the status line. */
export function renderHeader(model, { points = false } = {}) {
  return `page ${quote(model.title)} ${displayURL(model.url)}\nview ${model.viewport.w}x${model.viewport.h} scroll ${Math.round(model.scroll.y)}/${model.scroll.height}${points ? ' points' : ''}`;
}

/**
 * Changes since the agent's last view of this tab. Additions: everything a
 * default view prints now that the agent was not shown (new content, and
 * content that scrolled in, was uncovered, or was cut by a budget before;
 * live regions and text included). Changes and removals cover everything the
 * agent was shown. New items that would not print are counted as offscreen.
 * isGone(key, ref) tells a removed node from one that is only hidden now.
 */
export function renderDiff(model, base, { from, to, refFor = () => null, isGone = () => true } = {}) {
  const { printed } = selection(model, { mode: 'default' });
  const view = { known: new Set(model.items.map(item => item.key)), lines: new Map(base.lines), refs: new Map(base.refs) };
  const added = [], changed = [], removed = [], hidden = [];
  let offscreen = 0;
  const context = item => {
    for (let parent = item.parentKey && model.byKey.get(item.parentKey); parent; parent = parent.parentKey && model.byKey.get(parent.parentKey)) {
      if (REFERABLE.has(parent.kind)) {
        const ref = view.refs.get(parent.key) ?? refFor(parent);
        if (ref) { view.refs.set(parent.key, ref); return ` in ${ref}`; }
      }
    }
    return '';
  };
  for (const item of model.items) {
    const content = canonical(item, model);
    const shown = () => formatItem(item, { mode: 'default', model, showHref: !item.name });
    if (!base.lines.has(item.key)) {
      if (!printed.has(item.key)) {
        if (item.kind === 'i' && !base.known.has(item.key)) offscreen++;
        continue;
      }
      const ref = REFERABLE.has(item.kind) ? refFor(item) : null;
      if (ref) view.refs.set(item.key, ref);
      view.lines.set(item.key, content);
      added.push(`+ ${ref ? `${ref} ` : ''}${shown()}${context(item)}`);
    } else if (base.lines.has(item.key) && base.lines.get(item.key) !== content) {
      const ref = view.refs.get(item.key);
      view.lines.set(item.key, content);
      changed.push(`~ ${ref ? `${ref} ` : ''}${shown()}`);
    }
  }
  for (const [key] of base.lines) {
    if (model.byKey.has(key)) continue;
    const ref = base.refs.get(key);
    view.lines.delete(key);
    view.refs.delete(key);
    if (!ref) continue;
    (isGone(key, ref) ? removed : hidden).push(ref);
  }
  const counts = { added: added.length, changed: changed.length, removed: removed.length + hidden.length };
  if (!added.length && !changed.length && !removed.length && !hidden.length && !offscreen) {
    return { text: `no change since ${from}`, view, counts, large: false };
  }
  const lines = [...changed, ...added];
  if (removed.length) lines.push(`- ${removed.join(' ')}`);
  if (hidden.length) lines.push(`- ${hidden.join(' ')} (hidden)`);
  if (offscreen) lines.push(`+${offscreen} new offscreen`);
  const shown = lines.slice(0, DIFF_LINES);
  if (lines.length > shown.length) shown.push(`+${lines.length - shown.length} more changes (observe for the full view)`);
  return {
    text: `diff ${from}→${to} +${counts.added} ~${counts.changed} -${counts.removed}\n${shown.join('\n')}`,
    view, counts, large: lines.length > 0.6 * Math.max(1, printed.size),
  };
}

/**
 * Text/regex search over the full model (semantic matcher, match.mjs), with the
 * nearest referable ancestors as context. Sensitive values are never matched.
 */
export function renderFind(model, query, { match, refFor = () => null, limit = 20 } = {}) {
  const hits = [];
  model.items.forEach((item, index) => {
    if (item.kind === 'f' && !item.name) return;
    const fields = item.kind === 't' ? { name: item.name }
      : { name: item.name, value: item.sensitive ? '' : item.value, role: item.role, href: item.href };
    const result = match(query, fields);
    if (result) hits.push({ item, index, score: result.score, complete: result.matched === result.terms });
  });
  // Elements matching every term make partial (some-term) matches noise.
  if (hits.some(hit => hit.complete)) hits.splice(0, hits.length, ...hits.filter(hit => hit.complete));
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  const view = { lines: new Map(), refs: new Map() };
  const lines = hits.slice(0, limit).map(({ item }) => {
    const ancestry = [];
    for (let parent = item.parentKey && model.byKey.get(item.parentKey); parent && ancestry.length < 2;
      parent = parent.parentKey && model.byKey.get(parent.parentKey)) {
      if (!REFERABLE.has(parent.kind)) continue;
      const ref = refFor(parent);
      ancestry.push(`${ref ? `${ref} ` : ''}${parent.role}${parent.name ? ` ${quote(clip(parent.name, 30))}` : ''}`);
    }
    const content = formatItem(item, { mode: 'default', model, showHref: true });
    const ref = REFERABLE.has(item.kind) ? refFor(item) : null;
    if (ref) { view.refs.set(item.key, ref); view.lines.set(item.key, canonical(item, model)); }
    return `${ref ? `${ref} ` : ''}${content}${item.inView ? '' : ' offscreen'}${ancestry.length ? ` in ${ancestry.join(' in ')}` : ''}`;
  });
  return { text: `find ${quote(query)}: ${hits.length} match${hits.length === 1 ? '' : 'es'}${lines.length ? `\n${lines.join('\n')}` : ''}`, view, count: hits.length };
}

/** Readable text of every frame, in order (mode `text`); whole lines within the token budget. */
export function renderText(model, { limit = BUDGETS.text } = {}) {
  const parts = [];
  let frameId = model.rootId;
  for (const item of model.items) {
    if (item.frameId !== frameId) {
      frameId = item.frameId;
      parts.push(`iframe ${quote(host(model.frames.get(frameId)?.url ?? ''))}`);
    }
    // Every page string is a quoted literal after a fixed marker, so page
    // text can never forge a status, signal or ref line.
    if (item.kind === 't') parts.push(`text ${quote(item.name)}`);
    else if (item.kind === 'h') parts.push(`h${item.level ?? 2} ${quote(item.name)}`);
    else if (item.kind === 'l' && item.value) parts.push(`${safeRole(item.role)} =${quote(item.value)}`);
    else if (item.kind === 'i' && item.name) parts.push(`${safeRole(item.role)} ${quote(item.name)}`);
  }
  // Budgets are estimated tokens everywhere (estimateTokens); never a partial line.
  let total = 0, kept = 0;
  for (; kept < parts.length; kept++) {
    const cost = estimateTokens(`${parts[kept]}\n`);
    if (total + cost > limit) break;
    total += cost;
  }
  const out = parts.slice(0, kept);
  if (kept < parts.length) out.push(`+${parts.length - kept} more lines (over budget; use find or scope)`);
  return out.join('\n');
}

/** First line of every result: `<disposition> <action>[ <ref>] tab=<t> …`. */
export function statusLine(result) {
  const fields = [result.disposition, result.action];
  if (result.ref) fields.push(result.ref);
  if (result.tabId) fields.push(`tab=${result.tabId}`);
  if (result.snapshotId) fields.push(`snap=${result.snapshotId}`);
  if (result.code) fields.push(`code=${result.code}`);
  if (result.observed === false) fields.push('observed=false');
  if (result.cause) fields.push(`cause=${result.cause}`);
  if (result.requestedInputDispatched === false) fields.push('dispatched=false');
  if (result.preparation && result.preparation !== 'none') fields.push(`preparation=${result.preparation}`);
  if (result.replaySafe === false) fields.push('replaySafe=false');
  return fields.join(' ');
}
