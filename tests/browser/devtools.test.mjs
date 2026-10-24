import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVTOOLS_LIMITS, DevToolsRecorder, PrivacyWindows, pageRead, redactBody, redactHeaders, redactURL, responseBody,
} from '../../src/browser/devtools.mjs';

function recorder(types = {}) {
  const state = { mode: 'automation' };
  const devtools = new DevToolsRecorder(() => state.mode, sessionId => types[sessionId]);
  return { devtools, state };
}
const log = (devtools, value, extra = {}, sessionId) => devtools.record('Runtime.consoleAPICalled', {
  type: 'log', args: [{ type: 'string', value }], timestamp: Date.now(), ...extra,
}, sessionId);
function request(devtools, requestId, url, extra = {}, sessionId) {
  devtools.record('Network.requestWillBeSent', {
    requestId, request: { url, method: 'GET', headers: {}, ...extra.request }, type: extra.type ?? 'Fetch',
    timestamp: 10, wallTime: Date.now() / 1000, initiator: { type: 'script' }, ...extra.params,
  }, sessionId);
}
const respond = (devtools, requestId, status, extra = {}, sessionId) => devtools.record('Network.responseReceived', {
  requestId, type: 'Fetch', response: { status, statusText: 'S', mimeType: 'application/json', headers: {}, ...extra },
}, sessionId);
const finish = (devtools, requestId, sessionId) => devtools.record('Network.loadingFinished', { requestId, timestamp: 10.25, encodedDataLength: 120 }, sessionId);

test('recording starts on every attached session, with network buffers bounded per page', () => {
  const { devtools } = recorder();
  const page = devtools.attach(undefined, 'page');
  const MiB = 1024 * 1024;
  assert.deepEqual(page.map(([method]) => method), ['Network.enable', 'Log.enable', 'Performance.enable']);
  assert.deepEqual(page[0][1], { maxTotalBufferSize: 6 * MiB, maxResourceBufferSize: MiB, maxPostDataSize: 65536 });
  assert.deepEqual(devtools.attach('frame', 'iframe').map(([method]) => method), ['Network.enable', 'Log.enable']);
  assert.deepEqual(devtools.attach('w', 'service_worker').map(([method]) => method), ['Runtime.enable', 'Network.enable', 'Log.enable']);
  for (const [method, params] of page) assert.doesNotMatch(JSON.stringify([method, params]), /cache|intercept|pause|emulat|throttl/i);
  // 6 MiB main + 1 MiB per session until the 10 MiB page total is spent.
  const sizes = ['a', 'b', 'c'].map(id => devtools.attach(id, 'iframe')[0][1].maxTotalBufferSize);
  assert.deepEqual(sizes, [MiB, MiB, 0]);
  assert.equal(devtools.attach('c', 'iframe')[0][1].maxResourceBufferSize, 0);
  devtools.detach('frame');
  assert.equal(devtools.attach('d', 'iframe')[0][1].maxTotalBufferSize, MiB, 'A detached session returns its budget');
  // Re-attaching the main session reuses its own share.
  assert.equal(devtools.attach(undefined, 'page')[0][1].maxTotalBufferSize, 6 * MiB);
});

test('redaction is linear on 64 KiB adversarial page text', () => {
  const inputs = [
    'a'.repeat(65536), `{${'a'.repeat(65535)}`, 'a.'.repeat(32768), 'password'.repeat(8192), 'pass='.repeat(13107),
    'a:"'.repeat(21845), 'eyJ-'.repeat(16384), 'eyJa.'.repeat(13107), 'Bearer '.repeat(9362), 'https://a/?'.repeat(5957),
    'name="password"\n'.repeat(4096), 'Content-Disposition: form-data; name="pass"\n'.repeat(1489), `${'['.repeat(32768)}${']'.repeat(32768)}`,
    ` ${' '.repeat(65534)}:`, `token${' '.repeat(65530)}`, '&'.repeat(65536), 'a=&'.repeat(21845),
  ];
  for (const input of inputs) {
    for (const run of [() => redactBody(input, DEVTOOLS_LIMITS.requestBody), () => redactBody(input, DEVTOOLS_LIMITS.maxChars),
      () => redactURL(`http://h/?q=${input}`), () => redactHeaders({ 'X-Note': input, Location: input, Link: input, Refresh: `0; url=${input}` })]) {
      const started = performance.now();
      run();
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 250, `${elapsed.toFixed(0)} ms for ${JSON.stringify(input.slice(0, 24))}`);
    }
  }
  const { devtools } = recorder();
  const started = performance.now();
  for (const input of inputs) {
    request(devtools, `r${input.length}${input[0]}`, 'http://127.0.0.1/', { request: { method: 'POST', postData: input, hasPostData: true, headers: { 'X-Note': input } } });
    log(devtools, input);
    devtools.record('Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: { text: input, exception: { description: input } } });
  }
  assert.ok(performance.now() - started < 1000, 'Recording adversarial events stays fast');
});

