import { webContents } from 'electron';
import { isDeepStrictEqual } from 'node:util';
import { PermissionBroker } from './permission-broker.mjs';
import { ConsentSurface } from './consent.mjs';
import { fail, freshId } from '../shared/contract.mjs';
import { showManualMessageBox } from './dialogs.mjs';

const descriptorKey = value => JSON.stringify({
  origin: value.origin, embeddingOrigin: value.embeddingOrigin, kind: value.kind,
  scope: Object.fromEntries(Object.entries(value.scope).sort(([a], [b]) => a.localeCompare(b))),
  ...(value.authorityId === undefined ? {} : { authorityId: value.authorityId }),
});
const scopeKindKey = value => JSON.stringify([value.origin, value.embeddingOrigin, value.kind]);
const deviceKinds = new Set(['hid', 'usb']);
const deviceScope = device => ({
  deviceId: device.deviceId, vendorId: device.vendorId, productId: device.productId,
});
const frameKey = frame => `${frame.processId}:${frame.routingId}`;
const safeOrigin = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null') throw new Error('Opaque/unsupported requester origin');
  return url.origin;
};
const onceCallback = callback => {
  let called = false;
  return value => { if (!called) { called = true; return callback(value); } };
};

export class BrowserPermissions {
  #selections = new WeakMap();
  #generations = new WeakMap();

