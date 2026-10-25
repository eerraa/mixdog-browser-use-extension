// One script run: a fresh sandbox, the bridge under the run's caller, a hard
// deadline, a watch for Stop and handoff on touched tabs, and a compact
// report. Electron-free: the sandbox factory is injected (sandbox.mjs).
import vm from 'node:vm';
import { RUN_BOUNDS } from '../../shared/contract.mjs';
import { RUNNER_API_SOURCE } from './api.mjs';
import { pauseStatus, RunnerBridge } from './bridge.mjs';

export const RUN_LIMITS = Object.freeze({
  defaultMs: RUN_BOUNDS.defaultMs, minMs: RUN_BOUNDS.minMs, maxMs: RUN_BOUNDS.maxMs, scriptChars: RUN_BOUNDS.scriptChars,
  returnChars: 4000, consoleChars: 2000, consoleLineChars: 300, stepLines: 60, settleMs: 3000, watchMs: 250,
  // Final views: at most `views` tabs, `viewChars` each and `viewTotalChars`
  // together, within `finalMs` and the gateway's 120 s call limit (`callMs`).
  views: 4, viewChars: 6000, viewTotalChars: 12000, finalMs: 10000, callMs: 115000, reportChars: 24000,
});
const CODES = {
  error: 'SCRIPT_ERROR', syntax: 'SCRIPT_SYNTAX', deadline: 'RUN_DEADLINE', stopped: 'AUTOMATION_PAUSED',
  paused: 'AUTOMATION_PAUSED', handoff: 'PRIVATE_HANDOFF', cancelled: 'CANCELLED', crashed: 'RUNNER_CRASHED', limit: 'RUN_LIMIT',
};
// Report text comes from the script's world: line breaks, C0/C1 controls,
// U+2028/2029 and bidi controls are escaped so it cannot forge report lines.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const escape = text => text.replace(UNSAFE, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const field = (value, max) => (typeof value === 'string' && value ? escape(value.slice(0, max)) : undefined);
// Cuts at a line boundary and says how much is left.
const clipLines = (text, max, rest) => {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  const kept = text.slice(0, cut > 0 ? cut : max);
  return `${kept}\n+${text.length - kept.length} more characters (${rest})`;
};
const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_RUN', requestedInputDispatched: false }); };

/**
 * The sandbox program: the API, then the script as an async function body.
 * Builtins the wrapper needs are captured before the script runs (it may
 * replace globals and prototypes). WebRTC constructors are removed: ICE
 * would reach the network outside request interception.
 */
export function runnerSource(script, tabId) {
  return `(async () => {
'use strict';
const __wbSlice = Function.prototype.call.bind(String.prototype.slice);
const __wbStringify = JSON.stringify, __wbString = String;
const __wbField = (value, max) => { try { return __wbSlice(typeof value === 'string' ? value : __wbString(value), 0, max); } catch { return '[unreadable]'; } };
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription']) {
  try { delete globalThis[name]; } catch { /* not configurable */ }
}
const __wbApi = (${RUNNER_API_SOURCE})(window.__wbBridge.call, ${JSON.stringify(tabId ?? null)});
try {
  const __wbValue = await (async (page, { open, tabs, sleep, RunnerError }) => {
${script}
  })(__wbApi.page, __wbApi.ctx);
  let json;
  try { json = __wbStringify(__wbValue); } catch { json = '"[unserializable return value]"'; }
  if (typeof json !== 'string') return { status: 'ok', value: null, length: 0 };
  return { status: 'ok', value: __wbSlice(json, 0, ${RUN_LIMITS.returnChars}), length: json.length };
} catch (error) {
  let name, code, kind, message;
  try { name = error && error.name; code = error && error.code; kind = error && error.kind; message = (error && error.message) || error; } catch { /* hostile getter */ }
  return { status: 'error', name: __wbField(name || 'Error', 100), code: code ? __wbField(code, 64) : undefined,
    kind: kind ? __wbField(kind, 32) : undefined, message: __wbField(message, 1000) };
}
})()`;
}

/**
 * Compile-only checks in main; nothing is run. The script must parse as one
 * async function body on its own (a script that closes the wrapper and goes
 * on outside it does not), and the whole program must compile.
 */
export function syntaxError(script, tabId) {
  try {
    vm.runInNewContext('new (async function () {}).constructor("page", "{ open, tabs, sleep, RunnerError }", source)',
      { source: script }, { timeout: 2000 });
    new vm.Script(runnerSource(script, tabId), { filename: 'run.js' });
    return null;
  } catch (error) {
    return String(error?.message ?? error).slice(0, 300);
  }
}

// The sandbox's answer is data from the script's world: only a plain
// { status, … } object of strings is believed; everything is clipped and
// escaped here, whatever the wrapper did.
function scriptOutcome(value) {
  const plain = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (plain && value.status === 'ok') {
    const text = typeof value.value === 'string' ? value.value.slice(0, RUN_LIMITS.returnChars) : null;
    const total = Number.isSafeInteger(value.length) && text !== null && value.length > text.length ? value.length : text?.length ?? 0;
    return { status: 'ok', returned: text === null ? null : `${escape(text)}${total > text.length ? `…(+${total - text.length})` : ''}` };
  }
  if (plain && value.status === 'error') {
    const name = field(value.name, 100) ?? 'Error', code = field(value.code, 64);
    return { status: 'error', message: `${name}${code ? ` ${code}` : ''}: ${field(value.message, 1000) ?? 'script failed'}` };
  }
  return { status: 'error', message: 'The script returned a malformed result' };
}

