import { actions, keys } from '../shared/contract.mjs';

// These results stay compact JSON; every other action returns text (D13).
export const JSON_ACTIONS = new Set(['status', 'list_tabs', 'create_session', 'list_sessions', 'close_session', 'list_profiles', 'requests', 'respond', 'permissions', 'downloads', 'revoke',
  'console', 'network', 'inspect', 'performance']);

// Server instructions for MCP stdio registrations (Claude Code, Codex,
// Antigravity, DSH, etc.): fixed per registration engine across restarts (D26),
// and kept within Claude Code's 4096-character display cap.
const CAMOUFOX_INSTRUCTIONS = `Independent Windows Browser (primary: Camoufox/Firefox 158): browse drives real owned Firefox windows with persistent profiles (never shared with other browsers). Use this server for ordinary interactive websites, sign-in flows, named persistent profiles, forms, uploads, downloads, native alert/confirm/prompt dialogs, and HTTP/WebSocket DevTools debugging. Use web fetch/search for plain text research.

Hardware routing: Firefox does not implement WebHID/WebUSB. For physical-device configurators (e.g. usekb.cc, VIA/QMK keyboards, USB/HID tools), choose the Electron hardware browser registration (win-browser-hid) before opening the page. Keep every handle (t<n>, ctx<n>, e<n>) on the registration that returned it, because each registration numbers tabs independently; never switch registrations to bypass Stop, denial, cancellation, or uncertain input.

Calls: every call needs action. This connection is its own caller authority: never send _lease. A restarted or reconnected server is a new browser with no tabs: earlier tab ids and refs fail CLOSED_TAB, so open the page again (owned profiles persist in WB_DATA_DIR; see status.profilePersistence and list_profiles).

Pages & profiles: Windows open visibly in the background without stealing focus and highlight the taskbar on first open or show. open {url,sessionId?} (http/https) returns tab t<n>, session ctx<n>, and e<n> refs; omit sessionId for default. list_profiles lists persistent profiles (default, work, personal, plus custom slugs) and lock state. create_session {profile,name?} binds a named persistent profile (failing PROFILE_IN_USE if another live process holds it); create_session {name?} makes an empty temporary session. Idle zero-tab non-default persistent profiles automatically reclaim their Firefox process into runtimeState:"dormant" while keeping ctx<n>, disk logins, and the exclusive .lock: open {sessionId} wakes a fresh process transparently, and close_session releases the lock without launching Firefox. Closing the last window via top-right × keeps the connection alive (next open starts a new window); only revoke or confirmed #nav-bar Disconnect (연결 종료) ends the connection (state:"connection-ended", requiring explicit host reconnection). Tabs in one session share login; sessions never copy storage. Refs stay valid while unchanged. observe takes find:"words", scope:"e5", mode:"full"|"text", or screenshot:true. run scripts known flows. console, network, inspect, and performance are DevTools reads.

Results & native requests: first line is status. not-executed with dispatched=false means nothing was sent. uncertain or replaySafe=false means input may have run: inspect and never repeat it. STALE_REF after handoff/return: observe the same tab for fresh refs. DevTools withheld counts are cumulative privacy exclusions. Native requests (file chooser, alert/confirm/prompt, notifications, geolocation) appear as request lines or via requests; answer with respond (optionRef, prompt text, explicit files, or cancel:true), never repeat the initiating click, and never choose by list order. Cancelling a permission request is final for that scope in this connection.

Sign-in, passwords, CAPTCHA, 2FA: check status.automationMode. In standard mode, call handoff on that tab for passwords, OTP, CAPTCHA, or 2FA (non-empty sensitive fill/type fails SENSITIVE_INPUT_REFUSED; empty fill "" clears). In explicit elevated mode (WB_AUTOMATION_MODE=elevated, browser-policy.json, or user-saved #nav-bar preference), fill/type/click/observe continue on sensitive fields with masking while evaluate/console expressions stay blocked beside secrets; still call handoff for CAPTCHA/human verification and respect Revert/Stop/Take control immediately. On handoff the window flashes without taking focus; tell the person which window needs them and wait until they return control (Return to agent / Retry return on returnFailure). Stop, denial, cancellation, and handoff are never bypassed; revoke closes every window of this connection, so use it only when asked. Report completion only from observed effects.`;

