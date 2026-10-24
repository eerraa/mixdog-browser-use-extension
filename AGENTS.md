# AGENTS.md

Entry point for agents maintaining this repository. Read this file, then only the
doc the task router points to.

Read order for a task: this file → `change-map.md` recipe → the `contracts.md`
sections it names → `testing.md` matrix.

## Identity

| Key | Value |
| --- | --- |
| Product | Independent Windows Browser, a folder-registered Mixdog plugin named `win-browser` |
| Agent surface | MCP tool `mcp__plugin-win-browser__browse` (24 actions), skill `independent-browser`, host hooks (auth and lifecycle only) |
| Runtime | Own Electron 44.9.1 companion per MCP connection; one window per page (toolbar + live page + input shield) |
| Platform | Windows x64; development needs Node.js ≥ 22.19 |
| Repository | `github.com/eerraa/mixdog-browser-use-extension` (private), branch `main` |
| Release state | `v0.1.0` released; its tag points outside `main`'s single initial commit. `main` adds the single-window toolbar UI (unreleased) |
| Languages | Code and agent docs: English. `README.md`: Korean, for end users. Toolbar UI: en and ko |

## Doc system

Each fact has one owner. Other docs link to the owner instead of repeating it.

| Doc | Owns | Read when |
| --- | --- | --- |
| `AGENTS.md` | identity, hard rules, doc ownership, commands, task router | always first |
| `docs/agents/architecture.md` | processes, call path, module map, Electron hooks, page and window model, data and package layout | locating code, tracing a flow |
| `docs/agents/contracts.md` | binding invariants C1–C10, authority, observation and input rules, handoff state machine, permissions, result vocabulary | before any behavior change or review |
| `docs/agents/change-map.md` | recipes R1–R16: request → files and symbols → co-changes → tests → docs | implementing a request |
| `docs/agents/testing.md` | suites, prerequisites, fixtures, where to add tests, manual checks, test artifacts | verifying a change |
| `docs/agents/build-release.md` | pins, build and package pipeline, versioning, release, licensing | building, packaging, upgrading, releasing |
| `docs/agents/decisions.md` | rationale, rejected alternatives, revisit triggers (D1–D10) | proposing a design change; "why not X?" |
| `README.md` | end-user install, usage, safety (shipped) | user-visible behavior changes |
| `skills/independent-browser/SKILL.md` | how agents use the tool (shipped) | tool behavior or usage changes |
| `THIRD_PARTY_NOTICES.md` | third-party provenance and licenses (shipped) | pins, vendored files or patches change |

Doc rules:
- Update the owning doc in the same change as the code; each recipe lists its docs.
- Cite `path` + symbol, never line numbers. Tables over prose.
- A new recurring change pattern gets a recipe in `change-map.md` and a router row here.

## Hard rules

1. Official Mixdog plugin contract only: skills, MCP servers, hooks. Never patch installed Mixdog, its ASAR or runtime, call its private bridge, depend on built-in Browser Use, or assume an undocumented extension API.
2. `contracts.md` is binding. Never weaken it to pass a test, auto-resume Stop, handoff or denial, or replay executed or uncertain input.
3. Never copy external browser profiles, cookies or accounts. Never use real accounts for login, posting, payment or deletion during verification.
4. Do not modify installed Mixdog, account, auth or server settings, `D:\Engineering\mixdog-computer-use-extension`, or `D:\Engineering\antigravity-aistudio-bridge`.
5. User-only steps: plugin registration and activation, disabling built-in Browser Use, app restart, OS consent prompts.
6. Commit, push, tag, release and remote changes only on explicit user request.
7. Upstream code enters only through `vendor/mixdog` + `upstream.lock.json`. Adapt it in `scripts/build.mjs` behind exact-once guards; never edit vendored files.
8. Report verification per layer (unit, live Electron, packaged MCP, real device). Unverified is not done.
9. `build/`, `dist/`, `vendor/mixdog/`, `node_modules/` and `%TEMP%` test directories are generated. Never commit them. Mixdog runs a registered package in place, so never delete a `dist/` package without asking.

## Repo map

| Path | Contents | Details |
| --- | --- | --- |
| `src/` | MCP server, hook, gateway, companion, browser host | `architecture.md` |
| `native/` | `bridge.cpp` launcher with Job object; `consent.cpp` Windows consent helper | `architecture.md` |
| `scripts/` | vendor, build, build-native, package, SDK adapter | `build-release.md` |
| `tests/` | unit, live Electron, packaged MCP | `testing.md` |
| `plugin.json`, `hooks/`, `skills/`, `browser-policy.json` | shipped plugin surface and policy | `architecture.md`, `contracts.md` |
| `upstream.lock.json`, `THIRD_PARTY_NOTICES.md`, `LICENSE` | provenance and licensing | `build-release.md` |
| `docs/agents/` | this doc system; not shipped | — |

## Commands

| Purpose | Command | Needs |
| --- | --- | --- |
| Setup | `npm ci`; `node node_modules/electron/install.js`; `npm run vendor` | network |
| Bundle | `npm run build` | vendor |
| Core tests | `npm test` | node_modules |
| Browser unit tests | `npm run test:browser` | build |
| Live Electron tests | `npm run test:live` | build, unlocked desktop |
| Native helpers | `npm run build:native -- "<MinGW licenses dir>"` | MinGW-w64 `g++` |
| Native test | `npm run test:native` | native helpers |
| Package | `npm run package` | build, native helpers |
| Package tests | `$env:WB_PACKAGE_DIR="<abs>\win-browser"; npm run test:package` | package |

Prerequisites and caveats: `testing.md`, `build-release.md`.

## Task router

| Request | Recipe in `change-map.md` |
| --- | --- |
| New or changed `browse` action or argument | R1 |
| Toolbar, window chrome, labels, languages | R2 |
| Handoff, Stop, resume, fail-closed behavior | R3 |
| Observation, targeting, frames, input dispatch | R4 |
| JS dialogs, file uploads, downloads | R5 |
| Device or web permissions, delegation policy | R6 |
| Profiles, data directories, connection lifetime | R7 |
| MCP transport, timeouts, process lifecycle | R8 |
| Caller identity, hooks | R9 |
| Plugin, server or tool rename | R10 |
| Version bump | R11 |
| Electron upgrade | R12 |
| Upstream Mixdog upgrade | R13 |
| MCP SDK upgrade | R14 |
| Native helpers | R15 |
| Browser identity (user agent) | R16 |
| Not listed | find the module in `architecture.md`, apply the nearest recipe, then add a recipe |

## Done when

- Code, owning docs, and `README.md` or `SKILL.md` when user- or agent-visible behavior changed.
- Suites for the touched area pass (`testing.md`); shipped-surface changes also pass `test:package` on a fresh package.
- No generated files committed; `%TEMP%` test directories removed when cleaning up (prefixes in `testing.md`).
