# Change map

Owns: where and how to change code for a request. Each recipe lists edits in
dependency order, the contracts to keep, tests, and docs to update. Structure:
`architecture.md`. Test details: `testing.md`.

## R1 `browse` action or argument

- Edit: `src/browser/contract.mjs` (`fields`, `inputActions`, `keys`, `validateArgs`) → `src/tool-schema.mjs` (`inputSchema` property and description) → `src/browser/host.mjs` (`execute` for immediate actions; `#run` and `#perform` for lane work; call `markSent` right before dispatch).
- Keep: `contracts.md` Observation and input. Every mutating action belongs in `inputActions`.
- Test: `tests/browser/contract.test.mjs` (enumerates every action), `tests/browser/host.test.mjs`; real browser effect → `tests/live/scenarios.mjs`; MCP-visible → `tests/package/mcp.test.mjs`.
- Docs: `SKILL.md`, `README.md` action table.

## R2 Toolbar, window chrome, labels, languages

- Edit: `src/browser/presentation.mjs`: `STRINGS` (a new locale needs its key and the selection in the constructor), `toolbarHTML` and `shieldHTML` (markup, CSS, icons), `#state` (what each mode shows), `#toolbarAction` (accepted actions and mode guards), `TOOLBAR_HEIGHT`.
- Edit: `src/browser/toolbar-preload.cjs` (`render`, `send`); action names must match `#toolbarAction`.
- Edit: `host.mjs #registerPage` `humanActions`; native menu in `consent.mjs installPageMenu`.
- Keep: chrome CSP and no navigation; the toolbar never resumes by itself; address bar and history only in native-handoff.
- Test: `host.test.mjs` toolbar tests with `tests/browser/electron-fixture.mjs`; live `toolbar: …` check in `tests/live/scenarios.mjs`; probes in `tests/live/presentation.mjs`.
- Ship: a new chrome file needs a copy step in `scripts/build.mjs`, `scripts/package.mjs`, and an entry in `tests/package/layout.test.mjs`.
- Docs: `README.md` (Korean button names), `SKILL.md` (button names agents cite), `architecture.md` Window composition.

## R3 Handoff, Stop, resume, fail-closed

- Edit: `presentation.mjs` (`beginDrain`, `enterNative`, `beginReturn`, `finishReturn`, `failClosed`, `shieldKeyboard`, `shieldMouse`, `nativeKeyboard`, `nativeMouse`, frame event handlers); `host.mjs` (`#pause`, `#handoff`, `#resume`, `#owned`); `permissions.mjs admits` (requests during native handoff).
- Keep: every row of `contracts.md` Handoff state machine.
- Test: handoff, Stop, drain and fail-closed tests in `host.test.mjs`; live `scenarios.mjs`.
- Docs: `contracts.md` state machine, `README.md` handoff paragraphs, `SKILL.md` step 6 and Recovery.

## R4 Observation, targeting, frames, input dispatch

- Edit: `frames.mjs` (`capture`, `checkpoint`, `assertCheckpoints`, `prepare`, `point`, `toRoot`, `presented`, target and worker attach); `host.mjs` (`#observe`, `#captureImage`, `#fresh`, `#resolve`, `#perform`); `contract.mjs` (`matchesTarget`, `sameCheckpoint`, `keys`).
- Upstream behavior: adapt in `scripts/build.mjs` with an exact-once guard; never edit `vendor/`.
- Keep: `contracts.md` Observation and input.
- Test: `frames.test.mjs`, `contract.test.mjs`, `host.test.mjs`; live `review-regressions` (geometry, shadow), `observation`, `workers`; package nested-frame test.
- Docs: `SKILL.md` targeting guidance when agent-visible.

## R5 JS dialogs, file uploads, downloads

- Dialogs: `dialogs.mjs` (Electron-pinned adapter), `host.mjs` `#nativeDialog`, `#humanDialog` and the `handle_dialog` branch of `execute`, `frames.mjs` `Page.javascriptDialog*`.
- Uploads: `host.mjs` `#nativeFilePicker`, `#validateFiles`, upload in `#perform`; `frames.mjs` `Page.fileChooserOpened`.
- Downloads: `host.mjs #profile` `will-download`. Registry: `requests.mjs`.
- Keep: refs are not approvals; a dispatched dialog response is never repeated (`DIALOG_UNCERTAIN`); uploads take explicit absolute regular files only.
- Test: `dialogs.test.mjs`, `requests.test.mjs`, `host.test.mjs`; live `autonomous`; package request test.
- Docs: `README.md` limits, `SKILL.md` step 4, `status().capabilities`.

## R6 Device or web permissions, delegation policy