test('console rows are compact: formatted messages, levels, locations, exceptions, browser log and repeats', () => {
  const { devtools } = recorder({ w: 'worker' });
  devtools.record('Runtime.consoleAPICalled', { type: 'log', timestamp: Date.now(), args: [
    { type: 'string', value: 'count %d of %s%c' }, { type: 'number', value: 3 }, { type: 'string', value: 'x' }, { type: 'string', value: 'color:red' },
    { type: 'object', className: 'Object', preview: { type: 'object', description: 'Object', overflow: false, properties: [{ name: 'a', type: 'number', value: '1' }] } },
  ], stackTrace: { callFrames: [{ url: 'http://127.0.0.1/app.js?token=SECRET', lineNumber: 4, columnNumber: 2, functionName: 'f' }] } });
  devtools.record('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'careful' }], timestamp: Date.now() }, 'w');
  devtools.record('Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: {
    text: 'Uncaught', url: 'http://127.0.0.1/app.js', lineNumber: 9, columnNumber: 0,
    exception: { description: 'Error: boom\n    at a (app.js:10:1)' },
    stackTrace: { callFrames: [
      { functionName: 'a', url: 'http://127.0.0.1/app.js', lineNumber: 9, columnNumber: 0 },
      { functionName: '', url: 'http://127.0.0.1/app.js', lineNumber: 20, columnNumber: 4 },
    ] },
  } });
  request(devtools, 'r1', 'http://127.0.0.1/missing');
  devtools.record('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource: 404', timestamp: Date.now(), url: 'http://127.0.0.1/missing', networkRequestId: 'r1' } });
  for (let i = 0; i < 3; i++) log(devtools, 'tick');
  log(devtools, 'x'.repeat(400));
  const { rows, next } = devtools.consoleRows({});
  assert.deepEqual(rows[0], { i: 1, msg: 'count 3 of x Object {a: 1}', at: 'http://127.0.0.1/app.js?token=%5Bredacted%5D:5:3' });
  assert.deepEqual(rows[1], { i: 2, lv: 'warn', msg: 'careful', in: 'worker' });
  assert.deepEqual(rows[2], { i: 3, lv: 'error', k: 'exception', msg: 'Uncaught Error: boom', at: 'http://127.0.0.1/app.js:10:1',
    stack: ['a@http://127.0.0.1/app.js:10:1', '(anonymous)@http://127.0.0.1/app.js:21:5'] });
  assert.deepEqual(rows[3], { i: 4, lv: 'error', k: 'network', msg: 'Failed to load resource: 404', at: 'http://127.0.0.1/missing:1', req: 'n1' });
  assert.deepEqual(rows[4], { i: 7, msg: 'tick', n: 3 });
  assert.equal(rows[5].msg, `${'x'.repeat(DEVTOOLS_LIMITS.message)}…(+100)`);
  assert.equal(next, 8);
});

test('console cursors return only new rows, page forward without gaps and filter server-side', () => {
  const { devtools } = recorder();
  for (let i = 1; i <= 40; i++) log(devtools, `m${i}`, i % 10 === 0 ? { type: 'error' } : {});
  const tail = devtools.consoleRows({});
  assert.equal(tail.rows.length, DEVTOOLS_LIMITS.rows);
  assert.equal(tail.rows[0].msg, 'm11');
  assert.equal(tail.omitted, 10);
  assert.equal(tail.next, 40);
  assert.deepEqual(devtools.consoleRows({ since: tail.next }), { next: 40 });
  log(devtools, 'later');
  assert.deepEqual(devtools.consoleRows({ since: tail.next }).rows, [{ i: 41, msg: 'later' }]);
  const first = devtools.consoleRows({ since: 0, limit: 25 });
  assert.equal(first.rows.at(-1).msg, 'm25');
  assert.equal(first.next, 25);
  assert.equal(devtools.consoleRows({ since: first.next, limit: 25 }).rows[0].msg, 'm26');
  assert.deepEqual(devtools.consoleRows({ filter: 'level:error' }).rows.map(row => row.msg), ['m10', 'm20', 'm30', 'm40']);
  assert.deepEqual(devtools.consoleRows({ filter: 'level:error m3' }).rows.map(row => row.msg), ['m30']);
  assert.throws(() => devtools.consoleRows({ filter: 'level:fatal' }), error => error.code === 'INVALID_ARGUMENT');
});