  constructor({ connectionId, consentHelperPath, pageFor, isClosed, revoke, policy, nativeRequests }) {
    this.connectionId = connectionId;
    this.pageFor = pageFor;
    this.isClosed = isClosed;
    this.revoke = revoke;
    this.policy = policy;
    this.nativeRequests = nativeRequests;
    this.actors = new Map();
    this.surface = new ConsentSurface(consentHelperPath);
    this.requests = new Map();
    this.choosers = new Set();
    this.prompts = new Map();
    this.choices = new Map();
    this.deniedChoosers = new Set();
    this.deniedPermissions = new Set();
    this.events = [];
    this.remembered = new Map();
    this.broker = new PermissionBroker({
      connectionId,
      verifyRequest: request => this.verify(request),
      onPrompt: descriptor => {
        this.prompts.set(descriptor.id, descriptor);
        if (deviceKinds.has(descriptor.kind) || this.policy.mode !== 'manual') {
          this.#authorizeSelection(descriptor);
          return;
        }
        return this.surface.prompt(descriptor,
          () => [...this.requests.values()].some(r => descriptorKey(r.request) === descriptorKey(descriptor) && this.verify(r.request)),
          (id, decision) => this.broker.decide(id, decision));
      },
      onDismiss: id => { this.prompts.delete(id); this.surface.dismiss(id); },
      // Confirmation is only possible in the gateway AFTER this process exits.
      revokePermission: async () => { await this.revoke(); return false; },
    });
  }
  note(kind, reason, page) {
    this.events.push({ kind, reason, tabId: page?.id ?? null });
    if (this.events.length > 100) this.events.shift();
  }
  bindActor(page, caller, signal) {
    this.actors.set(page, { caller, signal });
  }
  actor(page) {
    const actor = this.actors.get(page);
    if (!actor || actor.caller.sessionId !== page.owner || actor.signal.aborted || actor.caller.signal.aborted) return null;
    actor.caller.assertLive();
    return actor;
  }
  #authority(page) {
    if (this.policy.mode === 'manual' || page.presentation.mode !== 'automation') return undefined;
    const actor = this.actor(page);
    if (!actor) return undefined;
    let id = this.#generations.get(actor.caller.signal);
    if (!id) { id = freshId(); this.#generations.set(actor.caller.signal, id); }
    return id;
  }
  admits(page) {
    if (!page || page.closed || !page.connected || page.returnController || this.isClosed()
      || page.contents.isDestroyed() || page.presentation.closed || !page.presentation.ready) return false;
    if (page.presentation.mode === 'automation') {
      return !page.paused && page.presentation.shielded() && page.presentation.healthy();
    }
    return page.presentation.mode === 'native-handoff' && !!page.paused
      && page.paused !== 'explicit-stop' && page.presentation.logicalVisible();
  }
  #authorizeSelection(descriptor) {
    const key = descriptorKey(descriptor);
    const members = [...this.requests.values()].filter(entry => descriptorKey(entry.request) === key);
    for (const entry of members) {
      const selection = this.#selections.get(entry);
      this.#selections.delete(entry);
      if (selection && selection.connectionId === this.connectionId && selection.key === key
        && !this.deniedChoosers.has(scopeKindKey(entry.request))
        && (selection.decision !== 'approve' || !this.deniedPermissions.has(scopeKindKey(entry.request)))
        && this.live(entry) && this.live(selection.chooser)
        && selection.chooser.frame.url === selection.chooser.frameURL
        && (!selection.record || (this.policy.permits(entry.request.kind) && this.nativeRequests.isResponding(selection.record)))) {
        this.broker.decide(descriptor.id, selection.decision);
        return;
      }
    }
    // A cached preference, renderer flag or fabricated request is not consent.
    // Withdraw rather than turning missing/stale UI evidence into human denial.
    for (const entry of members) entry.controller.abort(new Error('No current native device selection'));
  }
  install(session) {
    // Never custom-grant a device: that callback does not identify its frame.
    // Chromium's chooser callback retains the native per-origin in-memory grant.
    session.setDevicePermissionHandler(null);
    session.setPermissionCheckHandler((wc, kind, requestingOrigin, details) => {
      const page = this.pageFor(wc);
      if (!this.admits(page)) {
        this.note(kind, 'Permission check blocked by current browser state', page);
        return false;
      }
      let verified = false;
      try {
        verified = details.isMainFrame === true && !wc.mainFrame.detached
          && (!details.requestingUrl || details.requestingUrl === wc.mainFrame.url)
          && safeOrigin(requestingOrigin) === safeOrigin(wc.mainFrame.url)
          && (!details.securityOrigin || safeOrigin(details.securityOrigin) === safeOrigin(wc.mainFrame.url))
          && (!details.embeddingOrigin || safeOrigin(details.embeddingOrigin) === safeOrigin(wc.mainFrame.url));
      } catch { verified = false; }
      if (!verified) {
        this.note(kind, 'Permission check lacks a verifiably current main requesting frame', page);
        return false;
      }
      if (deviceKinds.has(kind)) return true; // chooser admission ONLY, never a device grant
      if (!['notifications', 'geolocation'].includes(kind)) {
        this.note(kind, 'Unsupported permission check', page); return false;
      }
      const key = descriptorKey({
        origin: safeOrigin(wc.mainFrame.url), embeddingOrigin: safeOrigin(wc.mainFrame.url),
        kind, scope: { permission: kind }, authorityId: this.#authority(page),
      });
      // This is only a synchronous mirror of the broker's positive grant handle,
      // not another approval ledger. Its abort signal is the broker authority.
      const granted = this.remembered.get(key);
      return !this.deniedPermissions.has(scopeKindKey({
        origin: safeOrigin(wc.mainFrame.url), embeddingOrigin: safeOrigin(wc.mainFrame.url), kind,
      })) && !!granted && !granted.aborted;
    });
    session.setPermissionRequestHandler((wc, kind, callback, details) => {
      const page = this.pageFor(wc);
      if (!this.admits(page) || details.isMainFrame !== true || details.requestingUrl !== wc.mainFrame.url
        || !['notifications', 'geolocation'].includes(kind)) {
        this.note(kind, 'Unsupported permission or native callback cannot prove supported main-frame requester', page);
        callback(false);
        return;
      }
      const once = onceCallback(callback);
      this.#permissionRequest(page, wc.mainFrame, kind, once).catch(() => {
        this.note(kind, 'Native permission response failed; inspect current state before retrying', page);
        once(false);
      });
    });
    session.setDisplayMediaRequestHandler((_request, callback) => {
      this.note('display-capture', 'Screen capture is unsupported; no verifiable approval adapter');
      callback({});
    });
    for (const kind of deviceKinds) {
      session.on(`select-${kind}-device`, (event, details, callback) => {
        event.preventDefault();
        const once = onceCallback(callback);
        this.choose(kind, session, details, once).catch(() => once());
      });
    }
    session.on('select-serial-port', (event, _ports, wc, callback) => {
      event.preventDefault();
      this.note('serial', 'Unverifiable requester frame; serial is unsupported', this.pageFor(wc));
      callback('');
    });
  }
  document(page, frame) {
    const key = frameKey(frame);
    let token = page.permissionDocuments.get(key);
    if (!token) { token = freshId(); page.permissionDocuments.set(key, token); }
    return token;
  }
  makeRequest(page, frame, kind, scope, offered) {
    try {
      if (!frame || frame.detached || !this.admits(page)
        || webContents.fromFrame(frame) !== page.contents) throw new Error('Requester is not live');
      const request = {
        requesterId: `${page.id}:${frameKey(frame)}`, documentId: this.document(page, frame),
        origin: safeOrigin(frame.url), embeddingOrigin: safeOrigin(page.contents.mainFrame.url),
        kind, scope, ...(this.#authority(page) === undefined ? {} : { authorityId: this.#authority(page) }),
      };
      const entry = { request, page, frame, frameURL: frame.url, offered, controller: new AbortController() };
      const id = `${request.requesterId}:${request.documentId}:${descriptorKey(request)}`;
      // Each consumer is distinct even when a broker record is shared.
      entry.id = `${id}:${freshId()}`;
      this.requests.set(entry.id, entry);
      return entry;
    } catch {
      this.note(kind, 'Requester frame/document/origin could not be verified', page);
      return null;
    }
  }
  live(entry) {
    try {
      const { frame, page, request } = entry;
      return this.admits(page) && !frame.detached
        && webContents.fromFrame(frame) === page.contents
        && page.permissionDocuments.get(frameKey(frame)) === request.documentId
        && safeOrigin(frame.url) === request.origin
        && safeOrigin(page.contents.mainFrame.url) === request.embeddingOrigin
        && (!entry.offered || entry.offered.has(request.scope.deviceId))
        && !entry.controller.signal.aborted;
    } catch { return false; }
  }
  verify(request) {
    return request.connectionId === undefined || request.connectionId === this.connectionId
      ? [...this.requests.values()].some(entry => entry.request.requesterId === request.requesterId
        && entry.request.documentId === request.documentId
        && descriptorKey(entry.request) === descriptorKey(request) && this.live(entry))
      : false;
  }
  async authorize(entry) {
    try {
      const result = await this.broker.request(entry.request, { signal: entry.controller.signal });
      const granted = result.status === 'granted' && !result.signal.aborted && this.live(entry);
      if (!granted) this.note(entry.request.kind, result.reason ?? 'Request no longer live', entry.page);
      return granted ? result.signal : null;
    } finally {
      this.#selections.delete(entry);
      this.requests.delete(entry.id);
    }
  }
  #applyPermission(entry, callback, signal, record) {
    const allowed = !!signal && !signal.aborted && this.live(entry)
      && !this.deniedPermissions.has(scopeKindKey(entry.request))
      && (!record || this.nativeRequests.isResponding(record));
    callback(allowed);
    if (allowed) this.remembered.set(descriptorKey(entry.request), signal);
    return allowed;
  }
  #denyPermission(entry) {
    const key = scopeKindKey(entry.request);
    this.deniedPermissions.add(key);
    for (const sibling of this.requests.values()) {
      if (sibling !== entry && scopeKindKey(sibling.request) === key) {
        sibling.controller.abort(new Error('Operator denied permission'));
      }
    }
  }
  async #permissionRequest(page, frame, kind, callback) {
    const entry = this.makeRequest(page, frame, kind, { permission: kind });
    if (!entry) { callback(false); return; }
    try {
      if (this.deniedPermissions.has(scopeKindKey(entry.request))) { callback(false); return; }
      const known = this.broker.inspect(entry.request);
      if (['denied', 'cancelled', 'closed', 'unverified'].includes(known.status)) {
        this.note(kind, known.reason ?? 'Permission scope is terminal', page);
        callback(false);
        return;
      }
      if (this.policy.mode === 'manual') {
        this.#applyPermission(entry, callback, await this.authorize(entry));
        return;
      }
      if (known.status === 'granted' && (page.presentation.mode === 'native-handoff' || (this.policy.permits(kind) && this.actor(page)))) {
        this.#applyPermission(entry, callback, await this.authorize(entry));
        return;
      }
      if (page.presentation.mode === 'native-handoff') {
        const choice = await showManualMessageBox(page.frame, {
          type: 'question', title: 'Independent Browser permission',
          message: `Allow ${kind} for ${entry.request.origin}?`,
          detail: `Embedding origin: ${entry.request.embeddingOrigin}\nConnection: ${this.connectionId}`,
          buttons: ['Decline', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
          signal: entry.controller.signal,
        });
        if (!this.live(entry)) { callback(false); return; }
        const decision = choice.response === 1 ? 'approve' : 'deny';
        if (decision !== 'approve') this.#denyPermission(entry);
        this.#selections.set(entry, Object.freeze({
          chooser: entry, key: descriptorKey(entry.request), connectionId: this.connectionId,
          decision,
        }));
        this.#applyPermission(entry, callback, await this.authorize(entry));
        return;
      }
      const actor = this.actor(page);
      if (!this.policy.permits(kind) || !actor) {
        this.note(kind, `Delegated permission blocked: ${this.policy.reason}; a live owner is required`, page);
        callback(false);
        return;
      }
      const generation = page.presentation.generation;
      let record;
      record = this.nativeRequests.create({
        page, caller: actor.caller, signal: AbortSignal.any([actor.signal, entry.controller.signal]), kind,
        context: { origin: entry.request.origin, embeddingOrigin: entry.request.embeddingOrigin, scope: entry.request.scope },
        options: [
          { label: 'Allow', metadata: { decision: 'allow' }, value: 'approve' },
          { label: 'Deny', metadata: { decision: 'deny' }, value: 'deny' },
        ],
        isCurrent: () => this.live(entry) && frame.url === entry.frameURL && page.presentation.generation === generation,
        validate: (response, decision) => {
          if (response.files !== undefined || response.text !== undefined) fail('INVALID_NATIVE_RESPONSE', 'Permission requests accept an offered decision or cancel');
          if (response.cancel) return 'cancel';
          if (!['approve', 'deny'].includes(decision)) fail('INVALID_NATIVE_RESPONSE', 'Choose a current permission option');
          return decision;
        },
        respond: async decision => {
          if (decision !== 'approve') this.#denyPermission(entry);
          this.#selections.set(entry, Object.freeze({
            chooser: entry, record, key: descriptorKey(entry.request), connectionId: this.connectionId, decision,
          }));
          const allowed = this.#applyPermission(entry, callback, await this.authorize(entry), record);
          return { requestRef: record.requestRef, kind,
            resolution: allowed ? 'allowed' : decision === 'approve' ? 'withdrawn' : decision === 'cancel' ? 'cancelled' : 'denied' };
        },
        withdraw: reason => {
          entry.controller.abort(new Error(reason));
          callback(false);
        },
      });
      await record.closed;
    } finally {
      this.#selections.delete(entry);
      this.requests.delete(entry.id);
    }
  }
  async #selectDevice({ page, frame, base, offered, chooser, current, finish, selected, freshSelection, record }) {
    if (!current() || !offered.has(selected)) {
      finish();
      return { resolution: 'withdrawn' };
    }
    const device = offered.get(selected);
    const scope = Object.freeze(deviceScope(device));
    const entry = this.makeRequest(page, frame, base.kind, scope, offered);
    if (!entry || entry.request.requesterId !== chooser.request.requesterId
      || entry.request.documentId !== chooser.request.documentId) {
      if (entry) this.requests.delete(entry.id);
      finish();
      return { resolution: 'withdrawn' };
    }
    if (freshSelection) this.#selections.set(entry, Object.freeze({
      chooser, record, key: descriptorKey(entry.request), connectionId: this.connectionId, decision: 'approve',
    }));
    const grantSignal = await this.authorize(entry);
    if (grantSignal && !grantSignal.aborted && current() && this.live(entry)
      && isDeepStrictEqual(device, offered.get(selected))
      && (!record || this.nativeRequests.isResponding(record))) {
      finish(selected);
      this.choices.set(scopeKindKey(base), Object.freeze({
        descriptor: Object.freeze({ ...entry.request, scope }), device: Object.freeze(device), signal: grantSignal,
      }));
      return { resolution: 'selected', device };
    }
    finish();
    return { resolution: 'withdrawn' };
  }
  #deviceOptions(offered) {
    return [...offered.values()].map(device => ({
      label: device.productName || device.name || `HID/USB ${device.vendorId}:${device.productId}`,
      metadata: device, value: device,
    }));
  }
  #cachedDevice(base, offered) {
    const cached = this.choices.get(scopeKindKey(base));
    const device = offered.get(cached?.descriptor.scope.deviceId);
    return cached && !cached.signal.aborted && device && isDeepStrictEqual(cached.device, device)
      && descriptorKey(cached.descriptor) === descriptorKey({ ...base, scope: deviceScope(device) }) ? cached : null;
  }
  #delegatedDevice({ page, frame, base, offered, chooser, current, finish }) {
    const actor = this.actor(page);
    if (!this.policy.permits(base.kind) || !actor) {
      this.note(base.kind, `Delegated device selection blocked: ${this.policy.reason}; a live owner is required`, page);
      finish();
      return null;
    }
    const generation = page.presentation.generation;
    let record;
    record = this.nativeRequests.create({
      page, caller: actor.caller, signal: AbortSignal.any([actor.signal, chooser.controller.signal]), kind: base.kind,
      context: { origin: base.origin, embeddingOrigin: base.embeddingOrigin },
      options: this.#deviceOptions(offered),
      isCurrent: () => current() && page.presentation.generation === generation,
      validate: (response, device) => {
        if (response.files !== undefined || response.text !== undefined) fail('INVALID_NATIVE_RESPONSE', 'Device requests accept an offered device or cancel');
        if (response.cancel) return null;
        if (!device || !isDeepStrictEqual(device, offered.get(device.deviceId))) fail('STALE_NATIVE_OPTION', 'The offered device changed');
        return device;
      },
      respond: async device => {
        if (!device) {
          const key = scopeKindKey(base);
          this.deniedChoosers.add(key);
          for (const sibling of this.choosers) {
            if (scopeKindKey(sibling.request) === key) sibling.controller.abort(new Error('Operator cancelled device selection'));
          }
          finish();
          return { requestRef: record.requestRef, kind: base.kind, resolution: 'cancelled' };
        }
        const result = await this.#selectDevice({
          page, frame, base, offered, chooser, current, finish, selected: device.deviceId, freshSelection: true, record,
        });
        return { requestRef: record.requestRef, kind: base.kind, ...result };
      },
      withdraw: reason => {
        chooser.controller.abort(new Error(reason));
        finish();
      },
    });
    return record;
  }
  async choose(kind, session, details, callback) {
    const finish = onceCallback(callback);
    const frame = details.frame;
    const page = frame ? this.pageFor(webContents.fromFrame(frame)) : null;
    if (!frame || !this.admits(page)) {
      this.note(kind, 'Chooser requester is missing, foreign or blocked by browser state', page);
      finish(); return;
    }
    let base;
    try { base = { origin: safeOrigin(frame.url), embeddingOrigin: safeOrigin(page.contents.mainFrame.url),
      kind, ...(this.#authority(page) === undefined ? {} : { authorityId: this.#authority(page) }) }; }
    catch { this.note(kind, 'Opaque chooser origin', page); finish(); return; }
    const chooserKey = scopeKindKey(base);
    if (this.deniedChoosers.has(chooserKey)) { finish(); return; }
    // The chooser displays JSON: absent/undefined fields are equivalent, and
    // comparison below ignores object-key order without dropping any visible data.
    const offered = new Map(details.deviceList.map(device => [device.deviceId, JSON.parse(JSON.stringify(device))]));
    if (!offered.size || [...offered.keys()].some(id => typeof id !== 'string' || !id)) {
      this.note(kind, 'No exact device offered', page);
      finish(); return;
    }
    const documentId = this.document(page, frame);
    const requesterId = `${page.id}:${frameKey(frame)}`;
    const initialURL = frame.url;
    // Lifecycle only, not another authorization ledger. The same document,
    // origin and state validation applies before and after every chooser await.
    const chooser = {
      page, frame, frameURL: initialURL, request: Object.freeze({ requesterId, documentId, ...base }),
      controller: new AbortController(),
    };
    const current = () => !this.deniedChoosers.has(chooserKey) && this.live(chooser) && frame.url === initialURL;
    chooser.controller.signal.addEventListener('abort', () => finish(), { once: true });
    this.choosers.add(chooser);
    let nativeRecord;
    const changed = (_event, update, ownerWC) => {
      // Electron HID removal supplies {frame,device}; USB removal supplies
      // (device,webContents). Removal only withdraws, never grants anything.
      const device = kind === 'hid' ? update.frame === frame ? update.device : null
        : ownerWC === page.contents ? update : null;
      if (device?.deviceId) {
        offered.delete(device.deviceId);
        for (const entry of this.requests.values()) {
          if (entry.offered === offered && !offered.has(entry.request.scope.deviceId)) {
            entry.controller.abort(new Error('Device removed'));
          }
        }
        if (nativeRecord) {
          if (offered.size) this.nativeRequests.replaceOptions(nativeRecord, this.#deviceOptions(offered));
          else this.nativeRequests.withdraw(nativeRecord, 'No offered device remains');
        }
      }
    };
    session.on(`${kind}-device-removed`, changed);
    try {
      if (page.presentation.mode === 'automation' && this.policy.mode !== 'manual') {
        const cached = this.#cachedDevice(base, offered);
        if (cached && this.policy.permits(kind) && this.actor(page)) {
          await this.#selectDevice({ page, frame, base, offered, chooser, current, finish,
            selected: cached.descriptor.scope.deviceId, freshSelection: false });
          return;
        }
        nativeRecord = this.#delegatedDevice({ page, frame, base, offered, chooser, current, finish });
        if (nativeRecord) await nativeRecord.closed;
        return;
      }
      if (offered.size > 16) {
        this.note(kind, 'The native human chooser supports at most 16 offered devices', page);
        finish(); return;
      }
      const cached = this.#cachedDevice(base, offered);
      let selected = cached?.descriptor.scope.deviceId;
      let freshSelection = false;
      if (!cached) {
        const devices = [...offered.values()];
        const choice = await showManualMessageBox(page.frame, {
          type: 'question', title: 'Independent Browser — select exact device',
          message: `Select and allow a ${kind.toUpperCase()} device for ${base.origin}`,
          detail: `Embedding origin: ${base.embeddingOrigin}\nConnection: ${this.connectionId}\nSelecting authorizes only that exact device for these origins in this connection. No additional approval or Windows verification follows. Cancel is final for this permission scope.\n`
            + devices.map((d, i) => `${i + 1}: ${JSON.stringify(d)}`).join('\n'),
          buttons: ['Cancel', ...devices.map((_d, i) => `Device ${i + 1}`)], defaultId: 0, cancelId: 0, noLink: true,
          signal: chooser.controller.signal,
        });
        if (!current()) { finish(); return; }
        if (choice.response === 0) {
          this.deniedChoosers.add(chooserKey);
          for (const sibling of this.choosers) {
            if (scopeKindKey(sibling.request) === chooserKey) sibling.controller.abort(new Error('Human cancelled device selection'));
          }
          finish(); return;
        }
        selected = devices[choice.response - 1]?.deviceId;
        if (!offered.has(selected)) { finish(); return; }
        freshSelection = true;
      }
      // No URL-only or VID/PID-only permission: exact live offered device ID.
      if (!current() || !offered.has(selected)) {
        this.note(kind, 'Chooser changed or requester navigated before authorization', page); finish(); return;
      }
      await this.#selectDevice({ page, frame, base, offered, chooser, current, finish, selected, freshSelection });
    } catch {
      this.note(kind, 'Chooser failed or became invalid; inspect the connection before retrying', page);
      finish();
    } finally {
      this.choosers.delete(chooser);
      session.removeListener(`${kind}-device-removed`, changed);
    }
  }
  withdraw(page, processId, routingId) {
    const frameId = processId === undefined ? null : `${processId}:${routingId}`;
    for (const entry of [...this.requests.values(), ...this.choosers]) {
      if (entry.page === page && (!frameId || frameKey(entry.frame) === frameId)) {
        entry.controller.abort(new Error('Requester withdrawn/navigation/Stop'));
        this.broker.withdraw(entry.request.requesterId, entry.request.documentId);
      }
    }
    if (frameId) {
      page.permissionDocuments.delete(frameId);
      this.nativeRequests.prune(page);
    } else {
      page.permissionDocuments.clear();
      this.nativeRequests.withdrawPage(page);
      if (page.paused || page.closed || !page.visible || !page.connected || this.isClosed()) this.actors.delete(page);
    }
  }
  prune(page) {
    for (const entry of [...this.requests.values(), ...this.choosers]) {
      if (entry.page === page && !this.live(entry)) {
        entry.controller.abort(new Error('Requester frame/document is no longer live'));
        this.broker.withdraw(entry.request.requesterId, entry.request.documentId);
      }
    }
    this.nativeRequests.prune(page);
  }
  status(page) {
    return {
      pending: [...this.prompts.values()].filter(p => [...this.requests.values()].some(r => r.page === page && descriptorKey(r.request) === descriptorKey(p))),
      events: this.events.filter(e => e.tabId === page.id),
      chromiumGrantLifetime: 'in-memory connection; no custom persistent grants',
      revoke: 'terminates all windows and the companion connection; gateway must verify process exit',
    };
  }
  close() {
    this.broker.close();
    this.surface.close();
    this.nativeRequests.close();
    for (const entry of [...this.requests.values(), ...this.choosers]) entry.controller.abort(new Error('Connection closed'));
    this.requests.clear();
    this.choosers.clear();
    this.actors.clear();
    this.remembered.clear();
  }
}
