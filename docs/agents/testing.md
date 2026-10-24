# Testing

Owns: how to verify. Build steps: `build-release.md`. What must hold: `contracts.md`.

## Suites

| Command | Scope | Needs | Real windows | `%TEMP%` dirs left |
| --- | --- | --- | --- | --- |
| `npm test` | `tests/core/*.test.mjs`, `tests/authority*.test.mjs`, `tests/rpc.test.mjs`, `tests/sdk-adapter.test.mjs`, `tests/companion-termination.test.mjs` | `node_modules` | no | `companion-termination-*` |
| `npm run test:browser` | `tests/browser/run.mjs` → contract, frames, host, policy, requests, dialogs, user-agent in one `node --test` (30 s cap); arguments select a subset | `npm run build` | no (Electron mocked) | `independent-browser-check-*`, `independent-browser-unit-*`, `browser-startup-cancel-*`, `browser-policy-*` |
| `npm run test:native` | `tests/native-consent.test.mjs`: availability enum only, never a prompt | `build/native-consent.exe` | no | — |
| `npm run test:live` | `tests/live/*.test.mjs` (5 files, 6 tests) | `npm run build`, `node_modules/electron/dist`, unlocked desktop | yes | `independent-browser-live-*`, `browser-autonomous-live-*`, `browser-observation-한글-*`, `browser-review-*`, `browser-workers-live-*` |
| `npm run test:package` | `tests/package/layout.test.mjs`, `tests/package/mcp.test.mjs`: packaged `bin/bridge.exe`, MCP SDK client, hook admission, real pages | `WB_PACKAGE_DIR` = absolute path of the packaged `win-browser` folder | yes | `browser-package-한글-*` |

- Baseline at v0.2.0: `npm test` 27, `test:browser` 111, `test:live` 6, `test:package` 8, `test:native` 1 passing. A lower count means skipped or lost tests.
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

- Each test spawns `node_modules/electron/dist/electron.exe <harness> <dataDir>` without `ELECTRON_RUN_AS_NODE`. The harness serves local HTTP fixtures on 127.0.0.1 and must print its marker.
- Add real-window checks as `await check('<behavior>', async () => …)` in `tests/live/scenarios.mjs`; shared probes live in `tests/live/presentation.mjs`.
- Windows open and take focus; leave the desktop alone during the run.
- `harness.mjs` uses `BrowserPolicy.manual()` with `consentHelperPath = build/native-consent.exe`. With that helper present, a manual-consent path can raise a real Windows consent prompt. Keep native helpers out of the repo `build/` (build them in an isolated copy, `build-release.md`) or run attended.

## Where to add tests

| Behavior | File |
| --- | --- |
| argument shapes, URL rules, target matching, checkpoints | `tests/browser/contract.test.mjs` |
| CDP, frames, workers, geometry, `presented()` | `tests/browser/frames.test.mjs` |
| ownership, handoff and Stop, toolbar, popups, permissions, dialogs, uploads, revoke | `tests/browser/host.test.mjs` |
| native request registry | `tests/browser/requests.test.mjs` |
| dialog adapter | `tests/browser/dialogs.test.mjs` |
| policy parsing | `tests/browser/policy.test.mjs` |
| user agent | `tests/browser/user-agent.test.mjs` |
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

## Rules

- Assert behavior, not code shape. Never relax a contract to pass.
- Report each suite separately; unit, live, package and real-device evidence are different claims.
- Evidence comes from the current code and package; earlier reports or test counts are not evidence.
- Local fixtures only; no real-account side effects.
