import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runnerApi } from '../../src/browser/runner/api.mjs';
import { RUNNER_FLOOD, RunnerBridge, validateOp } from '../../src/browser/runner/bridge.mjs';
import { RUN_LIMITS, runScript, syntaxError } from '../../src/browser/runner/run.mjs';
import { validateArgs } from '../../src/browser/contract.mjs';

const caller = () => {
  const controller = new AbortController();
  return { sessionId: 'runner-owner', callId: 'call-1', signal: controller.signal, assertLive() { controller.signal.throwIfAborted(); }, controller };
};
const hostError = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
// A stand-in for the sandbox renderer in unit tests only: the generated program
// runs against a bridge that structured-clones arguments like IPC does.
const fakeSandbox = log => async ({ onOp, onConsole }) => {
  const sandbox = { destroyed: false };
  sandbox.evaluate = source => vm.runInNewContext(source, {
    window: { __wbBridge: { call: (op, args) => (sandbox.destroyed ? new Promise(() => {}) : onOp(op, structuredClone(args))) } },
    // A destroyed sandbox runs nothing more, like a terminated renderer.
    setTimeout: (callback, ms) => (sandbox.destroyed ? 0 : setTimeout(callback, ms)), clearTimeout, console: { log: (...values) => onConsole('info', values.join(' ')) },
  });
  sandbox.destroy = () => { sandbox.destroyed = true; log?.push('destroyed'); };
  return sandbox;
};

test('the script API maps a Playwright-like subset onto bridge ops and raises typed errors', async () => {
  const calls = [];
  const replies = { open: { ok: true, value: { tabId: 't2' } }, read: { ok: true, value: { text: 'Saved', value: 'x' } } };
  const call = async (op, args) => { calls.push([op, args]); return replies[op] ?? { ok: true, value: { ref: 'e1' } }; };
  const { page, ctx } = runnerApi(call, 't1');
  await page.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 100 });
  await page.getByLabel('Name').fill(42);
  await page.frame('e9').getByText('Inner').click();
  await page.locator('#go').press('Enter');
  await page.ref('e5').selectOption('b');
  assert.equal(await page.getByRole('status').innerText(), 'Saved');
  await page.evaluate(() => document.title);
  const second = await ctx.open('http://127.0.0.1/x');
  assert.equal(second.tabId, 't2');
  assert.deepEqual(calls.slice(0, 7), [
    ['click', { tabId: 't1', loc: { target: { role: 'button', name: 'Save', exact: true } }, timeoutMs: 100 }],
    ['fill', { tabId: 't1', loc: { target: { name: 'Name' } }, text: '42' }],
    ['click', { tabId: 't1', loc: { target: { name: 'Inner', frame: 'e9' } } }],
    ['press', { tabId: 't1', loc: { target: { selector: '#go' } }, key: 'Enter' }],
    ['select', { tabId: 't1', loc: { ref: 'e5' }, values: ['b'] }],
    ['read', { tabId: 't1', loc: { target: { role: 'status' } } }],
    ['evaluate', { tabId: 't1', expression: '(() => document.title)()' }],
  ]);
  const failing = runnerApi(async () => ({ ok: false, error: { code: 'TARGET_NOT_FOUND', kind: 'not-executed', message: 'No element' } }), 't1');
  await assert.rejects(failing.page.getByText('Later').click(),
    error => error.name === 'RunnerError' && error.code === 'TARGET_NOT_FOUND' && error.kind === 'not-executed');
});

