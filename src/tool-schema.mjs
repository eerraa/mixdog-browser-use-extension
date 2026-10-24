import { actions, keys } from './browser/contract.mjs';
import { statusLine } from './browser/perception/render.mjs';

// These results stay compact JSON; every other action returns text (D13).
export const JSON_ACTIONS = new Set(['status', 'list_tabs', 'requests', 'respond', 'permissions', 'downloads', 'revoke',
  'console', 'network', 'inspect', 'performance']);

export function browserTool(channel) {
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
        _lease: { type: 'string', description: 'Injected by the plugin host hook. Do not invent a value.' },
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
