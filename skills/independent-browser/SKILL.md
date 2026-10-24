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
schema and its exact `_channel`; the host hook supplies `_lease`. Never invent
caller identity, run the hook, edit endpoint files or impersonate the host.
Inspect capabilities when a protected interaction is needed. Registration of
the default package delegates new HID/USB and notifications/geolocation choices
to live authenticated owners of their pages. A missing/disabled policy is a
blocker, not permission to edit it or operate a human approval surface.

## Procedure

1. Open the requested HTTP(S) page, or inspect this caller's existing tabs.
   Confirm the returned URL, tab ownership and current observation.
2. Prefer a known semantic `target`. Otherwise use a ref from the latest
   observation. Resolve ambiguity from returned candidates, not guessed
   coordinates. Raw points require the latest combined DOM/PNG `snapshotId`;
   coordinates are CSS viewport pixels, not PNG pixels. Object-target preparation
   can scroll before fresh observation; it never silently follows a replacement.
3. Read each mutation's result before deciding the next action. A returned
   observation replaces all earlier refs. Check the actual form values, page
   text, navigation or downloaded file state that proves the requested outcome.
4. Resolve ordinary browser requests yourself. Read `pendingRequests` or call
   `requests` on the same tab, then `respond` with its `requestRef` and one
   current `optionRef`, explicit `files`, or `cancel:true`. Native requests can be resolved while their initiating
   click/evaluation is still waiting; do not repeat that initiating operation.
   Check the next observation for the site's actual result.
5. Click device-authentication buttons through the normal input path. Select
   the intended exact offered HID/USB device from task evidence and complete
   connection without handoff or repeated consent. Never guess from list order
   or select an unrelated device just because it is the only offer. If identity
   is ambiguous, report the missing identification rather than guessing.
   Allow notifications/geolocation only when needed by the task. Selecting
   explicit local files discloses their contents to the requesting site.
6. For password entry, login, CAPTCHA or 2FA, request `handoff` on that exact
   tab and stop automated page work. The person uses the native browser window.
   Do not request, log or supply their password, PIN, OTP or biometric data.
   Page observations are blocked during native handoff. Continue only after
   the person uses the native **Resume automation** menu and fresh state is
   available.
7. Respect explicit cancellation/denial and Stop. `respond` is a typed
   interaction, not a universal permission override or Resume endpoint.
   Mandatory OS identity and unsupported capture/serial/Bluetooth are specific
   blockers, not reasons to disable browser security.
8. Report completion only from observed effects. Leave the exact native page
   available when the person must continue; close only this task's disposable
   owned tabs. Revocation closes every plugin window in this MCP connection,
   so request it only when the user intends that connection-wide effect.

## Recovery

- For stale refs, frame replacement or recoverable navigation, obtain current
  state and identify the intended target again. Never reuse an old ref/point.
- `uncertain` or `replaySafe:false` means input may have executed. Inspect
  effects without repeating the mutation. An absent reply is not proof of
  non-execution. A reported preparation can have scrolled even when requested
  input was not dispatched. Stale native request/option refs also require fresh
  inspection; they cannot resurrect a withdrawn or denied request.
- Stop, native handoff, a failed return, or permission refusal is not ordinary
  staleness. Do not open another tab or connection to get around it.
- The presentation is a bitmap preview, not a second interactive website.
  Its initiating gesture is discarded before native handoff.
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
