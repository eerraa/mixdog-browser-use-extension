// Engine-neutral host shaping, ref validation, upload validation, and shared
// contract constants composed by both Electron `BrowserHost` and `CamoufoxHost`.
// Pure Node (zero Electron or Camoufox imports) so both engines stay strictly
// aligned on public envelopes, error codes, and bounds.
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { pause } from '../shared/async.mjs';
import { BrowserHostError, fail, inputActions } from '../shared/contract.mjs';
import { isProtectedInternalPath } from '../shared/preferences.mjs';
import { rankBrowserSemanticMatch } from './perception/match.mjs';
import { quote, renderDiff, renderFind, renderHeader, renderSnapshot, renderText } from './perception/render.mjs';
import { formatSignals } from './signals.mjs';

// Shared contract bounds (contracts.md Observation and input / Browser sessions).
export const TILE = 24;
export const WAIT_POLL_MS = 100;
export const SHORT_SETTLE = new Set(['scroll', 'evaluate']);
export const SHORT_PROBE_ACTIONS = new Set(['scroll', 'fill', 'type', 'select', 'upload']);
export const NATIVE_REQUEST_ACK_GRACE_MS = 300;
export const MIN_POINT_OPACITY = 0.1;
export const MAX_SESSION_TABS = 32;
export const MAX_TEMPORARY_SESSIONS = 16;
export const RETURN_TIMEOUT_MS = 25000;

export const hash = value => createHash('sha256').update(value).digest('hex');
export const hostOf = url => { try { return new URL(url).host || String(url).slice(0, 40); } catch { return ''; } };
export const clipText = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// Paint holding: resolve as soon as real `first-contentful-paint` fires via
// `PerformanceObserver` (which page script cannot forge), capped at `maxMs`
// after `responseStart`. Falls back to returning the numeric wait in minimal
// VM sandboxes without `PerformanceObserver`/`setTimeout`.
export function paintHoldingExpression(maxMs) {
  const bound = Number(maxMs);
  return `(()=>{
  const hasFcp=()=>performance.getEntriesByType('paint').some(e=>e.name==='first-contentful-paint');
  if(hasFcp())return 0;
  const nav=performance.getEntriesByType('navigation')[0];
  const wait=Math.min(${bound},Math.max(0,(nav?nav.responseStart:0)+${bound}-performance.now()));
  if(!(wait>0))return 0;
  if(typeof PerformanceObserver!=='function'||typeof setTimeout!=='function')return wait;
  return new Promise(resolve=>{
    let obs=null,done=false;
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);try{obs&&obs.disconnect();}catch{}resolve(0);};
    const timer=setTimeout(finish,wait);
    try{
      obs=new PerformanceObserver(list=>{
        if(list.getEntries().some(e=>e.name==='first-contentful-paint')||hasFcp())finish();
      });
      obs.observe({type:'paint',buffered:true});
    }catch{}
    if(hasFcp())finish();
  });
})()`;
}

export function assertLiveCaller(caller, signal, closed) {
  if (!caller || typeof caller.sessionId !== 'string' || !caller.sessionId || typeof caller.callId !== 'string'
    || !caller.callId || typeof caller.assertLive !== 'function' || !caller.signal) {
    fail('UNAUTHENTICATED_CALLER', 'Authenticated live host caller is required');
  }
  caller.assertLive();
  caller.signal.throwIfAborted();
  signal?.throwIfAborted();
  if (closed) fail('CONNECTION_CLOSED', 'Browser connection is closed or terminating revocation');
}

// Local regular files only; returns their real paths, which are what the page
// receives. Network and device paths (\\host\share, \\?\UNC\…, //host) are
// refused before any filesystem call (prevents NTLM credential leaks).
export async function validateUploadFiles(files, multiple, { dataRoot, connectionDataDir }) {
  if (!Array.isArray(files) || !files.length || files.length > 32 || (!multiple && files.length !== 1)) {
    fail('INVALID_UPLOAD_FILE', 'File selection must match the input multiplicity');
  }
  const local = file => typeof file === 'string' && !file.includes('\0') && /^[a-zA-Z]:[\\/]/.test(file);
  const refuse = () => fail('INVALID_UPLOAD_FILE', 'Upload requires existing local regular files with drive-letter paths; network and device paths are refused');
  const real = [];
  for (const file of files) {
    if (!local(file)) refuse();
    let resolved, info;
    try { resolved = await realpath(file); } catch { refuse(); }
    if (!local(resolved)) refuse();
    if (isProtectedInternalPath(resolved, { dataRoot, connectionDataDir })) {
      fail('INVALID_UPLOAD_FILE', 'Uploading internal browser profile, preference, or connection control files is refused');
    }
    try { info = await stat(resolved); } catch { refuse(); }
    if (!info.isFile()) refuse();
    real.push(resolved);
  }
  return real;
}

