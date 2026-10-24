const deviceKinds = new Set(['hid', 'usb', 'serial', 'bluetooth']);
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value;

function exactJSON(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const result = [];
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Scope arrays must be dense JSON');
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !('value' in descriptor)) throw new Error('Scope arrays must be dense JSON');
      result.push(exactJSON(descriptor.value));
    }
    return result;
  }
  if (value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value).sort()) {
      if (typeof key !== 'string') throw new Error('Scope must be exact JSON');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Scope must be exact JSON');
      result[key] = exactJSON(descriptor.value);
    }
    return result;
  }
  throw new Error('Scope must be exact JSON');
}

function origin(value) {
  if (!text(value)) throw new Error('Unverifiable origin');
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Unverifiable origin');
  return parsed.origin;
}

function normalize(value, connectionId) {
  if (!value || !text(value.requesterId) || !text(value.documentId) || !text(value.kind)) {
    throw new Error('Unverifiable requester, document or permission kind');
  }
  if (!value.scope || Array.isArray(value.scope) || typeof value.scope !== 'object') {
    throw new Error('Missing exact permission scope');
  }
  const scope = exactJSON(value.scope);
  if (!Object.keys(scope).length || (deviceKinds.has(value.kind) && !text(scope.deviceId))) {
    throw new Error('Missing exact permission/device scope');
  }
  const descriptor = {
    origin: origin(value.origin), embeddingOrigin: origin(value.embeddingOrigin),
    kind: value.kind, scope,
    ...(value.authorityId === undefined ? {} : { authorityId: value.authorityId }),
  };
  if (value.authorityId !== undefined && !text(value.authorityId)) throw new Error('Unverifiable delegated authority');
  return {
    descriptor, key: JSON.stringify(descriptor),
    request: { ...descriptor, connectionId, requesterId: value.requesterId, documentId: value.documentId },
  };
}

/**
 * One instance per browser connection. Keep this instance in the trusted host:
 * decide() must never be exposed as an MCP/browser-callable tool.
 *
 * verifyRequest(normalizedRequest) must synchronously return true only after
 * checking authoritative requester/document membership, current frame origins,
 * permission kind and exact device scope against the live browser connection.
 * onPrompt({id, origin, embeddingOrigin, kind, scope}) is a trusted host adapter:
 * human UI or privately verified delegated selection, never model authority.
 * revokePermission(scopeDescriptor) resolves true ONLY for confirmed Chromium
 * revocation, not merely removal from this authorization ledger.
 *
 * Granted results include a signal: consumers must use it to cancel work on
 * revoke/close. This ledger does not itself grant Chromium permissions.
 */
export class PermissionBroker {
  #connectionId;
  #verify;
  #onPrompt;
  #onDismiss;
  #realRevoke;
  #closed = false;
  #records = new Map();
  #prompts = new Map();
  #revocations = new Map();
  #sequence = 0;

  constructor({ connectionId, verifyRequest, onPrompt, onDismiss = () => {}, revokePermission }) {
    if (!text(connectionId) || typeof verifyRequest !== 'function' ||
        typeof onPrompt !== 'function' || typeof onDismiss !== 'function' ||
        typeof revokePermission !== 'function') throw new TypeError('Trusted connection adapters required');
    this.#connectionId = connectionId;
    this.#verify = verifyRequest;
    this.#onPrompt = onPrompt;
    this.#onDismiss = onDismiss;
    this.#realRevoke = revokePermission;
  }

  #checked(value) {
    const normalized = normalize(value, this.#connectionId);
    // Do not let a verifier mutate the descriptor used for scope comparison.
    if (this.#verify(structuredClone(normalized.request)) !== true) {
      throw new Error('Requester/document/origin/scope not verified');
    }
    return normalized;
  }