test('ops are allowlisted with strict argument shapes; input ops never render a snapshot', () => {
  const refused = (op, args, pattern) => assert.throws(() => validateOp(op, args), error => error.code === 'INVALID_RUNNER_OP' && pattern.test(error.message));
  refused('revoke', {}, /disallowed/);
  refused('handoff', { tabId: 't1' }, /disallowed/);
  refused('__proto__', {}, /disallowed/);
  refused('evaluate', { tabId: 't1', expression: '1', world: 'page' }, /world is not allowed/);
  refused('click', { tabId: 't1', loc: { ref: 'e1' }, point: { x: 1, y: 1 } }, /point is not allowed/);
  refused('click', { tabId: 'x', loc: { ref: 'e1' } }, /tabId/);
  refused('click', { tabId: 't1' }, /locator is required/);
  refused('click', { tabId: 't1', loc: { target: { name: 'a', xpath: '//a' } } }, /target.xpath/);
  refused('click', { tabId: 't1', loc: { ref: 'e1', target: {} } }, /loc must be/);
  refused('wait', { tabId: 't1', text: 'a', gone: 'b' }, /exactly one/);
  refused('click', { tabId: 't1', loc: { ref: 'e1' }, timeoutMs: 60000 }, /timeoutMs/);
  assert.deepEqual(validateOp('click', { tabId: 't1', loc: { target: { role: 'button', name: 'Go' } } }),
    { action: 'click', tabId: 't1', target: { role: 'button', name: 'Go' }, snapshot: 'none' });
  assert.deepEqual(validateOp('find', { tabId: 't1', query: 'Sign in' }), { action: 'observe', tabId: 't1', find: 'Sign in' });
  assert.deepEqual(validateOp('wait', { tabId: 't1', gone: 'Loading', timeoutMs: 0 }),
    { action: 'observe', tabId: 't1', wait: { gone: 'Loading', timeoutMs: 1 } });
});

test('a not-executed step is catchable and auto-wait retries only absent or unactionable targets within the timeout', async () => {
  let attempts = 0;
  const bridge = new RunnerBridge({ caller: caller(), deadline: Date.now() + 10000, execute: async args => {
    if (args.target?.name === 'Late' && ++attempts < 3) throw hostError('TARGET_NOT_FOUND', { requestedInputDispatched: false });
    if (args.target?.name === 'Never') throw hostError('TARGET_NOT_FOUND', { requestedInputDispatched: false });
    if (args.target?.name === 'Twice') throw hostError('AMBIGUOUS_TARGET', { requestedInputDispatched: false, candidates: ['e1 button "Twice"', 'e2 button "Twice"'] });
    return { action: args.action, disposition: 'executed', tabId: 't1', ref: 'e7' };
  } });
  assert.deepEqual(await bridge.handle('click', { tabId: 't1', loc: { target: { name: 'Late' } } }), { ok: true, value: { ref: 'e7' } });
  assert.equal(attempts, 3);
  const started = Date.now();
  const never = await bridge.handle('click', { tabId: 't1', loc: { target: { name: 'Never' } }, timeoutMs: 300 });
  assert.deepEqual([never.ok, never.error.code, never.error.kind], [false, 'TARGET_NOT_FOUND', 'not-executed']);
  assert.ok(Date.now() - started >= 200 && Date.now() - started < 1000);
  const ambiguous = await bridge.handle('click', { tabId: 't1', loc: { target: { name: 'Twice' } } });
  assert.equal(ambiguous.error.code, 'AMBIGUOUS_TARGET', 'ambiguity fails at once');
  assert.equal(ambiguous.error.candidates.length, 2);
  assert.equal(bridge.sealed, null, 'not-executed steps never end the run');
  assert.deepEqual(bridge.steps.map(step => step.outcome), ['executed', 'not-executed', 'not-executed']);
});

test('an uncertain step seals the bridge: every later op is refused, even read-only ones', async () => {
  const sent = [];
  const bridge = new RunnerBridge({ caller: caller(), deadline: Date.now() + 10000, execute: async args => {
    sent.push(args.action);
    return { action: args.action, disposition: 'uncertain', tabId: 't1', replaySafe: false, code: 'DISPATCH_FAILED' };
  } });
  const first = await bridge.handle('click', { tabId: 't1', loc: { ref: 'e1' } });
  assert.deepEqual([first.ok, first.error.kind], [false, 'uncertain']);
  assert.deepEqual(await bridge.ended, { status: 'uncertain', code: 'DISPATCH_FAILED', message: undefined });
  for (const [op, args] of [['click', { tabId: 't1', loc: { ref: 'e2' } }], ['read', { tabId: 't1', loc: { ref: 'e2' } }], ['tabs', {}]]) {
    assert.equal((await bridge.handle(op, args)).error.code, 'RUN_SEALED');
  }
  assert.deepEqual(sent, ['click'], 'nothing reaches the browser after the seal');
});

