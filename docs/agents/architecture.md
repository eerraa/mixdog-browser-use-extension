# Architecture

Owns: processes, call path, module map, import direction, Electron hooks, page model,
window composition, data layout and package layout.
Not here: rules (`contracts.md`), where a request lands (`AGENTS.md` Edit table,
`change-map.md`), build and package steps (`build-release.md`).
Update when: a process, entry point, module, named symbol, Electron hook, data path or
package path is added, moved, renamed or removed.

## Processes

```text
Host: Mixdog (hook authority) or a plain MCP registration such as Claude Code (connection authority)
├─ MCP (stdio)  bin/bridge.exe --mcp     → runtime/electron.exe app/mcp.cjs        ELECTRON_RUN_AS_NODE=1
│    └─ gateway bin/bridge.exe --browser → runtime/electron.exe app/companion.cjs  Electron main
│                  ⇅ named pipe, newline JSON (RpcPeer), role "gateway"
│                  ⇅ connection authority only: same pipe, role "hook", the gateway's ticket issuer
└─ hooks        bin/bridge.exe --hook    → runtime/electron.exe app/hook.cjs       ELECTRON_RUN_AS_NODE=1
   (hook authority only)  ⇅ same pipe, role "hook", one short connection per event
```

- Authority (`src/shared/paths.mjs authorityMode`): `WB_AUTHORITY` from the registration, `hook` by default. Mixdog runs `${MIXDOG_PLUGIN_ROOT}/bin/bridge.exe --mcp` from `plugin.json` plus `hooks/hooks.json`; Claude Code runs the same launcher by absolute path with `WB_AUTHORITY=connection` and `WB_DATA_DIR`, and loads no manifest, hooks or skill.
- `native/bridge.cpp` resolves the plugin root from its own path, clears `NODE_OPTIONS` and `NODE_PATH`, and runs the child in a kill-on-close Job, so children die with the launcher. Claude Code on Windows closes a server's stdin and ends its process tree 300 ms later; the Jobs end the companion with it.
- One companion per MCP server process, which is one connection. Channel = fresh UUID; key = 32 random bytes (base64url); both passed as `WB_CHANNEL`/`WB_IPC_KEY`. Ready line `WB_READY <channel>` on stdout within 20 s.
- Pipe `\\.\pipe\independent-browser-<sha256(data\0channel)[:32]>`. Hooks find it through `connections/<channel>/endpoint.json` (hook authority only).

## Call path