  inspect(value) {
    if (this.#closed) return { status: 'closed', reason: 'Connection closed' };
    let normalized;
    try { normalized = this.#checked(value); }
    catch (error) { return { status: 'unverified', reason: error.message }; }
    const record = this.#records.get(normalized.key);
    return record ? { status: record.status, reason: record.outcome?.reason } : { status: 'unseen' };
  }

  request(value, { signal } = {}) {
    if (this.#closed) return Promise.resolve({ status: 'closed', reason: 'Connection closed' });
    let normalized;
    try { normalized = this.#checked(value); }
    catch (error) { return Promise.resolve({ status: 'denied', reason: error.message }); }
    if (signal?.aborted) return Promise.resolve({ status: 'withdrawn', reason: 'Requester aborted' });
    const { key, descriptor, request } = normalized;
    let record = this.#records.get(key);
    if (record && record.status !== 'pending') return Promise.resolve(record.outcome);
    const fresh = !record;
    if (fresh) {
      record = {
        key, descriptor, status: 'pending', members: new Set(),
        id: `${this.#connectionId}:${++this.#sequence}`, controller: new AbortController(),
      };
      this.#records.set(key, record);
      this.#prompts.set(record.id, record);
    }
    const result = new Promise(resolve => {
      const member = {
        requesterId: request.requesterId, documentId: request.documentId,
        settle: outcome => {
          signal?.removeEventListener('abort', abort);
          if (!record.members.delete(member)) return;
          resolve(outcome);
        },
      };
      const abort = () => {
        member.settle({ status: 'withdrawn', reason: 'Requester aborted' });
        this.#dropEmpty(record);
      };
      record.members.add(member);
      signal?.addEventListener('abort', abort, { once: true });
    });
    if (fresh) {
      try {
        const notified = this.#onPrompt({ id: record.id, ...structuredClone(descriptor) });
        Promise.resolve(notified).catch(() => this.#promptFailed(record));
      } catch { this.#promptFailed(record); }
    }
    return result;
  }

  #promptFailed(record) {
    if (record.status === 'pending' && this.#prompts.get(record.id) === record) {
      this.#settle(record, { status: 'denied', reason: 'Trusted prompt unavailable' });
    }
  }

  #dismiss(record) {
    this.#prompts.delete(record.id);
    // UI cleanup cannot strand members or alter a terminal security decision.
    try { Promise.resolve(this.#onDismiss(record.id)).catch(() => {}); } catch {}
  }

  #settle(record, outcome) {
    record.status = outcome.status;
    record.outcome = outcome;
    for (const member of record.members) member.settle(outcome);
    this.#dismiss(record);
  }

  #dropEmpty(record) {
    if (record.status === 'pending' && record.members.size === 0) {
      this.#records.delete(record.key);
      this.#dismiss(record);
    }
  }

  /** Trusted host adapter only; false means the prompt is stale or invalid. */
  decide(promptId, decision) {
    const record = this.#prompts.get(promptId);
    if (this.#closed || !record || !['approve', 'deny', 'cancel'].includes(decision)) return false;
    const outcome = decision === 'approve'
      ? { status: 'granted', signal: record.controller.signal }
      : { status: decision === 'deny' ? 'denied' : 'cancelled', reason: `Operator ${decision}` };
    this.#settle(record, outcome);
    return true;
  }

  /** Omit documentId to withdraw all documents belonging to that requester. */
  withdraw(requesterId, documentId) {
    for (const record of this.#records.values()) {
      if (record.status !== 'pending') continue;
      for (const member of record.members) {
        if (member.requesterId === requesterId && (documentId === undefined || member.documentId === documentId)) {
          member.settle({ status: 'withdrawn', reason: 'Requester withdrawn/navigation' });
        }
      }
      this.#dropEmpty(record);
    }
  }

  revoke(value) {
    if (this.#closed) return Promise.resolve({ status: 'not-confirmed', confirmed: false, reason: 'Connection closed' });
    let normalized;
    try { normalized = this.#checked(value); }
    catch (error) { return Promise.resolve({ status: 'not-confirmed', confirmed: false, reason: error.message }); }
    const { key, descriptor } = normalized;
    if (this.#revocations.has(key)) return this.#revocations.get(key).promise;
    let record = this.#records.get(key);
    if (!record) {
      record = { key, descriptor, members: new Set(), controller: new AbortController() };
      this.#records.set(key, record);
    }
    // Block admissions and cancel members/work BEFORE invoking the real adapter.
    const pending = record.status === 'pending';
    record.status = 'blocked';
    record.outcome = { status: 'blocked', reason: 'Permission revoked; scope remains blocked' };
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    const flight = { promise, resolve };
    this.#revocations.set(key, flight);
    const finish = outcome => {
      if (this.#revocations.get(key) !== flight) return;
      this.#revocations.delete(key);
      resolve(outcome);
    };
    record.controller.abort(new DOMException('Permission revoked', 'AbortError'));
    for (const member of record.members) member.settle(record.outcome);
    if (pending) this.#dismiss(record);
    // Cancellation/UI hooks may synchronously close the connection.
    if (this.#closed) return promise;
    try {
      Promise.resolve(this.#realRevoke(structuredClone(descriptor))).then(
        confirmed => finish(confirmed === true
          ? { status: 'revoked', confirmed: true }
          : { status: 'not-confirmed', confirmed: false, reason: 'Real revocation not confirmed' }),
        error => finish({ status: 'not-confirmed', confirmed: false, reason: String(error?.message ?? error) }),
      );
    } catch (error) {
      finish({ status: 'not-confirmed', confirmed: false, reason: String(error?.message ?? error) });
    }
    return promise;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const record of this.#records.values()) {
      record.controller.abort(new DOMException('Connection closed', 'AbortError'));
      if (record.status === 'pending') this.#settle(record, { status: 'closed', reason: 'Connection closed' });
    }
    this.#records.clear();
    this.#prompts.clear();
    for (const flight of this.#revocations.values()) {
      flight.resolve({ status: 'not-confirmed', confirmed: false, reason: 'Connection closed before confirmation' });
    }
    this.#revocations.clear();
  }
}