test('network rows carry status, failures and cache flags; details redact secrets; filters run server-side', () => {
  const { devtools } = recorder();
  request(devtools, 'a', 'http://127.0.0.1/api/ok?q=1&access_token=SECRET', { request: {
    method: 'POST', headers: { Cookie: 'sid=SECRET', Authorization: 'Bearer SECRET', 'X-Api-Key': 'SECRET', Accept: 'application/json' },
    postData: '{"user":"alice","password":"SECRET","nested":{"otp":"123456"}}', hasPostData: true,
  } });
  respond(devtools, 'a', 200, { headers: { 'Set-Cookie': 'sid=SECRET', 'Content-Type': 'application/json' } });
  finish(devtools, 'a');
  request(devtools, 'b', 'http://127.0.0.1/missing');
  respond(devtools, 'b', 404, { mimeType: 'text/html', fromDiskCache: true });
  finish(devtools, 'b');
  request(devtools, 'c', 'http://127.0.0.1/blocked', { type: 'Script' });
  devtools.record('Network.loadingFailed', { requestId: 'c', timestamp: 10.1, errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'inspector' });
  request(devtools, 'd', 'http://127.0.0.1/form', { request: { method: 'POST', postData: 'name=a&pass=SECRET&csrf_token=SECRET', hasPostData: true } });
  const { rows, next } = devtools.networkRows({});
  assert.deepEqual(rows, [
    { id: 'n1', m: 'POST', u: 'http://127.0.0.1/api/ok?q=1&access_token=%5Bredacted%5D', ty: 'fetch', s: 200, mt: 'application/json', sz: 120, ms: 250 },
    { id: 'n2', u: 'http://127.0.0.1/missing', ty: 'fetch', s: 404, mt: 'text/html', sz: 120, ms: 250, c: 'disk' },
    { id: 'n3', u: 'http://127.0.0.1/blocked', ty: 'script', ms: 100, err: 'blocked:inspector' },
    { id: 'n4', m: 'POST', u: 'http://127.0.0.1/form', ty: 'fetch', st: 'run' },
  ]);
  assert.deepEqual(devtools.networkRows({ filter: 'is:failed' }).rows.map(row => row.id), ['n2', 'n3']);
  assert.deepEqual(devtools.networkRows({ filter: 'status:4xx' }).rows.map(row => row.id), ['n2']);
  assert.deepEqual(devtools.networkRows({ filter: 'type:script' }).rows.map(row => row.id), ['n3']);
  assert.deepEqual(devtools.networkRows({ filter: 'method:post api' }).rows.map(row => row.id), ['n1']);
  assert.deepEqual(devtools.networkRows({ filter: 'is:running' }).rows.map(row => row.id), ['n4']);
  assert.throws(() => devtools.networkRows({ filter: 'status:4x' }), error => error.code === 'INVALID_ARGUMENT');
  const detail = devtools.detail('n1');
  assert.equal(detail.reqHeaders.Cookie, '[redacted]');
  assert.equal(detail.reqHeaders.Authorization, '[redacted]');
  assert.equal(detail.reqHeaders['X-Api-Key'], '[redacted]');
  assert.equal(detail.reqHeaders.Accept, 'application/json');
  assert.equal(detail.resHeaders['Set-Cookie'], '[redacted]');
  assert.deepEqual(JSON.parse(detail.reqBody), { user: 'alice', password: '[redacted]', nested: { otp: '[redacted]' } });
  assert.equal(devtools.detail('n4').reqBody, 'name=a&pass=[redacted]&csrf_token=[redacted]');
  assert.doesNotMatch(JSON.stringify([rows, detail, devtools.detail('n4')]), /SECRET/);
  // Incremental reads return new or changed rows only.
  respond(devtools, 'd', 201);
  finish(devtools, 'd');
  assert.deepEqual(devtools.networkRows({ since: next }).rows.map(row => [row.id, row.s]), [['n4', 201]]);
  assert.throws(() => devtools.detail('n99'), error => error.code === 'UNKNOWN_ENTRY');
  assert.throws(() => devtools.bodyTarget('n3'), error => error.code === 'BODY_UNAVAILABLE');
});

