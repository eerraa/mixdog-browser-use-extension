---
name: independent-browser
description: Verify web apps and operate an independent browser with delegated native requests.
when_to_use: 'Web app verification, interactive sites, forms and browser workflows; not plain URL text retrieval.'
dependencies:
  tools:
    - type: mcp
      value: plugin-win-browser
---

# Independent Browser

Use this plugin to complete interactive web tasks and verify implemented apps,
including when built-in Browser Use is disabled. It owns its windows, profiles,
native requests and cancellation; it does not use a built-in bridge.

## Boundary

Use web retrieval for plain page text or research. Use the independent browser
when interaction, rendered state or authentication is required. Never switch
windows, tools, callers or connections to bypass Stop, denial, cancellation,
CAPTCHA, authentication, or a browser/OS security refusal.

Direct file responses support DOM-bound HTML uploads only, not
`showOpenFilePicker`, `showSaveFilePicker` or `showDirectoryPicker`.
General OS file operations are outside this tool's contract. Report the
capability limit and observed result; this plugin does not select or invoke
another plugin. The agent chooses among available tools without bypassing
Stop or denial, or replaying an uncertain action.

## Prerequisites

The folder plugin and MCP server must already be enabled. Use the current
schema and its exact `_channel`; the host hook supplies `_lease`. Under a plain
MCP registration (Claude Code, `mcp__win-browser__browse`) the schema has
neither and neither is sent; a restarted server is a new browser without the
earlier tabs. The server instructions carry this guidance there.
Never invent caller identity, run the hook, edit endpoint files or impersonate
the host.
Inspect capabilities when a protected interaction is needed. Registration of
the default package delegates new HID/USB and notifications/geolocation choices
to live authenticated owners of their pages. A missing/disabled policy is a
blocker, not permission to edit it or operate a human approval surface.

## Procedure

1. Open the requested HTTP(S) page, or inspect this caller's existing tabs.
   Confirm the returned URL, tab ownership and current observation.
2. Act on `e<n>` refs from any earlier result; they stay valid while their
   element is unchanged, so do not re-observe just to refresh them. Use `find`
   for elements not on screen, or a semantic `target` when no ref is known.
   Resolve ambiguity from returned candidates, not guessed coordinates. Points
   are a last resort: take `screenshot:true`, then use CSS pixels of that
   image with its `snapshotId`. A target out of view is scrolled into view
   first; a replaced element is never followed (`STALE_REF`).
3. Read each action's diff before deciding the next action. Check the actual
   form values, page text, navigation or downloaded file state that proves the
   requested outcome.
4. Resolve ordinary browser requests yourself. Read the `request …` lines or
   `signal pending requests`, or call `requests` on the same tab, then
   `respond` with its `requestRef` and one
   current `optionRef`, explicit `files`, or `cancel:true`. Native requests can be resolved while their initiating
   click/evaluation is still waiting; do not repeat that initiating operation.
   A click that opens an `alert`/`confirm` answers `uncertain … code=DIALOG_OPEN`
   with the request: answer the request, never repeat the click.
   Check the next observation for the site's actual result.
5. Click device-authentication buttons through the normal input path. Select
   the intended exact offered HID/USB device from task evidence and complete
   connection without handoff or repeated consent. Never guess from list order
   or select an unrelated device just because it is the only offer. If identity
   is ambiguous, report the missing identification rather than guessing.
   Allow notifications/geolocation only when needed by the task. Selecting
   explicit local files discloses their contents to the requesting site.
6. For password entry, login, CAPTCHA or 2FA, request `handoff` on that exact
   tab and stop automated page work. The window flashes but does not take
   focus; tell the person which window needs them, and ask them to finish
   signing in (submit the form) before returning control. The person uses the same
   live page in its browser window. Do not request, log or supply their password, PIN, OTP or
   biometric data. Page observations are blocked during native handoff, and
   nothing the person does there (pages, dialogs, popups, downloads) reaches
   your results. Fields they typed into stay `sensitive` afterwards.
   Continue only after the person returns control in that window (toolbar
   **Return to agent** or **Resume agent**, or the **Resume automation** menu)
   and fresh state is available.
7. Respect explicit cancellation/denial and Stop. `respond` is a typed
   interaction, not a universal permission override or Resume endpoint.
   Mandatory OS identity and unsupported capture/serial/Bluetooth are specific
   blockers, not reasons to disable browser security.
8. Report completion only from observed effects. Leave the exact native page
   available when the person must continue; close only this task's disposable
   owned tabs. Revocation closes every plugin window in this MCP connection,
   so request it only when the user intends that connection-wide effect.

## Reading results

Page results are text. The first line is the status:
`executed click e7 tab=t1 snap=s8`. Then `signal …` lines for events since
your last result (navigation, popup, download, dialog, Stop or handoff,
pending requests, console errors, failed requests), the page header on a new
page, and the body:

- Snapshot (open, observe, a new page): what is on screen, indented by
  nesting. `e12 button "Sign in"`, `e13 textbox "Email" focused ="a@b.c"`,
  `text "…"`, `h2 "…"`; iframe content is inlined under its `iframe` line.
  `+N offscreen (…)`, `+N covered` and `outline:` summarize the rest.
