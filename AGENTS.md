# AGENTS.md

Entry point for agents maintaining this repository. Read this file, then only the
docs its Edit table names.

Read order for a task: this file (Edit table) → the `change-map.md` steps → the
`contracts.md` sections they name → `testing.md`.

## Identity

| Key | Value |
| --- | --- |
| Product | Independent Windows Browser, a folder-registered Mixdog plugin named `win-browser` |
| Agent surface | MCP tool `mcp__plugin-win-browser__browse` (29 actions, including DevTools reads and the sandboxed script runner `run`; text page results with persistent `e<n>` refs and diffs), skill `independent-browser`, host hooks (auth and lifecycle only) |
| Runtime | Own Electron 44.9.1 companion per MCP connection; one window per page (toolbar + live page + input shield) |
| Platform | Windows x64; development needs Node.js ≥ 22.19 |
| Repository | `github.com/eerraa/mixdog-browser-use-extension` (private), branch `main` |
| Version | `0.3.5`. Version locations and releases: `build-release.md` |
| Languages | Code and agent docs: English. `README.md`: Korean, for end users. Toolbar UI: en and ko |

## Docs

Each fact has one owner; other docs link to it. Every doc under `docs/agents/` opens
with Owns, Not here and Update when.

| Doc | Owns | Not here | Read when |
| --- | --- | --- | --- |
| `AGENTS.md` | identity, doc list, hard rules, repo map, commands, Edit table | how code connects, rules, symbol-level steps | always first |
| `docs/agents/requirements.md` | requirements C1–C10, acceptance criteria, covering suites and real-device status per criterion | behavior rules, test procedures | scoping a change; reporting verification |
| `docs/agents/architecture.md` | processes, call path, module map, import direction, Electron hooks, page and window model, data and package layout | rules, edit steps, build steps | locating code, tracing a flow |
| `docs/agents/contracts.md` | binding behavior rules: authority, observation and input, DevTools reads, script runner, human DevTools, handoff state machine, permissions, result vocabulary | requirements, rationale, code locations | before any behavior change or review |
| `docs/agents/change-map.md` | symbol-level edit steps, rules to keep and extra steps per Edit table ID | which files, tests and docs | implementing a request |
| `docs/agents/testing.md` | suites, prerequisites, expected counts, Electron substitute, live harnesses, where to add tests, real-device check procedure, test rules | criteria and their status, build steps | verifying a change |
| `docs/agents/build-release.md` | pins, build and package pipeline, clean package build, versioning, release, licensing upkeep | notice texts, verification | building, packaging, upgrading, releasing |
| `docs/agents/decisions.md` | rationale, rejected alternatives, revisit triggers (D1–D24) | the rules themselves | proposing a design change; "why not X?" |
| `README.md` | end-user install, usage, safety (Korean, shipped) | maintainer detail | user-visible behavior changes |
| `skills/independent-browser/SKILL.md` | how agents use the tool (shipped) | implementation | tool behavior or usage changes |
| `THIRD_PARTY_NOTICES.md` | third-party provenance and licenses (shipped) | when to update it (`build-release.md` Licensing) | pins, derived Mixdog files or patches change |

Doc rules:
- Update the owning doc in the same change as the code; the Edit table lists the docs per request.
- Cite `path` + symbol, never line numbers. Tables and paths over prose.
- No progress notes, work logs or histories in docs; real-device status per criterion lives in `requirements.md`.
- A new recurring change pattern gets an Edit table row, and `change-map.md` steps when files alone are not enough.

## Hard rules

1. Official Mixdog plugin contract only: skills, MCP servers, hooks. Never patch installed Mixdog, its ASAR or runtime, call its private bridge, depend on built-in Browser Use, or assume an undocumented extension API.
2. `requirements.md` and `contracts.md` are binding. Never weaken them to pass a test, auto-resume Stop, handoff or denial, or replay executed or uncertain input.
3. Never copy external browser profiles, cookies or accounts. Never use real accounts for login, posting, payment or deletion during verification.
4. Do not modify installed Mixdog, account, auth or server settings, `D:\Engineering\mixdog-computer-use-extension`, or `D:\Engineering\antigravity-aistudio-bridge`.
5. User-only steps: plugin registration and activation, disabling built-in Browser Use, app restart, OS consent prompts.
6. An implementation request is standing approval to prepare a dedicated development branch/managed worktree and stage/commit verified logical units without waiting for the whole task to end. Reuse the same task's development branch; never implement directly on main or switch another active task's branch. Include only owned or explicitly approved changes. Main integration, push, merge, history rewriting, tags, releases and remote changes require separate explicit user requests.
7. Code derived from Mixdog is an independent fork of 1.3.4 (`968ee089`), recorded in `third_party/mixdog/provenance.json`; Mixdog is not tracked or re-synced. Edit derived files in place and, in the same change, keep their change notice, the provenance record and `THIRD_PARTY_NOTICES.md` current (R13).
8. Report verification per layer (unit, live Electron, packaged MCP, real device).
9. `build/`, `dist/`, `node_modules/` and `%TEMP%` test directories are generated. Never commit them. Mixdog runs a registered package in place, so never delete a `dist/` package without asking.

