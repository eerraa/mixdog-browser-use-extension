import { actions, keys } from '../shared/contract.mjs';

// These results stay compact JSON; every other action returns text (D13).
export const JSON_ACTIONS = new Set(['status', 'list_tabs', 'requests', 'respond', 'permissions', 'downloads', 'revoke',
  'console', 'network', 'inspect', 'performance']);

// Server instructions under connection authority (a plain MCP registration such
// as Claude Code's): the shipped skill is not loaded there, so the essentials
// travel with the server. Claude Code shows at most 4096 characters.
export const CONNECTION_INSTRUCTIONS = `Independent Windows Browser: the browse tool drives real browser windows that this server owns (its own Chromium runtime and profiles; nothing is shared with other browsers). Use it for interactive web work: operating and verifying web apps, forms, sign-in flows with a person, uploads, downloads, dialogs, and connecting WebHID or WebUSB devices to pages. Use web fetch or search for plain page text and research.

Calls: every call needs action and _channel copied exactly from the schema constant. A reconnect replaces the channel; after "replaced browser channel", reload the browse schema. This connection is its own caller authority: never send _lease.

Pages: open {url} (http or https only) returns a tab t<n> and a text snapshot with e<n> refs. Refs stay valid while their element is unchanged: act on them with click, fill, type, press, select or scroll, and read each action's diff instead of observing again. observe takes find:"words", scope:"e5", mode:"full"|"text" or screenshot:true (points are a last resort). run executes a short Playwright-like script for a known multi-step flow. console, network, inspect and performance are DevTools reads.

Results: the first line is the status. not-executed with dispatched=false means nothing was sent. uncertain or replaySafe=false means the input may have run: inspect the page and never repeat it. STALE_REF: observe or find again.

Native requests (file chooser, alert or confirm, notifications, geolocation, HID, USB) appear as request lines or through requests on that tab. Answer with respond: tabId, requestRef and a response holding exactly one offered optionRef, explicit files, or cancel:true. Never repeat the click that opened a request. Cancelling a permission or device request is final for that scope in this connection.

WebHID and WebUSB: click the page's own connect button with a normal click. The browser chooser becomes a hid or usb request whose options carry each offered device (vendorId, productId, name). Respond with the exact device the task identifies; never choose by list order or because it is the only offer, and if the identity is unclear, stop and report. A missing or disabled delegation policy is a blocker, not something to change.

Sign-in, passwords, CAPTCHA and 2FA: call handoff on that tab and stop page work. The window flashes without taking focus; tell the person which window needs them and wait until they return control in that window. Pages cannot be observed meanwhile. Never ask for or type their secrets. Sensitive fields never show values, and evaluate and console expressions are refused beside them.

Stop, denial, cancellation and handoff are never bypassed: no new tab, connection or retry loop around them, and no call resumes a stopped page. revoke closes every window of this connection; use it only when asked. Report completion only from observed effects.`;