const ELECTRON_INSTRUCTIONS = `Independent Windows Browser — Hardware / WebHID & WebUSB (Electron/Chromium 44.9.1): browse drives real owned Electron windows specifically for physical device workflows over WebHID and WebUSB (e.g. keyboard configurators such as usekb.cc, VIA/QMK, USB/HID diagnostics or flashing). For ordinary interactive websites, sign-in flows, window.prompt(), or named persistent profiles, use the primary Camoufox registration (win-browser) instead. Use web fetch/search for plain text research.

Registration discipline: keep every handle (t<n>, ctx<n>, e<n>) on the registration that returned it, because each registration numbers tabs independently; choose this hardware registration before opening a device page. Never switch registrations to bypass Stop, denial, cancellation, or uncertain input.

Calls & lazy startup: every call needs action. This connection is its own caller authority: never send _lease. Electron starts lazily on the first operational call (status and list_profiles answer cold without launching Electron; status.companionState reports not-started vs running). A restarted or reconnected server is a new browser with no tabs: earlier tab ids and refs fail CLOSED_TAB, so open the page again.

WebHID/WebUSB device selection: click the page's connect/authorize button through the normal input path. Pending device choices appear as request lines or via requests on that tab; options carry vendorId, productId, and name. Answer with respond (tabId, requestRef, and one offered optionRef or cancel:true) matching the exact device the task identifies — never choose by list order or sole offer. Never repeat the initiating click. Missing/disabled policy is a blocker, not something to change. Cancelling a permission or device request is final for that scope in this connection.

Windows, sessions & limits: Electron windows open with showInactive() so they never steal keyboard focus, and highlight the taskbar on the first top-level open. If the person cannot see the window, call show to highlight the taskbar again and tell them the window title and session (ctx<n>) to switch via taskbar or Alt+Tab. open {url,sessionId?} returns tab t<n>, session ctx<n>, and e<n> refs. create_session {name?} creates an isolated temporary session; close_session clears it. Named persistent profiles are unsupported on Electron (list_profiles returns supported:false). window.prompt() is unsupported in Electron 44.9.1 (alert/confirm work). Refs stay valid while unchanged. observe, run, console, network, inspect, and performance work as usual.

Results: first line is status. not-executed with dispatched=false means nothing was sent. uncertain or replaySafe=false means input may have run: inspect and never repeat it. STALE_REF after handoff/return: observe the same tab for fresh refs. DevTools withheld counts are cumulative privacy exclusions.

Sign-in, passwords, CAPTCHA, 2FA: check status.automationMode. In standard mode, call handoff on that tab for passwords, OTP, CAPTCHA, or 2FA (non-empty sensitive fill/type fails SENSITIVE_INPUT_REFUSED; empty fill "" clears). In explicit elevated mode (WB_AUTOMATION_MODE=elevated, browser-policy.json, or user-saved toolbar Elevate preference), fill/type/click/observe continue on sensitive fields with masking while evaluate/console expressions stay blocked beside secrets; still call handoff for CAPTCHA and respect Revert/Stop/Take control immediately. On handoff the window flashes without taking focus; tell the person which window needs them and wait until they return control (Return to agent / Return all / Retry return on returnFailure). Stop, denial, cancellation, and handoff are never bypassed; revoke (or confirmed toolbar Disconnect / 연결 종료) closes every window and ends this connection (state:"connection-ended", requiring explicit reconnect), so use revoke only when asked. Report completion only from observed effects.`;

export function connectionInstructions(engine = 'camoufox') {
  return engine === 'electron' ? ELECTRON_INSTRUCTIONS : CAMOUFOX_INSTRUCTIONS;
}

export const CONNECTION_INSTRUCTIONS = CAMOUFOX_INSTRUCTIONS;