export function formatRequestLines(pending) {
  return pending.map(request => `request ${request.requestRef} ${request.kind}`
    + `${request.context?.message ? ` ${quote(clipText(String(request.context.message), 200))}` : ''}`
    + `${request.options?.length ? ` options ${request.options.map(option => `${option.optionRef}=${quote(option.label)}`).join(' ')}` : ' (respond with files or cancel)'}`);
}

export function drainPageSignals(p, caller, { signals, nativeRequests, header = false }) {
  // Script steps keep the queue for the run's final views.
  if (caller?.keepSignals) return [];
  const queued = signals.drain(p.owner, p.id)
    .filter(signal => !(header && signal.tabId === p.id && signal.kind === 'navigated'));
  const lines = formatSignals(queued, p.id);
  const devtools = p.devtools.since(p.cursor ?? { console: 0, network: 0 });
  p.cursor = devtools.cursor;
  if (devtools.errors) lines.push(formatSignals([{ tabId: p.id, kind: 'console', count: devtools.errors }], p.id)[0]);
  if (devtools.failed) lines.push(formatSignals([{ tabId: p.id, kind: 'network', count: devtools.failed }], p.id)[0]);
  const pending = caller ? nativeRequests.list(p, caller?.requestOwner?.caller ?? caller).length : 0;
  if (pending) lines.push(formatSignals([{ tabId: p.id, kind: 'requests', count: pending }], p.id)[0]);
  return lines;
}

export function buildDialogFirst(p, caller, action, { nativeRequests }) {
  const pending = nativeRequests.list(p, caller?.requestOwner?.caller ?? caller);
  return {
    action, tabId: p.id, disposition: 'not-executed', code: 'DIALOG_OPEN', requestedInputDispatched: false,
    dialog: { type: p.dialog.type }, pendingRequests: pending,
    text: [`dialog ${p.dialog.type} ${quote(clipText(p.dialog.message ?? '', 200))}: answer it first with handle_dialog or respond`,
      ...formatRequestLines(pending)].join('\n'),
  };
}

export function buildPendingUncertain(p, args, state, caller, { signals, nativeRequests, code = 'DIALOG_OPEN' }) {
  const parked = code === 'DIALOG_OPEN';
  const pending = parked && caller ? nativeRequests.list(p, caller?.requestOwner?.caller ?? caller) : [];
  return {
    action: args.action, ref: state.ref, tabId: p.id, disposition: 'uncertain', replaySafe: false, code,
    ...(parked ? { operationPending: true, pendingRequests: pending } : {}),
    text: [...drainPageSignals(p, caller, { signals, nativeRequests }),
      ...(parked && p.dialog ? [`dialog ${p.dialog.type} ${quote(clipText(p.dialog.message ?? '', 200))}: answer with handle_dialog or respond`] : []),
      ...formatRequestLines(pending),
      'note the input may have been delivered in part or in full; never repeat it; observe first'].join('\n'),
  };
}

export function buildUnobserved(p, args, cause, state = {}, caller = null, { signals, nativeRequests }) {
  if (state.delivered) return null;
  const parked = cause === 'DIALOG_OPEN';
  const pending = parked && caller ? nativeRequests.list(p, caller?.requestOwner?.caller ?? caller) : [];
  return {
    action: args.action, disposition: 'executed', tabId: p.id, ref: state.ref ?? args.ref, observed: false, cause, replaySafe: false,
    ...(state.code ? { code: state.code } : {}),
    ...(state.value === undefined ? {} : { value: state.value }),
    ...(parked ? { operationPending: true, pendingRequests: pending } : {}),
    text: [...drainPageSignals(p, caller, { signals, nativeRequests }),
      ...(p.dialog ? [`dialog ${p.dialog.type} ${quote(clipText(p.dialog.message ?? '', 200))}: answer with handle_dialog or respond`] : []),
      ...formatRequestLines(pending),
      ...(parked ? ['note the action is still pending behind the dialog; its result follows the answer'] : []),
      ...(state.value === undefined ? [] : [`value ${clipText(JSON.stringify(state.value) ?? 'undefined', 4000)}`]),
      'note input delivered once; observe to see the result; never repeat it'].join('\n'),
  };
}

