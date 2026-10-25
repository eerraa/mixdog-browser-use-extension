# Third-party source and runtime notices

## Mixdog browser source (independent fork)

Mixdog, Copyright (c) 2026 tribgames, Apache License 2.0.

- Repository: https://github.com/tribgames/mixdog
- Fork point: version 1.3.4, commit `968ee08965e75c3fa1999ab8d18d20e45229fc89`
- Upstream tracking: none. This plugin carries an independent fork of the
  files below; Mixdog changes after the fork point are not tracked or applied.
- Mixdog's unmodified `LICENSE` and `NOTICE.md` and the fork record
  (`provenance.json`, with the original files' git blob ids): `licenses/mixdog/`

Derived files (paths in this plugin's source repository; each carries a
notice of its changes, and the bundled `app/*.cjs.map` source maps embed them):

| Original file (`apps/desktop/src/main/browser/`) | Derived file | Changes |
| --- | --- | --- |
| `cdp-execution.ts` | `src/browser/cdp-execution.mjs` | TypeScript types removed; the CDP request timeout imported from `./command` is a local constant (15 s) |
| `actionability.ts` | `src/browser/actionability.mjs` | TypeScript types removed; `pause` comes from the plugin's async helper instead of `./settle` |
| `stable-rect.ts` | `src/browser/perception/target-point.mjs` (`BROWSER_STABLE_RECT`) | scrolling removed from the measurement: the host prepares the exact target and ancestor viewports first, so geometry and hit testing stay mutation-free |
| `snapshot-scripts.ts` | `src/browser/perception/target-point.mjs` (`browserRefPointExpression`), `src/browser/perception/semantics.mjs` (`compact`, `inferRole`, `accessibleName`, `stateList`) | only these are kept; the snapshot expression is not used. The ref-point resolver reads its element from the renamed isolated-world global `__independentTargetSnapshot`. The accessible name reads labels, `aria-labelledby` targets and element content through a plugin-owned rendered-text helper instead of `textContent`/`innerText`, and its `textContent` fallback is removed, so style, script and unrendered text never become names |
| `semantic-query.ts` | `src/browser/perception/match.mjs` | only the element matcher is kept; TypeScript types removed |

The independent perception walker composes the role, name and state helpers;
`match.mjs` ranks `find` matches and `target-point.mjs` supplies the target
point expression. The independent host owns lifecycle, permissions, profiles,
observation authority, human presentation and MCP. The queue's
actual-operation fence is an independent implementation of the invariant of
Mixdog's command queue and CDP execution fence at the fork point.

No agent runner, default agent settings, installed core, private bridge,
password-import sidecar or old plugin implementation is included.
The complete Mixdog NOTICE is preserved for reference; its unrelated
components are not claims that those components are shipped here.

## Electron

Electron 44.9.1 is obtained from its pinned npm package and official runtime.
The complete runtime is included under `runtime/`, including its original
`LICENSE` and `LICENSES.chromium.html`. Chromium, Node.js and their bundled
third-party components retain the terms in those original notices.

## Bundled MCP dependencies

Only packages appearing in the compiler's actual bundled import graph are
included in `licenses/npm-packages.json`. Their package versions, declared
licenses and unmodified license/NOTICE files are preserved under `licenses/npm/`.
The MCP SDK is `@modelcontextprotocol/sdk` 1.32.1, MIT, Anthropic PBC.

Bundled-source change: `dist/esm/shared/protocol.js`, `Protocol._oncancel`,
replaces the falsy `requestId` guard with `requestId === undefined` so valid
JSON-RPC request ID `0` reaches the SDK's original cancellation handling.
The exact version and source match are build requirements. Installed dependency
files remain unmodified; the source map records the adapted input.
The SDK's `sourceMappingURL` comments are removed while bundling to avoid
chaining incomplete published TypeScript maps. The distribution map embeds the
actual JavaScript inputs, including the adapted protocol implementation.

## Native helpers

The independent native sources are included under `sources/native/`.
Windows UserConsentVerifier is used through its documented desktop ABI;
no credential or biometric data is returned to this plugin.

The shipped Windows helpers are built with MinGW-w64 GCC. Compiler provenance,
original GCC GPLv3/Runtime Library Exception 3.1, MinGW-w64 runtime notices and
winpthreads notices are included under `licenses/native/`. The GCC Runtime
Library Exception governs the eligible compilation of these independent modules;
the compiler itself is not shipped.
