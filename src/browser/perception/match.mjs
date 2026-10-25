// Derived from Mixdog 1.3.4 (commit 968ee08965e75c3fa1999ab8d18d20e45229fc89),
// apps/desktop/src/main/browser/semantic-query.ts, Apache License 2.0.
// Independent fork; Mixdog changes after that commit are not tracked
// (third_party/mixdog/provenance.json).
// Changed: only the element matcher is kept (the query parser and line filter
// are not used here); TypeScript types removed.

/**
 * How a `find` query ranks elements (render.mjs `renderFind`): whitespace
 * splits the query into keywords that match with OR, and an element matching
 * every keyword ranks above a partial match. The matcher also understands
 * `/pattern/` or `/pattern/i`; `find` itself admits words only (contract.mjs).
 */

/** Self-contained element matcher, instantiated below for the host. Keep it
 *  free of module references. */
const BROWSER_SEMANTIC_MATCH_SOURCE = `function(rawQuery, fields) {
  const compact = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const query = compact(rawQuery);
  if (!query) return { field: 'name', score: 0, matched: 0, terms: 0 };
  const role = compact(fields.role).toLowerCase();
  const rolePriority = ({
    link: 40, button: 35, menuitem: 30, menuitemcheckbox: 30, menuitemradio: 30,
    tab: 25, option: 20, checkbox: 15, radio: 15, switch: 15, combobox: 10,
    listbox: 10, searchbox: 10, textbox: 10,
  })[role] || 0;
  const hrefText = (value) => {
    const raw = compact(value);
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      return compact(parsed.hostname + decodeURIComponent(parsed.pathname));
    } catch {
      return compact(raw.split(/[?#]/, 1)[0]);
    }
  };
  const candidates = [
    ['name', compact(fields.name), 400],
    ['value', compact(fields.value), 300],
    ['role', compact(fields.role), 200],
    ['href', hrefText(fields.href), role === 'link' ? 330 : 100],
  ];
  const regexForm = /^\\/(.+)\\/([a-z]*)$/s.exec(query);
  let regex = null;
  let tokens = [];
  if (regexForm) {
    try { regex = new RegExp(regexForm[1], regexForm[2].includes('i') ? 'i' : ''); } catch { return null; }
  } else {
    tokens = query.toLowerCase().split(/\\s+/).filter(Boolean);
  }
  const terms = regex ? [regex] : tokens;
  let best = null;
  let total = 0;
  let matched = 0;
  for (const term of terms) {
    let termBest = null;
    for (const [field, value, base] of candidates) {
      const lowered = value.toLowerCase();
      const hit = regex ? regex.test(value) : lowered.includes(term);
      if (!hit) continue;
      const bonus = regex ? 0 : (lowered === term ? 20 : lowered.startsWith(term) ? 10 : 0);
      const score = base + rolePriority + bonus;
      if (!termBest || score > termBest.score) termBest = { field, score };
    }
    if (!termBest) continue;
    matched += 1;
    total += termBest.score;
    if (!best || termBest.score > best.score) best = termBest;
  }
  if (!best) return null;
  return {
    field: best.field,
    score: total + (matched === terms.length ? 1000 : 0),
    matched,
    terms: terms.length,
  };
}`;

/** `(query, { name, value, role, href }) => { field, score, matched, terms } | null`. */
export const rankBrowserSemanticMatch = new Function(
  `return (${BROWSER_SEMANTIC_MATCH_SOURCE})`
)();
