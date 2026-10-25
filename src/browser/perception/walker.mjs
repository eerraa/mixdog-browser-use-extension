// Page-side perception walker (decision D15). One synchronous evaluation per
// frame returns that frame's snapshot together with its checkpoint, so no
// cross-frame quiet requirement exists. The script runs only in this plugin's
// isolated world: page scripts cannot reach it, and sensitive values never
// leave it.
//
// Role, accessible-name and state logic comes from `semantics.mjs` (derived
// from Mixdog); `walkerInstallSource` composes it with this module's own
// traversal and `renderedText`.

const SEMANTICS = Object.freeze(['compact', 'inferRole', 'accessibleName', 'stateList']);
// Rendered text of an element: innerText when it is rendered (innerText of an
// unrendered element is its textContent). An aria-labelledby target may be
// hidden (ARIA names include it); then only its text nodes outside script,
// style, template and noscript count. A label that contains the control it
// names never names it with the control's own text (a select's options, a
// textarea's content): those text nodes are skipped, and so are unrendered
// ones of a rendered label.
const RENDERED_TEXT = `const renderedText = (node, hidden = false, exclude = null) => {
  if (!node || node.nodeType !== 1) return '';
  const shown = el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const visible = node.checkVisibility();
  const nested = !!exclude && exclude !== node && node.contains(exclude);
  if (visible && !nested) return node.innerText || '';
  if (!visible && !hidden) return '';
  let out = '';
  const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: text => {
    const parent = text.parentElement;
    if (!parent || parent.closest('script,style,template,noscript')) return 2;
    if (nested && exclude.contains(text)) return 2;
    return visible && !shown(parent) ? 2 : 1;
  } });
  for (let text = walker.nextNode(); text && out.length < 2000; text = walker.nextNode()) out += text.data + ' ';
  return out;
};`;