// No fallback to another node: same-role+name refs are a hint only.
export function failStaleRef(p, entry, reason, { refs }) {
  const generation = p.presentation.generation;
  const now = (p.model?.items ?? []).filter(item => item.id !== undefined && item.role === entry.role && item.name === entry.name
    && !(item.frameId === entry.frameId && item.documentId === entry.documentId && item.id === entry.id))
    .slice(0, 3).map(item => refs.ref({
      tabId: p.id, frameId: item.frameId, documentId: item.documentId, id: item.id,
      role: item.role, name: item.name, generation,
    }));
  fail('STALE_REF', `${entry.ref} ${entry.role}${entry.name ? ` ${quote(clipText(entry.name, 60))}` : ''} ${reason}`
    + `${now.length ? `; same role+name now: ${now.join(' ')} (verify before acting)` : '; observe again'}`);
}

export function lookupLiveRef(p, ref, { refs, pages }) {
  const entry = refs.lookup(ref);
  if (!entry) fail('STALE_REF', `Unknown ref ${ref}; observe for current refs`);
  if (entry.tabId !== p.id) {
    const other = pages.get(entry.tabId);
    if (other && other.owner === p.owner && !other.closed) fail('WRONG_TAB', `${ref} belongs to tab ${entry.tabId}`);
    if (other && other.owner === p.owner) fail('STALE_REF', `${ref} belonged to tab ${entry.tabId}, which is closed`);
    fail('STALE_REF', `Unknown ref ${ref}; observe for current refs`);
  }
  if (entry.state !== 'live' || entry.generation !== p.presentation.generation) {
    const reason = entry.generation !== p.presentation.generation || entry.state === 'retired'
      ? 'is from an earlier presentation (handoff, Stop, hide or show)'
      : entry.state === 'renamed' ? 'changed its role or name' : entry.state === 'replaced' ? 'belongs to a replaced document' : 'was removed';
    failStaleRef(p, entry, reason, { refs });
  }
  return entry;
}

export function scopeKeyForRef(p, ref, { refs, pages }) {
  const entry = lookupLiveRef(p, ref, { refs, pages });
  const key = `${entry.frameId}:${entry.documentId}:${entry.id}`;
  if (!p.model?.byKey.has(key)) fail('STALE_REF', `${ref} is not on the page now; observe again`);
  return key;
}

export function resolveFrameRef(p, ref, { refs, pages }) {
  const entry = lookupLiveRef(p, ref, { refs, pages });
  if (entry.role !== 'iframe') fail('INVALID_ARGUMENT', `${ref} is not an iframe ref`);
  const item = p.model?.byKey.get(`${entry.frameId}:${entry.documentId}:${entry.id}`);
  const frame = item?.childFrameId && p.driver.frames.get(item.childFrameId);
  if (!frame) fail('STALE_FRAME', `${ref} has no current frame document; observe again`);
  return frame;
}

export function retirePerceivedRefs(p, model, generation, { refs }) {
  refs.retireGeneration(p.id, generation);
  for (const frame of model.frames.values()) {
    if (!frame.documentId) continue;
    refs.retireDocument(p.id, frame.frameId, frame.documentId);
    refs.gone(p.id, frame.frameId, frame.documentId, frame.gone, frame.renamed);
  }
  for (const frameId of p.model?.frames.keys() ?? []) {
    if (!model.frames.has(frameId)) refs.retireDocument(p.id, frameId);
  }
}

