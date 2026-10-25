# Change map

Owns: where and how to change code for a request. Each recipe lists edits in
dependency order, the contracts to keep, tests, and docs to update. Structure:
`architecture.md`. Test details: `testing.md`.

## R1 `browse` action or argument

- Edit: `src/browser/contract.mjs` (`fields`, `inputActions`, `keys`, `validateArgs`) → `src/tool-schema.mjs` (`inputSchema` property and description; `JSON_ACTIONS` when the result is structured data rather than a page) → `src/browser/host.mjs` (`execute` for immediate actions; `#run`, `#validate` and `#perform` for lane work; call `markSent` right before dispatch; page results through `#present`).
- Keep: `contracts.md` Observation and input and Result vocabulary (`isError`). Every mutating action belongs in `inputActions`.
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

- What the walker sees (roles, names, text, sensitivity and handoff privatization, label proxies, occlusion, quiet, ids, the dispatch guard, the trusted-input listeners): `src/browser/perception/walker.mjs`. Frame composition: `model.mjs`. Ref lifetime: `refs.mjs` and `host.mjs #perceive`, `#liveRef`. Text, budgets, diff and find: `render.mjs`. Settle bounds: `settle.mjs SETTLE_BOUNDS`. Signals: `signals.mjs` and `host.mjs #signal`, `#drainSignals`.
- CDP side: `frames.mjs` (walker installation and `FRAME_CAP`, `#rebuild` per-frame degradation, `snapshot`, `quiet`, `describe`, `resolveObject`, `inView`, `prepare`, `pointFor` with `#ownersStable`, `toRoot`, `hitChain`, `armGuard`, `sensitivePresent`, `privatize`, `inputReady`, `presented`, target and worker attach, `INPUT_BINDING`); `host.mjs` (`#read`, `#perceive`, `#present`, `#screenshot`, `#validate`, `#validatePoint`, `#perform`, `#dispatchInput`, `#assertNoSensitive`, `#signal`, `#beginPrivate`); `contract.mjs` (`keys`, target fields, `find` words-only rule).
- Live proof for security-relevant behavior (handoff privacy, frame races, sensitive fields, points, escape paths, bounds): `tests/live/security-harness.mjs`.
- Derived from Mixdog (R13): role, name and state helpers `perception/semantics.mjs`; target point and stable rect `perception/target-point.mjs`; `find` ranking `perception/match.mjs`; CDP execution fence `cdp-execution.mjs`; preflight retry `actionability.mjs`.
- Keep: `contracts.md` Observation and input (privacy exclusions, ref lifetime, pipeline order, disposition, live regions in diffs) and D13–D19.
- Test: `tests/browser/perception.test.mjs` (pure modules), `frames.test.mjs`, `contract.test.mjs`, `host.test.mjs`; live `perception` (real Chromium walker), `review-regressions` (geometry, shadow), `observation`, `workers`, `scenarios.mjs`; package nested-frame test.
- Measure: when the projection changes, re-measure tokens on a large page with `estimateTokens` and report the numbers.
- Docs: `contracts.md` text grammar, `SKILL.md` Reading results and targeting guidance.

## R5 JS dialogs, file uploads, downloads

- Dialogs: `dialogs.mjs` (Electron-pinned adapter), `host.mjs` `#nativeDialog`, `#humanDialog` and the `handle_dialog` branch of `execute`, `frames.mjs` `Page.javascriptDialog*`.
- Uploads: `host.mjs` `#nativeFilePicker`, `#validateFiles`, upload in `#perform`; `frames.mjs` `Page.fileChooserOpened`.
- Downloads: `host.mjs #profile` `will-download`. Registry: `requests.mjs`.
- Keep: refs are not approvals; a dispatched dialog response is never repeated (`DIALOG_UNCERTAIN`); uploads take local drive-letter regular files only, resolved to their real path, with network and device paths refused before any filesystem call (`BrowserHost#validateFiles`).
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

## R13 Code derived from Mixdog

- Files: `third_party/mixdog/provenance.json` `derived[].files`. The fork is not tracked: never fetch or merge newer Mixdog code (D23).
- Edit the file in place; in the same change update its `Changed:` header notice, its row in `THIRD_PARTY_NOTICES.md`, and `provenance.json` `derived[].files` when a derived file moves, splits or is added. Finder: `grep -rn 968ee089`.
- Test: the tests of the area the file belongs to (R4); `tests/package/layout.test.mjs` checks the shipped fork record and Mixdog notices.

## R14 MCP SDK upgrade

`package.json` dependency → `scripts/sdk-adapter.mjs` (version-pinned exact patch) with `tests/sdk-adapter.test.mjs` → `THIRD_PARTY_NOTICES.md` SDK section → SDK version assert in `tests/package/layout.test.mjs`.

## R15 Native helpers

`native/bridge.cpp`, `native/consent.cpp`, `scripts/build-native.mjs` (flags, outputs, license list), `THIRD_PARTY_NOTICES.md` native section. Test: `tests/native-consent.test.mjs`, package suite.