test('Stop and handoff end the run; an executed step that reports a code is catchable and counts as executed', async () => {
  // The host's pause reason tells Stop from a handoff (or another pause).
  for (const [code, paused, status, sealedCode] of [['AUTOMATION_PAUSED', 'explicit-stop', 'stopped', 'AUTOMATION_PAUSED'],
    ['AUTOMATION_PAUSED', 'human-handoff', 'handoff', 'PRIVATE_HANDOFF'], ['AUTOMATION_PAUSED', 'unexpected-page-input', 'paused', 'AUTOMATION_PAUSED'],
    ['PRIVATE_HANDOFF', undefined, 'handoff', 'PRIVATE_HANDOFF']]) {
    const bridge = new RunnerBridge({ caller: caller(), deadline: Date.now() + 10000,
      execute: async () => { throw hostError(code, { requestedInputDispatched: false, ...(paused ? { paused } : {}) }); } });
    assert.equal((await bridge.handle('click', { tabId: 't1', loc: { ref: 'e1' } })).error.code, code);
    assert.deepEqual([bridge.sealed.status, bridge.sealed.code], [status, sealedCode]);
    assert.equal((await bridge.handle('tabs', {})).error.code, 'RUN_SEALED');
  }
  const bridge = new RunnerBridge({ caller: caller(), deadline: Date.now() + 10000,
    execute: async args => ({ action: args.action, disposition: 'executed', tabId: 't1', code: 'PAGE_SCRIPT_ERROR' }) });
  const reply = await bridge.handle('evaluate', { tabId: 't1', expression: 'throw 1' });
  assert.deepEqual([reply.error.kind, reply.error.code, bridge.executedAny, bridge.sealed], ['executed', 'PAGE_SCRIPT_ERROR', true, null]);
});

test('a run executes a multi-step form flow in one call and reports steps, return value, console and final views', async () => {
  const sent = [];
  const page = { name: '', status: 'draft', saved: '' };
  const execute = async (args, runCaller) => {
    assert.equal(runCaller.sessionId, 'runner-owner');
    sent.push(args);
    if (args.action === 'list_tabs') return { tabs: [{ tabId: 't1', mode: 'automation', paused: null }] };
    if (args.action === 'fill') page.name = args.text;
    if (args.action === 'select') page.status = args.values[0];
    if (args.action === 'click') page.saved = JSON.stringify({ name: page.name, status: page.status });
    if (args.action === 'read') return { action: 'read', disposition: 'observed', tabId: 't1', text: `text ${JSON.stringify(page.saved)}` };
    return { action: args.action, disposition: 'executed', tabId: 't1', ref: 'e3' };
  };
  const report = await runScript({
    script: `
      await page.getByLabel('Task name').fill('Runner task');
      await page.getByLabel('Status').selectOption('ready');
      await page.getByRole('button', { name: 'Save' }).click();
      console.log('saved', 1);
      return JSON.parse(await page.getByRole('status').innerText());`,
    tabId: 't1', execute, caller: caller(), createSandbox: fakeSandbox(), finalView: async tabId => `final view of ${tabId}`,
  });
  assert.deepEqual(page, { name: 'Runner task', status: 'ready', saved: '{"name":"Runner task","status":"ready"}' });
  assert.deepEqual([report.disposition, report.status, report.code, report.replaySafe], ['executed', 'ok', undefined, false]);
  const lines = report.text.split('\n');
  assert.match(lines[0], /^run ok 4 steps \d+ ms$/);
  assert.match(lines[1], /^1 executed fill t1 "Task name" text\(11\) \d+ms$/);
  assert.ok(lines.slice(1, 5).every(line => !line.includes('Runner task')), 'typed text is never echoed in step lines');
  assert.ok(lines.includes('return {"name":"Runner task","status":"ready"}'));
  assert.ok(lines.includes('info saved 1'));
  assert.deepEqual(lines.slice(-2), ['-- t1', 'final view of t1']);
  assert.ok(sent.filter(args => args.action !== 'list_tabs').every(args => args.action === 'read' || args.snapshot === 'none'));
});

