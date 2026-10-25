# Change map

Owns: per request, the symbol-level edit order, the rules to keep and extra steps
(finders, measurements). IDs match the `AGENTS.md` Edit table.
Not here: which files, tests and docs a request touches (`AGENTS.md` Edit table),
module roles (`architecture.md`), test procedures (`testing.md`).
Update when: a symbol named here is renamed or moved, or a request gains a step or a
rule to keep.

## R1 `browse` action or argument

- Edit: `src/shared/contract.mjs` (`fields`, `inputActions`, `keys`, `validateArgs`) → `src/mcp/tool.mjs` (`inputSchema` property and description; `JSON_ACTIONS` when the result is structured data rather than a page) → `src/browser/host.mjs` (`execute` for immediate actions; `#run`, `#validate` and `#perform` for lane work; call `markSent` right before dispatch; page results through `#present`).
- Keep: `contracts.md` Observation and input and Result vocabulary (`isError`). Every mutating action belongs in `inputActions`.

## R2 Toolbar, window chrome, labels, languages

- Edit: `src/browser/presentation.mjs`: `STRINGS` (a new locale needs its key and the selection in the constructor), `toolbarHTML` and `shieldHTML` (markup, CSS, icons), `#state` (what each mode shows), `#toolbarAction` (accepted actions and mode guards), `TOOLBAR_HEIGHT`.
- Edit: `src/browser/toolbar-preload.cjs` (`render`, `send`); action names must match `#toolbarAction`.
- Edit: `host.mjs #registerPage` `humanActions`; native menu in `consent.mjs installPageMenu`.
- Keep: chrome CSP and no navigation; the toolbar never resumes by itself; address bar and history only in native-handoff.

## R3 Handoff, Stop, resume, fail-closed

- Edit: `presentation.mjs` (`beginDrain`, `enterNative`, `beginReturn`, `finishReturn`, `failClosed`, `shieldKeyboard`, `shieldMouse`, `nativeKeyboard`, `nativeMouse`, frame event handlers); `host.mjs` (`#pause`, `#handoff`, `#resume`, `#owned`); `permissions.mjs admits` (requests during native handoff).
- Keep: every row of `contracts.md` Handoff state machine.

## R4 Observation, targeting, frames, input dispatch

- What the walker sees (roles, names, text, sensitivity and handoff privatization, label proxies, occlusion, quiet, ids, the dispatch guard, the trusted-input listeners): `src/browser/perception/walker.mjs`. Frame composition: `model.mjs`. Ref lifetime: `refs.mjs` and `host.mjs #perceive`, `#liveRef`. Text, budgets, diff and find: `render.mjs`. Settle bounds: `settle.mjs SETTLE_BOUNDS`. Signals: `signals.mjs` and `host.mjs #signal`, `#drainSignals`.
- CDP side: `frames.mjs` (walker installation and `FRAME_CAP`, `#rebuild` per-frame degradation, `snapshot`, `quiet`, `describe`, `resolveObject`, `inView`, `prepare`, `pointFor` with `#ownersStable`, `toRoot`, `hitChain`, `armGuard`, `sensitivePresent`, `privatize`, `inputReady`, `presented`, target and worker attach, `INPUT_BINDING`); `host.mjs` (`#read`, `#perceive`, `#present`, `#screenshot`, `#validate`, `#validatePoint`, `#perform`, `#dispatchInput`, `#assertNoSensitive`, `#signal`, `#beginPrivate`); `shared/contract.mjs` (`keys`, target fields, `find` words-only rule).
- Derived from Mixdog (R13): role, name and state helpers `perception/semantics.mjs`; target point and stable rect `perception/target-point.mjs`; `find` ranking `perception/match.mjs`; CDP execution fence `cdp-execution.mjs`; preflight retry `actionability.mjs`.
- Keep: `contracts.md` Observation and input (privacy exclusions, ref lifetime, pipeline order, disposition, live regions in diffs) and D13–D19.
- Measure: when the projection changes, re-measure tokens on a large page with `estimateTokens` and report the numbers.