test('redaction rules cover headers, URLs and request bodies by sensitive names', () => {
  assert.deepEqual(redactHeaders({ 'Proxy-Authorization': 'x', 'X-CSRF-Token': 'x', 'X-Session-Id': 'x', 'Content-Type': 'a' }),
    { 'Proxy-Authorization': '[redacted]', 'X-CSRF-Token': '[redacted]', 'X-Session-Id': '[redacted]', 'Content-Type': 'a' });
  assert.equal(redactURL('https://u:p@example.com/a?q=1&api_key=2'), 'https://example.com/a?q=1&api_key=%5Bredacted%5D');
  assert.match(redactBody('--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nSECRET\r\n--b--'), /\[redacted\]/);
  assert.doesNotMatch(redactBody('--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nSECRET\r\n--b--'), /SECRET/);
  assert.doesNotMatch(redactBody('mutation { login(user: "a", password: "SECRET") }'), /SECRET/);
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x-h${i}`, 'v'.repeat(200)]));
  const bounded = redactHeaders(many);
  assert.ok(JSON.stringify(bounded).length < DEVTOOLS_LIMITS.headerBytes + 400);
  assert.match(bounded['…'], /^\+\d+ headers$/);
});

test('nothing generated while the person controls the page is recorded; in-flight requests end incomplete', async () => {
  const { devtools, state } = recorder();
  const later = () => new Promise(resolve => setTimeout(resolve, 5));
  log(devtools, 'before');
  request(devtools, 'flight', 'http://127.0.0.1/slow');
  state.mode = 'draining';
  devtools.boundary();
  await later();
  for (const mode of ['draining', 'native-handoff', 'returning']) {
    state.mode = mode;
    log(devtools, `private ${mode}`);
    request(devtools, `p-${mode}`, 'http://127.0.0.1/login');
    devtools.record('Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: private' } } });
  }
  respond(devtools, 'flight', 200);
  const emittedDuringHandoff = Date.now();
  await later();
  state.mode = 'automation';
  devtools.boundary();
  await later();
  finish(devtools, 'flight');
  // Late delivery of an entry produced during the handoff stays private.
  log(devtools, 'late private', { timestamp: emittedDuringHandoff });
  devtools.record('Network.requestWillBeSent', { requestId: 'late', request: { url: 'http://127.0.0.1/late-private', method: 'GET', headers: {} },
    timestamp: 11, wallTime: emittedDuringHandoff / 1000, initiator: { type: 'other' } });
  log(devtools, 'after');
  const consoleRows = devtools.consoleRows({});
  assert.deepEqual(consoleRows.rows.map(row => row.msg), ['before', 'after']);
  assert.equal(consoleRows.withheld, 7);
  const network = devtools.networkRows({});
  assert.deepEqual(network.rows, [{ id: 'n1', u: 'http://127.0.0.1/slow', ty: 'fetch', st: 'incomplete' }]);
  assert.equal(network.withheld, 4);
  assert.doesNotMatch(JSON.stringify([consoleRows, network, devtools.detail('n1')]), /private|login/);
  assert.throws(() => devtools.bodyTarget('n1'), error => error.code === 'BODY_UNAVAILABLE' && /person in control/.test(error.message));
});

test('a re-attached session never replays earlier entries; buffers are bounded rings', () => {
  const { devtools } = recorder();
  devtools.attach(undefined, 'page');
  const old = Date.now() - 1000;
  log(devtools, 'first', { timestamp: old });
  devtools.attach(undefined, 'page');
  log(devtools, 'first', { timestamp: old });
  log(devtools, 'new');
  assert.deepEqual(devtools.consoleRows({}).rows.map(row => row.msg), ['first', 'new']);
  for (let i = 0; i < DEVTOOLS_LIMITS.console + 5; i++) log(devtools, `r${i}`);
  const result = devtools.consoleRows({ since: 0, limit: 100 });
  assert.equal(result.dropped, 7);
  assert.equal(result.rows[0].msg, 'r5');
  for (let i = 0; i < DEVTOOLS_LIMITS.network + 2; i++) request(devtools, `q${i}`, `http://127.0.0.1/${i}`);
  assert.equal(devtools.networkRows({}).dropped, 2);
  assert.throws(() => devtools.detail('n1'), error => error.code === 'UNKNOWN_ENTRY');
});