test('a caught uncertain step ends the run sealed; the next op is refused and never sent', async () => {
  const sent = [];
  const execute = async args => {
    if (args.action === 'list_tabs') return { tabs: [] };
    sent.push(args.target?.name ?? args.action);
    return { action: args.action, disposition: args.target?.name === 'Pay' ? 'uncertain' : 'executed', tabId: 't1', replaySafe: false };
  };
  const report = await runScript({
    script: `try { await page.getByText('Pay').click(); } catch (error) { await page.getByText('Pay again').click(); }
      return 'unreachable';`,
    tabId: 't1', execute, caller: caller(), createSandbox: fakeSandbox(),
  });
  assert.deepEqual(sent, ['Pay']);
  assert.deepEqual([report.disposition, report.status, report.replaySafe], ['uncertain', 'uncertain', false]);
  assert.match(report.text, /^run uncertain /);
  assert.ok(!report.text.includes('unreachable'));
});

test('the deadline, Stop seen by the watch, and caller cancellation end a run and destroy its sandbox', async () => {
  const quiet = async args => (args.action === 'list_tabs' ? { tabs: [{ tabId: 't1', mode: 'automation', paused: null }] }
    : { action: args.action, disposition: 'executed', tabId: 't1' });
  let log = [];
  let started = Date.now();
  const deadline = await runScript({ script: 'await new Promise(() => {});', tabId: 't1', timeoutMs: RUN_LIMITS.minMs,
    execute: quiet, caller: caller(), createSandbox: fakeSandbox(log) });
  assert.deepEqual([deadline.status, deadline.code, deadline.disposition, log], ['deadline', 'RUN_DEADLINE', 'not-executed', ['destroyed']]);
  assert.ok(Date.now() - started >= 950 && Date.now() - started < 2500);

  let polls = 0;
  const stopping = async args => {
    if (args.action === 'list_tabs') return { tabs: [{ tabId: 't1', mode: 'automation', paused: ++polls > 2 ? 'explicit-stop' : null }] };
    return { action: args.action, disposition: 'executed', tabId: 't1' };
  };
  log = [];
  const stopped = await runScript({ script: 'for (;;) await sleep(20);', tabId: 't1', execute: stopping, caller: caller(),
    createSandbox: fakeSandbox(log), watchMs: 20 });
  assert.deepEqual([stopped.status, stopped.code, log], ['stopped', 'AUTOMATION_PAUSED', ['destroyed']]);

  const handoff = await runScript({ script: 'for (;;) await sleep(20);', tabId: 't1', caller: caller(), createSandbox: fakeSandbox(), watchMs: 20,
    execute: async args => (args.action === 'list_tabs' ? { tabs: [{ tabId: 't1', mode: 'native-handoff', paused: 'human-handoff' }] } : {}) });
  assert.equal(handoff.status, 'handoff');

  const owner = caller();
  started = Date.now();
  setTimeout(() => owner.controller.abort(new Error('caller ended')), 100);
  const cancelled = await runScript({ script: 'for (;;) await sleep(20);', tabId: 't1', execute: quiet, caller: owner, createSandbox: fakeSandbox() });
  assert.deepEqual([cancelled.status, cancelled.code], ['cancelled', 'CANCELLED']);
  assert.ok(Date.now() - started < 1000);
});