## R5 JS dialogs, file uploads, downloads

- Dialogs: `dialogs.mjs` (Electron-pinned adapter), `host.mjs` `#nativeDialog`, `#humanDialog` and the `handle_dialog` branch of `execute`, `frames.mjs` `Page.javascriptDialog*`.
- Uploads: `host.mjs` `#nativeFilePicker`, `#validateFiles`, upload in `#perform`; `frames.mjs` `Page.fileChooserOpened`.
- Downloads: `host.mjs #profile` `will-download`. Registry: `requests.mjs`.
- Keep: refs are not approvals; a dispatched dialog response is never repeated (`DIALOG_UNCERTAIN`); uploads take local drive-letter regular files only, resolved to their real path, with network and device paths refused before any filesystem call (`BrowserHost#validateFiles`).
- Capabilities: `host.mjs status().capabilities`.

## R6 Device or web permissions, delegation policy

- Edit: `permissions.mjs` (handlers, chooser flow, delegated selection, `admits`); `permission-broker.mjs` (ledger rules); `policy.mjs` (`supported`, schema) with `browser-policy.json`; `consent.mjs` and `native/consent.cpp` (manual OS consent); `host.mjs status().capabilities`.
- Keep: `requirements.md` C5, C6 and `contracts.md` Native requests and permissions.

## R7 Profiles, data directories, connection lifetime

- Edit: `host.mjs #profile`, `src/shared/paths.mjs`, `src/companion/main.mjs` (userData, `window-all-closed`), `src/mcp/gateway.mjs close` (keeps profiles).
- Keep: `requirements.md` C4 and AC18; profiles per connection and session; the companion outlives its last page window.

## R8 MCP transport, timeouts, process lifecycle

- Edit: `src/mcp/main.mjs` (server, error envelope, EOF); `src/mcp/gateway.mjs` (startup 20 s, call 120 s, exit wait 8 s); `src/shared/rpc.mjs` (framing, limits); `src/companion/main.mjs` (roles, methods, `terminate`); `plugin.json` (`startupTimeoutMs` 30000, `timeoutMs` 120000); `host.mjs #run` (25 s); `native/bridge.cpp`.
- Keep: transport loss reports `replaySafe:false`; a reconnect serves new calls only.

## R9 Caller identity, hooks

- Edit: `src/hook/main.mjs`, `src/shared/authority.mjs`, `hooks/hooks.json` (events, matcher, timeouts 5 s and 2 s), hook role in `src/companion/main.mjs`.
- Keep: hooks act only on `BROWSER_TOOL` and deny on failure; `contracts.md` Authority and isolation.

## R10 Plugin, server or tool rename

Avoid: it breaks existing registrations. Change together: `plugin.json` `name` and `mcpServers` key, the `hooks.json` matcher, `authority.mjs BROWSER_TOOL`, the tool name in `mcp/tool.mjs` and the name check in `mcp/main.mjs`, `SKILL.md` `dependencies` (`plugin-win-browser`), the package folder `win-browser` in `package.mjs`.

## R12 Electron upgrade

- Edit: `package.json` (`devDependencies.electron`, `allowScripts` key) and lockfile; re-validate the `dialogs.mjs` adapter (D5).
- Every version string: `grep -rn "44\.9\.1"` (in code: `host.mjs status()`, `dialogs.mjs`, `scripts/package.mjs`).
- Re-check D9 (occlusion) and D10 (`window.prompt`).

## R13 Code derived from Mixdog

- Files: `third_party/mixdog/provenance.json` `derived[].files`. The fork is not tracked: never fetch or merge newer Mixdog code (D23).
- Edit the file in place; in the same change update its `Changed:` header notice, its row in `THIRD_PARTY_NOTICES.md`, and `provenance.json` `derived[].files` when a derived file moves, splits or is added. Finder: `grep -rn 968ee089`.

