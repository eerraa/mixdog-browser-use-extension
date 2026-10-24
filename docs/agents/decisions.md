# Decisions

Owns: why the design is what it is, rejected options, and when to revisit.
Current rules: `contracts.md`. Add a row when a request changes or reverses one.

| ID | Decision | Because | Rejected | Revisit when |
| --- | --- | --- | --- | --- |
| D1 | Folder-registered plugin: MCP server, skill and hooks | The only official plugin contract; installs without touching Mixdog | Patching Mixdog's ASAR or provider loader; replacing built-in tools by name | Mixdog documents provider or tool-replacement APIs |
| D2 | Own Electron companion per MCP connection, launched by `bridge.exe` in a kill-on-close Job | Independent runtime, windows and profiles; no orphan processes | Mixdog's built-in browser or private bridge | — |
| D3 | Caller identity from single-use tickets issued by the PreToolUse hook | Model arguments cannot prove identity; hooks run in the host | Model-supplied session IDs | The host passes caller identity to MCP servers |
| D4 | Revocation terminates the companion | In-process removal of Chromium device grants cannot be confirmed; process exit can | Clearing internal caches | Electron offers confirmable grant revocation |
| D5 | JS dialogs through a wrapped `dialog.showMessageBox` paired with CDP events, pinned to Electron 44.9.1 | Electron has no documented dialog interception API | Patching page scripts | Any Electron upgrade |
| D6 | Shipped policy `delegated` for hid, usb, notifications, geolocation | Registering the package with this policy is the person's delegation; agents finish device flows on owned pages without routine handoff | Per-request human consent as the default (`manual` stays available) | The user wants per-request consent |
| D7 | One window per page: toolbar, live page view, transparent input shield | Normal browser UX; the person takes over the same live page | v0.1.0 split of a bitmap preview (automation) and a separate real window (human), with no address bar | — |
| D8 | No Mixdog side-panel embedding | Mixdog 1.3.5 plugins contribute only skills, MCP servers and hooks; the side-panel browser is Mixdog's own | Private bridge, core edits | Mixdog ships an official plugin panel or webview API |
| D9 | `CalculateNativeWinOcclusion` disabled and `presented()` bounded to 3 s | A window covered before its first frame never painted, so observe hung | Requiring a foreground window | Electron paints new occluded windows |
| D10 | File System Access pickers and `window.prompt` unsupported | Electron 44.9.1 throws on `prompt()`; FSA choosers would need a custom Electron/Chromium build (explored in a discarded prototype) | A custom Electron build | Electron exposes FSA chooser handling or supports `prompt()` |