test('URL secrets: URL-valued headers, fragments, OAuth/SAML names, Bearer/Basic and JWT-shaped values', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
  const headers = redactHeaders({
    Location: '/auth/callback?code=SECRET&state=SECRET&next=/home', Referer: 'https://idp.example/login?ticket=SECRET#access_token=SECRET&token_type=bearer',
    'Content-Location': 'https://a.example/x?sig=SECRET', Link: '<https://a.example/next?key=SECRET>; rel="next"', Refresh: '0; url=/cb?SAMLResponse=SECRET',
    'Ocp-Apim-Subscription-Key': 'SECRET', DPoP: 'SECRET', 'X-Access-Key': 'SECRET', 'X-Client-Key': 'SECRET',
    'X-Upstream': `Bearer SECRET`, 'X-Debug': `basic SECRET`, 'X-Id': jwt, Accept: 'text/html',
  });
  assert.doesNotMatch(JSON.stringify(headers), /SECRET|c2lnbmF0dXJl/);
  assert.equal(headers.Location, '/auth/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&next=%2Fhome');
  assert.equal(headers.Referer, 'https://idp.example/login?ticket=%5Bredacted%5D#access_token=%5Bredacted%5D&token_type=%5Bredacted%5D');
  assert.equal(headers['X-Upstream'], 'Bearer [redacted]');
  assert.equal(headers.Accept, 'text/html');
  for (const name of ['jwt', 'assertion', 'SAMLResponse', 'sig', 'key', 'ticket', 'code', 'state', 'client_key', 'id_token']) {
    assert.doesNotMatch(redactURL(`https://a.example/?${name}=SECRET`), /SECRET/, name);
  }
  assert.equal(redactURL('https://a.example/app#/route?id_token=SECRET&tab=2'), 'https://a.example/app#/route?id_token=%5Bredacted%5D&tab=2');
  assert.equal(redactURL('https://a.example/app#/route/plain'), 'https://a.example/app#/route/plain');
  assert.equal(redactURL(`https://a.example/?t=${jwt}`), 'https://a.example/?t=%5Bredacted%5D');
  assert.equal(redactURL('https://a.example/?postcode=1&q=x'), 'https://a.example/?postcode=1&q=x');
  assert.doesNotMatch(redactBody(`{"note":"Authorization: Bearer SECRET","t":"${jwt}","redirect":"https://a.example/cb?code=SECRET"}`, 2048), /SECRET|c2lnbmF0dXJl/);
});