## R16 Browser identity (user agent)

`src/browser/user-agent.mjs`. Test: `tests/browser/user-agent.test.mjs`, `tests/companion-fixture.mjs`, identity baseline run in `tests/live/browser-host.test.mjs`. Docs: `README.md` 권한과 안전 경계.

## R17 Agent DevTools: console, network, inspect, performance, page world, human DevTools

- Records, formats, limits, redaction, privacy windows: `src/browser/devtools.mjs` (`DevToolsRecorder.attach`, `detach`, `record`, `boundary`, `consoleRows`, `networkRows`, `detail`, `bodyTarget`; `PrivacyWindows`; `redactURL`, `redactText`, `redactHeaders`, `redactBody`; `DEVTOOLS_LIMITS`). A new CDP event or domain starts in `attach` and `record`.
- Any new regex on page text: cut the input first (`redactClip`), keep it linear, and add the input to the 64 KiB adversarial test in `devtools.test.mjs`.
- Privacy: page windows follow the page mode; `profile.devtoolsPrivacy` (`host.mjs #registerPage`) covers service and shared workers. Mode transitions reach `host.mjs #devtoolsMode`.
- Reads: `devtools.mjs` (`pageRead`, `responseBody`, `performanceSnapshot`, `selectElement`, `inspectNode`, `INSPECT_ELEMENT`) → `host.mjs` (`#devtoolsRead`, `#inspect`, routing in `execute` and `#run`). Keep the host interface narrow; formatting stays in `devtools.mjs`.
- CDP plumbing: `frames.mjs` (`#record` at the start of `enable` and after worker release, `devtoolsFlush`, `onMessage` forwarding and console-store discard, worker `Runtime` events as records only, `#trackPageWorld`, `pageContext`, `devtoolsCommand`, `evaluateUser(world)`).
- Arguments: R1 (`contract.mjs` `fields`, `devtoolsActions`, `validateArgs`; `tool-schema.mjs`). Keep schema growth to one-line descriptions.
- Human DevTools: `consent.mjs installPageMenu` (`open-devtools` item), `host.mjs` (`#openDevTools` with `devtoolsOpening`, `#closeDevTools` from `#devtoolsMode` and `#resume`, `devtools-opened` guard, frame `closed`).
- Result signals: `DevToolsRecorder.since(cursor)` → `host.mjs #drainSignals` (counts only). Dialog-first refusals: `host.mjs #dialogFirst`.
- Keep: `contracts.md` DevTools reads and Human DevTools; D11, D12 exclusions; no observation, PNG or ref change in DevTools outputs; nothing recorded outside `automation`.
- Test: `tests/browser/devtools.test.mjs` (recorder, redaction, adversarial input timing, redirects, privacy windows, page read), `frames.test.mjs` (recording order, worker fence, replays, discard, flush, page worlds), `host.test.mjs` (gates, lane independence, Stop, profile-shared workers, human DevTools exits), `contract.test.mjs`; live `tests/live/devtools-harness.mjs`; package DevTools test in `tests/package/mcp.test.mjs`.
- Docs: `SKILL.md` DevTools section, `README.md` action table and 개발자 도구 paragraph, `architecture.md` CDP rows.

## R18 Script runner (`run`)

- Script API (what scripts can call): `src/browser/runner/api.mjs runnerApi` (self-contained; serialized with `toString`). A new method maps to an existing op or needs a new op below.
- Ops and their rules: `src/browser/runner/bridge.mjs` (`RUNNER_OPS` allowlist, `validateOp` shapes, `RETRY` auto-wait codes, `TERMINAL` and `pauseStatus`, seal on uncertain, step labels that never echo typed text). An op is one `execute` call; never add `run`, `handoff`, `respond`, `revoke`, points or page-world evaluate.
- Run lifecycle and report: `run.mjs` (`runScript`, `RUN_LIMITS`, watch for Stop and handoff, deadline, final views); bounds shared with `contract.mjs RUN_BOUNDS`.
- Sandbox: `sandbox.mjs` (window preferences, partition, request cancel, CSP, `routeOp` nonce and sender checks) and `preload.cjs`; shipped as `app/runner-preload.cjs` by `scripts/build.mjs`, passed by `companion-main.mjs` as `runnerPreloadPath`.
- Host: `host.mjs #runScript` (routing, `keepSignals`, final `#run` observe-after); arguments through R1 (`contract.mjs` `fields.run`, `tool-schema.mjs` `script`, `timeoutMs`).
- Keep: `contracts.md` Script runner; D20; every op through the same gates; nothing resent; the seal holds after a caught uncertain step.
- Test: `tests/browser/runner.test.mjs` (API, allowlist, outcomes, seal, deadline, report), `host.test.mjs` run test, `contract.test.mjs`; live `tests/live/runner-harness.mjs` (no Node, no network, forged nonce and ops, form flow, seal, Stop, handoff, CPU-loop deadline); package run test in `tests/package/mcp.test.mjs`.
- Docs: `SKILL.md` Scripts section, `README.md` action table, `contracts.md` Script runner.