// Self-contained: serialized with toString(), so it must not close over
// anything in this module. `U` carries the composed role, name and state
// helpers (semantics.mjs) and `renderedText`.
function pageInstall(U) {
  if (globalThis.__independentState) return true;
  const { compact, inferRole, accessibleName, stateList, renderedText } = U;
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  const state = {
    documentId: Array.from(random, byte => byte.toString(16).padStart(2, '0')).join(''),
    revision: 0, lastSignificant: performance.now(),
  };
  globalThis.__independentState = state;

  const SIGNIFICANT_ATTRIBUTE = /^(?:aria-|role$|disabled$|hidden$|inert$|open$|value$|checked$|selected$|href$|src$)/;
  // Text-only and style/class churn (tickers, clocks, animations) keep the
  // revision moving but do not delay a settle; the diff still reports them.
  const significant = records => records.some(record => record.type === 'childList'
    ? [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1)
    : record.type === 'attributes' && SIGNIFICANT_ATTRIBUTE.test(record.attributeName));
  const changed = isSignificant => {
    state.revision++;
    if (isSignificant) state.lastSignificant = performance.now();
  };
  const observing = { subtree: true, childList: true, attributes: true, characterData: true };
  const roots = new WeakSet();
  const observe = root => {
    if (roots.has(root)) return;
    roots.add(root);
    new MutationObserver(records => changed(significant(records))).observe(root, observing);
  };
  observe(document);
  for (const event of ['input', 'change']) addEventListener(event, () => changed(true), true);
  for (const event of ['scroll', 'resize']) addEventListener(event, () => changed(false), true);

  // Persistent identity: one local id per (element, role, name). A role or
  // name change gives the element a new id, so its old ref can never alias it.
  let nextId = 1;
  const records = new WeakMap();
  const byId = new Map();
  let renamed = [];
  const identify = (el, role, name) => {
    const record = records.get(el);
    if (record && record.role === role && record.name === name) return record.id;
    const id = nextId++;
    if (record) { renamed.push([record.id, id]); byId.delete(record.id); }
    records.set(el, { id, role, name });
    byId.set(id, new WeakRef(el));
    return id;
  };
  state.resolve = id => {
    const el = byId.get(id)?.deref();
    return el && el.isConnected ? el : null;
  };
  state.idOf = el => records.get(el)?.id ?? 0;

  const ARIA = new Set(['alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'cell', 'checkbox',
    'columnheader', 'combobox', 'complementary', 'contentinfo', 'dialog', 'document', 'feed', 'figure', 'form', 'grid',
    'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math',
    'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'note', 'option',
    'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox',
    'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
    'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem', 'iframe']);
  const CONTROLS = new Set(['button', 'link', 'tab', 'checkbox', 'radio', 'combobox', 'listbox', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'textbox', 'treeitem', 'gridcell']);
  const CONTAINERS = new Set(['dialog', 'alertdialog', 'form', 'navigation', 'main', 'search', 'region', 'tablist', 'menu',
    'menubar', 'radiogroup', 'grid', 'table', 'tree', 'treegrid', 'toolbar']);
  const LIVE = new Set(['alert', 'status', 'log', 'marquee']);
  const IMPLICIT = { nav: 'navigation', main: 'main', form: 'form', dialog: 'dialog', table: 'table', search: 'search',
    section: 'region', img: 'img', iframe: 'iframe', frame: 'iframe', option: 'option', output: 'status' };
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base']);
  // Matched against name, id, aria-label, placeholder and label text.
  const SECRET = new RegExp(['pass', 'pwd', '^pw$', 'secret', 'token', 'otp', 'one.?time', 'cvv', 'cvc', '\\bcsc\\b', 'security.?code',
    'card.?(?:num|no)', 'cc.?num', 'ssn', '^pin(?:code)?$', 'auth.?(?:num|code)', 'sms.?code', 'verif(?:y|ication).?code', '^code$',
    '인증\\s*번호', '보안\\s*코드', '주민\\s*(?:등록\\s*)?번호', '비밀\\s*번호', '암호', '승인\\s*번호'].join('|'), 'i');
  const AUTOCOMPLETE_SECRET = /one-time-code|cc-|current-password|new-password/i;
  const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color']);
  // Sticky per document: once sensitive (or typed by the person during a
  // handoff), an element stays sensitive, e.g. after a show-password toggle.
  const sticky = new WeakSet();
  const labelText = el => { try { return Array.from(el.labels || [], label => label.innerText || '').join(' '); } catch { return ''; } };
  const otpShaped = el => {
    const max = el.maxLength;
    if (String(el.inputMode || el.getAttribute('inputmode') || '').toLowerCase() === 'numeric' && max > 0 && max <= 8) return true;
    return max === 1 && !!el.parentElement && el.parentElement.querySelectorAll('input[maxlength="1"]').length >= 4;
  };
  const sensitiveRule = (el, tag, style) => {
    const editable = el.isContentEditable;
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !editable) return false;
    const type = String(el.type || '').toLowerCase();
    if (tag === 'input' && NOT_TEXT.has(type)) return false;
    if (type === 'password' || AUTOCOMPLETE_SECRET.test(el.getAttribute('autocomplete') || '')) return true;
    for (const text of [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelText(el)]) {
      if (text && SECRET.test(String(text).trim())) return true;
    }
    if (tag === 'input' && otpShaped(el)) return true;
    return (style?.getPropertyValue('-webkit-text-security') || 'none') !== 'none';
  };
  const isSensitive = (el, tag, style) => {
    if (sticky.has(el)) return true;
    if (!sensitiveRule(el, tag, style)) return false;
    sticky.add(el);
    return true;
  };
  state.sensitive = el => {
    if (!el || el.nodeType !== 1) return false;
    let style = null;
    try { style = getComputedStyle(el); } catch { /* detached */ }
    return isSensitive(el, el.localName, style);
  };
  // Elements that received trusted input; at return the host marks those typed
  // since the handoff began as sensitive (state.privatize), in this document
  // and in documents loaded during the handoff.
  // One entry per element, its latest trusted input time; never truncated, so
  // a flood of input elsewhere cannot push a typed field out.
  const typedAt = new WeakMap();
  let typed = [];
  addEventListener('input', event => {
    if (!event.isTrusted) return;
    const el = event.composedPath()[0];
    if (el?.nodeType !== 1) return;
    const entry = typedAt.get(el);
    if (entry) { entry.at = Date.now(); return; }
    const fresh = { ref: new WeakRef(el), at: Date.now() };
    typedAt.set(el, fresh);
    typed.push(fresh);
    if (typed.length > 1000 && typed.length % 1000 === 0) typed = typed.filter(item => item.ref.deref());
  }, true);
  state.privatize = since => {
    let marked = 0;
    for (const { ref, at } of typed) {
      const el = ref.deref();
      if (el && at >= since) { sticky.add(el); marked++; }
    }
    return marked;
  };
  // A non-empty sensitive field anywhere in this document (open shadow roots
  // included); page-code evaluations are refused while one exists.
  state.sensitivePresent = () => {
    const roots = [document];
    let count = 0;
    while (roots.length) {
      const walker = document.createTreeWalker(roots.pop(), NodeFilter.SHOW_ELEMENT);
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        if (++count > 100000) return true;
        if (el.shadowRoot) roots.push(el.shadowRoot);
        const tag = el.localName;
        const editable = el.isContentEditable && !el.parentElement?.isContentEditable;
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !editable) continue;
        if (!state.sensitive(el)) continue;
        if (editable ? (el.innerText || '').trim() : el.value) return true;
      }
    }
    return false;
  };
  // Trusted pointer and key input outside an agent dispatch reaches the host
  // through a binding that exists only in this world (escape-path guard).
  for (const type of ['pointerdown', 'keydown']) {
    addEventListener(type, event => {
      if (!event.isTrusted) return;
      try { globalThis.__wbTrustedInput?.(type); } catch { /* binding absent */ }
    }, true);
  }

  const labelledName = el => {
    const labelledBy = compact(el.getAttribute('aria-labelledby'), 200);
    if (!labelledBy) return '';
    const scope = el.getRootNode();
    return compact(labelledBy.split(/\s+/).map(id => renderedText(scope.getElementById ? scope.getElementById(id) : document.getElementById(id), true)).join(' '), 120);
  };
  const authorName = el => labelledName(el) || compact(el.getAttribute('aria-label') || el.getAttribute('title') || '', 120);
  const roleOf = (el, tag) => {
    let role = inferRole(el, tag);
    if (!ARIA.has(role)) role = IMPLICIT[role] || role;
    if (role === 'region' && !authorName(el)) role = tag;
    return role;
  };
  const NO_VALUE = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden']);
  const valueOf = (el, tag, role) => {
    if (tag === 'input' && !NO_VALUE.has(String(el.type || '').toLowerCase())) return compact(el.value, 100);
    if (tag === 'textarea') return compact(el.value, 100);
    if (tag === 'select') return compact(Array.from(el.selectedOptions || []).map(o => o.label || o.text).join(', '), 100);
    if (el.isContentEditable && role === 'textbox') return compact(el.innerText, 100);
    if (role === 'slider' || role === 'spinbutton' || role === 'progressbar') return compact(el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow'), 40);
    return '';
  };
  // A control whose computed name is empty (an image-only link or button) is
  // named by the text alternatives of its rendered embedded content in tree
  // order, each taken as accessible-name computation takes it
  // (aria-labelledby, aria-label, an img's alt, an svg's own title, title); a
  // descendant that supplies one is not entered. Nested controls, form fields
  // and editable content keep their own names and values, so a wrapper never
  // takes a nested control's name; aria-hidden, display:none,
  // visibility:hidden and opacity:0 descendants supply nothing.
  const NESTED_CONTROL_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
  const svgTitle = el => compact(renderedText(el.querySelector(':scope > title'), true), 120);
  const alternativeOf = (node, tag) => labelledName(node) || compact(node.getAttribute('aria-label'), 120)
    || (tag === 'img' ? compact(node.getAttribute('alt'), 120) : '') || (tag === 'svg' ? svgTitle(node) : '')
    || compact(node.getAttribute('title'), 120);
  const renderedChildren = node => {
    if (node.shadowRoot) return Array.from(node.shadowRoot.children);
    const assigned = node.localName === 'slot' ? node.assignedNodes({ flatten: true }) : [];
    return assigned.length ? assigned.filter(child => child.nodeType === 1) : Array.from(node.children);
  };
  const embeddedName = (el, tag) => {
    if (tag === 'svg') return svgTitle(el);
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) return '';
    const parts = [];
    const stack = renderedChildren(el).slice(0, 100).reverse();
    for (let visited = 0; stack.length && visited < 100 && parts.length < 8; visited++) {
      const node = stack.pop();
      const childTag = node.localName;
      if (node.getAttribute('aria-hidden') === 'true' || NESTED_CONTROL_TAGS.has(childTag) || CONTROLS.has(roleOf(node, childTag))) continue;
      if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && getComputedStyle(node).display !== 'contents') continue;
      const alternative = alternativeOf(node, childTag);
      if (alternative) parts.push(alternative);
      else if (childTag !== 'svg') stack.push(...renderedChildren(node).slice(0, 100).reverse());
    }
    return compact(parts.join(' '), 120);
  };
  const NAMED_BY_CONTENT = new Set(['interactive', 'heading', 'img']);
  const nameOf = (el, tag, purpose) => NAMED_BY_CONTENT.has(purpose)
    ? accessibleName(el, tag) || (purpose === 'interactive' ? embeddedName(el, tag) : '')
    : purpose === 'frame' ? compact(el.getAttribute('title') || el.getAttribute('name') || '', 120) : authorName(el);
  const deepActive = () => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  const composedContains = (ancestor, node) => {
    for (let current = node; current; current = current.parentNode || current.host) if (current === ancestor) return true;
    return false;
  };
  const deepHit = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const nested = hit.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === hit) break;
      hit = nested;
    }
    return hit;
  };
  const MAP_STATE = { 'expanded=true': 'expanded', 'expanded=false': 'collapsed', 'pressed=true': 'pressed', 'pressed=mixed': 'pressed',
    'file-input': 'file', 'scrollable=y': 'scrollable=y', 'scrollable=x': 'scrollable=x', 'scrollable=yx': 'scrollable=yx' };
  const statesOf = (el, style, active) => {
    const states = [];
    for (const raw of stateList(el, style)) {
      if (raw === 'pressed=false' || raw.startsWith('accept=') || raw.startsWith('expanded=undefined')) continue;
      states.push(MAP_STATE[raw] || raw.replace(/^(expanded|pressed)=.*/, '$1'));
    }
    if (el === active && !states.includes('focused')) states.push('focused');
    if (el.getAttribute('aria-invalid') === 'true') states.push('invalid');
    return states;
  };
  const kindOf = (el, tag, role, style, parentStyle, inInteractive) => {
    const tabindex = el.hasAttribute('tabindex') ? Number(el.getAttribute('tabindex')) : Number.NaN;
    const semantic = CONTROLS.has(role) || ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag) && role !== tag;
    if (semantic || el.isContentEditable && !el.parentElement?.isContentEditable) return 'interactive';
    if (inInteractive || tag === 'html' || tag === 'body' || (tag === 'label' && el.control)) return null;
    // cursor:pointer is inherited; only its outermost element is a target.
    if ((Number.isFinite(tabindex) && tabindex >= 0) || el.hasAttribute('onclick')
      || (style.cursor === 'pointer' && parentStyle?.cursor !== 'pointer')) return 'clickable';
    return null;
  };
  const INLINE = /^(?:inline|inline-block|inline-flex|inline-grid|contents|ruby)$/;
  // Custom checkboxes, radios and file pickers hide the input (opacity 0, a
  // tiny box, display:none) behind a styled label. The input is still the
  // control: it is emitted with its label's box, and pointer input aims at
  // the label, which activates it.
  const PROXIED = new Set(['checkbox', 'radio', 'file']);
  const solid = node => {
    if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const rect = node.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  };
  const labelProxy = el => {
    if (el.localName !== 'input' || !PROXIED.has(String(el.type || '').toLowerCase()) || solid(el)) return null;
    try { return Array.from(el.labels || []).find(solid) || null; } catch { return null; }
  };
  state.actionTarget = id => {
    const el = state.resolve(id);
    return el ? labelProxy(el) || el : null;
  };
  // Is the element (or its label proxy) inside this document's viewport now?
  state.inView = id => {
    const el = state.resolve(id);
    const target = el && (labelProxy(el) || el);
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { inView: rect.width >= 1 && rect.height >= 1 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
      proxied: target !== el };
  };

  state.snapshot = (options = {}) => {
    const maxScan = options.maxScan || 12000;
    const checkpoint = { documentId: state.documentId, revision: state.revision, w: innerWidth, h: innerHeight,
      x: scrollX, y: scrollY, dpr: devicePixelRatio };
    const vw = innerWidth, vh = innerHeight;
    const active = deepActive();
    const nodes = [], elements = [], texts = [];
    renamed = [];
    let scanned = 0, capped = false;
    const inViewport = b => b[2] >= 1 && b[3] >= 1 && b[0] + b[2] > 0 && b[1] + b[3] > 0 && b[0] < vw && b[1] < vh;
    const box = rect => [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
    // One order counter for nodes and text runs keeps document order between them.
    let order = 0;
    const emit = (el, node) => { node.o = order++; nodes.push(node); elements.push(el); return node; };

    // ctx: p (emitted ancestor id), absorb (text belongs to an emitted name),
    // interactive (inside a control), live, fixed, block (current text run).
    // enter() handles an element before its children and returns either a
    // finished summary or a frame to descend into; exit() finishes a frame.
    // The walk is iterative, so DOM depth cannot overflow the stack.
    const enter = (el, ctx, parentStyle) => {
      if (scanned >= maxScan) { capped = true; return null; }
      scanned++;
      const tag = el.localName;
      if (SKIP.has(tag)) return null;
      let style;
      try { style = getComputedStyle(el); } catch { return null; }
      const proxy = tag === 'input' && !ctx.interactive ? labelProxy(el) : null;
      if (style.display === 'none' && !proxy) return null;
      if (el.shadowRoot) observe(el.shadowRoot);
      const rect = (proxy || el).getBoundingClientRect();
      const b = box(rect);
      const contents = style.display === 'contents';
      const visible = contents ? ctx.visible : el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      const rendered = !!proxy || (!contents && visible && b[2] >= 1 && b[3] >= 1);
      const role = roleOf(el, tag);
      const summary = { controls: 0 };
      let node = null;
      if (rendered) {
        const kind = tag === 'iframe' || tag === 'frame' ? 'frame'
          : kindOf(el, tag, role, style, parentStyle, !!ctx.interactive);
        if (kind === 'frame') {
          const left = rect.left + el.clientLeft + parseFloat(style.paddingLeft);
          const top = rect.top + el.clientTop + parseFloat(style.paddingTop);
          const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          const height = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
          const name = nameOf(el, tag, 'frame');
          node = emit(el, { id: identify(el, 'iframe', name), p: ctx.p, k: 'f', r: 'iframe', n: name,
            b: [left, top, width, height].map(Math.round), vp: inViewport(b) });
        } else if (kind) {
          const sensitive = isSensitive(el, tag, style);
          const name = nameOf(el, tag, 'interactive');
          const finalRole = ARIA.has(role) ? role : 'generic';
          const states = statesOf(el, style, active);
          if (finalRole === 'generic') states.push('clickable');
          node = emit(el, { id: identify(el, finalRole, name), p: ctx.p, k: 'i', r: finalRole, n: name,
            v: sensitive ? '' : valueOf(el, tag, finalRole), s: states, x: sensitive || undefined,
            h: tag === 'a' && el.hasAttribute('href') ? compact(el.href, 300) : undefined, b, vp: inViewport(b),
            generic: finalRole === 'generic' || undefined });
        } else if (!ctx.interactive && role === 'heading') {
          const name = nameOf(el, tag, 'heading');
          const level = /^h[1-6]$/.test(tag) ? Number(tag[1]) : Number(el.getAttribute('aria-level')) || 2;
          if (name) node = emit(el, { id: identify(el, 'heading', name), p: ctx.p, k: 'h', r: 'heading', n: name, lv: level, b, vp: inViewport(b) });
        } else if (!ctx.interactive && !ctx.live && (LIVE.has(role)
          || ['polite', 'assertive'].includes(el.getAttribute('aria-live')))) {
          const liveRole = LIVE.has(role) ? role : 'live';
          const name = nameOf(el, tag, 'live');
          node = emit(el, { id: identify(el, liveRole, name), p: ctx.p, k: 'l', r: liveRole, n: name,
            v: compact(state.maskedText(el).text, 200), b, vp: inViewport(b) });
        } else if (!ctx.interactive && CONTAINERS.has(role)) {
          const name = nameOf(el, tag, 'container');
          node = emit(el, { id: identify(el, role, name), p: ctx.p, k: 'c', r: role, n: name, s: statesOf(el, style, active)
            .filter(s => s.startsWith('scrollable')), b, vp: inViewport(b) });
        } else if (!ctx.interactive && !ctx.live && !ctx.fixed && style.position === 'fixed') {
          // Toast-like candidate; confirmed or dropped once its subtree is known.
          node = emit(el, { id: identify(el, 'toast', ''), p: ctx.p, k: 'toast', r: 'toast', n: '', b, vp: inViewport(b) });
        } else if (!ctx.interactive && role === 'img') {
          const name = nameOf(el, tag, 'img');
          if (name) node = emit(el, { id: identify(el, 'img', name), p: ctx.p, k: 'm', r: 'img', n: name, b, vp: inViewport(b) });
        }
      }
      if (node?.k === 'i') summary.controls++;
      // Frame documents are walked in their own world; SVG internals are art.
      if (['iframe', 'frame', 'svg'].includes(tag)) return { summary };
      const child = {
        p: node ? node.id : ctx.p,
        // A generic clickable may be dropped as a wrapper, so its text is kept
        // until then; a kept one drops the text its name already carries.
        // A control's label text is that control's name.
        absorb: ctx.absorb || (tag === 'label' && !!el.control)
          || !!node && (['h', 'l', 'm'].includes(node.k) || (node.k === 'i' && !node.generic)),
        interactive: ctx.interactive || node?.k === 'i',
        live: ctx.live || node?.k === 'l',
        fixed: ctx.fixed || style.position === 'fixed',
        visible,
        block: INLINE.test(style.display) ? ctx.block : null,
      };
      const run = child.absorb ? null : child.block || { parts: [], el, b, o: order++ };
      child.block = run;
      // Visually hidden (sr-only) text is not on screen.
      const tiny = b[2] <= 1 && b[3] <= 1;
      const children = el.shadowRoot ? el.shadowRoot.childNodes
        : tag === 'slot' && el.assignedNodes({ flatten: true }).length ? el.assignedNodes({ flatten: true }) : el.childNodes;
      return { el, b, node, child, run, style, summary, children: Array.from(children), index: 0, textual: !!run && visible && !tiny };
    };
    const exit = frame => {
      const { el, b, node, child, run, summary } = frame;
      if (run && run.el === el) {
        const t = compact(run.parts.join(''), 200);
        if (t) texts.push({ p: child.p, t, b: run.b, vp: inViewport(run.b), o: run.o });
      }
      if (node?.k === 'toast') {
        const t = compact(state.maskedText(el).text, 300);
        const area = b[2] * b[3];
        if (t && summary.controls <= 2 && area < 0.4 * vw * vh) {
          node.k = 'l';
          node.v = compact(t, 200);
        } else node.drop = true;
      }
      // Wrapper removal: a generic clickable without a name, or one that wraps
      // real controls, is not a separate target; its controls are.
      if (node?.generic && (!node.n || summary.controls > 1)) node.drop = true;
      return summary;
    };
    const root = document.documentElement;
    const first = root && enter(root, { p: 0, absorb: false, interactive: false, live: false, fixed: false, visible: true, block: null }, null);
    const stack = first?.children ? [first] : [];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.children.length) {
        stack.pop();
        const summary = exit(frame);
        if (stack.length) stack[stack.length - 1].summary.controls += summary.controls;
        continue;
      }
      const childNode = frame.children[frame.index++];
      if (childNode.nodeType === 3) {
        if (frame.textual) {
          const data = childNode.data.replace(/\s+/g, ' ');
          if (data.trim()) frame.run.parts.push(data);
        }
      } else if (childNode.nodeType === 1) {
        const entered = enter(childNode, frame.child, frame.style);
        if (entered?.children) stack.push(entered);
        else if (entered) frame.summary.controls += entered.summary.controls;
      }
    }

    // Drop wrappers and unconfirmed candidates; re-home their children.
    const alias = new Map();
    const carriesText = new Set();
    const resolveParent = p => { while (alias.has(p)) p = alias.get(p); return p; };
    const kept = [], keptElements = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.drop) { alias.set(node.id, node.p); continue; }
      if (node.r === 'toast' || node.generic) carriesText.add(node.id);
      node.p = resolveParent(node.p);
      delete node.generic;
      kept.push(node);
      keptElements.push(elements[i]);
    }
    // Text directly inside a toast or a kept generic clickable is already its value or name.
    const keptTexts = texts.filter(text => !carriesText.has(text.p));
    for (const text of keptTexts) text.p = resolveParent(text.p);
    // Occlusion: does a hit test at the center or a quarter point reach it?
    for (let i = 0; i < kept.length; i++) {
      const node = kept[i];
      if (!['i', 'f'].includes(node.k) || !node.vp) continue;
      const el = keptElements[i];
      const [x, y, w, h] = node.b;
      let reached = false;
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75]]) {
        const hit = deepHit(Math.min(vw - 1, Math.max(0, x + w * fx)), Math.min(vh - 1, Math.max(0, y + h * fy)));
        if (hit && (composedContains(el, hit) || hit.closest?.('label')?.control === el)) { reached = true; break; }
      }
      if (!reached) node.c = 1;
    }
    const gone = [];
    for (const [id, ref] of byId) {
      const el = ref.deref();
      if (el && el.isConnected) continue;
      gone.push(id);
      byId.delete(id);
      // A reinserted element gets a new id (and so a new ref).
      if (el) records.delete(el);
    }
    return {
      checkpoint, url: String(location.href), title: compact(document.title, 150),
      scrollHeight: Math.round(document.documentElement?.scrollHeight || 0),
      nodes: kept, texts: keptTexts, gone, renamed, scanned, capped,
    };
  };

  // Current role and name of a live element, computed exactly as the walk does.
  state.describe = id => {
    const el = state.resolve(id);
    if (!el) return null;
    const tag = el.localName;
    const style = getComputedStyle(el);
    if (tag === 'iframe' || tag === 'frame') return { role: 'iframe', name: nameOf(el, tag, 'frame') };
    const role = roleOf(el, tag);
    const kind = kindOf(el, tag, role, style, el.parentElement ? getComputedStyle(el.parentElement) : null, false);
    if (kind) return { role: ARIA.has(role) ? role : 'generic', name: nameOf(el, tag, 'interactive') };
    if (role === 'heading') return { role, name: nameOf(el, tag, 'heading') };
    if (LIVE.has(role) || ['polite', 'assertive'].includes(el.getAttribute('aria-live'))) {
      return { role: LIVE.has(role) ? role : 'live', name: nameOf(el, tag, 'live') };
    }
    if (CONTAINERS.has(role)) return { role, name: nameOf(el, tag, 'container') };
    if (style.position === 'fixed') return { role: 'toast', name: '' };
    return { role, name: nameOf(el, tag, 'img') };
  };
  // Exposes one validated element to the ref-point expression (target-point.mjs).
  state.target = id => {
    const el = state.actionTarget(id);
    window.__independentTargetSnapshot = el ? { id: 'independent-target', refs: new Map([['t', { element: el, frames: [] }]]) } : undefined;
    return !!el;
  };
  // One-shot capture guard around a dispatch: did the trusted pointerdown,
  // keydown or beforeinput land on the validated element? A keydown or
  // beforeinput elsewhere is cancelled in the same turn, so no key or text
  // acts on another element. id 0 arms a frame that holds no target: any
  // such event there is stray.
  let guard = null;
  state.disarmGuard = () => {
    const current = guard;
    guard = null;
    current?.remove();
    return current ? { fired: current.record.fired, inside: current.record.inside } : null;
  };
  state.armGuard = (id, type) => {
    state.disarmGuard();
    const el = id ? state.resolve(id) : null;
    if ((id && !el) || !['pointerdown', 'keydown', 'beforeinput'].includes(type)) return false;
    const record = { fired: false, inside: false };
    const listener = event => {
      if (!event.isTrusted) return;
      if (!record.fired) {
        record.fired = true;
        const hit = event.composedPath()[0];
        record.inside = !!el && (hit === el || (hit?.nodeType === 1 && (composedContains(el, hit) || hit.closest?.('label')?.control === el)));
      }
      if (!record.inside && type !== 'pointerdown') event.preventDefault();
    };
    addEventListener(type, listener, true);
    guard = { record, remove: () => removeEventListener(type, listener, true) };
    return true;
  };
  const label = el => {
    const tag = el.localName;
    const role = roleOf(el, tag);
    return { role: ARIA.has(role) ? role : 'generic', name: compact(nameOf(el, tag, 'interactive'), 60) };
  };
  // What covers a target, named by the walker (never textContent).
  state.coveringAt = id => {
    const el = state.actionTarget(id);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const hit = deepHit(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit && hit !== el && !composedContains(el, hit) ? label(hit) : null;
  };
  // The element at a viewport point with its effective opacity and
  // visibility; an iframe also reports its content box for the next hop.
  state.hitAt = (x, y) => {
    const hit = deepHit(x, y);
    if (!hit) return null;
    let opacity = 1;
    for (let node = hit; node; node = node.parentElement || node.getRootNode()?.host) {
      try { opacity *= Number(getComputedStyle(node).opacity); } catch { /* detached */ }
    }
    const tag = hit.localName;
    const out = { ...label(hit), opacity, visible: hit.checkVisibility({ opacityProperty: true, visibilityProperty: true }) };
    if (tag === 'iframe' || tag === 'frame') {
      const rect = hit.getBoundingClientRect(), style = getComputedStyle(hit);
      const left = rect.left + hit.clientLeft + parseFloat(style.paddingLeft);
      const top = rect.top + hit.clientTop + parseFloat(style.paddingTop);
      out.src = String(hit.src || '').slice(0, 300);
      out.frame = { id: identify(hit, 'iframe', nameOf(hit, tag, 'frame')), left, top,
        width: hit.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: hit.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) };
    }
    return out;
  };
  // Resolves once no significant mutation happened for `ms` (counted from the
  // call, so a reaction has time to start), or at `cap`.
  state.quiet = (ms, cap) => new Promise(resolve => {
    const start = performance.now();
    const tick = () => {
      const now = performance.now();
      const since = now - Math.max(start, state.lastSignificant);
      if (since >= ms) return resolve({ quiet: true, waited: Math.round(now - start) });
      if (now - start >= cap) return resolve({ quiet: false, waited: Math.round(now - start) });
      setTimeout(tick, Math.max(1, Math.min(ms - since, cap - (now - start))));
    };
    tick();
  });
  // Rendered text of `root` with the own text of every sensitive element in
  // its subtree (a contenteditable secret is part of innerText) replaced, so
  // neither a read nor a text match reveals or probes it. masked: whether
  // the subtree holds a sensitive element.
  state.maskedText = root => {
    let text = String(root?.innerText || '');
    let masked = false, count = 0;
    const roots = [root];
    while (roots.length) {
      const scope = roots.pop();
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      for (let el = scope.nodeType === 1 ? scope : walker.nextNode(); el; el = walker.nextNode()) {
        if (++count > 100000) return { text: '', masked: true };
        if (el.shadowRoot) roots.push(el.shadowRoot);
        const tag = el.localName;
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !el.isContentEditable) continue;
        if (!state.sensitive(el)) continue;
        masked = true;
        const secret = String(el.innerText || '');
        for (const part of new Set([secret, secret.trim()])) if (part) text = text.split(part).join('\u2022');
      }
    }
    return { text, masked };
  };
  state.textIncludes = text => !!document.body && state.maskedText(document.body).text.includes(text);
  return true;
}

