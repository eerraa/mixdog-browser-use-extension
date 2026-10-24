# Contracts

Owns: what must stay true. A change that breaks an item is a defect even when tests
pass. Rationale: `decisions.md`.

## Product contract

| ID | Invariant |
| --- | --- |
| C1 | Folder install: the packaged `win-browser` folder runs with its bundled runtime, app, native helpers and licenses. Users never install dev tools, build, or patch Mixdog. |
| C2 | Natural selection: one MCP tool and the `independent-browser` skill; agents choose them for interactive web work without being told. Own names are fine; built-in names and UI are not cloned. |
| C3 | Real browser work: navigation, DOM and screenshot observation, exact targeting, click, typing, forms, tabs, frames, HTML uploads, downloads, dialogs and result checks, keeping upstream freshness, ref validation, cancellation and uncertainty semantics. |
| C4 | Independence: works with built-in Browser Use off; own windows and profiles; the person handles login, passwords, CAPTCHA and 2FA in the same window; no copying of profiles, cookies or accounts; no built-in handoff. |
| C5 | Protected requests follow the trusted package policy below. The agent never operates an approval UI; MCP arguments never create policy or approval. |
| C6 | Denial and cancellation are never bypassed or re-asked. One requester's navigation or cancel never aborts another valid requester. Revocation removes real Chromium grants (process termination), never just caches. Unverifiable requester or scope: refuse with a reason. OS approval, user activation and browser security stay on. |
| C7 | Change is not stop: navigation, reload, frame swap, hide, human intervention and disconnect recover through fresh observation; Stop, denial and revocation are never auto-cleared. Stale refs, points and snapshot IDs are never reused; executed or uncertain input is never resent. |
| C8 | Isolation: tabs are owned per caller session; input is serialized per tab; ended callers' late calls are rejected; hooks affect only this plugin's tool. |
| C9 | Reuse boundary: only pinned vendored upstream browser files; no Mixdog core, ASAR or private bridge; no agent runner or agent settings; provenance and licenses preserved. |
| C10 | Honest verification: unit, live Electron, packaged MCP and real-device evidence are reported separately. |

## Authority and isolation

- Arguments carry `_channel` (this connection) and `_lease` (PreToolUse ticket). A hook failure denies that call and nothing else.
- Ticket: single use, 10 s, bound to `sessionId`, `callId`, `toolName === BROWSER_TOOL` and the sha256 of the canonical arguments without `_lease`.
- `end` aborts the session's admitted work and blocks its late calls. `UserPromptSubmit` starts a new generation even when `end` was lost.
- Tabs of another session fail with `FOREIGN_TAB`. Profiles are per connection and session.
- Pipe `hello` must match the channel and the 43-character key (constant-time compare). One gateway per companion. Methods per role: gateway `status`, `call`, `shutdown`; hook `begin`, `end`, `issue`.
- `status` is answered by the gateway without consuming a ticket.

## Observation and input

- Each observation issues a new `snapshotId` and voids all earlier refs.
- A ref, target or point is valid only against the latest observation, the same presentation `generation`, and passing checkpoints (document, revision, viewport, scroll). A point also needs the latest `snapshotId` and an unchanged screenshot hash; coordinates are CSS viewport pixels.
- Input admission (`#owned` with input): owner match, not paused, visible, connected, no dialog cleanup pending, `presentation.assertAutomation(generation)`.
- After dispatch (`markSent`), any failure returns `{disposition:'uncertain', replaySafe:false}`; nothing retries automatically. Before dispatch, the error carries `requestedInputDispatched:false` and `preparation`.
- `evaluate` is a mutation in its own isolated world: DOM only, no page globals, Node or host bindings.
- `read` never returns password values (`sensitive:true`).
- Agent URLs: credential-free http(s) only (`pageURL`). Address bar: `addressURL` (bare host → https, loopback → http).
- `FenceQueue`: cancellation settles the caller at once; the lane stays fenced until the actual operation settles.

## Handoff state machine

Two gates per page: `p.paused` (null or a reason) blocks input; `presentation.mode`
blocks observation with `PRIVATE_HANDOFF` unless it is `automation` (or `returning`
for the trusted return check). Every transition increments `generation`.

| From | Event | To |
| --- | --- | --- |
| automation | person clicks or types on the shield; toolbar Take control; menu Human handoff; `handoff` action | draining, paused = reason |
| any | fail-closed trigger | draining, paused = trigger |
| draining | lane idle, held keys and buttons released, CDP native mode on | native-handoff: shield hidden, page focused |
| native-handoff, draining, or paused automation | toolbar Return or Resume; menu Resume automation | returning |
| returning | fresh trusted observation passes | automation, paused = null |
| returning | observation fails | draining, paused = `return-failed` |

- Resume comes only from that window's toolbar document or native menu; no tool action resumes. Resume is refused while a page dialog is pending.
- Stop (`explicit-stop`) blocks input without changing mode, survives hide, show and handoff, and clears only on Resume.
- The gesture that starts a handoff is never delivered. A wheel cannot confirm a handoff; an explicit control is required.
- Fail-closed triggers: `unexpected-page-input`, `page-not-shielded`, `presentation-hidden`, `presentation-minimized` (automation only), `presentation-navigation-blocked`, `presentation-renderer-lost`, `presentation-lost`.
- Other pause reasons: `human-handoff`, `shell-pointer-intervention`, `shell-keyboard-intervention`, `inherited-native-handoff`, `return-failed`, `permission-revocation`.
- Toolbar messages count only from the window's own toolbar frame and URL; the main process enforces every mode rule.
- Chrome documents never navigate, open windows or attach webviews; an attempt fails closed.
- Pages keep painting while occluded (`CalculateNativeWinOcclusion` disabled before app ready). `FrameDriver.presented()` is bounded (3 s) and fails as `CAPTURE_FAILED`, never a hang.

## Native requests and permissions

- One interface: `requests` lists; `respond` takes `requestRef` and exactly one of `optionRef`, `files` or `cancel:true` (`text` only for a prompt option). Refs are handles, not approvals.
- Kinds: `javascript-dialog` (alert, confirm), `file-picker` (HTML file input), `hid`, `usb`, `notifications`, `geolocation`.
- Requests are withdrawn, not denied, on Stop, handoff, return start, hide, disconnect, navigation, caller end, document change and expiry (120 s).
- A human deny or cancel is terminal for that scope within the connection.
- Policy `browser-policy.json`, loaded once per connection, never from MCP arguments:
  - `disabled`, or missing or malformed: no new grants.
  - `manual`: OS consent through `native-consent.exe`.
  - `delegated`: `permissions` ⊆ {hid, usb, notifications, geolocation}, `origins: owned-pages`, `selection: offered-option`, `lifetime: caller-generation`, `newGrants: true`. The live authenticated owner picks an offered option through `respond`.
  - Shipped default: `delegated` with all four kinds.
- `revoke` closes every window of the connection by terminating the companion; only the gateway confirms the exit.
- Unsupported, refused with a reason: Bluetooth, serial, display capture, File System Access pickers, `window.prompt` (Electron 44.9.1).

## Result vocabulary

- `disposition`: `observed`, `executed`, `uncertain` (with `replaySafe:false`), `not-executed`, `connection-terminated`.
- Errors: `BrowserHostError(code)` from `contract.fail()`. The MCP envelope is `{disposition, code, reason, replaySafe:false}` with disposition `failed-or-unknown` or `not-executed`. Code inventory: `grep "fail('" src` (not mirrored here).
- Runtime capability report: `BrowserHost.status().capabilities`.