## R14 MCP SDK upgrade

Order: the `package.json` dependency → the version-pinned exact patch in `sdk-adapter.mjs` with its test → the notices → the SDK version assert in `layout.test.mjs`.

## R17 Agent DevTools: console, network, inspect, performance, page world, human DevTools

- Records, formats, limits, redaction, privacy windows: `src/browser/devtools.mjs` (`DevToolsRecorder.attach`, `detach`, `record`, `boundary`, `consoleRows`, `networkRows`, `detail`, `bodyTarget`; `PrivacyWindows`; `redactURL`, `redactText`, `redactHeaders`, `redactBody`; `DEVTOOLS_LIMITS`). A new CDP event or domain starts in `attach` and `record`.
- Any new regex on page text: cut the input first (`redactClip`), keep it linear, and add the input to the 64 KiB adversarial test in `devtools.test.mjs`.
- Privacy: page windows follow the page mode; `profile.devtoolsPrivacy` (`host.mjs #registerPage`) covers service and shared workers. Mode transitions reach `host.mjs #devtoolsMode`.
- Reads: `devtools.mjs` (`pageRead`, `responseBody`, `performanceSnapshot`, `selectElement`, `inspectNode`, `INSPECT_ELEMENT`) → `host.mjs` (`#devtoolsRead`, `#inspect`, routing in `execute` and `#run`). Keep the host interface narrow; formatting stays in `devtools.mjs`.
- CDP plumbing: `frames.mjs` (`#record` at the start of `enable` and after worker release, `devtoolsFlush`, `onMessage` forwarding and console-store discard, worker `Runtime` events as records only, `#trackPageWorld`, `pageContext`, `devtoolsCommand`, `evaluateUser(world)`).
- Arguments: R1 (`shared/contract.mjs` `fields`, `devtoolsActions`, `validateArgs`; `mcp/tool.mjs`). Keep schema growth to one-line descriptions.
- Human DevTools: `consent.mjs installPageMenu` (`open-devtools` item), `host.mjs` (`#openDevTools` with `devtoolsOpening`, `#closeDevTools` from `#devtoolsMode` and `#resume`, `devtools-opened` guard, frame `closed`).
- Result signals: `DevToolsRecorder.since(cursor)` → `host.mjs #drainSignals` (counts only). Dialog-first refusals: `host.mjs #dialogFirst`.
- Keep: `contracts.md` DevTools reads and Human DevTools; D11, D12 exclusions; no observation, PNG or ref change in DevTools outputs; nothing recorded outside `automation`.

## R18 Script runner (`run`)

- Script API (what scripts can call): `src/browser/runner/api.mjs runnerApi` (self-contained; serialized with `toString`). A new method maps to an existing op or needs a new op below.
- Ops and their rules: `src/browser/runner/bridge.mjs` (`RUNNER_OPS` allowlist, `validateOp` shapes, `RETRY` auto-wait codes, `TERMINAL` and `pauseStatus`, seal on uncertain, step labels that never echo typed text). An op is one `execute` call; never add `run`, `handoff`, `respond`, `revoke`, points or page-world evaluate.
- Run lifecycle and report: `run.mjs` (`runScript`, `RUN_LIMITS`, watch for Stop and handoff, deadline, final views); bounds shared with `shared/contract.mjs RUN_BOUNDS`.
- Sandbox: `sandbox.mjs` (window preferences, partition, request cancel, CSP, `routeOp` nonce and sender checks) and `preload.cjs`; shipped as `app/runner-preload.cjs` by `scripts/build.mjs`, passed by `src/companion/main.mjs` as `runnerPreloadPath`.
- Host: `host.mjs #runScript` (routing, `keepSignals`, final `#run` observe-after); arguments through R1 (`shared/contract.mjs` `fields.run`, `mcp/tool.mjs` `script`, `timeoutMs`).
- Keep: `contracts.md` Script runner; D20; every op through the same gates; nothing resent; the seal holds after a caught uncertain step.