- Diff (after an action): `~` changed, `+` added (with `in e<n>`), `- e<n>`
  removed, `(hidden)` still present but not shown. Alerts, status messages,
  toasts and new text appear here even when offscreen, and so does content a
  scroll brought into view (with a new `view` line). `no change since s8`
  means nothing visible changed. A large change returns a full snapshot.
  `snapshot:"full"` returns a full snapshot instead, `snapshot:"none"` only
  the status.
- `observe` options: `find:"words"` (refs for matches anywhere, with their
  container; words only, not regular expressions), `scope:"e5"` (one
  subtree), `mode:"full"` (whole page), `mode:"text"` (readable text, each
  line a quoted string), `screenshot:true` (image; enables points).
- `executed … observed=false cause=…` means the input happened but the page
  could not be read afterwards; observe, never repeat the input.
  `not-executed … dispatched=false` means nothing was sent.
  `executed … code=TARGET_MISMATCH` means the press or text landed on
  something else (a moving or covering frame) and was neutralized: no click
  formed and no text was inserted; observe before deciding.
- Values print as JSON strings. `sensitive` fields (passwords, OTP and
  verification codes, card fields, fields the person typed during a handoff)
  never show their value, in a container `read` or a text wait either. While
  one holds a value in the frame or in any same-origin frame or window, and
  while any of your windows is under the person's control, `evaluate` and
  `console` with `expression` answer `not-executed` `SENSITIVE_PRESENT`;
  continue with ordinary actions, or clear the field with `fill` and
  `text:""` first if the task allows.
- `upload` and file-picker `respond` take local drive-letter paths only;
  network paths (`\\host\share`) are refused.
- `hide` voids that tab's refs and points; `show` keeps them (observe before
  acting).
- `status`, `list_tabs`, `requests`, `respond`, `permissions`, `downloads`,
  `revoke` and the DevTools reads return compact JSON.

## Scripts (`run`)

For a known multi-step flow (fill a form, select, submit, wait for the
result), one `run` call replaces many tool calls. `script` is the body of an
async function; return JSON (up to 4000 characters).

```js
// { action: "run", tabId: "t1", script: … }
await page.getByLabel('Email').fill('qa@example.test');
await page.getByRole('combobox', { name: 'Plan' }).selectOption('pro');
await page.getByRole('button', { name: 'Save' }).click();
await page.waitForText('Saved');
return await page.getByRole('status').innerText();
```

- Globals: `page` (the `tabId` tab, if given), `open(url)` → page,
  `tabs()`, `sleep(ms)`, `RunnerError`. Page: `getByRole(role, {name, exact})`,
  `getByLabel`, `getByText`, `locator(css)`, `ref("e7")`, `frame("e3")`,
  `goto`, `find`, `snapshot`, `waitForText`, `waitForTextGone`,
  `waitForURL`, `evaluate` (isolated world), `dialog(accept)`, `url`, `title`,
  `close`. Locator: `click`, `fill`, `type`, `press` (keys go to an element:
  `page.getByLabel('Search').press('Enter')`), `selectOption`,
  `setInputFiles`, `scroll`, `innerText`, `inputValue`, `waitFor`; each takes
  `{timeout}` (default 5000 ms, max 10000) and waits for a missing or
  unactionable target. Wait texts are at most 500 characters.
- `getByText(text)` and `getByLabel(text)` match the accessible name
  (substring, `{exact:true}` for the whole name) of targetable elements:
  controls, links, live regions, images. Headings and plain text are not
  targets; use `waitForText` or `find` for them.
- Every step goes through the same checks as a direct call. A step that sent
  nothing throws a `RunnerError` with `kind:"not-executed"` you may catch
  (for optional elements), including invalid arguments
  (`INVALID_RUNNER_OP`). An uncertain step ends the run, even inside a
  catch; Stop or a handoff on any tab of the run, and the deadline
  (`timeoutMs`, default 60000, max 100000) end it too. A run makes at most
  2000 calls and 4 at once. Never rerun a script whose report says
  `executed` or `uncertain` without checking what already happened.
- A dialog or file chooser a step opened outlives the run: answer it with
  `handle_dialog` or `respond` after reading the report.
- The report lists the first 60 steps (`2 executed click t1 button "Save"
  41ms`), the return value, console output, and the changes of up to 4
  touched tabs since your last view (6000 characters each; others say
  `observe tN`). No network, Node, or page access exists inside the script
  except through these calls; a script that does not compile is refused
  before it runs (`SCRIPT_SYNTAX`).

## Debugging with DevTools reads

Use these instead of repeated `observe` or screenshots when the question is
why a page misbehaves. They return compact text rows, never an observation or
image, never change refs, and answer even while an action is running.

