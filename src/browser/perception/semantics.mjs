// Derived from Mixdog 1.3.4 (commit 968ee08965e75c3fa1999ab8d18d20e45229fc89),
// apps/desktop/src/main/browser/snapshot-scripts.ts (the `compact`,
// `inferRole`, `accessibleName` and `stateList` helpers of its page snapshot),
// Apache License 2.0. Independent fork; Mixdog changes after that commit are
// not tracked (third_party/mixdog/provenance.json).
// Changed: only these helpers are kept, as page-script sources the walker
// composes (walker.mjs `walkerInstallSource`); the original snapshot expression
// is not used. The accessible name reads labels, aria-labelledby targets and
// element content through the walker's `renderedText` instead of
// `textContent`/`innerText`, and its final `textContent` fallback is removed,
// so CSS, script and unrendered text never become names.

/** Role, accessible-name and state helpers, as source text for the walker's
 *  isolated-world install script. `accessibleName` calls `renderedText`. */
export const ELEMENT_SEMANTICS = Object.freeze({
  compact: String.raw`const compact = (value, max) => String(value == null ? '' : value)
      .replace(/\s+/g, ' ').trim().slice(0, max);`,
  inferRole: String.raw`const inferRole = (el, tag) => {
      const explicit = compact(el.getAttribute('role'), 40).toLowerCase();
      if (explicit) return explicit;
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = compact(el.getAttribute('type') || 'text', 30).toLowerCase();
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return tag;
    };`,
  accessibleName: String.raw`const accessibleName = (el, tag) => {
      const doc = el.ownerDocument;
      const labelledBy = compact(el.getAttribute('aria-labelledby'), 200);
      if (labelledBy) {
        // Inside a shadow root the referenced ids belong to that root, not to
        // the document, so a web component's label resolves only from there.
        const scope = el.getRootNode ? el.getRootNode() : doc;
        const byId = (id) => (scope.getElementById ? scope.getElementById(id) : doc.getElementById(id));
        const named = labelledBy.split(/\s+/)
          .map((id) => renderedText(byId(id), true))
          .join(' ');
        if (compact(named, 120)) return compact(named, 120);
      }
      const labels = el.labels && el.labels.length
        ? Array.from(el.labels).map((label) => renderedText(label, false, el)).join(' ')
        : '';
      return compact(
        el.getAttribute('aria-label')
          || labels
          || (tag === 'input' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase()) ? el.value : '')
          || el.getAttribute('alt')
          || el.getAttribute('placeholder')
          || el.getAttribute('title')
          || renderedText(el)
          || '',
        120,
      );
    };`,
  stateList: String.raw`const stateList = (el, style) => {
      const states = [];
      // A pane that scrolls on its own is invisible in the tree otherwise, and
      // the agent would scroll the page while the list it wants stays put.
      const scrollsY = el.scrollHeight - el.clientHeight > 4
        && /(auto|scroll)/.test(String(style && style.overflowY || ''));
      const scrollsX = el.scrollWidth - el.clientWidth > 4
        && /(auto|scroll)/.test(String(style && style.overflowX || ''));
      if (scrollsY || scrollsX) {
        states.push('scrollable=' + (scrollsY ? 'y' : '') + (scrollsX ? 'x' : ''));
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
      // Rendered but outside the accessibility tree: assistive tech and many
      // widgets treat it as absent, which is why acting on it can do nothing.
      if (el.closest && el.closest('[aria-hidden="true"]')) states.push('aria-hidden');
      // Every input carries a checked property; only a checkable one means it.
      const inputType = (el.tagName || '').toLowerCase() === 'input' ? String(el.type || '').toLowerCase() : '';
      const checkable = inputType === 'checkbox' || inputType === 'radio' || el.hasAttribute('aria-checked');
      if (checkable && (el.checked === true || el.getAttribute('aria-checked') === 'true')) states.push('checked');
      if (checkable && (el.checked === false || el.getAttribute('aria-checked') === 'false')) states.push('unchecked');
      if (el.selected === true || el.getAttribute('aria-selected') === 'true') states.push('selected');
      if (el.getAttribute('aria-expanded')) {
        states.push('expanded=' + compact(el.getAttribute('aria-expanded'), 80));
      }
      if (el.getAttribute('aria-pressed')) {
        states.push('pressed=' + compact(el.getAttribute('aria-pressed'), 80));
      }
      if (el.required || el.getAttribute('aria-required') === 'true') states.push('required');
      if (el.readOnly || el.getAttribute('aria-readonly') === 'true') states.push('readonly');
      if (el.ownerDocument.activeElement === el) states.push('focused');
      if ((el.tagName || '').toLowerCase() === 'input' && String(el.type || '').toLowerCase() === 'file') {
        states.push('file-input');
        const accept = compact(el.getAttribute('accept'), 120);
        if (accept) states.push('accept=' + accept);
        if (el.multiple) states.push('multiple');
      }
      return states;
    };`,
});