/** Install script for one isolated world; compose with `ELEMENT_SEMANTICS` (semantics.mjs). */
export function walkerInstallSource(semantics) {
  for (const name of SEMANTICS) {
    if (typeof semantics?.[name] !== 'string' || !semantics[name]) throw new TypeError(`Missing ${name} source`);
  }
  return `(() => {
${RENDERED_TEXT}
${semantics.compact}
${semantics.inferRole}
${semantics.accessibleName}
${semantics.stateList}
return (${pageInstall.toString()})({ compact, inferRole, accessibleName, stateList, renderedText });
})()`;
}

// With a documentId, an expression answers `{ stale: 'document' }` (or null
// for resolve) when the frame now holds another document: local ids restart
// in every document, so an id is meaningful only with its document.
const call = (body, documentId, staleValue = "{ stale: 'document' }") => `(() => { const s = globalThis.__independentState;
  if (!s) return ${staleValue === 'null' ? 'null' : '{ missing: true }'};
  ${documentId === undefined ? '' : `if (s.documentId !== ${JSON.stringify(String(documentId))}) return ${staleValue};`}
  ${body} })()`;
export const snapshotExpression = (options = {}) => call(`return s.snapshot(${JSON.stringify(options)});`);
export const describeExpression = (id, documentId) => call(`return { described: s.describe(${Number(id)}) };`, documentId);
export const resolveExpression = (id, documentId) => call(`return s.resolve(${Number(id)});`, documentId, 'null');
export const quietExpression = (ms, cap) => call(`return s.quiet(${Number(ms)}, ${Number(cap)});`);
export const textIncludesExpression = text => call(`return { found: s.textIncludes(${JSON.stringify(String(text))}) };`);
export const viewportExpression = () => call('return { documentId: s.documentId, w: innerWidth, h: innerHeight, x: scrollX, y: scrollY };');
export const privatizeExpression = since => call(`return { marked: s.privatize(${Number(since)}) };`);
export const sensitivePresentExpression = () => call('return { present: s.sensitivePresent() };');
export const armGuardExpression = (id, type, documentId) => call(`return { armed: s.armGuard(${Number(id)}, ${JSON.stringify(type)}) };`, documentId);
export const disarmGuardExpression = () => call('return { guard: s.disarmGuard() };');
export const inViewExpression = (id, documentId) => call(`return { view: s.inView(${Number(id)}) };`, documentId);
export const actionTargetExpression = (id, documentId) => call(`return s.actionTarget(${Number(id)});`, documentId, 'null');
export const coveringExpression = (id, documentId) => call(`return { covering: s.coveringAt(${Number(id)}) };`, documentId);
export const hitExpression = (x, y) => call(`return { hit: s.hitAt(${Number(x)}, ${Number(y)}) };`);
/** Runs `browserRefPointExpression('t')` (target-point.mjs) against one validated element. */
export const targetPointExpression = (id, refPointExpression, documentId) => call(
  `if (!s.target(${Number(id)})) return { error: 'stale' }; return ${refPointExpression};`, documentId, "{ error: 'stale' }");