test('script errors, a syntax error, invalid run arguments and clipped output are reported without retries', async () => {
  const execute = async args => (args.action === 'list_tabs' ? { tabs: [] } : (() => { throw hostError('TARGET_NOT_FOUND', { requestedInputDispatched: false }); })());
  const uncaught = await runScript({ script: "await page.getByText('Missing').click({ timeout: 0 });", tabId: 't1', execute, caller: caller(), createSandbox: fakeSandbox() });
  assert.deepEqual([uncaught.status, uncaught.code, uncaught.disposition], ['error', 'SCRIPT_ERROR', 'not-executed']);
  assert.match(uncaught.text, /^run error 1 step \d+ ms: RunnerError TARGET_NOT_FOUND: /);
  const caught = await runScript({ script: "try { await page.getByText('Missing').click({ timeout: 0 }); } catch (e) { return e.kind; }",
    tabId: 't1', execute, caller: caller(), createSandbox: fakeSandbox() });
  assert.deepEqual([caught.status, caught.disposition], ['ok', 'observed']);
  assert.match(caught.text, /\nreturn "not-executed"/);
  const syntax = await runScript({ script: 'return (', tabId: 't1', execute, caller: caller(), createSandbox: fakeSandbox() });
  assert.deepEqual([syntax.status, syntax.code], ['syntax', 'SCRIPT_SYNTAX']);
  const big = await runScript({ script: "for (let i = 0; i < 100; i++) console.log('x'.repeat(100)); return 'y'.repeat(9000);",
    tabId: 't1', execute, caller: caller(), createSandbox: fakeSandbox() });
  const returned = big.text.split('\n').find(line => line.startsWith('return '));
  assert.ok(returned.length < RUN_LIMITS.returnChars + 40, 'return value clipped to 4k');
  assert.match(big.text, /\+\d+ more console lines/);
  const consoleChars = big.text.split('console:\n')[1].length;
  assert.ok(consoleChars < RUN_LIMITS.consoleChars + 100, 'console clipped to 2k');
  await assert.rejects(runScript({ script: '', execute, caller: caller(), createSandbox: fakeSandbox() }), error => error.code === 'INVALID_RUN');
  await assert.rejects(runScript({ script: '1', timeoutMs: 100001, execute, caller: caller(), createSandbox: fakeSandbox() }),
    error => error.code === 'INVALID_RUN' && error.requestedInputDispatched === false);
});

const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const quietTabs = async args => (args.action === 'list_tabs' ? { tabs: [] } : { action: args.action, disposition: 'executed', tabId: args.tabId ?? 't1' });

test('whatever the bridge accepts the host accepts; invalid input is a catchable refusal that never seals', async () => {
  const samples = [
    ['open', { url: 'http://127.0.0.1/a' }], ['open', { url: 'about:blank' }], ['open', { url: 'file:///C:/x' }], ['open', { url: '/relative' }],
    ['navigate', { tabId: 't1', url: 'https://example.test' }], ['navigate', { tabId: `t${'1'.repeat(200)}`, url: 'https://example.test' }],
    ['press', { tabId: 't1', loc: { ref: 'e1' }, key: 'Enter' }], ['press', { tabId: 't1', loc: { ref: 'e1' }, key: 'F5' }], ['press', { tabId: 't1', key: 'Enter' }],
    ['select', { tabId: 't1', loc: { ref: 'e1' }, values: ['a'] }], ['select', { tabId: 't1', loc: { ref: 'e1' }, values: [''] }],
    ['select', { tabId: 't1', loc: { ref: 'e1' }, values: [] }], ['evaluate', { tabId: 't1', expression: '1' }],
    ['evaluate', { tabId: 't1', expression: 'x'.repeat(65537) }], ['click', { tabId: 't1', loc: { ref: 'e12345678901' } }],
    ['click', { tabId: 't1', loc: { target: { name: 'x', frame: 'e12345678901' } } }], ['click', { tabId: 't1', loc: { target: { name: 'x', frame: 'e2' } } }],
    ['wait', { tabId: 't1', text: 'x'.repeat(501) }], ['wait', { tabId: 't1', text: 'ok', timeoutMs: 10000 }], ['wait', { tabId: 't1', url: 'x', timeoutMs: 10001 }],
    ['find', { tabId: 't1', query: '/a+/' }], ['find', { tabId: 't1', query: '   ' }], ['find', { tabId: 't1', query: 'Sign in' }],
    ['scroll', { tabId: 't1', loc: { ref: 'e1' }, deltaX: 0, deltaY: 100 }], ['upload', { tabId: 't1', loc: { ref: 'e1' }, files: ['C:\\a.txt'] }],
    ['dialog', { tabId: 't1', accept: true }], ['tabs', {}], ['close', { tabId: 't1' }], ['read', { tabId: 't1', loc: { target: { role: 'status' } } }],
    ['snapshot', { tabId: 't1', mode: 'text' }], ['fill', { tabId: 't1', loc: { ref: 'e1' }, text: '' }],
  ];
  let accepted = 0;
  for (const [op, args] of samples) {
    let browse;
    try { browse = validateOp(op, args); } catch (error) { assert.equal(error.code, 'INVALID_RUNNER_OP', `${op} ${JSON.stringify(args).slice(0, 80)}`); continue; }
    accepted++;
    assert.doesNotThrow(() => validateArgs(browse), `${op}: the host accepts what the bridge accepts`);
  }
  assert.equal(accepted, 16);
  // Refused before the host sees it: catchable, nothing sent, the run goes on.
  const sent = [];
  const bridge = new RunnerBridge({ caller: caller(), deadline: Date.now() + 10000, execute: async args => { sent.push(args.action); return { disposition: 'executed' }; } });
  for (const [op, args] of [['press', { tabId: 't1', loc: { ref: 'e1' }, key: 'F5' }], ['navigate', { tabId: 't1', url: 'file:///C:/x' }],
    ['select', { tabId: 't1', loc: { ref: 'e1' }, values: [''] }], ['evaluate', { tabId: 't1', expression: 'x'.repeat(65537) }],
    ['click', { tabId: 't1', loc: { ref: 'e12345678901' } }], ['navigate', { tabId: `t${'1'.repeat(200)}`, url: 'https://example.test' }]]) {
    const reply = await bridge.handle(op, args);
    assert.deepEqual([reply.ok, reply.error.code, reply.error.kind], [false, 'INVALID_RUNNER_OP', 'not-executed'], op);
  }
  assert.deepEqual([sent, bridge.sealed, bridge.executedAny], [[], null, false]);
  const report = await runScript({ script: "try { await page.getByRole('textbox').press('F5'); } catch (error) { return [error.kind, typeof page.press]; }",
    tabId: 't1', execute: quietTabs, caller: caller(), createSandbox: fakeSandbox() });
  assert.deepEqual([report.status, report.disposition], ['ok', 'observed']);
  assert.match(report.text, /\nreturn \["not-executed","undefined"\]/, 'Page.press is gone; Locator.press stays');
});

