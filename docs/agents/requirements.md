# Requirements

Owns: requirements C1–C10, their acceptance criteria, and per criterion the suites
that cover it and its real-device status.
Not here: the behavior rules (`contracts.md`), how to run suites and real-device
checks (`testing.md`), rationale (`decisions.md`).
Update when: a requirement or criterion is added, changed or removed; a covering
suite changes; a real-device check runs on a package built from the current tree; a
change touches the path of a `verified` criterion (it goes back to `not verified`).

Binding together with `contracts.md`: a change that breaks an item is a defect even
when tests pass.

## Requirements

| ID | Requirement |
| --- | --- |
| C1 | Folder install: the packaged `win-browser` folder runs with its bundled runtime, app, native helpers and licenses. Users never install dev tools, build, or patch Mixdog. |
| C2 | Natural selection: one MCP tool and the `independent-browser` skill; agents choose them for interactive web work without being told. Own names are fine; built-in names and UI are not cloned. |
| C3 | Real browser work: navigation, DOM and screenshot observation, exact targeting, click, typing, forms, tabs, frames, HTML uploads, downloads, dialogs and result checks, with ref freshness and validation, cancellation and uncertainty semantics. |
| C4 | Independence: works with built-in Browser Use off; own windows and profiles; the person handles login, passwords, CAPTCHA and 2FA in the same window; no copying of profiles, cookies or accounts; no built-in handoff. |
| C5 | Protected requests follow the trusted package policy (`contracts.md` Native requests and permissions). The agent never operates an approval UI; MCP arguments never create policy or approval. |
| C6 | Denial and cancellation are never bypassed or re-asked. One requester's navigation or cancel never aborts another valid requester. Revocation removes real Chromium grants (process termination), never just caches. Unverifiable requester or scope: refuse with a reason. OS approval, user activation and browser security stay on. |
| C7 | Change is not stop: navigation, reload, frame swap, hide, human intervention and disconnect recover through fresh observation; Stop, denial and revocation are never auto-cleared. Stale refs, points and snapshot IDs are never reused; executed or uncertain input is never resent. |
| C8 | Isolation: tabs are owned per caller session; input is serialized per tab; ended callers' late calls are rejected; hooks affect only this plugin's tool. |
| C9 | Reuse boundary: only the Mixdog browser code forked at 1.3.4 (`third_party/mixdog/provenance.json`), not tracked afterwards; no Mixdog core, ASAR or private bridge; no agent runner or agent settings; provenance and licenses preserved. |
| C10 | Honest verification: unit, live Electron, packaged MCP and real-device evidence are reported separately. |

## Acceptance criteria

Suites: unit `<name>` = `tests/{shared,companion,scripts,browser}/<name>.test.mjs`,
native `<name>` = `tests/native/<name>.test.mjs`, live `<name>` =
`tests/live/<name>.test.mjs`, package `<name>` = `tests/package/<name>.test.mjs`
(`testing.md` Suites).

Real device: the package registered in Mixdog on the user's PC (`testing.md`
Real-device checks). `verified` = checked on a package built from the current tree;
`not verified`; `—` = nothing beyond the suites to check.

| AC | Req | Criterion | Suites | Real device |
| --- | --- | --- | --- | --- |
| AC1 | C1 | The package folder holds the runtime, `app/` bundles, `bin/` helpers, policy, hooks, skill and licenses, and serves MCP through `bin/bridge.exe --mcp` with nothing else installed | package `layout`, `mcp` | — |
| AC2 | C1, C2, C8 | Registered in Mixdog with built-in Browser Use off, the tool appears, its calls pass the host hooks, and an agent picks the tool and the skill for interactive web work unprompted | package `mcp` (hook admission) | verified |
| AC3 | C3 | Navigation, text and screenshot observation, exact targeting, click, typing, forms, tabs, frames, uploads, downloads and dialogs, with result checks, on local pages | unit `contract`, `host`, `frames`, `perception`, `dialogs`, `requests`; live `browser-host`, `perception`, `observation`, `review-regressions`, `workers`; package `mcp` | — |
| AC4 | C3 | Text results and agent DevTools reads stay compact on large real sites (e.g. naver main and login) through the registered tool | unit `perception`, `devtools`; live `perception`, `devtools` (local pages) | verified |
| AC5 | C2, C3 | An agent chooses and completes `run` scripts through the registered package on real sites | unit `runner`; live `runner`; package `mcp` (local pages) | verified |
| AC6 | C4 | A person takes over the same window with a real mouse and keyboard on the toolbar, shield and page, and hands control back | unit `host`; live `browser-host` (synthetic input) | verified |
| AC7 | C4 | Agent windows never take focus: a handoff only flashes the window, and focus emulation keeps pages behaving as focused, as seen by a person on a real desktop | unit `host`; live `security` (focus emulation in an out-of-process iframe) | verified |
| AC8 | C3, C4 | Korean IME input and real secrets entered by a person reach the page and stay out of results, signals and DevTools | live `security` (synthetic input) | verified |
| AC9 | C4 | Human DevTools opened from the real menu bar (Alt) during handoff work for a person and close on return | unit `host`; live `devtools` (menu callback) | verified |
| AC10 | C5 | Protected requests follow the shipped `browser-policy.json`; the agent resolves delegated requests through the tool, never through an approval UI or MCP arguments | unit `permission-broker`, `policy`, `host`; live `autonomous`; package `layout` (shipped policy) | — |
| AC11 | C5, C6 | Under a `manual` policy, a protected request raises the Windows consent prompt, and a denial is final | unit `host`; native `consent` (availability only) | not verified |
| AC12 | C5 | Real HID devices can be selected and used under the shipped policy | unit `host`; live `browser-host` (device permission checks) | verified |
| AC13 | C6 | Denial and cancellation are never bypassed or re-asked; one requester's cancel never aborts another; revocation terminates the companion | unit `host`, `permission-broker`, `requests`, `termination`; live `autonomous`, `security`; package `mcp` (teardown) | — |
| AC14 | C7 | Navigation, reload, frame swap, hide and human intervention recover through fresh observation; Stop and denial are never auto-cleared; stale refs and points are refused; executed or uncertain input is never resent | unit `host`, `perception`, `runner`; live `browser-host`, `security`, `runner` | — |
| AC15 | C7 | Native picker and dropdown windows (`showPicker`, date and color pickers) used by a person during automation fail closed with `unexpected-page-input` | live `security`, `runner` (synthetic trusted input) | not verified |
| AC16 | C8 | Tabs are owned per caller session, input is serialized per tab, ended callers' late calls are rejected, and hooks act only on this tool | unit `authority`, `authority-turns`, `authority-lifecycle`, `queue`, `host`; package `mcp` (hook admission) | — |
| AC17 | C9 | Only the forked Mixdog browser code is used, and its fork record and Mixdog's notices ship unmodified | package `layout` | — |
| AC18 | C3, C7 | Closing every tab keeps the connection: the same channel opens new pages; only MCP EOF and revocation end the companion | package `mcp` (last tab, teardown) | verified |
| AC19 | C5 | Real USB devices can be selected and used under the shipped policy | unit `host`; live `browser-host` (device permission checks) | not verified |

C10 governs every verification report (`testing.md` Rules) and has no criterion of its own.
