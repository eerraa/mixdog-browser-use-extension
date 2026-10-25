# Testing

Owns: how to verify. Build steps: `build-release.md`. What must hold: `contracts.md`.

## Suites

| Command | Scope | Needs | Real windows | `%TEMP%` dirs left |
| --- | --- | --- | --- | --- |
| `npm test` | `tests/core/*.test.mjs`, `tests/authority*.test.mjs`, `tests/rpc.test.mjs`, `tests/sdk-adapter.test.mjs`, `tests/companion-termination.test.mjs` | `node_modules` | no | `companion-termination-*` |
| `npm run test:browser` | `tests/browser/run.mjs` → contract, frames, host, policy, requests, dialogs, user-agent, devtools, perception, runner in one `node --test` (30 s cap); arguments select a subset | `node_modules` | no (Electron mocked) | `independent-browser-check-*`, `independent-browser-unit-*`, `browser-startup-cancel-*`, `browser-policy-*` |
| `npm run test:native` | `tests/native-consent.test.mjs`: availability enum only, never a prompt | `build/native-consent.exe` | no | — |
| `npm run test:live` | `tests/live/*.test.mjs` (9 files, 10 tests) | `node_modules/electron/dist`, unlocked desktop | yes | `independent-browser-live-*`, `browser-autonomous-live-*`, `browser-observation-한글-*`, `browser-review-*`, `browser-workers-live-*`, `browser-devtools-live-*`, `browser-perception-live-*`, `browser-runner-live-*`, `browser-security-live-*` |
| `npm run test:package` | `tests/package/layout.test.mjs`, `tests/package/mcp.test.mjs`: packaged `bin/bridge.exe`, MCP SDK client, hook admission, real pages | `WB_PACKAGE_DIR` = absolute path of the packaged `win-browser` folder | yes | `browser-package-한글-*` |

- Baseline at v0.3.1 (image-only control names): `npm test` 27, `test:browser` 187, `test:live` 10, `test:package` 11, `test:native` 1 passing (v0.3.0 after the runner review fixes, D22: 27, 187, 10, 11, 1; script runner R18 and Phase B review fixes: 27, 174, 10, 11, 1; text-result perception D13–D19: 27, 157, 8, 9, 1; DevTools round: 27, 134, 7, 9, 1; v0.2.0: 27, 111, 6, 8, 1). A lower count means skipped or lost tests.
- Runners keep stdout and stderr in their temp dirs and print the path. Nothing deletes them; clean up by the prefixes above.
- File lists: `npm test` globs live in `package.json`; `test:browser` files are listed in `tests/browser/run.mjs` (add new files there); `test:live` and `test:package` glob their folders.

## Unit Electron substitute

- `tests/browser/*.test.mjs` map `electron` to `tests/browser/electron-fixture.mjs` with `node:module` `registerHooks`. The fixture models windows, views, focus, IPC, debugger and sessions; it proves no Chromium or OS behavior.
- A new Electron API in `src/browser/*` needs a fixture extension first.
- `tests/companion-termination.test.mjs` maps `electron`, `node:net`, `./browser/host.mjs` and `./rpc.mjs` to `tests/companion-fixture.mjs`.

## Live harnesses

