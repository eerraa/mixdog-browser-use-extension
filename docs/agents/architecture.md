# Architecture

Owns: what exists and how it connects. Rules: `contracts.md`. Edits: `change-map.md`.

## Processes

```text
Mixdog host
├─ MCP (stdio)  bin/bridge.exe --mcp     → runtime/electron.exe app/mcp.cjs        ELECTRON_RUN_AS_NODE=1
│    └─ gateway bin/bridge.exe --browser → runtime/electron.exe app/companion.cjs  Electron main
│                  ⇅ named pipe, newline JSON (RpcPeer), role "gateway"
└─ hooks        bin/bridge.exe --hook    → runtime/electron.exe app/hook.cjs       ELECTRON_RUN_AS_NODE=1
                   ⇅ same pipe, role "hook", one short connection per event
```

- `native/bridge.cpp` resolves the plugin root from its own path, clears `NODE_OPTIONS` and `NODE_PATH`, and runs the child in a kill-on-close Job, so children die with the launcher.
- One companion per MCP server process, which is one connection. Channel = fresh UUID; key = 32 random bytes (base64url); both passed as `WB_CHANNEL`/`WB_IPC_KEY`. Ready line `WB_READY <channel>` on stdout within 20 s.
- Pipe `\\.\pipe\independent-browser-<sha256(data\0channel)[:32]>`. Hooks find it through `connections/<channel>/endpoint.json`.

## Call path

1. The agent calls `browse` with `_channel` (schema const = connection UUID).
2. `PreToolUse` → `src/hook.mjs`: endpoint.json → `hello{role:hook}` → `issue` → `CallerAuthority.issue` → ticket. The hook returns `updatedInput` with `_lease`, or denies on any failure.
3. `src/mcp.mjs` → `gateway.execute` → pipe `call{args}` (120 s). Action `status` goes to `gateway.status` without a ticket.
4. `src/companion-main.mjs` → `authority.consume(_lease, args)` → caller `{sessionId, callId, signal, assertLive}` → `BrowserHost.execute`.
5. `BrowserHost.execute` → `validateArgs` → immediate actions, or `#run` (per-tab `FenceQueue` lane, 25 s) → `#observe`, `#resolve` → `#perform`.
6. `toolResult` (`src/tool-schema.mjs`) moves the PNG into MCP image content; `uncertain` sets `isError`.

- Lifecycle: `SessionStart`, `UserPromptSubmit`, `SubagentStart` send `begin`; `Stop`, `StopFailure`, `SessionEnd`, `SubagentStop` send `end` to every `connections/*` channel (150 ms each).
- Teardown: MCP stdin EOF → `server.close` → `gateway.close` → `shutdown` → companion exits; endpoint.json is removed, profiles stay.
- Revoke: companion `terminate` → gateway waits up to 8 s for exit and reports `processTeardownConfirmed`.

## Module map

| Path | Role | Key symbols |
| --- | --- | --- |
| `src/mcp.mjs` | MCP stdio server; single tool; error envelope; EOF shutdown | `main` |
| `src/tool-schema.mjs` | tool schema (action enum from contract); result shaping | `browserTool`, `toolResult` |
| `src/gateway.mjs` | spawn and own the companion, endpoint.json, reconnect for new calls only, revoke confirmation | `createGateway` |
| `src/hook.mjs` | lease injection for this tool only; lifecycle fan-out | `main`, `deliver` |
| `src/companion-main.mjs` | Electron main per connection; pipe server; role and method auth; termination | `terminate`, `sameKey` |
| `src/authority.mjs` | caller generations; single-use tickets bound to an args digest | `CallerAuthority`, `BROWSER_TOOL`, `withoutLease` |
| `src/rpc.mjs` | newline-JSON request, response, event and cancel; 16 MiB frames; 256 in flight | `RpcPeer` |
| `src/paths.mjs` | plugin data root, connection directory, pipe name | `pluginData`, `connectionPaths`, `validChannel` |
| `src/async.mjs` | abortable pause; timeout + signal bound | `pause`, `bounded` |
| `src/upstream-entry.mjs` | re-exports vendored Mixdog browser code; bundled to `build/upstream.mjs` | — |
| `src/core/queue.mjs` | per-key FIFO lane; abort settles the caller, the actual operation keeps fencing | `FenceQueue` |
| `src/core/permissions.mjs` | connection permission ledger: shared prompts, exact-scope reuse, terminal deny, revoke | `PermissionBroker` |
| `src/browser/host.mjs` | pages, ownership, action dispatch, observe/resolve/perform, handoff and resume, popups, downloads, dialog and file-picker requests, revoke | `BrowserHost`: `execute`, `status`, `#run`, `#observe`, `#captureImage`, `#fresh`, `#resolve`, `#perform`, `#pause`, `#handoff`, `#resume`, `#registerPage`, `#createPage`, `#profile`, `#nativeDialog`, `#humanDialog`, `#nativeFilePicker`, `#revoke` |
| `src/browser/presentation.mjs` | one window per page: toolbar, page view, shield; mode machine; toolbar IPC; en/ko strings; occlusion switch | `PagePresentation`, `TOOLBAR_HEIGHT`, `STRINGS` |
| `src/browser/toolbar-preload.cjs` | toolbar controller in the toolbar's isolated preload world | — |
| `src/browser/frames.mjs` | CDP attach, frames, iframes, workers, isolated worlds, capture, checkpoints, prepare/point/toRoot, native mode, `presented()` (3 s) | `FrameDriver` |
| `src/browser/contract.mjs` | action table, argument validation, keys, URL rules, error type | `actions`, `inputActions`, `keys`, `validateArgs`, `pageURL`, `addressURL`, `fail`, `BrowserHostError` |
| `src/browser/requests.mjs` | native request registry: requestRef/optionRef, 120 s TTL, withdraw | `BrowserRequests` |
| `src/browser/permissions.mjs` | Chromium permission and device handlers → broker, requests, consent; policy gating | `BrowserPermissions` |
| `src/browser/policy.mjs` | `browser-policy.json` loader and validator | `BrowserPolicy` |
| `src/browser/dialogs.mjs` | JS dialog adapter: wraps `dialog.showMessageBox`, pairs CDP events | `BrowserDialogs`, `showManualMessageBox` |
| `src/browser/consent.mjs` | `native-consent.exe` prompt surface; native page menu | `ConsentSurface`, `installPageMenu` |
| `src/browser/user-agent.mjs` | removes `IndependentWindowsBrowser/` and `Electron/` UA tokens | `configureBrowserIdentity` |
| `native/bridge.cpp` | launcher modes `--mcp`, `--hook`, `--browser`; Job object | `wmain` |
| `native/consent.cpp` | Windows `UserConsentVerifier` helper: `--availability` or prompt | — |