test('floods are bounded: ops per run, ops in flight, tabs that join the run, console lines, final views and the report', async () => {
  const sent = [];
  const bridge = new RunnerBridge({ caller: caller(), deadline: Date.now() + 60000, execute: async args => { sent.push(args.action); return { tabs: [] }; } });
  for (let i = 0; i < RUNNER_FLOOD.ops; i++) await bridge.handle(i % 2 ? 'tabs' : 'refused-op', {});
  assert.equal(bridge.sealed, null);
  assert.equal((await bridge.handle('tabs', {})).error.code, 'RUN_LIMIT', 'refused ops count too');
  assert.deepEqual([bridge.sealed.status, bridge.sealed.code, sent.length], ['limit', 'RUN_LIMIT', RUNNER_FLOOD.ops / 2]);

  const gate = held();
  const busy = new RunnerBridge({ caller: caller(), deadline: Date.now() + 60000, execute: async () => { await gate.promise; return { tabs: [] }; } });
  const flights = Array.from({ length: RUNNER_FLOOD.inFlight + 1 }, () => busy.handle('tabs', {}));
  assert.equal((await flights.at(-1)).error.code, 'RUN_BUSY');
  gate.release();
  assert.ok((await Promise.all(flights.slice(0, -1))).every(reply => reply.ok));

  const joined = new RunnerBridge({ caller: caller(), deadline: Date.now() + 60000, tabs: ['t1'], execute: async args => {
    if (args.tabId === 't9') throw hostError('FOREIGN_TAB', { requestedInputDispatched: false });
    return { action: 'read', disposition: 'observed', tabId: args.tabId, text: 'text ""' };
  } });
  await joined.handle('read', { tabId: 't9', loc: { ref: 'e1' } });
  await joined.handle('read', { tabId: 't2', loc: { ref: 'e1' } });
  assert.deepEqual([...joined.touched], ['t1', 't2'], 'a foreign tab never joins the run');

  let opened = 1;
  const openMany = async args => (args.action === 'list_tabs' ? { tabs: [] } : { action: 'open', disposition: 'executed', tabId: `t${++opened}` });
  const script = "console.log('z'.repeat(1000000)); console.log('a\\u0085b\\u202ec'); for (let i = 0; i < 6; i++) await open('http://127.0.0.1/' + i); return 1;";
  const short = await runScript({ script, tabId: 't1', caller: caller(), createSandbox: fakeSandbox(), execute: openMany, finalView: async tabId => `view ${tabId}` });
  const lines = short.text.split('\n');
  const consoleAt = lines.indexOf('console:');
  assert.ok(lines[consoleAt + 1].length <= RUN_LIMITS.consoleLineChars, 'a huge console message is sliced first');
  assert.equal(lines[consoleAt + 2], 'info a\\u0085b\\u202ec');
  assert.deepEqual(lines.filter(line => line.startsWith('-- ')), ['-- t1', '-- t2', '-- t3', '-- t4',
    '-- t5 not shown: observe t5', '-- t6 not shown: observe t6', '-- t7 not shown: observe t7']);
  opened = 1;
  const long = await runScript({ script, tabId: 't1', caller: caller(), createSandbox: fakeSandbox(), execute: openMany,
    finalView: async tabId => `view ${tabId}\n${'line of the page\n'.repeat(2000)}` });
  const views = long.text.split('\n').filter(line => line.startsWith('-- '));
  assert.deepEqual(views.slice(0, 3), ['-- t1', '-- t2', '-- t3 not shown: observe t3'], 'views share one character budget');
  assert.match(long.text, /\n\+\d+ more characters \(observe t1\)\n/, 'a view is cut at a line boundary');
  assert.ok(long.text.length <= RUN_LIMITS.reportChars + 100);
});