## Repo map

| Path | Responsibility |
| --- | --- |
| `src/mcp/` | MCP stdio server, `browse` schema and result text, gateway that spawns and owns the companion |
| `src/hook/` | host hook process: lease injection, lifecycle fan-out |
| `src/companion/` | Electron main per connection: pipe server, role and method auth, termination |
| `src/browser/` | browser engine: pages, dispatch and handoff (`host.mjs`), CDP and frames, window presentation, permissions, dialogs, DevTools |
| `src/browser/perception/` | walker source and the pure text projection: model, refs, render, `find` |
| `src/browser/runner/` | `run`: sandbox window, op bridge, script API |
| `src/shared/` | modules of more than one process, without Electron: browse contract, authority, RPC, paths, async |
| `native/` | `bridge.cpp` launcher (Job object), `consent.cpp` Windows consent helper |
| `scripts/` | `build.mjs` bundles, `build-native.mjs`, `package.mjs`, `sdk-adapter.mjs` SDK patch |
| `tests/shared/`, `tests/companion/`, `tests/scripts/` | core unit tests (`npm test`) |
| `tests/browser/` | engine unit tests on an Electron fixture (`test:browser`) |
| `tests/native/` | native helper test (`test:native`) |
| `tests/live/` | real Electron harnesses (`test:live`) |
| `tests/package/` | packaged folder and MCP end to end (`test:package`) |
| `plugin.json`, `hooks/`, `skills/`, `browser-policy.json` | shipped plugin surface and policy |
| `third_party/mixdog/` | Mixdog fork record `provenance.json`, Mixdog `LICENSE` and `NOTICE.md` |
| `THIRD_PARTY_NOTICES.md`, `LICENSE` | shipped notices; project license |
| `docs/agents/` | this doc system; not shipped |

Modules, entry points and import direction: `architecture.md`.

## Commands

| Purpose | Command | Needs |
| --- | --- | --- |
| Setup | `npm ci`; `node node_modules/electron/install.js` | network |
| Bundle | `npm run build` | node_modules |
| Core tests | `npm test` | node_modules |
| Browser unit tests | `npm run test:browser` | node_modules |
| Live Electron tests | `npm run test:live` | node_modules, unlocked desktop |
| Native helpers | `npm run build:native -- "<MinGW licenses dir>"` | MinGW-w64 `g++` |
| Native test | `npm run test:native` | native helpers |
| Package | `npm run package` | build, native helpers |
| Package tests | `$env:WB_PACKAGE_DIR="<abs>\win-browser"; npm run test:package` | package |
| Real-device check | procedure in `testing.md` Real-device checks; criteria in `requirements.md` | fresh package, user registration, PC not in use |

Prerequisites and caveats: `testing.md`, `build-release.md`.

## Edit table

Where a request lands: files to edit, tests to update or run, docs to update.
Symbol-level steps and the rules to keep: `change-map.md` under the same ID (R11, R15
and R16 need none). Harnesses are in `tests/live/`; `mcp.test.mjs` and
`layout.test.mjs` are in `tests/package/`.

