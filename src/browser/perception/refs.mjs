// Connection-wide ref registry (decision D14). A ref `e<n>` names one
// (tab, frame, document, local node id) whose local id already encodes the
// node's role and accessible name (walker.mjs gives a renamed node a new id).
// Refs are never recycled and never fall back to another node.

export const REF_PATTERN = /^e[1-9]\d*$/;
const DEFAULT_CAP = 50000;

// Entries are indexed by tab and frame, so retiring a document or a tab never
// scans other tabs, and eviction drops retired entries first and then only
// the inserting tab's own live refs: one page cannot evict another's refs.
export class RefRegistry {
  #next = 1;
  #byRef = new Map();
  #byKey = new Map();
  #byTab = new Map();
  #dead = new Set();
  #cap;

  constructor({ cap = DEFAULT_CAP } = {}) { this.#cap = cap; }

  #frame(tabId, frameId) {
    if (!this.#byTab.has(tabId)) this.#byTab.set(tabId, new Map());
    const frames = this.#byTab.get(tabId);
    if (!frames.has(frameId)) frames.set(frameId, new Set());
    return frames.get(frameId);
  }
  #entries(tabId, frameId) {
    const frames = this.#byTab.get(tabId);
    if (!frames) return [];
    return frameId === undefined ? [...frames.values()].flatMap(set => [...set]) : [...(frames.get(frameId) ?? [])];
  }
  #setState(entry, state) {
    entry.state = state;
    if (state !== 'live') this.#dead.add(entry);
  }

  /** Returns the existing live ref for this node or issues the next one. */
  ref({ tabId, frameId, documentId, id, role, name, generation }) {
    const key = `${tabId}\n${frameId}\n${documentId}\n${id}`;
    const existing = this.#byKey.get(key);
    if (existing && existing.state === 'live' && existing.generation === generation) return existing.ref;
    const entry = { ref: `e${this.#next++}`, key, tabId, frameId, documentId, id, role, name, generation, state: 'live' };
    this.#byRef.set(entry.ref, entry);
    this.#byKey.set(key, entry);
    this.#frame(tabId, frameId).add(entry);
    this.#evict(tabId);
    return entry.ref;
  }
  /** The entry for a ref, live or retired, or null when unknown or evicted. */
  lookup(ref) {
    return this.#byRef.get(ref) ?? null;
  }
  /** Ref of a node only if it was already issued and is still live. */
  existing({ tabId, frameId, documentId, id, generation }) {
    const entry = this.#byKey.get(`${tabId}\n${frameId}\n${documentId}\n${id}`);
    return entry?.state === 'live' && entry.generation === generation ? entry.ref : null;
  }
  #retire(entries, predicate, state) {
    for (const entry of entries) if (entry.state === 'live' && predicate(entry)) this.#setState(entry, state);
  }
  /** Node removal or rename reported by the walker for one document. */
  gone(tabId, frameId, documentId, ids, renamed = []) {
    const removed = new Set(ids);
    const next = new Map(renamed);
    for (const entry of this.#entries(tabId, frameId)) {
      if (entry.state !== 'live' || entry.documentId !== documentId) continue;
      if (next.has(entry.id)) { entry.successorId = next.get(entry.id); this.#setState(entry, 'renamed'); }
      else if (removed.has(entry.id)) this.#setState(entry, 'removed');
    }
  }
  /** A frame's document was replaced (or the frame went away). */
  retireDocument(tabId, frameId, keepDocumentId = null) {
    this.#retire(this.#entries(tabId, frameId), entry => entry.documentId !== keepDocumentId, 'replaced');
  }
  /** Presentation generation changed (handoff, return, hide). */
  retireGeneration(tabId, keepGeneration) {
    this.#retire(this.#entries(tabId), entry => entry.generation !== keepGeneration, 'retired');
  }
  retireTab(tabId) {
    this.#retire(this.#entries(tabId), () => true, 'retired');
  }
  /** Live refs of a tab, for diff bookkeeping. */
  live(tabId) {
    return this.#entries(tabId).filter(entry => entry.state === 'live');
  }
  get size() { return this.#byRef.size; }
  #forget(entry) {
    this.#byRef.delete(entry.ref);
    this.#dead.delete(entry);
    if (this.#byKey.get(entry.key) === entry) this.#byKey.delete(entry.key);
    const frames = this.#byTab.get(entry.tabId);
    const set = frames?.get(entry.frameId);
    set?.delete(entry);
    if (set && !set.size) frames.delete(entry.frameId);
    if (frames && !frames.size) this.#byTab.delete(entry.tabId);
  }
  // Forget the oldest retired entries first; then only the inserting tab's
  // oldest live refs. A forgotten ref reports as unknown (STALE_REF).
  #evict(tabId) {
    for (const entry of this.#dead) {
      if (this.#byRef.size <= this.#cap) return;
      this.#forget(entry);
    }
    if (this.#byRef.size <= this.#cap) return;
    for (const set of this.#byTab.get(tabId)?.values() ?? []) {
      for (const entry of set) {
        if (this.#byRef.size <= this.#cap) return;
        this.#forget(entry);
      }
    }
  }
}