const TOOL_DESCRIPTIONS = {
  camoufox: 'Primary independent browser (Camoufox / Firefox 158) for ordinary interactive websites, sign-in flows, named persistent profiles, forms, tabs, HTML uploads, downloads, native alert/confirm/prompt dialogs, and DevTools debugging. Do NOT use this server for WebHID/WebUSB hardware configurators (e.g. VIA/QMK keyboards like usekb.cc) — use the Electron hardware browser registration (win-browser-hid) instead. File System Access pickers and general OS file operations are unsupported. Results are text: a status line, signals, page header, and on-screen snapshot with e<n> refs; actions return diffs. Refs stay valid while unchanged. observe supports find, scope, mode full|text, screenshot. run executes a short Playwright-like script in a hardened sandbox. DevTools reads (console, network, inspect, performance) return compact JSON rows. Inspect status (engine, automationMode: standard|elevated, capabilities) and browser-generated requests, then respond with offered refs. Not for plain URL text retrieval. Standard mode requires handoff for sensitive inputs; elevated mode allows sensitive fill/type/click/observe with masking while CAPTCHA/OS identity and Stop/Revert stay human boundaries; never bypass refusal, resume a stopped page, switch registrations to escape Stop/denial, or repeat an executed/uncertain input.',
  electron: 'Hardware-capable independent browser (Electron / Chromium 44.9.1) specifically for connecting physical devices via WebHID or WebUSB, including keyboard configurators such as usekb.cc (VIA/QMK) and USB/HID tools; select the requested offered device by exact identity (vendorId/productId/name), never by list order or sole offer. For ordinary web browsing, sign-in, window.prompt(), or named persistent profiles, use the primary Camoufox registration (win-browser) instead. File System Access pickers, window.prompt(), and general OS file operations are unsupported. Results are text: a status line, signals, page header, and on-screen snapshot with e<n> refs; actions return diffs. Refs stay valid while unchanged. observe supports find, scope, mode full|text, screenshot. run executes a short Playwright-like script in a sandbox. DevTools reads (console, network, inspect, performance) return compact JSON rows. Inspect status (engine, companionState, automationMode, capabilities) and browser-generated requests, then respond with offered refs. Windows open via showInactive() with a taskbar flash cue on first top-level open (use show to cue again). Never bypass Stop/denial, switch registrations to escape Stop/denial, or repeat an executed/uncertain input.',
};

// Static MCP tool schema: holds nothing that differs between server processes
// of the same registration, because a host may keep a tool schema across
// restarts (D26).
export function browserTool({ engine = 'camoufox' } = {}) {
  const description = engine === 'electron' ? TOOL_DESCRIPTIONS.electron : TOOL_DESCRIPTIONS.camoufox;
  return {
    name: 'browse',
    description,
    inputSchema: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: actions },
        tabId: { type: 'string', description: 'Tab id (t<n>) returned by this connection.' },
        sessionId: { type: 'string', pattern: '^ctx[1-9]\\d{0,9}$', description: 'open/close_session: browser session from create_session/list_sessions, never caller authority. Omit on open for the default.' },
        name: { type: 'string', maxLength: 80, description: 'create_session: human-readable display name for a temporary session or named persistent profile binding.' },
        profile: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$', description: 'create_session only: bind a named persistent Camoufox profile (e.g. default, work, personal, or new slug from list_profiles) instead of a temporary session.' },
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
        filter: { type: 'string', maxLength: 500, description: 'console: text, level:error|warn|info|log|debug. network: URL text, status:404|4xx, type:fetch|websocket, method:POST, is:failed|running|cached.' },
        limit: { type: 'integer', minimum: 1, maximum: 65536, description: 'Rows (default 30, max 100); body or console expression: characters (default 8192).' },
        id: { type: 'string', maxLength: 64, description: 'network: one row id for redacted headers, timing, TLS, redirect links and WebSocket frame summary.' },
        body: { type: 'boolean', description: 'network with id: return the response body (or redacted WebSocket frames for type:websocket) instead.' },
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
  if (result.sessionId) fields.push(`session=${result.sessionId}`, `name=${JSON.stringify(result.sessionName)}`);
  return fields.join(' ');
}

export function toolResult(result, action) {
  if (JSON_ACTIONS.has(action)) {
    const data = ['console', 'network'].includes(action) && result.withheld > 0 ? { ...result,
      withheldReason: 'Human-control privacy: cumulative excluded events (including shared workers and late events/redirects); returning control does not restore them.',
    } : result;
    return { isError: failed(result), content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
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
  const recovery = ['STALE_REF', 'STALE_FRAME'].includes(code)
    ? 'Observe this same tab for current element and iframe refs; handoff/return invalidates earlier refs. Never replay an executed or uncertain input.' : null;
  if (!args.action || JSON_ACTIONS.has(args.action) || !actions.includes(args.action)) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        disposition: notExecuted ? 'not-executed' : 'failed-or-unknown', code, reason: error?.message, replaySafe: false,
        ...(notExecuted ? { tabId: error.tabId, preparation: error.preparation, requestedInputDispatched: false } : {}),
        ...(error?.candidates ? { candidates: error.candidates } : {}),
        ...(recovery ? { recovery } : {}),
      }) }],
    };
  }
  const lines = [statusLine({
    disposition: notExecuted ? 'not-executed' : 'failed', action: args.action, ref: args.ref, tabId: error?.tabId ?? args.tabId,
    code, requestedInputDispatched: notExecuted ? false : undefined, preparation: error?.preparation,
  }), `reason ${error?.message ?? 'Browser error'}`];
  if (recovery) lines.push(`note ${recovery}`);
  if (error?.candidates?.length) lines.push('candidates:', ...error.candidates);
  return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
}
