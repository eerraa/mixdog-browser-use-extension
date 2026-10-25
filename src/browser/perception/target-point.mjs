// Derived from Mixdog 1.3.4 (commit 968ee08965e75c3fa1999ab8d18d20e45229fc89),
// Apache License 2.0: `BROWSER_STABLE_RECT` from
// apps/desktop/src/main/browser/stable-rect.ts and `browserRefPointExpression`
// from apps/desktop/src/main/browser/snapshot-scripts.ts. Independent fork;
// Mixdog changes after that commit are not tracked
// (third_party/mixdog/provenance.json).
// Changed: the measurement no longer scrolls the target or its frames into
// view, because the host prepares the exact target and ancestor viewports
// first (frames.mjs `prepare`); the resolver reads the validated element from
// the isolated-world global `__independentTargetSnapshot` (renamed); TypeScript
// types removed.

/** Two layout samples a frame apart fence movement; measuring never mutates
 *  scroll. */
export const BROWSER_STABLE_RECT = `async function(target, frames = []) {
  const view = target.ownerDocument.defaultView;
  const first = target.getBoundingClientRect();
  await new Promise((resolve) => {
    let frame;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      view.clearTimeout(timer);
      view.cancelAnimationFrame(frame);
      resolve();
    };
    const timer = view.setTimeout(finish, 100);
    frame = view.requestAnimationFrame(finish);
  });
  const rect = target.getBoundingClientRect();
  if (Math.abs(first.left - rect.left) > 2 || Math.abs(first.top - rect.top) > 2
    || Math.abs(first.width - rect.width) > 2 || Math.abs(first.height - rect.height) > 2) return null;
  return rect;
}`;

/** Page-context resolver that turns one ref of `window.__independentTargetSnapshot`
 *  into a safe click coordinate (walker.mjs `targetPointExpression` exposes
 *  the validated element under ref `t`). */
export function browserRefPointExpression(ref) {
  return `(async () => {
    const snapshot = window.__independentTargetSnapshot;
    const record = snapshot?.refs?.get(${JSON.stringify(ref)});
    const el = record?.element || record;
    const frames = Array.isArray(record?.frames) ? record.frames : [];
    if (!snapshot || !el || !el.isConnected) return { error: 'stale' };
    if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') return { error: 'disabled' };
    const ownerWindow = el.ownerDocument?.defaultView || window;
    const hidden = (node) => {
      const style = ownerWindow.getComputedStyle(node);
      return style.display === 'none' || style.visibility === 'hidden';
    };
    if (hidden(el)) return { error: 'not-actionable' };
    const targetRect = await (${BROWSER_STABLE_RECT})(el, frames);
    if (!targetRect) return { error: 'moving' };
    // A transparent or 1px control hides behind its label on purpose; the
    // label is what a person clicks, and clicking it activates the control.
    const labels = el.labels ? Array.from(el.labels) : [];
    const candidates = [el, ...labels.filter((label) => (
      label !== el && label.isConnected && !hidden(label)
    ))];
    let offsetX = 0;
    let offsetY = 0;
    for (const frame of frames) {
      const frameRect = frame.getBoundingClientRect();
      offsetX += frameRect.left;
      offsetY += frameRect.top;
    }
    const points = [
      [0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
    ];
    const controlSelector = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"]';
    const controlFor = (value) => value?.matches?.(controlSelector)
      ? value
      : value?.closest?.(controlSelector);
    const labelControl = (value) => value?.closest?.('label')?.control || null;
    const sameDestination = (left, right) => {
      if (!left || !right || left === right
        || left.matches?.('a[href]') !== true || right.matches?.('a[href]') !== true) return false;
      try {
        return new URL(left.href, location.href).href === new URL(right.href, location.href).href;
      } catch {
        return false;
      }
    };
    const deepHit = (globalX, globalY) => {
      let doc = document;
      let localX = globalX;
      let localY = globalY;
      for (const frame of frames) {
        const frameRect = frame.getBoundingClientRect();
        const frameHit = doc.elementFromPoint(localX, localY);
        if (frameHit !== frame && !frame.contains(frameHit) && !frameHit?.contains?.(frame)) return frameHit;
        localX -= frameRect.left;
        localY -= frameRect.top;
        doc = frame.contentDocument;
        if (!doc) return frameHit;
      }
      let hit = doc.elementFromPoint(localX, localY);
      while (hit?.shadowRoot) {
        const nested = hit.shadowRoot.elementFromPoint?.(localX, localY);
        if (!nested || nested === hit) break;
        hit = nested;
      }
      return hit;
    };
    let covering = null;
    let visible = false;
    for (const candidate of candidates) {
      const rect = candidate === el ? targetRect : candidate.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      visible = true;
      for (const [rx, ry] of points) {
        const x = Math.round(Math.min(Math.max(0, window.innerWidth - 1), Math.max(0, offsetX + rect.left + rect.width * rx)));
        const y = Math.round(Math.min(Math.max(0, window.innerHeight - 1), Math.max(0, offsetY + rect.top + rect.height * ry)));
        const hit = deepHit(x, y);
        const targetControl = controlFor(el);
        const hitControl = controlFor(hit);
        const related = hit && (
          hit === el
          || hit === candidate
          || (candidate.contains(hit) && (!hitControl || hitControl === targetControl))
          || (targetControl && hitControl === targetControl)
          || sameDestination(targetControl, hitControl)
          || labelControl(hit) === el
        );
        if (related) return { x, y };
        covering = hit || covering;
      }
    }
    if (!visible) return { error: 'not-visible' };
    if (covering) {
      const label = (covering.tagName || 'element').toLowerCase() + ' "'
        + String(covering.getAttribute?.('aria-label') || covering.textContent || '')
          .replace(/\\s+/g, ' ').trim().slice(0, 60) + '"';
      // An unnamed overlay owns no ref, so the caller needs a selector to act on.
      const escape = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '\\\\$&');
      const selector = covering.id
        ? '#' + escape(covering.id)
        : ((covering.tagName || 'element').toLowerCase()
          + Array.from(covering.classList || []).slice(0, 2).map((name) => '.' + escape(name)).join(''));
      return { error: 'covered', covering: label, coveringSelector: selector };
    }
    return { error: 'not-visible' };
  })()`;
}