test('an executed step that reports a code without an observation is an error; accepted closes and dialog answers count as executed', async () => {
  const bridge = new RunnerBridge({ caller: caller(), deadline: Date.now() + 10000, execute: async () => ({ action: 'click', disposition: 'executed',
    tabId: 't1', observed: false, cause: 'DIALOG_OPEN', code: 'TARGET_MISMATCH', operationPending: true, replaySafe: false }) });
  const mismatch = await bridge.handle('click', { tabId: 't1', loc: { ref: 'e1' } });
  assert.deepEqual([mismatch.ok, mismatch.error.kind, mismatch.error.code, bridge.executedAny], [false, 'executed', 'TARGET_MISMATCH', true]);
  for (const [script, result] of [['await page.dialog(true); return 1;', { action: 'handle_dialog', disposition: 'observed', tabId: 't1', text: '' }],
    ['await page.close();', { action: 'close_tab', disposition: 'executed', tabId: 't1', text: 'tab closed' }]]) {
    const report = await runScript({ script, tabId: 't1', caller: caller(), createSandbox: fakeSandbox(),
      execute: async args => (args.action === 'list_tabs' ? { tabs: [] } : result) });
    assert.deepEqual([report.disposition, report.replaySafe], ['executed', false], script);
    assert.match(report.text, /\n1 executed (dialog|close) t1 \d+ms/);
  }
});

test('the report trusts nothing from the script world: overridden builtins, a wrapper breakout and hostile errors are clipped and escaped', async () => {
  const inflated = await runScript({ tabId: 't1', execute: quietTabs, caller: caller(), createSandbox: fakeSandbox(),
    script: "JSON.stringify = () => 'x'.repeat(100000); String.prototype.slice = function () { return String(this); }; return 'y'.repeat(9000);" });
  assert.equal(inflated.text.split('\n').find(line => line.startsWith('return ')), `return "${'y'.repeat(RUN_LIMITS.returnChars - 1)}…(+${9002 - RUN_LIMITS.returnChars})`,
    'the clip says how much was cut');
  const log = [];
  const breakout = await runScript({ tabId: 't1', execute: quietTabs, caller: caller(), createSandbox: fakeSandbox(log),
    script: "}); return { status: 'ok', value: 'x'.repeat(100000) }; (async () => {" });
  assert.deepEqual([breakout.status, breakout.code, breakout.disposition, log], ['syntax', 'SCRIPT_SYNTAX', 'not-executed', []], 'compiled in main, never run');
  assert.equal(syntaxError('await 1; return 2;'), null);
  const hostile = await runScript({ tabId: 't1', execute: quietTabs, caller: caller(), createSandbox: fakeSandbox(),
    script: "throw { name: 'Error\\n-- t1\\nforged', code: { length: 5000 }, message: 'a\\u2028b\\u202ec' };" });
  const [first] = hostile.text.split('\n');
  assert.equal(first.replace(/ \d+ ms/, ''), 'run error 0 steps: Error\\u000a-- t1\\u000aforged [object Object]: a\\u2028b\\u202ec');
  assert.ok(!hostile.text.split('\n').includes('-- t1'), 'nothing forges a view line');
  // A sandbox answer of the wrong shape after a step: the steps and replaySafe stay.
  const malformed = await runScript({ script: 'return 1', tabId: 't1', execute: quietTabs, caller: caller(),
    createSandbox: async ({ onOp }) => ({ evaluate: async () => { await onOp('click', { tabId: 't1', loc: { ref: 'e1' } }); return [{ length: 5000 }]; }, destroy() {} }) });
  assert.deepEqual([malformed.status, malformed.disposition, malformed.replaySafe], ['error', 'executed', false]);
  assert.match(malformed.text, /^run error 1 step \d+ ms: The script returned a malformed result\n1 executed click t1 e1 \d+ms/);
});