- `console`: page, iframe and worker console calls, uncaught exceptions with
  top stack frames, and browser log entries (failed loads, security). Rows:
  `i` id, `lv` level (omitted for log), `k` kind (`exception`, `network`, …),
  `msg`, `at` url:line:col, `in` iframe/worker, `n` repeats. Narrow with
  `filter` (`level:error`, words). Keep the returned `next` and pass it as
  `since` to get only new rows. A first call without `since` returns the
  newest rows; `omitted` then counts older kept rows, which only `since:0`
  pages through from the oldest. Following `next` never returns them.
- `network`: rows `id`, `m` (non-GET), `u`, `ty`, `s` status, `mt`, `sz`
  bytes, `ms`, `err`, `c` cache source, `st` (`run`, `incomplete`). Filter with
  `status:4xx`, `status:404`, `type:fetch`, `method:POST`, `is:failed`,
  `is:running`, or URL words. `id` gives redacted headers, initiator and the
  request body; add `body:true` only when the response content matters
  (8 KB default, `limit` up to 65536; binary returns size and type only).
- `console` with `expression`: a page-world JavaScript read, like typing in
  the DevTools Console. It sees page globals that `evaluate` cannot. V8
  refuses detected side effects (`SIDE_EFFECT`), but this is a best-effort
  check: page code such as getters or overridden built-ins still runs. Treat
  the result as page-reported. Objects return a short preview; read the
  specific properties you need. It is refused while the tab is paused,
  including after Stop. A read running over 2 s is stopped (`SCRIPT_TIMEOUT`).
  While a page dialog is open, it, response bodies and `performance` answer
  `not-executed` with `DIALOG_OPEN`; answer the dialog first.
- `evaluate` with `world:"page"`: only when page globals must be changed or
  called with side effects. It is a mutation like default `evaluate`; page
  scripts can see and tamper with it, so treat its result as page-reported.
- `inspect`: a live `ref`, or `target.selector` (with optional
  `target.frame`, an iframe ref) for elements observations omit, such as hidden
  ones. Returns box, margins/borders/padding, layout and visibility styles
  (add more names in `values`), `visible` with `hiddenBy`, matched CSS rules
  with source lines, and event listener types.
- `performance`: DOM and heap counters, layout/script time and navigation
  timing (ttfb, dcl, load, fcp).

Entries produced while the person controls the page are never shown; a
`withheld` count may appear, and requests in flight at that moment end as
`incomplete`. While any window of the connection is in handoff, service and
shared worker entries are withheld in every window. Your own `evaluate`
console output is not recorded; use `world:"page"` if you need it in
`console`. A redirect hop (`s` 3xx) has no body; read the final hop.

Redaction is best effort and works by name and shape, not by meaning:
- Cookie/auth-like headers become `[redacted]`.
- URL parameters with token-, code- or key-like names become `[redacted]`.
- `Bearer`/`Basic` credentials and JWT-shaped values become `[redacted]`.
- JSON, form and `name=value` fields with password- or token-like names in
  request and response bodies become `[redacted]`.
- Secrets under other names, HTML content and page-world read results are
  not redacted. The person can
open the page's own DevTools from the window menu only during handoff; it
closes when control returns.

## Recovery

- `STALE_REF` means that element was removed (an element put back gets a new
  ref), renamed or replaced, its tab closed, or control changed hands; observe
  or `find` and identify the intended target again. Never reuse an old point.
- `NOT_ACTIONABLE` "Target frame kept moving" or a covered target: wait for
  the page to settle (observe `wait`) and act on the ref again; never fall back
  to points. `POINT_HIDDEN_TARGET` means a transparent frame or element sits
  over the point; act on a ref instead.
- `uncertain` or `replaySafe:false` means input may have executed. Inspect
  effects without repeating the mutation. An absent reply is not proof of
  non-execution. A reported preparation can have scrolled even when requested
  input was not dispatched. Stale native request/option refs also require fresh
  inspection; they cannot resurrect a withdrawn or denied request.
- Stop, native handoff, a failed return, or permission refusal is not ordinary
  staleness. Do not open another tab or connection to get around it.
- The window shows the live page under an input shield while automation runs.
  A person's click or key on it, or the toolbar's Take control or Stop agent,
  pauses automation; the initiating gesture is discarded before handoff.
- Scrolling uses the verified native DOM scroll container. A widget that
  requires physical wheel gestures needs human handoff, not synthetic retries.
- A terminated/revoked connection requires the user's explicit reconnection;
  do not edit plugin settings or silently replace it.
- Real `alert`/`confirm` dialogs are supported. This Electron runtime throws
  `prompt() is not supported.` before native `window.prompt()` creates a request.
  Report a prompt-dependent app as blocked by that capability, not verified;
  handoff, waiting or sending a dialog response cannot repair the missing API.

## Verification

Distinguish a successful tool response from a completed web task. Confirm the
task-specific result, and report uncertainty, pending human action and
unsupported permission APIs explicitly. For app verification, exercise the
actual UI and its result without routine human steps. Device selection,
connection and successful physical I/O are separate evidence. An exact device
grant is neither technically read-only nor document-exclusive; honor the task's
no-settings-write restriction without claiming protocol enforcement.
