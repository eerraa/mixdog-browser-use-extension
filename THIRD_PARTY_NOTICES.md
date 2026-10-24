# Third-party source and runtime notices

## Mixdog browser source

Mixdog, Copyright (c) 2026 tribgames, Apache License 2.0.

- Repository: https://github.com/tribgames/mixdog
- Version: 1.3.4
- Fixed commit: `968ee08965e75c3fa1999ab8d18d20e45229fc89`
- Untouched originals and upstream license/notices: `vendor/mixdog/`
- Verified source blob identities: `upstream.lock.json`

Only these browser implementation files are reused:

- `apps/desktop/src/main/browser/snapshot-scripts.ts`
- `apps/desktop/src/main/browser/semantic-query.ts`
- `apps/desktop/src/main/browser/stable-rect.ts`
- `apps/desktop/src/main/browser/ref-recovery.ts`
- `apps/desktop/src/main/browser/actionability.ts`
- `apps/desktop/src/main/browser/cdp-execution.ts`

Statement of changes: the original files remain unmodified as source artifacts.
The build disables recursive same-origin frame traversal in the DOM fallback
because this host captures each frame in its own isolated world. Standalone
abort/pause and bounded CDP timeout adapters replace host-local imports.
The build removes scrolling from stable-rectangle measurements; the host
prepares the exact target and ancestor viewports before a new observation
and same-object identity check. Geometry and hit testing remain mutation-free.
TypeScript is compiled and bundled. The independent host owns lifecycle,
permissions, profiles, observation authority, human presentation and MCP.
The queue's actual-operation fence is an independent implementation of the
attributed upstream invariant.

No agent runner, default agent settings, installed core, private bridge,
password-import sidecar or old plugin implementation is included.
The complete upstream NOTICE is preserved for reference; its unrelated
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
