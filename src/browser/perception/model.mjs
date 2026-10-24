// Host-side page model (decisions D13, D15): composes per-frame walker
// snapshots into one ordered tree in root viewport coordinates. The agent sees
// a projection of it (render.mjs); target resolution uses the full model.

const keyOf = (frameId, documentId, id) => `${frameId}:${documentId}:${id}`;
// Bound on model size; past it the model is marked partial (capped).
export const MAX_ITEMS = 30000;
const intersect = (a, b) => {
  if (!a || !b) return null;
  const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bottom = Math.min(a.b, b.b);
  return r - l >= 1 && bottom - t >= 1 ? { l, t, r, b: bottom } : null;
};
const toRoot = (frame, [x, y, w, h]) => ({
  l: frame.origin.x + x * frame.origin.sx, t: frame.origin.y + y * frame.origin.sy,
  r: frame.origin.x + (x + w) * frame.origin.sx, b: frame.origin.y + (y + h) * frame.origin.sy,
});

/**
 * frames: [{ frameId, parentId, url, snapshot, error, ownerId }], where
 * snapshot is a walker result and ownerId is the parent document's local id of
 * the frame's owner element (null when it could not be mapped).
 * Only the root frame is required; every other frame degrades to hidden,
 * unavailable or unplaced and never fails the model.
 */