Import direction: entry points → `browser/host.mjs` → other `browser/*` → `core/*`, `contract.mjs`, `async.mjs`. Only `frames.mjs` imports `build/upstream.mjs`.

## Electron hooks

| Concern | Hook | File |
| --- | --- | --- |
| Page creation | `WebContentsView` with `session.fromPath(profiles/<hash>)` | `host.mjs #createPage`, `#profile` |
| Popups | `setWindowOpenHandler` → `createWindow` adopts Chromium's contents | `host.mjs #registerPage` |
| Navigation guard | page `will-frame-navigate` → `pageURL`; chrome documents block all navigation | `host.mjs`, `presentation.mjs` |
| Downloads | `will-download` → `downloads/<hash>/<uuid>-<name>` | `host.mjs #profile` |
| CDP | `webContents.debugger` 1.3: `Page.javascriptDialogOpening/Closed`, `Page.fileChooserOpened`, `Input.*`, `DOM.*`, `Runtime.*` | `frames.mjs` |
| Permissions | `setPermissionCheckHandler`, `setPermissionRequestHandler`, `select-hid-device`, `select-usb-device`, `<kind>-device-removed`, `setDevicePermissionHandler(null)` | `permissions.mjs` |
| Refused APIs | `setDisplayMediaRequestHandler`, `select-serial-port`, `select-bluetooth-device` | `permissions.mjs`, `host.mjs` |
| JS dialogs | wrapped `dialog.showMessageBox` | `dialogs.mjs` |
| Human input | shield and page `before-input-event`, `before-mouse-event` | `presentation.mjs` |
| Window state | frame `hide`, `minimize`, `show`, `restore`, `resize`; `render-process-gone` | `presentation.mjs`, `host.mjs` |

## Page model

`host.mjs #registerPage` creates `p`:
`{ id (tabId), owner (sessionId), profile, view, contents, presentation, frame, driver, paused (reason or null), observation {id, checkpoints, result, imageHash, generation}, stamp, dialog, downloads[], connected, visible, ready, manualFlight, returnController, actorGeneration }`

- `#invalidate(p, reason)` drops the observation and bumps `stamp` on every page change.
- Popups become owned pages of the same owner and profile and inherit a pause or handoff.

## Window composition

```text
BrowserWindow "frame"  default 1120×820; its own webContents is the toolbar (data: URL + toolbar-preload.cjs)
├─ page   WebContentsView  y = TOOLBAR_HEIGHT (44); owner's profile session
└─ shield WebContentsView  same bounds, transparent; visible except in native-handoff
```

- Chrome documents (toolbar, shield): private in-memory partition per window, CSP `default-src 'none'`, sandboxed.
- IPC: toolbar → main `independent-browser:toolbar {action, value?}`; main → toolbar `independent-browser:state` (url, secure, editable, canGoBack, canGoForward, loading, notice, chip, primary, secondary).
- Toolbar actions: `ready`, `back`, `forward`, `reload`, `stop-loading`, `navigate`, `take-control`, `resume`, `stop-automation`.
- Native menu (`consent.mjs installPageMenu`): Stop automation, Resume automation, Human handoff, Accept and Dismiss pending page dialog, Revoke permissions and close connection.
- Locale: `app.getLocale()` starting with `ko` selects `STRINGS.ko`, otherwise `STRINGS.en`.

## Data layout

Root: `MIXDOG_PLUGIN_DATA`, assigned by Mixdog per registered folder; a new package path gets a new root.

| Path | Content | Lifetime |
| --- | --- | --- |
| `connections/<channel>/endpoint.json` | `{channel, key, pipe, protocol:1}` | removed on clean MCP close |
| `connections/<channel>/electron/` | Electron userData | kept |
| `connections/<channel>/profiles/<sha256(sessionId)>/` | Chromium profile per caller session | kept; never reused by a new connection |
| `connections/<channel>/downloads/<sha256(sessionId)>/` | `<uuid>-<sanitized name>` | kept |

## Package layout

`npm run package` → `dist/win-browser-XXXXXX/win-browser/`:
`plugin.json`, `browser-policy.json`, `hooks/`, `skills/`, `bin/bridge.exe`, `bin/native-consent.exe`, `runtime/` (Electron dist), `app/{mcp,hook,companion}.cjs` + maps, `app/toolbar-preload.cjs`, `vendor/mixdog/`, `licenses/native/`, `licenses/npm/`, `licenses/npm-packages.json`, `sources/native/*.cpp`, `LICENSE`, `README.md`, `THIRD_PARTY_NOTICES.md`, `upstream.lock.json`.

Mixdog derives the registry stem from the folder basename, so it must stay `win-browser` (server `plugin-win-browser`).