1. The agent calls `browse`. Hook authority: with `_channel` (schema const = connection UUID). Connection authority: the schema has no `_channel`; step 3 stamps the gateway's own.
2. Hook authority: `PreToolUse` → `src/hook/main.mjs`: endpoint.json → `hello{role:hook}` → `issue` → `CallerAuthority.issue` → ticket. The hook returns `updatedInput` with `_lease`, or denies on any failure. Connection authority: no hook; step 3 refuses a `_lease` argument and takes the ticket itself.
3. `src/mcp/main.mjs` → `gateway.execute` → (connection authority: `issue{sessionId: CONNECTION_CALLER, callId: fresh UUID}` over the gateway's hook-role connection) → pipe `call{args}` (120 s). Action `status` goes to `gateway.status` without a ticket.
4. `src/companion/main.mjs` → `authority.consume(_lease, args)` → caller `{sessionId, callId, signal, assertLive}` → `BrowserHost.execute`.
5. `BrowserHost.execute` → `validateArgs` → immediate actions (including DevTools buffer reads), or `#run` (per-tab `FenceQueue` lane, 25 s): input → `#validate` (after `FrameDriver.inputReady`) → `#perform` (dispatch guard) → `settle` → `#perceive` → `#present`; observe/read → `#read` → `#perceive` → `#present`. `run` → `#runScript` → `runner/run.mjs runScript`: a sandbox renderer (`runner/sandbox.mjs`) whose bridge ops (`runner/bridge.mjs`) each call `BrowserHost.execute` under the run's caller (`keepSignals`), then one final `#run` observe-after per touched tab.
6. `toolResult` (`src/mcp/tool.mjs`) renders page results as text (`statusLine` + body), adds the screenshot as image content only on request, keeps `JSON_ACTIONS` as JSON, and sets `isError` (`contracts.md` Result vocabulary).

- Lifecycle (hook authority): `SessionStart`, `UserPromptSubmit`, `SubagentStart` send `begin`; `Stop`, `StopFailure`, `SessionEnd`, `SubagentStop` send `end` to every `connections/*` channel (150 ms each). Connection authority has no lifecycle events; the connection is the caller's lifetime.
- Teardown: MCP stdin EOF → `server.close` → `gateway.close` → `shutdown` → companion exits; endpoint.json (hook authority) is removed, profiles stay. Closing the last page window never ends the companion (`window-all-closed` is handled in `src/companion/main.mjs`).
- Revoke: companion `terminate` → gateway waits up to 8 s for exit and reports `processTeardownConfirmed`.

## Module map

| Path | Role | Key symbols |
| --- | --- | --- |
| `src/mcp/main.mjs` | MCP stdio server; authority from the registration; single tool; server instructions under connection authority; error envelope; EOF shutdown | `main` |
| `src/mcp/tool.mjs` | tool schema (action enum from contract; `_lease` only under hook authority); result shaping and the status line; connection-authority server instructions | `browserTool`, `toolResult`, `errorResult`, `statusLine`, `CONNECTION_INSTRUCTIONS` |
| `src/mcp/gateway.mjs` | spawn and own the companion, endpoint.json (hook authority), connection-authority tickets over its own hook-role connection, reconnect for new calls only, revoke confirmation | `createGateway`, `CONNECTION_CALLER` |
| `src/hook/main.mjs` | lease injection for this tool only; lifecycle fan-out | `main`, `deliver` |
| `src/companion/main.mjs` | Electron main per connection; pipe server; role and method auth; termination | `terminate`, `sameKey` |
| `src/shared/authority.mjs` | caller generations; single-use tickets bound to an args digest | `CallerAuthority`, `BROWSER_TOOL`, `withoutLease` |
| `src/shared/rpc.mjs` | newline-JSON request, response, event and cancel; 16 MiB frames; 256 in flight | `RpcPeer` |
| `src/shared/paths.mjs` | caller authority of the registration, data root per authority, connection directory, pipe name | `authorityMode`, `pluginData`, `connectionPaths`, `validChannel` |
| `src/shared/async.mjs` | abortable pause; timeout + signal bound | `pause`, `bounded` |
| `src/shared/contract.mjs` | action table, argument validation, keys, URL rules, error type | `actions`, `inputActions`, `keys`, `validateArgs`, `pageURL`, `addressURL`, `fail`, `BrowserHostError` |
| `src/browser/queue.mjs` | per-key FIFO lane; abort settles the caller, the actual operation keeps fencing | `FenceQueue` |
| `src/browser/permission-broker.mjs` | connection permission ledger: shared prompts, exact-scope reuse, terminal deny, revoke | `PermissionBroker` |
| `src/browser/host.mjs` | pages, ownership, action dispatch, perception and text results, validation/perform/settle, refs, signals, handoff and resume, popups, downloads, dialog and file-picker requests, revoke | `BrowserHost`: `execute`, `status`, `#run`, `#read`, `#perceive`, `#present`, `#screenshot`, `#captureImage`, `#validate`, `#validatePoint`, `#perform`, `#liveRef`, `#drainSignals`, `#dialogFirst`, `#pause`, `#handoff`, `#resume`, `#registerPage`, `#createPage`, `#profile`, `#nativeDialog`, `#humanDialog`, `#nativeFilePicker`, `#revoke` |
| `src/browser/perception/walker.mjs` | isolated-world walker source: iterative synchronous per-frame snapshot with checkpoint, persistent element ids, rendered text (`renderedText`), embedded-content names for image-only controls (`embeddedName`), sticky sensitivity and handoff privatization, label proxies for hidden inputs, occlusion, quiet; `describe`/`target`/`resolve`/`inView`/`hitAt` helpers; the dispatch guard; the trusted-input binding listeners; composes the role/name/state helpers of `semantics.mjs` | `walkerInstallSource`, `describeExpression`, `targetPointExpression`, `resolveExpression`, `armGuardExpression`, `sensitivePresentExpression`, `privatizeExpression`, `hitExpression` |
| `src/browser/perception/semantics.mjs` | role, accessible-name and state helper sources the walker composes (derived from Mixdog, R13) | `ELEMENT_SEMANTICS` |
| `src/browser/perception/target-point.mjs` | page-side stable-rect measurement and ref-to-point resolver behind `targetPointExpression` (derived, R13) | `BROWSER_STABLE_RECT`, `browserRefPointExpression` |
| `src/browser/perception/match.mjs` | `find` ranking (derived, R13) | `rankBrowserSemanticMatch` |
| `src/browser/perception/model.mjs` | compose frame snapshots into one root-coordinate model; degrade hidden or unavailable frames | `composeModel`, `subtree` |
| `src/browser/perception/refs.mjs` | connection-wide `e<n>` registry; retire on removal, rename, document or generation change | `RefRegistry`, `REF_PATTERN` |
| `src/browser/perception/render.mjs` | text projection: snapshot, diff, find, text, header; token budgets | `renderSnapshot`, `renderDiff`, `renderFind`, `renderText`, `renderHeader`, `BUDGETS` |
| `src/browser/settle.mjs` | bounded post-dispatch settle and navigation arming | `armNavigation`, `settle`, `SETTLE_BOUNDS` |
| `src/browser/runner/run.mjs` | one script run: sandbox, bridge, deadline, Stop/handoff watch, report (Electron-free; sandbox injected) | `runScript`, `runnerSource`, `RUN_LIMITS` |
| `src/browser/runner/bridge.mjs` | main-process op allowlist and argument shapes; one `execute` call per op; seal on uncertain; auto-wait | `RunnerBridge`, `validateOp`, `RUNNER_OPS`, `pauseStatus` |
| `src/browser/runner/api.mjs` | script-facing Playwright-like API, serialized into the sandbox | `runnerApi`, `RUNNER_API_SOURCE` |
| `src/browser/runner/sandbox.mjs` | hidden sandboxed runner window, network-less partition, nonce-checked IPC route | `createRunnerSandbox`, `routeOp`, `RUNNER_CHANNEL`, `BOOTSTRAP_URL` |
| `src/browser/runner/preload.cjs` | exposes `__wbBridge.call` with the run's nonce; shipped as `app/runner-preload.cjs` | — |
| `src/browser/signals.mjs` | per-session signal queue and one-line formats | `SignalQueue`, `formatSignals` |
| `src/browser/presentation.mjs` | one window per page: toolbar, page view, shield; mode machine; toolbar IPC; en/ko strings; occlusion switch | `PagePresentation`, `TOOLBAR_HEIGHT`, `STRINGS` |
| `src/browser/toolbar-preload.cjs` | toolbar controller in the toolbar's isolated preload world | — |
| `src/browser/frames.mjs` | CDP attach, cached frame tree (per-frame setup failures become unavailable frames; at most `FRAME_CAP` frames set up), iframes, workers, walker installation (new documents and existing ones), parallel per-frame snapshots, quiet probes (outside the execution fence), describe/resolve/inView/point/owner stability/toRoot, hit chain for points, dispatch guard, sensitive checks, paint-holding wait before first input, native mode with focus emulation (page and OOPIF sessions), the walker-world input binding, page-world contexts, `presented()` (3 s); forwards CDP events to the page's recorder and starts recording per session | `FrameDriver`: `snapshot`, `quiet`, `describe`, `resolveObject`, `inView`, `pointFor`, `hitChain`, `armGuard`, `disarmGuard`, `sensitivePresent`, `privatize`, `inputReady`, `setNativeMode`, `evaluateUser(world)`, `evaluationContext`, `devtoolsCommand`, `FRAME_CAP`, `INPUT_BINDING` |
| `src/browser/cdp-execution.mjs` | CDP command fence: after a cancelled or timed-out command, later commands wait until the actual dispatch and any termination settle (derived, R13) | `createBrowserCdpExecution` |
| `src/browser/actionability.mjs` | retries read-only preflight failures until a deadline (derived, R13) | `waitForBrowserActionable`, `BrowserActionabilityError` |
| `src/browser/devtools.mjs` | agent DevTools: per-page bounded console/exception/log/network records with page and profile privacy windows and bounded linear redaction; page-world best-effort side-effect-free reads; element inspection; performance snapshot | `DevToolsRecorder` (`attach`, `detach`, `boundary`, `record`), `PrivacyWindows`, `redactURL`, `redactText`, `redactHeaders`, `redactBody`, `DEVTOOLS_LIMITS`, `pageRead`, `responseBody`, `performanceSnapshot`, `selectElement`, `inspectNode`, `INSPECT_ELEMENT` |
| `src/browser/requests.mjs` | native request registry: requestRef/optionRef, 120 s TTL, withdraw | `BrowserRequests` |
| `src/browser/permissions.mjs` | Chromium permission and device handlers → broker, requests, consent; policy gating | `BrowserPermissions` |
| `src/browser/policy.mjs` | `browser-policy.json` loader and validator | `BrowserPolicy` |
| `src/browser/dialogs.mjs` | JS dialog adapter: wraps `dialog.showMessageBox`, pairs CDP events | `BrowserDialogs`, `showManualMessageBox` |
| `src/browser/consent.mjs` | `native-consent.exe` prompt surface; native page menu | `ConsentSurface`, `installPageMenu` |
| `src/browser/user-agent.mjs` | removes `IndependentWindowsBrowser/` and `Electron/` UA tokens | `configureBrowserIdentity` |
| `native/bridge.cpp` | launcher modes `--mcp`, `--hook`, `--browser`; Job object | `wmain` |
| `native/consent.cpp` | Windows `UserConsentVerifier` helper: `--availability` or prompt | — |

Import direction, one way: `companion/` → `browser/` → `shared/`; `mcp/` → `shared/`; `hook/` → `shared/`. `shared/` imports no other layer and no Electron, and `mcp/` and `hook/` never import `browser/`, so the MCP and hook bundles carry no engine code. Inside `browser/`, `host.mjs` imports the other modules and `perception/*` modules are pure. Nothing under `src/` imports `build/`.

## Electron hooks

| Concern | Hook | File |
| --- | --- | --- |
| Page creation | `WebContentsView` with `session.fromPath(profiles/<hash>)` | `host.mjs #createPage`, `#profile` |
| Popups | `setWindowOpenHandler` → `createWindow` adopts Chromium's contents | `host.mjs #registerPage` |
| Navigation guard | page `will-frame-navigate` → `pageURL`; chrome documents block all navigation | `host.mjs`, `presentation.mjs` |
| Downloads | `will-download` → `downloads/<hash>/<uuid>-<name>` | `host.mjs #profile` |
| CDP | `webContents.debugger` 1.3: `Page.javascriptDialogOpening/Closed`, `Page.fileChooserOpened`, `Input.*`, `DOM.*`, `Runtime.*` | `frames.mjs` |
| CDP DevTools recording | page and iframe sessions at the start of `enable` (before `Runtime.enable`), worker sessions after their startup release: `Network.enable` (page budget 10 MiB: main 6 MiB, others 1 MiB; 1 MiB per resource; 64 KiB post data), `Log.enable`, `Performance.enable` (main), `Runtime.enable` (workers); events `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`, `Network.requestWillBeSent/requestServedFromCache/responseReceived/loadingFinished/loadingFailed`, `CSS.styleSheetAdded/Removed`, `Runtime.executionContextCreated/Destroyed/Cleared` (page worlds); `Runtime.discardConsoleEntries` every 200 console events; `Runtime.getIsolateId` round trip per session (`devtoolsFlush`) before a return | `frames.mjs #record`, `devtoolsFlush`, `onMessage`; `devtools.mjs` |
| CDP DevTools reads | `Runtime.evaluate` (`throwOnSideEffect`), `Network.getResponseBody`, `Performance.getMetrics`, `Page.createIsolatedWorld`; `inspect`: `DOM.describeNode`, `CSS.enable` (lazy), `DOM.getDocument`, `DOM.pushNodesByBackendIdsToFrontend`, `CSS.getMatchedStylesForNode`, `DOM.resolveNode`, `DOMDebugger.getEventListeners` | `devtools.mjs` via `FrameDriver.devtoolsCommand` / `send` |
| Human DevTools | page `openDevTools({mode:'detach'})`, `closeDevTools`, `isDevToolsOpened`, `devtools-opened`, `devtools-closed` | `host.mjs #openDevTools`, `#closeDevTools`, `#devtoolsMode`, `#registerPage` |
| Permissions | `setPermissionCheckHandler`, `setPermissionRequestHandler`, `select-hid-device`, `select-usb-device`, `<kind>-device-removed`, `setDevicePermissionHandler(null)` | `permissions.mjs` |
| Refused APIs | `setDisplayMediaRequestHandler`, `select-serial-port`, `select-bluetooth-device` | `permissions.mjs`, `host.mjs` |
| JS dialogs | wrapped `dialog.showMessageBox` | `dialogs.mjs` |
| Human input | shield and page `before-input-event`, `before-mouse-event` | `presentation.mjs` |
| Window state | frame `hide`, `minimize`, `show`, `restore`, `resize`; `render-process-gone` | `presentation.mjs`, `host.mjs` |

## Page model

`host.mjs #registerPage` creates `p`:
`{ id (t<n>), owner (sessionId), profile, view, contents, presentation, frame, driver, devtools (DevToolsRecorder), devtoolsMenuItem, devtoolsOpening, devtoolsShown, paused (reason or null), actorGeneration (the presentation generation an admitted lane operation runs under; input admission checks it), privateSince (start of a handoff, for privatize at return), model (latest composed model), base (the agent's last view: lines, refs, snapshotId, root document, generation, scroll; the next diff base), shot (latest screenshot-bearing snapshot for points), cursor (DevTools signal cursor), dialog, downloads[], connected, visible, ready, manualFlight, returnController, settleInterrupt, onTrustedInput }`

- Connection-wide: `#refs` (`RefRegistry`), `#signals` (`SignalQueue`), `t<n>` and `s<n>` sequences.
- Script runs: one sandbox window per run (below); `RunnerBridge` per run; steps carry `keepSignals` so they neither drain signals nor move `base`.
- `#invalidate(p, reason)` on every page change; it also runs `#devtoolsMode`. Refs retire by evidence (walker `gone`/`renamed`, document replacement, `generation`), not by invalidation. That updates privacy windows (`boundary()` on every page of the profile; `profile.devtoolsPrivacy` covers service and shared workers), syncs the DevTools menu item with the mode, and closes human DevTools outside `native-handoff`. `#handoff` (after `enterNative`) and `#resume` (after `finishReturn`) call it too.
- DevTools reads: `execute` → `#devtoolsRead` (console, network, performance; outside the lane) or `#run` → `#inspect` (lane).
- Popups become owned pages of the same owner and profile and inherit a pause or handoff.

## Window composition

```text
BrowserWindow "frame"  default 1120×820; its own webContents is the toolbar (data: URL + toolbar-preload.cjs)
├─ page   WebContentsView  y = TOOLBAR_HEIGHT (44); owner's profile session
└─ shield WebContentsView  same bounds, transparent; visible except in native-handoff
```

- Chrome documents (toolbar, shield): private in-memory partition per window, CSP `default-src 'none'`, sandboxed.
- Script runner (`runner/sandbox.mjs`): a separate hidden, unfocusable `BrowserWindow` per run on a `data:` bootstrap page with `runner-preload.cjs`, the shared in-memory partition `wb-runner` (every other request cancelled, a dead fixed proxy, cleared after each run), CSP `default-src 'none'`; IPC `wb-runner:op (nonce, op, args)` handled by `routeOp`. `run.mjs` compile-checks the script in main (`node:vm`, compile only) before any sandbox exists.
- IPC: toolbar → main `independent-browser:toolbar {action, value?}`; main → toolbar `independent-browser:state` (url, secure, editable, canGoBack, canGoForward, loading, notice, chip, primary, secondary).
- Toolbar actions: `ready`, `back`, `forward`, `reload`, `stop-loading`, `navigate`, `take-control`, `resume`, `stop-automation`.
- Native menu (`consent.mjs installPageMenu`): Stop automation, Resume automation, Human handoff, Accept and Dismiss pending page dialog, Open DevTools (while you have control), Revoke permissions and close connection.
- Locale: `app.getLocale()` starting with `ko` selects `STRINGS.ko`, otherwise `STRINGS.en`.

## Data layout

Root: hook authority `MIXDOG_PLUGIN_DATA`, assigned by Mixdog per registered folder (a new package path gets a new root); connection authority `WB_DATA_DIR`, set by the registration (`src/shared/paths.mjs pluginData`).

| Path | Content | Lifetime |
| --- | --- | --- |
| `connections/<channel>/endpoint.json` | `{channel, key, pipe, protocol:1}`; hook authority only | removed on clean MCP close |
| `connections/<channel>/electron/` | Electron userData | kept |
| `connections/<channel>/profiles/<sha256(sessionId)>/` | Chromium profile per caller session | kept; never reused by a new connection |
| `connections/<channel>/downloads/<sha256(sessionId)>/` | `<uuid>-<sanitized name>` | kept |

## Package layout

`npm run package` → `dist/win-browser-XXXXXX/win-browser/`:
`plugin.json`, `browser-policy.json`, `hooks/`, `skills/`, `bin/bridge.exe`, `bin/native-consent.exe`, `runtime/` (Electron dist), `app/{mcp,hook,companion}.cjs` + maps, `app/toolbar-preload.cjs`, `app/runner-preload.cjs`, `licenses/mixdog/` (Mixdog `LICENSE`, `NOTICE.md` and the fork record `provenance.json`), `licenses/native/`, `licenses/npm/`, `licenses/npm-packages.json`, `sources/native/*.cpp`, `LICENSE`, `README.md`, `THIRD_PARTY_NOTICES.md`.

Mixdog derives the registry stem from the folder basename, so it must stay `win-browser` (server `plugin-win-browser`). Claude Code uses no file of the folder's plugin surface: it runs `bin/bridge.exe --mcp` by absolute path under the server name its registration gives (`win-browser` → `mcp__win-browser__browse`).

`npm run package:clean` (`scripts/clean-package.mjs`) runs the three build steps in a temp copy and keeps only this folder; with `--release` it lays out `dist/releases/v<ver>/`: `win-browser/`, `win-browser-v<ver>-windows-x64.zip`, its `.sha256`, `win-browser-v<ver>-files.sha256` (one sha256 per packaged file) and `release.json` (version, source commit, ZIP digest).