test('console text, exceptions and log entries are redacted; agent isolated-world output is not recorded', () => {
  const { devtools } = recorder({ w: 'worker', frame: 'iframe' });
  devtools.record('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true, frameId: 'root' } } });
  devtools.record('Runtime.executionContextCreated', { context: { id: 2, auxData: { isDefault: false, frameId: 'root' } } });
  devtools.record('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true, frameId: 'child' } } }, 'frame');
  log(devtools, 'callback https://a.example/cb?code=SECRET done', { executionContextId: 1 });
  log(devtools, 'agent isolated world', { executionContextId: 2 });
  log(devtools, 'child page world', { executionContextId: 1 }, 'frame');
  log(devtools, 'unknown child world', { executionContextId: 7 }, 'frame');
  log(devtools, 'worker token=SECRET', { executionContextId: 1 }, 'w');
  devtools.record('Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: { executionContextId: 2, text: 'Uncaught', exception: { description: 'Error: agent' } } });
  devtools.record('Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: { executionContextId: 1, text: 'Uncaught',
    exception: { description: 'Error: fetch https://a.example/?access_token=SECRET failed' } } });
  devtools.record('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'GET https://a.example/x?sig=SECRET 404', timestamp: Date.now() } });
  devtools.record('Runtime.executionContextsCleared', {}, 'frame');
  log(devtools, 'after clear', { executionContextId: 1 }, 'frame');
  const rows = devtools.consoleRows({}).rows;
  assert.deepEqual(rows.map(row => row.msg), [
    'callback https://a.example/cb?code=%5Bredacted%5D done', 'child page world', 'worker token=[redacted]',
    'Uncaught Error: fetch https://a.example/?access_token=%5Bredacted%5D failed', 'GET https://a.example/x?sig=%5Bredacted%5D 404',
  ]);
});

test('redirect hops never serve a later hop body; a chain frozen or withheld at handoff stays private', async () => {
  const { devtools, state } = recorder();
  request(devtools, 'chain', 'http://127.0.0.1/start');
  request(devtools, 'chain', 'http://127.0.0.1/final', { params: { redirectResponse: { status: 302, statusText: 'Found', mimeType: 'text/html',
    headers: { Location: '/final?code=SECRET' } } } });
  respond(devtools, 'chain', 200);
  finish(devtools, 'chain');
  assert.deepEqual(devtools.networkRows({}).rows.map(row => [row.u, row.s, row.st]), [
    ['http://127.0.0.1/start', 302, undefined], ['http://127.0.0.1/final', 200, undefined]]);
  assert.equal(devtools.detail('n1').st, 'redirected');
  assert.equal(devtools.detail('n1').resHeaders.Location, '/final?code=%5Bredacted%5D');
  assert.throws(() => devtools.bodyTarget('n1'), error => error.code === 'BODY_UNAVAILABLE' && /redirect/.test(error.message));
  assert.equal(devtools.bodyTarget('n2').requestId, 'chain');
  // A hop running at handoff freezes its chain: later hops never appear.
  request(devtools, 'frozen', 'http://127.0.0.1/a');
  request(devtools, 'withheld', 'http://127.0.0.1/b');
  state.mode = 'native-handoff';
  devtools.boundary();
  await new Promise(resolve => setTimeout(resolve, 3));
  request(devtools, 'private', 'http://127.0.0.1/login');
  state.mode = 'automation';
  devtools.boundary();
  await new Promise(resolve => setTimeout(resolve, 3));
  for (const key of ['frozen', 'private']) {
    request(devtools, key, `http://127.0.0.1/${key}-next?code=SECRET`, { params: { redirectResponse: { status: 302, headers: {} } } });
    respond(devtools, key, 200);
    finish(devtools, key);
  }
  const rows = devtools.networkRows({}).rows;
  assert.deepEqual(rows.slice(2).map(row => [row.u, row.st]), [['http://127.0.0.1/a', 'incomplete'], ['http://127.0.0.1/b', 'incomplete']]);
  assert.doesNotMatch(JSON.stringify(rows), /next|login|SECRET/);
});

test('private windows: profile-shared workers, a backward clock step and a bounded window list only ever drop more', async () => {
  const state = { mode: 'automation', profile: true };
  const shared = new PrivacyWindows(() => state.profile);
  const devtools = new DevToolsRecorder(() => state.mode, sessionId => ({ sw: 'service_worker', w: 'worker' })[sessionId], shared);
  const now = Date.now;
  try {
    log(devtools, 'sw before', {}, 'sw');
    request(devtools, 'sw-flight', 'http://127.0.0.1/sw', {}, 'sw');
    request(devtools, 'page-flight', 'http://127.0.0.1/page');
    state.profile = false; // another page of the profile is in handoff
    devtools.boundary();
    log(devtools, 'PRIVATE sw', {}, 'sw');
    log(devtools, 'page still records');
    log(devtools, 'dedicated worker still records', {}, 'w');
    request(devtools, 'sw-private', 'http://127.0.0.1/PRIVATE', {}, 'sw');
    finish(devtools, 'page-flight');
    // Backward clock step while private: the window widens.
    const stepped = now() - 60000;
    Date.now = () => stepped;
    log(devtools, 'PRIVATE stepped', {}, 'sw');
    Date.now = () => stepped + 10;
    state.profile = true;
    devtools.boundary();
    Date.now = now;
    log(devtools, 'PRIVATE late', { timestamp: stepped + 5 }, 'sw');
    await new Promise(resolve => setTimeout(resolve, 3));
    log(devtools, 'sw after', {}, 'sw');
    const rows = devtools.consoleRows({});
    assert.deepEqual(rows.rows.map(row => row.msg), ['sw before', 'page still records', 'dedicated worker still records', 'sw after']);
    assert.equal(rows.withheld, 3);
    assert.deepEqual(devtools.networkRows({}).rows.map(row => [row.u, row.st]), [['http://127.0.0.1/sw', 'incomplete'], ['http://127.0.0.1/page', undefined]]);
  } finally { Date.now = now; }
  // 40 windows collapse into at most DEVTOOLS_LIMITS.privateWindows; old spans stay covered.
  const windows = new PrivacyWindows(() => state.mode === 'automation');
  const times = [];
  let clock = 1000;
  Date.now = () => clock;
  try {
    for (let i = 0; i < 40; i++) {
      state.mode = 'native-handoff'; windows.update(); times.push(clock + 1); clock += 10;
      state.mode = 'automation'; windows.update(); clock += 10;
    }
  } finally { Date.now = now; }
  assert.ok(times.every(time => windows.holds(time)));
  assert.equal(windows.holds(clock + 100), false);
});

test('response bodies: text is capped, binary reports size and mime only, evicted bodies are explicit', async () => {
  const sent = [];
  const driver = { devtoolsCommand: async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (params.requestId === 'gone') throw new Error('No resource with given identifier found');
    return params.requestId === 'png' ? { body: Buffer.from([1, 2, 3]).toString('base64'), base64Encoded: true }
      : { body: 'y'.repeat(10), base64Encoded: false };
  } };
  assert.deepEqual(await responseBody(driver, { id: 'n1', requestId: 'txt', session: 'frame', mt: 'application/json' }, 4),
    { id: 'n1', mt: 'application/json', size: 10, body: 'yyyy…(+6)' });
  assert.equal(sent[0].sessionId, 'frame');
  assert.deepEqual(await responseBody(driver, { id: 'n2', requestId: 'png', mt: 'image/png' }, 100), { id: 'n2', mt: 'image/png', size: 3, binary: true });
  await assert.rejects(responseBody(driver, { id: 'n3', requestId: 'gone' }, 100), error => error.code === 'BODY_UNAVAILABLE');
});

test('page-world reads are V8 side-effect-free with a timeout and return values or capped previews', async () => {
  const sent = [];
  let reply;
  const driver = {
    pageContext: frameId => frameId === 'child' ? { contextId: 31, sessionId: 'oopif' } : undefined,
    devtoolsCommand: async (method, params, sessionId) => { sent.push({ method, params, sessionId }); return method === 'Runtime.evaluate' ? reply : {}; },
  };
  reply = { result: { type: 'string', value: 'z'.repeat(20) } };
  assert.deepEqual(await pageRead(driver, { expression: 'window.secretGlobal', limit: 5 }), { type: 'string', value: 'zzzzz…(+15)' });
  const evaluation = sent.find(command => command.method === 'Runtime.evaluate');
  assert.equal(evaluation.params.throwOnSideEffect, true);
  assert.equal(evaluation.params.timeout, DEVTOOLS_LIMITS.evaluationMs);
  assert.equal(evaluation.params.returnByValue, false);
  assert.equal(evaluation.params.contextId, undefined);
  assert.ok(sent.some(command => command.method === 'Runtime.releaseObjectGroup'));
  reply = { result: { type: 'object', className: 'Object', objectId: 'o', preview: { type: 'object', description: 'Object', overflow: true,
    properties: [{ name: 'user', type: 'string', value: 'alice' }, { name: 'n', type: 'number', value: '2' }] } } };
  sent.length = 0;
  assert.deepEqual(await pageRead(driver, { expression: 'state', frameId: 'child' }),
    { type: 'object', class: 'Object', preview: 'Object {user: "alice", n: 2, …}' });
  assert.deepEqual([sent[0].params.contextId, sent[0].sessionId], [31, 'oopif']);
  reply = { result: { type: 'undefined' } };
  assert.deepEqual(await pageRead(driver, { expression: 'void 0' }), { type: 'undefined' });
  reply = { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { className: 'EvalError', description: 'EvalError: Possible side-effect in debug-evaluate' } } };
  await assert.rejects(pageRead(driver, { expression: 'localStorage.clear()' }), error => error.code === 'SIDE_EFFECT' && /world:"page"/.test(error.message));
  reply = { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: missing is not defined\n    at <anonymous>:1:1' } } };
  assert.deepEqual(await pageRead(driver, { expression: 'missing' }), { exception: 'ReferenceError: missing is not defined' });
  await assert.rejects(pageRead(driver, { expression: '1', frameId: 'gone' }), error => error.code === 'STALE_FRAME');
  // Long unserializable values and class names are clipped like previews.
  reply = { result: { type: 'bigint', unserializableValue: `${'9'.repeat(100002)}n` } };
  assert.deepEqual(await pageRead(driver, { expression: '10n ** 100000n', limit: 4 }), { type: 'bigint', value: '9999…(+99999)' });
  reply = { result: { type: 'object', className: 'C'.repeat(50), description: 'x' } };
  assert.equal((await pageRead(driver, { expression: 'x', limit: 5 })).class, 'CCCCC…(+45)');
});

test('a page-world read past its timeout is SCRIPT_TIMEOUT; each read releases only its own object group', async () => {
  const groups = [];
  let hang = true;
  const driver = {
    pageContext: () => undefined,
    devtoolsCommand: async (method, params) => {
      if (method === 'Runtime.releaseObjectGroup') { groups.push(['release', params.objectGroup]); return {}; }
      groups.push(['evaluate', params.objectGroup]);
      // V8 reports a terminated evaluation as a protocol error, not exceptionDetails.
      if (hang) throw new Error('Execution was terminated');
      return { result: { type: 'number', value: 1 } };
    },
  };
  await assert.rejects(pageRead(driver, { expression: 'for(;;){}' }), error => error.code === 'SCRIPT_TIMEOUT');
  hang = false;
  assert.deepEqual(await pageRead(driver, { expression: '1' }), { type: 'number', value: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const evaluated = groups.filter(([kind]) => kind === 'evaluate').map(([, group]) => group);
  assert.notEqual(evaluated[0], evaluated[1], 'a unique group per read');
  assert.deepEqual(groups.filter(([kind]) => kind === 'release').map(([, group]) => group).sort(), evaluated.slice().sort());
  // Other protocol failures stay what they are; a cancelled read reports the cancellation.
  driver.devtoolsCommand = async method => { if (method === 'Runtime.evaluate') throw new Error('Target closed'); return {}; };
  await assert.rejects(pageRead(driver, { expression: '1' }), error => error.code === undefined && /Target closed/.test(error.message));
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));
  driver.devtoolsCommand = async method => { if (method === 'Runtime.evaluate') throw new Error('Execution was terminated'); return {}; };
  await assert.rejects(pageRead(driver, { expression: '1' }, controller.signal), /caller cancelled/);
});

test('same-process iframe rows carry in; a frame document reported again by its own session stays one row', () => {
  const { devtools } = recorder({ oopif: 'iframe' });
  devtools.record('Page.frameAttached', { frameId: 'child', parentFrameId: 'main' });
  devtools.record('Runtime.executionContextCreated', { context: { id: 4, auxData: { isDefault: true, frameId: 'child' } } });
  devtools.record('Runtime.executionContextCreated', { context: { id: 3, auxData: { isDefault: true, frameId: 'main' } } });
  log(devtools, 'from child', { executionContextId: 4 });
  log(devtools, 'from main', { executionContextId: 3 });
  assert.deepEqual(devtools.consoleRows({}).rows.map(row => [row.msg, row.in]), [['from child', 'iframe'], ['from main', undefined]]);
  request(devtools, 'sub', 'http://127.0.0.1/sub', { params: { frameId: 'child' } });
  // An out-of-process frame document: requested on the parent session, then on its own.
  request(devtools, 'doc', 'http://localhost:9/frame', { type: 'Document', params: { frameId: 'oop' } });
  request(devtools, 'doc', 'http://localhost:9/frame', { type: 'Document', params: { frameId: 'oop' } }, 'oopif');
  respond(devtools, 'doc', 200, {}, 'oopif');
  finish(devtools, 'doc', 'oopif');
  const rows = devtools.networkRows({}).rows;
  assert.deepEqual(rows.map(row => [row.u, row.in, row.st]), [
    ['http://127.0.0.1/sub', 'iframe', 'run'], ['http://localhost:9/frame', 'iframe', undefined],
  ]);
});

test('style sheets are forgotten with their session and the oldest goes first at the cap', () => {
  const { devtools } = recorder({ oopif: 'iframe' });
  const sheet = (id, sessionId) => devtools.record('CSS.styleSheetAdded', { header: { styleSheetId: id, sourceURL: `http://x/${id}.css`, frameId: 'f' } }, sessionId);
  sheet('a', 'oopif');
  devtools.detach('oopif');
  assert.equal(devtools.sheets.size, 0);
  for (let i = 0; i <= DEVTOOLS_LIMITS.styleSheets; i++) sheet(`s${i}`);
  assert.equal(devtools.sheets.size, DEVTOOLS_LIMITS.styleSheets);
  assert.equal(devtools.sheets.has(':s0'), false);
  assert.equal(devtools.sheets.has(`:s${DEVTOOLS_LIMITS.styleSheets}`), true, 'a new sheet is never refused');
});

test('result signals count console errors and failed requests since a cursor', () => {
  const { devtools } = recorder();
  log(devtools, 'old', { type: 'error' });
  const { cursor } = devtools.since({});
  log(devtools, 'new error', { type: 'error' });
  log(devtools, 'plain');
  request(devtools, 'r1', 'http://127.0.0.1/missing');
  respond(devtools, 'r1', 404);
  finish(devtools, 'r1');
  const counted = devtools.since(cursor);
  assert.deepEqual([counted.errors, counted.failed], [1, 1]);
  assert.deepEqual([devtools.since(counted.cursor).errors, devtools.since(counted.cursor).failed], [0, 0]);
  request(devtools, 'r2', 'http://127.0.0.1/slow', { params: { wallTime: Date.now() / 1000 } });
  assert.equal(devtools.running(Date.now() - 1000), 1, 'requests the action started keep a settle waiting');
  assert.equal(devtools.running(Date.now() + 1000), 0);
});