export async function presentModel(
  p, model, caller, result,
  { observe, snapshot = 'diff', screenshot = false, lines = [], value, state } = {},
  { refs, signals, nativeRequests, pages, nextSnapshotId, takeScreenshot },
) {
  const generation = p.presentation.generation;
  const root = model.frames.get(model.rootId);
  const snapshotId = nextSnapshotId();
  const refFor = item => refs.ref({
    tabId: p.id, frameId: item.frameId, documentId: item.documentId, id: item.id, role: item.role, name: item.name, generation,
  });
  const isGone = (_key, ref) => refs.lookup(ref)?.state !== 'live';
  const base = p.base?.generation === generation && p.base.rootDocument === root.documentId ? p.base : null;
  let nextView = null;
  const merges = [];
  const view = next => { nextView = next; };
  // find and scope add what they showed to the current view.
  const merge = partial => { if (base) merges.push(partial); };
  const commit = () => {
    if (nextView) p.base = { view: nextView, snapshotId, rootDocument: root.documentId, generation, url: model.url, scroll: model.scroll.y };
    for (const partial of merges) {
      for (const [key, line] of partial.lines) base.view.lines.set(key, line);
      for (const [key, ref] of partial.refs) base.view.refs.set(key, ref);
    }
  };
  let header = !base || base.url !== model.url || screenshot;
  let viewLine = !header && base.scroll !== undefined && base.scroll !== model.scroll.y;
  let body = '';
  const full = mode => {
    const rendered = renderSnapshot(model, { mode, refFor });
    view(rendered.view);
    header = true;
    return rendered.text;
  };
  if (observe) {
    header = true;
    if (observe.find !== undefined) {
      const found = renderFind(model, observe.find, { match: rankBrowserSemanticMatch, refFor });
      merge(found.view);
      body = found.text;
    } else if (observe.mode === 'text') {
      body = renderText(model);
    } else if (observe.scope !== undefined) {
      const rendered = renderSnapshot(model, { scopeKey: scopeKeyForRef(p, observe.scope, { refs, pages }), depth: observe.depth, refFor });
      merge(rendered.view);
      body = rendered.text;
    } else {
      const rendered = renderSnapshot(model, { mode: observe.mode ?? 'default', depth: observe.depth, refFor });
      view(rendered.view);
      body = rendered.text;
    }
  } else if (snapshot === 'full' || (snapshot === 'diff' && !base)) {
    body = full(snapshot === 'full' ? 'full' : 'default');
  } else if (snapshot === 'diff') {
    const diff = renderDiff(model, base.view, { from: base.snapshotId, to: snapshotId, refFor, isGone });
    if (diff.large) body = full('default');
    else { view(diff.view); body = diff.text; }
  }
  if (screenshot) result.screenshot = await takeScreenshot(p, model, snapshotId);
  if (state?.delivered) return null;
  if (!caller?.keepSignals) commit();
  const out = [...drainPageSignals(p, caller, { signals, nativeRequests, header }), ...lines];
  if (header) out.push(renderHeader(model, { points: p.shot?.snapshotId === snapshotId }));
  else if (viewLine) out.push(renderHeader(model).split('\n')[1]);
  if (value !== undefined) out.push(`value ${clipText(JSON.stringify(value) ?? 'undefined', 4000)}`);
  if (body) out.push(body);
  return { ...result, ...(value === undefined ? {} : { value }), snapshotId, text: out.join('\n') };
}

export async function waitForCondition(p, wait, caller, signal, { assertOwned, getUrl, textIncludes }) {
  const deadline = Date.now() + (wait.timeoutMs ?? 5000);
  for (;;) {
    assertOwned();
    p.presentation.assertObservable();
    const met = wait.url !== undefined
      ? getUrl().includes(wait.url)
      : (await textIncludes(wait.text ?? wait.gone)) === (wait.text !== undefined);
    if (met) return true;
    if (Date.now() >= deadline) return false;
    await pause(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())), signal);
  }
}

export function tagNotDispatchedError(error, unchecked) {
  const action = unchecked?.action;
  if ((inputActions.has(action) || action === 'open' || action === 'run') && error && typeof error === 'object'
    && error.requestedInputDispatched === undefined) {
    Object.assign(error, { requestedInputDispatched: false, preparation: error.preparation ?? 'none', tabId: error.tabId ?? unchecked?.tabId });
  }
}

export function classifyRunError(error, { p, args, state, caller, mutation, signal, timeoutSignal, signals, nativeRequests }) {
  const code = timeoutSignal.aborted ? 'TIMEOUT' : typeof error?.code === 'string' ? error.code : signal.aborted ? 'ABORTED' : 'BROWSER_ERROR';
  if (mutation && state.acked) return buildUnobserved(p, args, code, state, caller, { signals, nativeRequests });
  if (mutation && state.sent) return buildPendingUncertain(p, args, state, caller, { signals, nativeRequests, code });
  if (mutation) {
    const failure = error instanceof BrowserHostError ? error
      : new BrowserHostError(code, signal.aborted ? 'Cancelled, timed out or stopped before dispatch' : String(error?.message ?? 'Target validation failed'));
    if (signal.aborted && failure.code !== 'AUTOMATION_PAUSED') failure.code = code;
    throw Object.assign(failure, { tabId: p.id, preparation: state.preparation, requestedInputDispatched: false });
  }
  throw error;
}