export function browserTool(channel, { lease = true } = {}) {
  return {
    name: 'browse',
    description: 'Use the independent agent browser for websites, app verification, forms, tabs, HTML file-input uploads, download status and supported dialogs. File System Access Save/Open/Directory pickers and general OS file operations are unsupported. Results are text: a status line, then signals, the page and a snapshot of what is on screen with e<n> refs; an action returns what changed. Refs stay valid while their element is unchanged. observe for more (find, scope, mode full|text, screenshot). run executes a short Playwright-like script (page.getByRole/getByLabel/getByText/locator, click, fill, selectOption, press, waitForText, find, evaluate) in a sandbox in one call: each step goes through the same checks, a step that did nothing throws a catchable error, an uncertain step ends the run; the result lists the steps and the final changes. DevTools reads (console, network, inspect, performance) return compact JSON rows. Inspect capabilities and browser-generated requests, then respond using their offered refs. Protected requests require the registered delegation policy. Not for plain URL text retrieval. Human sign-in/OS identity and explicit Stop remain boundaries; never bypass refusal or resume a stopped page; never repeat an executed or uncertain input.',
    inputSchema: {
      type: 'object',
      required: ['action', '_channel'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: actions },
        _channel: { type: 'string', enum: [channel], description: 'This server connection; copy this exact constant.' },
        // Only a host hook supplies _lease; under connection authority the server issues its own.
        ...(lease ? { _lease: { type: 'string', description: 'Injected by the plugin host hook. Do not invent a value.' } } : {}),
        tabId: { type: 'string', description: 'Tab id (t<n>) returned by this connection.' },
        url: { type: 'string', description: 'Credential-free HTTP(S) URL for open or navigate.' },
        ref: { type: 'string', description: 'Element ref (e<n>) from a result.' },
        target: {
          type: 'object', additionalProperties: false,
          properties: {
            role: { type: 'string' }, name: { type: 'string' }, exact: { type: 'boolean' },
            selector: { type: 'string' }, frame: { type: 'string' },
          },
          description: 'Semantic target when no ref is known; must match one element. frame: iframe ref. inspect: selector (+frame) only.',
        },
        point: {
          type: 'object', required: ['x', 'y', 'snapshotId'], additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' }, snapshotId: { type: 'string' } },
          description: 'CSS pixels in the screenshot of snapshotId (the latest result with screenshot:true).',
        },
        mode: { type: 'string', enum: ['default', 'full', 'text'], description: 'observe: default (on screen), full (whole page) or text (readable text).' },
        find: { type: 'string', maxLength: 500, description: 'observe: search names, values and text; matches come with refs.' },
        scope: { type: 'string', description: 'observe: the subtree of this ref only.' },
        depth: { type: 'integer', minimum: 0, maximum: 20, description: 'observe: nesting limit.' },
        screenshot: { type: 'boolean', description: 'Add an image (CSS scale); enables points.' },
        snapshot: { type: 'string', enum: ['diff', 'full', 'none'], description: 'Action result: changes (default), full snapshot, or status only.' },
        wait: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' }, gone: { type: 'string' }, url: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 } },
          description: 'observe: first wait until text appears, text is gone, or the URL contains url (default 5000 ms).',
        },
        text: { type: 'string', maxLength: 100000 },
        key: { type: 'string', enum: Object.keys(keys) },
        values: { type: 'array', items: { type: 'string' }, description: 'select: option values; inspect: extra CSS properties.' },
        deltaX: { type: 'number', minimum: -10000, maximum: 10000 },
        deltaY: { type: 'number', minimum: -10000, maximum: 10000 },
        expression: { type: 'string', description: 'evaluate: JavaScript in an isolated DOM world (world:page for page globals). console: page-world read; side effects refused (best effort).' },
        world: { type: 'string', enum: ['isolated', 'page'], description: 'evaluate: page runs in the page main world; page scripts can see it.' },
        frame: { type: 'string', description: 'evaluate/console expression: iframe ref to run in.' },
        since: { type: 'integer', minimum: 0, description: 'console/network: only rows after this returned next cursor.' },
        filter: { type: 'string', maxLength: 500, description: 'console: text, level:error|warn|info|log|debug. network: URL text, status:404|4xx, type:fetch, method:POST, is:failed|running|cached.' },
        limit: { type: 'integer', minimum: 1, maximum: 65536, description: 'Rows (default 30, max 100); body or console expression: characters (default 8192).' },
        id: { type: 'string', maxLength: 64, description: 'network: one row id for redacted headers and details.' },
        body: { type: 'boolean', description: 'network with id: return the response body instead.' },
        files: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' }, description: 'Absolute regular files for an explicit file-input target.' },
        accept: { type: 'boolean' },
        promptText: { type: 'string' },
        script: { type: 'string', maxLength: 100000, description: 'run: async function body. Globals: page (tabId\'s tab), open(url), tabs(), sleep(ms), RunnerError. Return JSON (up to 4000 chars).' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 100000, description: 'run: deadline (default 60000).' },
        requestRef: { type: 'string', maxLength: 128, description: 'An owned pending native request returned by observe or requests.' },
        response: {
          type: 'object', additionalProperties: false,
          properties: {
            optionRef: { type: 'string', maxLength: 128 },
            files: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } },
            text: { type: 'string', maxLength: 100000 },
            cancel: { type: 'boolean', enum: [true] },
          },
          description: 'Exactly one current optionRef, explicit file paths, or cancel:true. text is only for a prompt dialog option.',
        },
      },
    },
  };
}

// isError: nothing done (not-executed, failed), unknown outcome (uncertain),
// or a completed step that reports a failure code (a page script error, a
// failed navigation). executed with observed:false + cause is not an error.
const failed = result => ['not-executed', 'uncertain', 'failed', 'failed-or-unknown'].includes(result?.disposition);

/** First line of every result: `<disposition> <action>[ <ref>] tab=<t> …`. */
export function statusLine(result) {
  const fields = [result.disposition, result.action];
  if (result.ref) fields.push(result.ref);
  if (result.tabId) fields.push(`tab=${result.tabId}`);
  if (result.snapshotId) fields.push(`snap=${result.snapshotId}`);
  if (result.code) fields.push(`code=${result.code}`);
  if (result.observed === false) fields.push('observed=false');
  if (result.cause) fields.push(`cause=${result.cause}`);
  if (result.requestedInputDispatched === false) fields.push('dispatched=false');
  if (result.preparation && result.preparation !== 'none') fields.push(`preparation=${result.preparation}`);
  if (result.replaySafe === false) fields.push('replaySafe=false');
  return fields.join(' ');
}

export function toolResult(result, action) {
  if (JSON_ACTIONS.has(action)) return { isError: failed(result), content: [{ type: 'text', text: JSON.stringify(result) }] };
  const text = [statusLine(result), result.text].filter(Boolean).join('\n');
  return {
    isError: failed(result) || result.code !== undefined,
    content: [
      { type: 'text', text },
      ...(result.screenshot ? [{ type: 'image', mimeType: result.screenshot.mimeType, data: result.screenshot.data }] : []),
    ],
  };
}

export function errorResult(error, args = {}) {
  const notExecuted = error?.requestedInputDispatched === false;
  const code = error?.code ?? 'BROWSER_ERROR';
  if (!args.action || JSON_ACTIONS.has(args.action) || !actions.includes(args.action)) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        disposition: notExecuted ? 'not-executed' : 'failed-or-unknown', code, reason: error?.message, replaySafe: false,
        ...(notExecuted ? { tabId: error.tabId, preparation: error.preparation, requestedInputDispatched: false } : {}),
        ...(error?.candidates ? { candidates: error.candidates } : {}),
      }) }],
    };
  }
  const lines = [statusLine({
    disposition: notExecuted ? 'not-executed' : 'failed', action: args.action, ref: args.ref, tabId: error?.tabId ?? args.tabId,
    code, requestedInputDispatched: notExecuted ? false : undefined, preparation: error?.preparation,
  }), `reason ${error?.message ?? 'Browser error'}`];
  if (error?.candidates?.length) lines.push('candidates:', ...error.candidates);
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
}