| ID | Request | Edit | Tests | Docs |
| --- | --- | --- | --- | --- |
| R1 | New or changed `browse` action or argument | `src/shared/contract.mjs`, `src/mcp/tool.mjs`, `src/browser/host.mjs` | `tests/shared/contract.test.mjs` (enumerates every action), `tests/browser/host.test.mjs`; real browser effect: `scenarios.mjs`; MCP-visible: `mcp.test.mjs` | `SKILL.md`, `README.md` action table |
| R2 | Toolbar, window chrome, labels, languages | `src/browser/presentation.mjs`, `src/browser/toolbar-preload.cjs`, `src/browser/host.mjs`, `src/browser/consent.mjs`; a new chrome file also `scripts/build.mjs`, `scripts/package.mjs` | toolbar tests in `tests/browser/host.test.mjs` on `tests/browser/electron-fixture.mjs`; the `toolbar: …` check in `scenarios.mjs`, probes in `presentation.mjs`; a new chrome file also `layout.test.mjs` | `README.md` (Korean button names), `SKILL.md` (button names agents cite), `architecture.md` Window composition |
| R3 | Handoff, Stop, resume, fail-closed behavior | `src/browser/presentation.mjs`, `src/browser/host.mjs`, `src/browser/permissions.mjs` | handoff, Stop, drain and fail-closed tests in `tests/browser/host.test.mjs`; `scenarios.mjs` | `contracts.md` Handoff state machine, `README.md` handoff paragraphs, `SKILL.md` step 6 and Recovery |
| R4 | Observation, perception, text results, refs, settle, signals, targeting, frames, input dispatch | `src/browser/perception/*`, `src/browser/frames.mjs`, `src/browser/host.mjs`, `src/browser/settle.mjs`, `src/browser/signals.mjs`, `src/shared/contract.mjs` | `tests/browser/perception.test.mjs` (pure modules), `frames.test.mjs`, `host.test.mjs`, `tests/shared/contract.test.mjs`; `perception-harness.mjs` (real Chromium walker), `security-harness.mjs` (privacy, frame races, secrets, points, escape paths, bounds), `review-harness.mjs` (geometry, shadow), `observation-harness.mjs`, `workers-harness.mjs`, `scenarios.mjs`; nested-frame test in `mcp.test.mjs` | `contracts.md` Observation and input (text grammar), `SKILL.md` Reading results and targeting guidance |
| R5 | JS dialogs, file uploads, downloads | `src/browser/dialogs.mjs`, `src/browser/host.mjs`, `src/browser/frames.mjs`, `src/browser/requests.mjs` | `tests/browser/dialogs.test.mjs`, `requests.test.mjs`, `host.test.mjs`; `autonomous-harness.mjs`; request test in `mcp.test.mjs` | `README.md` limits, `SKILL.md` step 4 |
| R6 | Device or web permissions, delegation policy | `src/browser/permissions.mjs`, `permission-broker.mjs`, `policy.mjs`, `consent.mjs`, `host.mjs`; `browser-policy.json`; `native/consent.cpp` | `tests/browser/permission-broker.test.mjs`, `policy.test.mjs`, permission tests in `host.test.mjs`; `autonomous-harness.mjs`, device checks in `scenarios.mjs`; `layout.test.mjs` (shipped policy) | `README.md` 권한과 안전 경계, `SKILL.md` steps 4–5, `contracts.md` Native requests and permissions |
| R7 | Profiles, data directories, connection lifetime | `src/browser/host.mjs`, `src/shared/paths.mjs`, `src/companion/main.mjs`, `src/mcp/gateway.mjs` | isolation test in `tests/browser/host.test.mjs`; teardown and last-tab tests in `mcp.test.mjs` | `architecture.md` Data layout and Teardown, `requirements.md` AC18, `README.md` |
| R8 | MCP transport, timeouts, process lifecycle | `src/mcp/main.mjs`, `src/mcp/gateway.mjs`, `src/shared/rpc.mjs`, `src/companion/main.mjs`, `src/browser/host.mjs`, `plugin.json`, `native/bridge.cpp` | `tests/shared/rpc.test.mjs`, `tests/companion/termination.test.mjs`, `mcp.test.mjs` (EOF, teardown) | `architecture.md` Processes and Call path |
| R9 | Caller identity, hooks | `src/hook/main.mjs`, `src/shared/authority.mjs`, `src/companion/main.mjs`, `hooks/hooks.json` | `tests/shared/authority*.test.mjs`; hook admission test in `mcp.test.mjs` | `contracts.md` Authority and isolation |
| R10 | Plugin, server or tool rename (avoid) | `plugin.json`, `hooks/hooks.json`, `src/shared/authority.mjs`, `src/mcp/tool.mjs`, `src/mcp/main.mjs`, `skills/independent-browser/SKILL.md`, `scripts/package.mjs` | `layout.test.mjs` | `README.md`, Identity |
| R11 | Version bump | the files in `build-release.md` Versioning | — | Identity |
| R12 | Electron upgrade | `package.json`, `package-lock.json`, `src/browser/dialogs.mjs`, `src/browser/host.mjs`, `scripts/package.mjs` | version strings in `tests/browser/user-agent.test.mjs`, `tests/companion/fixture.mjs`, `autonomous-harness.mjs`, `mcp.test.mjs`; every suite, live and package included | `README.md`, `THIRD_PARTY_NOTICES.md`, `build-release.md` Pins, Identity |
| R13 | Code derived from Mixdog | the derived file (`third_party/mixdog/provenance.json` `derived[].files`); the record itself when a file moves, splits or is added | the tests of the file's area (R4); `layout.test.mjs` (fork record, Mixdog notices) | `THIRD_PARTY_NOTICES.md` Mixdog rows |
| R14 | MCP SDK upgrade | `package.json`, `package-lock.json`, `scripts/sdk-adapter.mjs` | `tests/scripts/sdk-adapter.test.mjs`; SDK version assert in `layout.test.mjs` | `THIRD_PARTY_NOTICES.md` SDK section, `build-release.md` Pins |
| R15 | Native helpers | `native/bridge.cpp`, `native/consent.cpp`, `scripts/build-native.mjs` (flags, outputs, license list) | `tests/native/consent.test.mjs`; package suite | `THIRD_PARTY_NOTICES.md` Native helpers |
| R16 | Browser identity (user agent) | `src/browser/user-agent.mjs` | `tests/browser/user-agent.test.mjs`, `tests/companion/fixture.mjs`; identity baseline run in `tests/live/browser-host.test.mjs` | `README.md` 권한과 안전 경계 |
| R17 | DevTools reads (console, network, inspect, performance), page-world evaluate, human DevTools | `src/browser/devtools.mjs`, `src/browser/host.mjs`, `src/browser/frames.mjs`, `src/browser/consent.mjs`; arguments as R1 | `tests/browser/devtools.test.mjs`, `frames.test.mjs` (recording order, worker fence, replays, discard, flush, page worlds), `host.test.mjs` (gates, lane independence, Stop, profile-shared workers, human DevTools exits), `tests/shared/contract.test.mjs`; `devtools-harness.mjs`; DevTools test in `mcp.test.mjs` | `contracts.md` DevTools reads and Human DevTools, `SKILL.md` DevTools section, `README.md` action table and 개발자 도구 paragraph, `architecture.md` CDP rows |
| R18 | Script runner (`run`): script API, ops, sandbox, run report | `src/browser/runner/*`, `src/browser/host.mjs`, `src/companion/main.mjs`, `scripts/build.mjs`; arguments as R1 | `tests/browser/runner.test.mjs` (API, allowlist, outcomes, seal, deadline, report), run test in `host.test.mjs`, `tests/shared/contract.test.mjs`; `runner-harness.mjs` (no Node, no network, forged nonce and ops, form flow, seal, Stop, handoff, CPU-loop deadline); run test in `mcp.test.mjs` | `contracts.md` Script runner, `SKILL.md` Scripts section, `README.md` action table |
| — | Not listed | the module's row in `architecture.md` Module map, then the nearest row above | as that row | as that row; add a row here |

## Done criteria

This list is complete; no other check is required. Intermediate steps run only the touched part's checks; the full set runs once, on the final candidate. A measured criterion the user sets for a task is that task's done criterion. Checks outside this list run only on user request and are reported as unverified, never as passed.

| Change | Done checks | Not a done criterion |
| --- | --- | --- |
| Code, tests, scripts, config or native sources (its Edit table row, or Not listed) | The tests in the row's Tests column pass (commands and expected counts: `testing.md` Suites); when they include `tests/package/` files, `test:package` passes on a fresh package (`build-release.md` Clean package build). The docs in the row's Docs column, plus `README.md` or `SKILL.md` when user- or agent-visible behavior changed. Real-device status in `requirements.md` back to `not verified` for criteria on a changed path | Suites outside the row; real-device checks (`testing.md` Real-device checks); live sites; hardware this PC lacks |
| Docs only (Markdown text; no shipped file added, moved or renamed) | `git diff --check` | Builds, packages, suites, live runs, real-device checks |

Every change: no generated files committed (Hard rule 9); `%TEMP%` test directories a run left are removed (prefixes in `testing.md` Suites).