| Test | Harness | Covers |
| --- | --- | --- |
| `browser-host.test.mjs` | `harness.mjs` + `scenarios.mjs` | identity baseline run, then the behavioral contract including toolbar and occluded-frame checks; marker `BROWSER_CONTRACT_PASSED` |
| `autonomous.test.mjs` | `autonomous-harness.mjs` | native requests resolved by the agent under the shipped policy |
| `observation.test.mjs` | `observation-harness.mjs` | first observations across independent connections |
| `review-regressions.test.mjs` | `review-harness.mjs` (`geometry`, `shadow`) | geometry and shadow DOM regressions |
| `workers.test.mjs` | `workers-harness.mjs` | worker startup in hidden and visible frames |
| `perception.test.mjs` | `perception-harness.mjs` | the composed walker in real Chromium isolated worlds: no password/OTP, CSS/JS, hidden or screen-reader-only text; wrappers folded; image-only links and icon buttons named by embedded `alt`, `aria-label` and svg `title` (never `aria-hidden` or `opacity:0` content, never a nested control's name); shadow DOM and iframe order; covered/offscreen summaries; persistent ids, rename and removal; live-region and toast diffs; quiet ignores text tickers, structural churn hits its cap; the dispatch guard (a real press under a cover reports a mismatch, a misdirected `insertText` is cancelled); prints token and capture timing |
| `security.test.mjs` | `security-harness.mjs` | review fixes through the real host: navigation, dialog, popup and download during handoff stay private from another tab and after return; a cross-origin frame moving every animation frame is refused; a transparent frame toggled over a target never gets a click; a point under an `opacity:0` cross-origin frame is refused and named; focus emulation reaches an out-of-process iframe; sensitive fields (show-password toggle, split OTP, Korean labels, a field typed during handoff) and `SENSITIVE_PRESENT`; trusted page input outside a dispatch fails closed; a reinserted element's new ref clicks; a scroll diff shows content that scrolled in; 1000 srcdoc frames and a 12 000-deep (`display:contents`) DOM stay bounded; page code refused beside a same-origin login iframe and while a named popup is in handoff; a parent stealing focus from a cross-origin iframe never receives text or keys; a container read, a live region and text waits never reveal a sensitive contenteditable; a field typed during handoff stays private after 600 input events elsewhere; label names leave out `visibility:hidden` and `opacity:0` text |
| `runner.test.mjs` | `runner-harness.mjs` | `run` through the host: no Node, network, navigation, popups or string evaluation in the sandbox; forged ops, arguments, nonce and sender refused; a multi-step form flow in one call with exactly one submit; a caught uncertain step seals the run; Stop and handoff mid-run; the deadline ends a CPU loop; WebRTC ICE, preconnect and dns-prefetch reach no local TCP or UDP listener; runs share the `wb-runner` partition behind the dead proxy; a syntax error or wrapper breakout is refused before any sandbox exists; a real `confirm()` makes the run uncertain and is answered with `handle_dialog` after it; trusted input between fast scripted clicks fails closed while the clicks alone never do |
| `devtools.test.mjs` | `devtools-harness.mjs` | load-time console, exception, worker and cross-origin frame entries; URL redaction in console text; 200/404 network rows, header, request and response body redaction, response body; a real 302 chain (hop `redirected`, no hop body, redacted `Location`); console cursor; isolated `evaluate` output not recorded; two windows of one profile with a service worker (worker activity during the other window's handoff withheld, recording resumes after); page-world read, side-effect refusal, `for(;;){}` read terminated as `SCRIPT_TIMEOUT` near 2 s with the next read succeeding, `world:'page'` evaluate; one row per out-of-process frame document at load and on re-navigation; inspect by ref (ref stays valid) and by selector for hidden elements; performance; handoff entries withheld and in-flight request incomplete; human DevTools only in handoff, closed on return; agent CDP session after DevTools; prints `SAMPLE` outputs and `DEVTOOLS_SIZES` |

- Each test spawns `node_modules/electron/dist/electron.exe <harness> <dataDir>` without `ELECTRON_RUN_AS_NODE`. The harness serves local HTTP fixtures on 127.0.0.1 and must print its marker.
- Add real-window checks as `await check('<behavior>', async () => …)` in `tests/live/scenarios.mjs`; shared probes live in `tests/live/presentation.mjs`.
- Windows open without taking focus (`showInactive`); leave the desktop alone during the run.
- `review-harness.mjs` clicks immediately after `open` on a page without contentful paint in its root, which exercises the paint-holding wait (`FrameDriver.inputReady`); a dropped click there shows as `effect 0`.
- `harness.mjs` uses `BrowserPolicy.manual()` with `consentHelperPath = build/native-consent.exe`. With that helper present, a manual-consent path can raise a real Windows consent prompt. Keep native helpers out of the repo `build/` (build them in an isolated copy, `build-release.md`) or run attended.

## Where to add tests

| Behavior | File |
| --- | --- |
| argument shapes, URL rules, target matching, checkpoints | `tests/browser/contract.test.mjs` |
| CDP, frames, workers, geometry, `presented()`, `inputReady()` | `tests/browser/frames.test.mjs` |
| walker composition, model, refs, text projection, diff, find, settle, signals (pure) | `tests/browser/perception.test.mjs` |
| walker in real Chromium | `tests/live/perception-harness.mjs` |
| security-relevant behavior through the real host (privacy, frame races, secrets, points, escape paths, bounds) | `tests/live/security-harness.mjs` |
| script API, op allowlist, run outcomes and report | `tests/browser/runner.test.mjs` |
| sandbox isolation and runs in real Electron | `tests/live/runner-harness.mjs` |
| ownership, handoff and Stop, toolbar, popups, permissions, dialogs, uploads, revoke | `tests/browser/host.test.mjs` |
| native request registry | `tests/browser/requests.test.mjs` |
| dialog adapter | `tests/browser/dialogs.test.mjs` |
| policy parsing | `tests/browser/policy.test.mjs` |
| user agent | `tests/browser/user-agent.test.mjs` |
| DevTools records, formats, redaction (including 64 KiB adversarial timing), redirects, privacy windows, page reads | `tests/browser/devtools.test.mjs` |
| tickets and generations | `tests/authority*.test.mjs` |
| queue, permission ledger | `tests/core/*.test.mjs` |
| RPC | `tests/rpc.test.mjs` |
| SDK patch | `tests/sdk-adapter.test.mjs` |
| companion shutdown | `tests/companion-termination.test.mjs` |
| real Electron behavior | `tests/live/scenarios.mjs` |
| packaged folder, MCP end to end | `tests/package/*.test.mjs` |

## Manual checks (not automated)

| Check | Status at the initial commit |
| --- | --- |
| Register the package in Mixdog with built-in Browser Use off; the agent picks the tool unprompted | not run for the current UI |
| Real mouse and keyboard on toolbar, shield and handoff | not run (tests use synthetic input) |
| Korean IME, real secrets, Windows consent prompt | not run |
| Real HID/USB selection and I/O | not run for the current UI |
| Human DevTools opened from the real menu bar (Alt) and used by a person during handoff | not run (live test invokes the native menu callback) |
| Agent DevTools on large real sites (token sizes, buffer pressure) | not run (local fixtures only) |
| Text projection token sizes on large real sites (e.g. naver main and login) through the real tool | not run; Phase A simulation from saved samples only |
| Focus emulation and flash-only handoff seen by a person on a real desktop | not run |
| `run` scripts chosen by an agent through the registered package on real sites | not run (local fixtures only) |
| Native picker or dropdown windows (`showPicker`, date and color pickers) used by a person during automation, and the `unexpected-page-input` fail-closed | not run (live test sends synthetic trusted input) |

## Rules

- Assert behavior, not code shape. Never relax a contract to pass.
- Report each suite separately; unit, live, package and real-device evidence are different claims.
- Evidence comes from the current code and package; earlier reports or test counts are not evidence.
- Local fixtures only; no real-account side effects.