- Edit: `permissions.mjs` (handlers, chooser flow, delegated selection, `admits`); `core/permissions.mjs` (ledger rules); `policy.mjs` (`supported`, schema) with `browser-policy.json`; `consent.mjs` and `native/consent.cpp` (manual OS consent); `host.mjs status().capabilities`.
- Keep: C5, C6 and `contracts.md` Native requests and permissions.
- Test: `core/permissions.test.mjs`, `policy.test.mjs`, permission tests in `host.test.mjs`; live `autonomous`; `tests/package/layout.test.mjs` asserts the shipped policy.
- Docs: `README.md` 권한과 안전 경계, `SKILL.md` steps 4–5.

## R7 Profiles, data directories, connection lifetime

- Edit: `host.mjs #profile`, `src/paths.mjs`, `companion-main.mjs` (userData), `gateway.mjs close` (keeps profiles).
- Keep: C4; profiles per connection and session.
- Test: isolation test in `host.test.mjs`; package teardown test.
- Docs: `architecture.md` Data layout, `README.md`.

## R8 MCP transport, timeouts, process lifecycle

- Edit: `mcp.mjs` (server, error envelope, EOF); `gateway.mjs` (startup 20 s, call 120 s, exit wait 8 s); `rpc.mjs` (framing, limits); `companion-main.mjs` (roles, methods, `terminate`); `plugin.json` (`startupTimeoutMs` 30000, `timeoutMs` 120000); `host.mjs #run` (25 s); `native/bridge.cpp`.
- Keep: transport loss reports `replaySafe:false`; a reconnect serves new calls only.
- Test: `rpc.test.mjs`, `companion-termination.test.mjs`, `tests/package/mcp.test.mjs` (EOF, teardown).
- Docs: `architecture.md` Processes and Call path.

## R9 Caller identity, hooks

- Edit: `hook.mjs`, `authority.mjs`, `hooks/hooks.json` (events, matcher, timeouts 5 s and 2 s), hook role in `companion-main.mjs`.
- Keep: hooks act only on `BROWSER_TOOL` and deny on failure; `contracts.md` Authority and isolation.
- Test: `tests/authority*.test.mjs`; package hook admission test.
- Docs: `contracts.md` Authority and isolation.

## R10 Plugin, server or tool rename

Avoid: it breaks existing registrations. Change together: `plugin.json` (`name`, `mcpServers` key), `hooks/hooks.json` matcher, `authority.mjs BROWSER_TOOL`, `tool-schema.mjs` tool name and the name check in `mcp.mjs`, `SKILL.md` `dependencies` (`plugin-win-browser`), package folder `win-browser` in `scripts/package.mjs`, `tests/package/layout.test.mjs`, `README.md`.

## R11 Version bump

`package.json`, `package-lock.json` (root and `packages[""]`), `plugin.json`, server version in `src/mcp.mjs`. Release names: `build-release.md`.

## R12 Electron upgrade

- Edit: `package.json` (`devDependencies.electron`, `allowScripts` key) and lockfile; re-validate the `dialogs.mjs` adapter (D5).
- Version strings (`grep -rn "44\.9\.1"`): `host.mjs status()`, `dialogs.mjs`, `scripts/package.mjs`, `README.md`, `THIRD_PARTY_NOTICES.md`, `tests/browser/user-agent.test.mjs`, `tests/companion-fixture.mjs`, `tests/live/autonomous-harness.mjs`, `tests/package/mcp.test.mjs`.
- Re-check D9 (occlusion) and D10 (`window.prompt`).
- Test: every suite, including live and package.

## R13 Upstream Mixdog upgrade

- Edit in order: `upstream.lock.json` (commit, version, git-blob sha1 per file) → `npm run vendor` → `src/upstream-entry.mjs` exports → `scripts/build.mjs` adapters and banner commit → attribution comment in `src/core/queue.mjs` → `THIRD_PARTY_NOTICES.md` (version, commit, files). Finder: `grep -rn 968ee089`.
- Test: `test:browser` (frames), live suites, package suite.

## R14 MCP SDK upgrade

`package.json` dependency → `scripts/sdk-adapter.mjs` (version-pinned exact patch) with `tests/sdk-adapter.test.mjs` → `THIRD_PARTY_NOTICES.md` SDK section → SDK version assert in `tests/package/layout.test.mjs`.

## R15 Native helpers

`native/bridge.cpp`, `native/consent.cpp`, `scripts/build-native.mjs` (flags, outputs, license list), `THIRD_PARTY_NOTICES.md` native section. Test: `tests/native-consent.test.mjs`, package suite.

## R16 Browser identity (user agent)

`src/browser/user-agent.mjs`. Test: `tests/browser/user-agent.test.mjs`, `tests/companion-fixture.mjs`, identity baseline run in `tests/live/browser-host.test.mjs`. Docs: `README.md` 권한과 안전 경계.