export function composeModel(frames) {
  const root = frames.find(frame => !frame.parentId);
  if (!root?.snapshot?.checkpoint) throw Object.assign(new Error('Root frame snapshot is unavailable'), { code: 'ROOT_UNAVAILABLE' });
  const byId = new Map(frames.map(frame => [frame.frameId, frame]));
  const children = new Map();
  for (const frame of frames) {
    if (!frame.parentId) continue;
    if (!children.has(frame.parentId)) children.set(frame.parentId, []);
    children.get(frame.parentId).push(frame);
  }
  const { w, h } = root.snapshot.checkpoint;
  const model = {
    rootId: root.frameId, url: root.snapshot.url, title: root.snapshot.title,
    viewport: { w, h }, scroll: { x: root.snapshot.checkpoint.x, y: root.snapshot.checkpoint.y, height: root.snapshot.scrollHeight },
    frames: new Map(), items: [], byKey: new Map(), hidden: [], capped: false,
  };
  const describe = (frame, status, extra = {}) => {
    const value = {
      frameId: frame.frameId, parentId: frame.parentId ?? null, url: frame.snapshot?.url ?? frame.url ?? '',
      title: frame.snapshot?.title ?? '', documentId: frame.snapshot?.checkpoint?.documentId ?? null,
      checkpoint: frame.snapshot?.checkpoint ?? null, status, ownerKey: null, covered: false,
      origin: { x: 0, y: 0, sx: 1, sy: 1 }, clip: null, gone: frame.snapshot?.gone ?? [], renamed: frame.snapshot?.renamed ?? [],
      ...extra,
    };
    model.frames.set(frame.frameId, value);
    return value;
  };
  const push = item => { model.items.push(item); model.byKey.set(item.key, item); };

  const place = (frame, info, ownerItem) => {
    const snapshot = frame.snapshot;
    if (snapshot.capped) model.capped = true;
    const local = new Map();
    const depthOf = p => (p && local.has(p) ? local.get(p).depth + 1 : (ownerItem ? ownerItem.depth + 1 : 0));
    const parentKeyOf = p => (p && local.has(p) ? local.get(p).key : ownerItem?.key ?? null);
    const owners = new Map();
    for (const child of children.get(frame.frameId) ?? []) if (child.ownerId) owners.set(child.ownerId, child);
    const unplaced = [];
    const inView = (rect, flag) => (info.status === 'unplaced' ? !!flag : !!intersect(rect, info.clip));
    // Text keys are content keys: the same text under the same parent is the
    // same line for diffs; an occurrence index keeps duplicates apart.
    const occurrences = new Map();
    const entries = [...snapshot.nodes.map(node => ({ node, o: node.o })), ...snapshot.texts.map(text => ({ text, o: text.o }))]
      .sort((a, b) => a.o - b.o);
    for (const { node, text } of entries) {
      if (model.items.length >= MAX_ITEMS) { model.capped = true; break; }
      if (text) {
        const base = `t:${frame.frameId}:${info.documentId}:${text.p}:${text.t}`;
        const n = occurrences.get(base) ?? 0;
        occurrences.set(base, n + 1);
        const rect = toRoot(info, text.b);
        push({
          key: `${base}#${n}`, frameId: frame.frameId, documentId: info.documentId, kind: 't', role: 'text', name: text.t,
          value: '', states: [], href: '', depth: depthOf(text.p), parentKey: parentKeyOf(text.p), rect,
          inView: inView(rect, text.vp), covered: info.covered,
        });
        continue;
      }
      const rect = toRoot(info, node.b);
      const item = {
        key: keyOf(frame.frameId, info.documentId, node.id), frameId: frame.frameId, documentId: info.documentId,
        id: node.id, kind: node.k, role: node.r, name: node.n ?? '', value: node.v ?? '', states: node.s ?? [],
        href: node.h ?? '', sensitive: !!node.x, level: node.lv, depth: depthOf(node.p), parentKey: parentKeyOf(node.p),
        rect, inView: inView(rect, node.vp), covered: !!node.c || info.covered,
      };
      local.set(node.id, item);
      push(item);
      if (node.k === 'f') {
        const child = owners.get(node.id);
        if (child) {
          owners.delete(node.id);
          item.childFrameId = child.frameId;
          enter(child, item, info);
        }
      }
    }
    // Children whose owner element was not emitted (not rendered) are hidden;
    // children without a mapped owner are placed after their parent.
    for (const child of children.get(frame.frameId) ?? []) {
      if (model.frames.has(child.frameId)) continue;
      if (child.ownerId && !local.has(child.ownerId)) hide(child, 'hidden');
      else if (!child.ownerId) unplaced.push(child);
    }
    for (const child of unplaced) enter(child, ownerItem ?? null, info, true);
  };
  const hide = (frame, status) => {
    describe(frame, status);
    model.hidden.push({ frameId: frame.frameId, url: frame.snapshot?.url ?? frame.url ?? '', status });
    for (const child of children.get(frame.frameId) ?? []) if (!model.frames.has(child.frameId)) hide(child, 'hidden');
  };
  const enter = (frame, ownerItem, parentInfo, unplaced = false) => {
    // Frames past the capture cap are hidden frames, never placed.
    if (frame.capped) { hide(frame, 'hidden'); return; }
    if (!frame.snapshot?.checkpoint) {
      const info = describe(frame, 'unavailable');
      if (ownerItem) { ownerItem.frameStatus = 'unavailable'; info.ownerKey = ownerItem.key; }
      for (const child of children.get(frame.frameId) ?? []) hide(child, 'hidden');
      return;
    }
    const { w: cw, h: ch } = frame.snapshot.checkpoint;
    if (!unplaced && (cw < 1 || ch < 1 || !ownerItem || ownerItem.rect.r - ownerItem.rect.l < 1)) { hide(frame, 'hidden'); return; }
    let info;
    if (unplaced) {
      info = describe(frame, 'unplaced', { covered: !!parentInfo?.covered });
    } else {
      const sx = (ownerItem.rect.r - ownerItem.rect.l) / cw, sy = (ownerItem.rect.b - ownerItem.rect.t) / ch;
      info = describe(frame, 'ok', {
        origin: { x: ownerItem.rect.l, y: ownerItem.rect.t, sx, sy },
        clip: intersect(parentInfo.clip, ownerItem.rect), covered: ownerItem.covered, ownerKey: ownerItem.key,
      });
      ownerItem.frameStatus = 'ok';
    }
    place(frame, info, ownerItem);
  };

  const rootInfo = describe(root, 'ok', { clip: { l: 0, t: 0, r: w, b: h } });
  place(root, rootInfo, null);
  for (const frame of frames) if (!model.frames.has(frame.frameId)) hide(frame, 'hidden');
  return model;
}

/** Items in the subtree of `key` (including frames inlined below an iframe). */
export function subtree(model, key) {
  const start = model.items.findIndex(item => item.key === key);
  if (start < 0) return [];
  const inside = new Set([key]);
  const out = [model.items[start]];
  for (const item of model.items.slice(start + 1)) {
    if (item.parentKey && inside.has(item.parentKey)) { inside.add(item.key); out.push(item); }
  }
  return out;
}