/** Status of the person's control over a tab, from list_tabs. */
function interruption(tab) {
  if (!tab) return null;
  if (tab.paused === 'explicit-stop') return 'stopped';
  if (tab.mode && tab.mode !== 'automation') return 'handoff';
  return tab.paused ? pauseStatus(tab.paused) : null;
}

/**
 * execute(args, caller) is BrowserHost.execute; caller is the run call's
 * trusted caller. createSandbox({onOp, onConsole}) → {evaluate(source), destroy()}.
 * finalView(tabId) → text of the tab after the run (null to skip).
 */
export async function runScript({ script, tabId, timeoutMs = RUN_LIMITS.defaultMs, execute, caller, createSandbox,
  finalView = null, tabState = null, now = Date.now, watchMs = RUN_LIMITS.watchMs }) {
  if (typeof script !== 'string' || !script.trim() || script.length > RUN_LIMITS.scriptChars) invalid(`script must be 1..${RUN_LIMITS.scriptChars} characters`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < RUN_LIMITS.minMs || timeoutMs > RUN_LIMITS.maxMs) invalid(`timeoutMs must be ${RUN_LIMITS.minMs}..${RUN_LIMITS.maxMs}`);
  caller.assertLive();
  caller.signal.throwIfAborted();
  const started = now();
  const controller = new AbortController();
  const stop = status => { if (!controller.signal.aborted) controller.abort({ runStatus: status }); };
  const forward = () => stop('cancelled');
  caller.signal.addEventListener('abort', forward, { once: true });
  let bridge;
  // keepSignals: step results drain no signals; the final views do, once.
  // requestOwner: native requests of steps belong to the run's own caller.
  // assertLive runs before every op and right before every dispatch: an
  // ended run, or Stop or handoff on any of its tabs, refuses at once.
  const runCaller = {
    sessionId: caller.sessionId, callId: `${caller.callId}:run`, signal: controller.signal, keepSignals: true,
    requestOwner: caller.requestOwner,
    assertLive() {
      try { caller.assertLive(); } catch (error) { stop('cancelled'); throw error; }
      controller.signal.throwIfAborted();
      if (bridge?.sealed) throw Object.assign(new Error(`The run has ended (${bridge.sealed.status})`), { code: 'RUN_SEALED', requestedInputDispatched: false });
      for (const touched of bridge?.touched ?? []) {
        const state = tabState?.(touched);
        const reason = interruption(state);
        if (!reason) continue;
        const code = reason === 'handoff' ? 'PRIVATE_HANDOFF' : 'AUTOMATION_PAUSED';
        bridge.end({ status: reason, code, message: `${touched}: ${state.paused ?? state.mode}` });
        throw Object.assign(new Error(`The run ended: ${touched} is ${reason}`), { code, requestedInputDispatched: false });
      }
    },
  };
  bridge = new RunnerBridge({ execute, caller: runCaller, deadline: started + timeoutMs, tabs: [tabId], now,
    onEnd: outcome => stop(outcome.status) });
  const consoleLines = [];
  let consoleChars = 0, consoleDropped = 0;
  const onConsole = (level, message) => {
    if (consoleChars >= RUN_LIMITS.consoleChars) { consoleDropped++; return; }
    const text = typeof message === 'string' ? message.slice(0, RUN_LIMITS.consoleLineChars) : '';
    const line = escape(`${String(level).slice(0, 16)} ${text.replace(/\s+/g, ' ')}`).slice(0, RUN_LIMITS.consoleLineChars);
    if (consoleChars + line.length > RUN_LIMITS.consoleChars) { consoleDropped++; return; }
    consoleChars += line.length + 1;
    consoleLines.push(line);
  };
  const syntax = syntaxError(script, tabId);
  let sandbox = null;
  if (!syntax) {
    try {
      sandbox = await createSandbox({ onOp: (op, args) => bridge.handle(op, args), onConsole });
    } catch (error) {
      caller.signal.removeEventListener('abort', forward);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: error?.code ?? 'RUNNER_UNAVAILABLE', requestedInputDispatched: false });
    }
  }
  const timers = [];
  let finished = false;
  const watch = new Promise(resolve => {
    const tick = async () => {
      if (finished || bridge.sealed || controller.signal.aborted) return;
      try {
        const tabs = (await execute({ action: 'list_tabs' }, runCaller)).tabs ?? [];
        if (finished) return;
        for (const touched of bridge.touched) {
          const reason = interruption(tabs.find(tab => tab.tabId === touched));
          if (reason) { resolve({ kind: 'interrupt', status: reason }); return; }
        }
      } catch { /* the bridge or deadline reports a lost caller */ }
      if (!finished) timers.push(setTimeout(tick, watchMs));
    };
    timers.push(setTimeout(tick, watchMs));
  });
  const deadline = new Promise(resolve => timers.push(setTimeout(() => resolve({ kind: 'deadline' }), timeoutMs)));
  const cancelled = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true }));
  const outcome = syntax ? { kind: 'syntax', message: syntax } : await Promise.race([
    Promise.resolve().then(() => sandbox.evaluate(runnerSource(script, tabId))).then(value => ({ kind: 'done', value }),
      error => ({ kind: 'crashed', error })),
    bridge.ended.then(sealed => ({ kind: 'sealed', sealed })), watch, deadline, cancelled,
  ]);
  finished = true;
  for (const timer of timers) clearTimeout(timer);
  caller.signal.removeEventListener('abort', forward);

  let status, message, returned;
  if (outcome.kind === 'done') ({ status, message, returned } = scriptOutcome(outcome.value));
  else if (outcome.kind === 'sealed') ({ status, message } = outcome.sealed);
  else if (outcome.kind === 'interrupt') status = outcome.status;
  else if (outcome.kind === 'deadline') { status = 'deadline'; message = `Deadline ${timeoutMs} ms reached; the sandbox was terminated`; }
  else if (outcome.kind === 'abort') status = controller.signal.reason?.runStatus ?? 'cancelled';
  else if (outcome.kind === 'syntax') { status = 'syntax'; message = escape(outcome.message); }
  else { status = outcome.kind; message = escape(String(outcome.error?.message ?? outcome.error).slice(0, 300)); }
  // Seal first so nothing new is admitted, then end any in-flight op and the
  // sandbox. The first end wins (an uncertain step, an interruption).
  ({ status, message } = bridge.end({ status, message }));
  stop(status);
  sandbox?.destroy();
  let settleTimer;
  await Promise.race([bridge.settled(), new Promise(resolve => { settleTimer = setTimeout(resolve, RUN_LIMITS.settleMs); })]);
  clearTimeout(settleTimer);

  // An input still in flight after the bounded settle has an unknown outcome.
  for (const step of bridge.steps) if (step.outcome === 'pending') step.outcome = step.input ? 'unknown' : 'aborted';
  const uncertain = status === 'uncertain' || bridge.steps.some(step => ['uncertain', 'unknown'].includes(step.outcome));
  const disposition = uncertain ? 'uncertain' : bridge.executedAny ? 'executed' : status === 'ok' ? 'observed' : 'not-executed';
  // Final views: one budget for all of them inside the gateway call limit;
  // tabs over the caps are named for the agent to observe.
  const views = [];
  if (finalView && !caller.signal.aborted) {
    const budget = Math.max(0, Math.min(RUN_LIMITS.finalMs, RUN_LIMITS.callMs - (now() - started)));
    const viewSignal = AbortSignal.any([caller.signal, AbortSignal.timeout(budget)]);
    let left = RUN_LIMITS.viewTotalChars, index = 0;
    for (const touched of bridge.touched) {
      if (index++ >= RUN_LIMITS.views || left <= 0 || viewSignal.aborted) { views.push(`-- ${touched} not shown: observe ${touched}`); continue; }
      try {
        const text = clipLines(String(await finalView(touched, viewSignal) ?? ''), Math.min(RUN_LIMITS.viewChars, left), `observe ${touched}`);
        left -= text.length;
        views.push(`-- ${touched}`, text);
      } catch (error) {
        views.push(viewSignal.aborted ? `-- ${touched} not shown: observe ${touched}`
          : `-- ${touched}\nunavailable: ${`${error?.code ?? ''} ${String(error?.message ?? '').slice(0, 200)}`.trim()}`);
      }
    }
  }
  const lines = [`run ${status} ${bridge.steps.length} step${bridge.steps.length === 1 ? '' : 's'} ${Math.round(now() - started)} ms${message ? `: ${message}` : ''}`];
  const shown = bridge.steps.slice(0, RUN_LIMITS.stepLines);
  shown.forEach((step, index) => lines.push(`${index + 1} ${step.outcome} ${step.op}`
    + `${step.what ? ` ${escape(step.what)}` : ''}${step.code ? ` code=${escape(String(step.code).slice(0, 64))}` : ''} ${step.ms}ms`));
  if (bridge.steps.length > shown.length) lines.push(`+${bridge.steps.length - shown.length} more steps`);
  if (returned !== undefined && returned !== null) lines.push(`return ${returned}`);
  if (consoleLines.length) lines.push('console:', ...consoleLines, ...(consoleDropped ? [`+${consoleDropped} more console lines`] : []));
  lines.push(...views);
  return {
    action: 'run', disposition, status, tabId: tabId ?? [...bridge.touched][0],
    ...(status === 'ok' ? {} : { code: bridge.sealed.code && status === 'uncertain' ? bridge.sealed.code : CODES[status] ?? 'RUN_FAILED' }),
    ...(disposition === 'executed' || disposition === 'uncertain' ? { replaySafe: false } : {}),
    steps: bridge.steps.length, text: clipLines(lines.join('\n'), RUN_LIMITS.reportChars, 'report capped'),
  };
}