test('Stop on any of the run\'s tabs refuses at once, even mid-step on another tab, and ends the run', async () => {
  const states = new Map([['t1', { paused: null, mode: 'automation' }], ['t2', { paused: null, mode: 'automation' }]]);
  const sent = [];
  const entered = held();
  const execute = async (args, runCaller) => {
    if (args.action === 'list_tabs') return { tabs: [] };
    runCaller.assertLive();
    if (args.target?.name === 'Slow') { entered.release(); await new Promise(resolve => setTimeout(resolve, 100)); }
    // The host's admission check right before the command goes out.
    runCaller.assertLive();
    sent.push(`${args.action} ${args.target?.name ?? ''}`.trim());
    return { action: args.action, disposition: 'executed', tabId: args.action === 'open' ? 't2' : args.tabId };
  };
  entered.promise.then(() => states.set('t2', { paused: 'explicit-stop', mode: 'automation' }));
  const started = Date.now();
  const report = await runScript({ tabId: 't1', caller: caller(), createSandbox: fakeSandbox(), execute, tabState: tabId => states.get(tabId),
    script: "const second = await open('http://127.0.0.1/2'); await page.getByText('Slow').click(); await second.getByText('Never').click(); return 'unreachable';" });
  assert.deepEqual(sent, ['open'], 'the step in flight on t1 is refused before dispatch once t2 is stopped');
  assert.deepEqual([report.status, report.code, report.disposition], ['stopped', 'AUTOMATION_PAUSED', 'executed']);
  assert.match(report.text, /\n2 aborted click t1 "Slow" code=AUTOMATION_PAUSED \d+ms/);
  assert.ok(Date.now() - started < 1500);
  // A caller that already ended runs nothing: no sandbox.
  const ended = caller();
  ended.controller.abort(new Error('caller ended'));
  let created = 0;
  await assert.rejects(runScript({ script: '1', tabId: 't1', execute: quietTabs, caller: ended, createSandbox: async () => { created++; } }));
  assert.equal(created, 0);
});

test('a step still in flight at the deadline is unknown; the final views share one budget inside the gateway call', async () => {
  const hung = await runScript({ script: "await page.getByText('Hang').click();", tabId: 't1', timeoutMs: RUN_LIMITS.minMs, caller: caller(),
    createSandbox: fakeSandbox(), execute: async args => (args.action === 'list_tabs' ? { tabs: [] } : new Promise(() => {})) });
  assert.deepEqual([hung.status, hung.disposition, hung.replaySafe], ['deadline', 'uncertain', false]);
  assert.match(hung.text, /\n1 unknown click t1 "Hang" \d+ms/);
  // 113 s have passed: 2 s are left for the views, which hang until aborted.
  let calls = 0;
  const started = Date.now();
  const late = await runScript({ script: "await open('http://127.0.0.1/2');", tabId: 't1', caller: caller(), createSandbox: fakeSandbox(),
    now: () => Date.now() + (calls++ > 0 ? 113000 : 0),
    execute: async args => (args.action === 'list_tabs' ? { tabs: [] } : { action: 'open', disposition: 'executed', tabId: 't2' }),
    finalView: (_tabId, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  assert.deepEqual(late.text.split('\n').filter(line => line.startsWith('-- ')), ['-- t1 not shown: observe t1', '-- t2 not shown: observe t2']);
  assert.ok(Date.now() - started >= 1800 && Date.now() - started < 4000);
});
