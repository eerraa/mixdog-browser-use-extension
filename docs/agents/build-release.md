# Build and release

Owns: toolchain pins, artifacts, versions, release, licensing. Verification: `testing.md`.

## Pins

| Item | Pin | Source of truth |
| --- | --- | --- |
| Platform | Windows x64 | guard in `scripts/build-native.mjs` |
| Node.js | ≥ 22.19.0 | `package.json` `engines` |
| Electron (shipped runtime) | 44.9.1 | `package.json` `devDependencies`, `allowScripts` |
| esbuild | 0.28.2 | `package.json` |
| MCP SDK (bundled, patched) | 1.32.1 | `package.json`; `scripts/sdk-adapter.mjs` |
| Upstream Mixdog browser code | 1.3.4 at `968ee08965e75c3fa1999ab8d18d20e45229fc89` | `upstream.lock.json` |
| Native compiler | MinGW-w64 `g++` on PATH, not pinned, so rebuilds are not byte-identical; v0.1.0 used i686-posix-sjlj 8.1.0 | package `licenses/native/provenance.json` |

Not needed: Visual Studio, ATL/MFC, depot_tools, a custom Electron build.

## Pipeline

| Step | Command | Produces |
| --- | --- | --- |
| deps | `npm ci` | `node_modules/` |
| runtime | `node node_modules/electron/install.js` (when install scripts were skipped) | `node_modules/electron/dist/` |
| upstream | `npm run vendor` | `vendor/mixdog/**` fetched at the lock commit, git-blob sha1 verified |
| bundle | `npm run build` | `build/upstream.mjs`, `build/app/{mcp,hook,companion}.cjs` + maps, `build/app/toolbar-preload.cjs`, `build/app/runner-preload.cjs`, `build/bundle-inputs.json` |
| native | `npm run build:native -- "<licenses dir>"` | `build/bridge.exe`, `build/native-consent.exe`, `build/licenses/native/*` |
| package | `npm run package` | a new `dist/win-browser-XXXXXX/win-browser/`; prints `{directory}` |
| verify | `$env:WB_PACKAGE_DIR="<directory>"; npm run test:package` | — |

- The licenses dir must contain `gcc/COPYING3`, `gcc/COPYING.RUNTIME`, `mingw-w64/COPYING.MinGW-w64-runtime.txt` and `winpthreads/COPYING`. MinGW-w64 ships it next to `bin`: `"$(Split-Path (Split-Path (Get-Command g++).Source))\licenses"`.
- `scripts/build.mjs` adapters (vendored `settle` and `command` shims, scroll removal in `stable-rect.ts`, extraction of `compact`, `inferRole`, `accessibleName` and `stateList` from `snapshot-scripts.ts` via `walker.mjs extractUpstreamSources`, which removes the `textContent` name fallback and routes the label, `aria-labelledby` and content reads of `accessibleName` through `renderedText`) throw unless each applies exactly once.
- `scripts/package.mjs` ships exactly the `upstream.lock.json` files from `vendor/mixdog/` and stops when one differs from its locked git blob id (checked at package time); `tests/package/layout.test.mjs` asserts the shipped set.
- The SDK patch (`adaptSdkCancellation`) matches files under `<repo>/node_modules/@modelcontextprotocol/sdk` by real path. In a copied tree, copy `node_modules` (only `electron` may be a junction); otherwise the patch silently skips and package cancellation tests fail.
- `scripts/package.mjs` copies an explicit list. A new shipped file needs `package.mjs` and `tests/package/layout.test.mjs`. npm license texts come from the real bundle graph (`build/bundle-inputs.json`); a bundled package without a LICENSE or NOTICE file fails packaging.

## Clean package build

Build in an isolated copy so the repo `build/` stays free of native helpers (live-test caveat in `testing.md`):

1. Copy `src`, `scripts`, `native`, `vendor`, `skills`, `hooks`, `plugin.json`, `browser-policy.json`, `README.md`, `THIRD_PARTY_NOTICES.md`, `upstream.lock.json`, `package.json` and `LICENSE` to a fresh temp dir.
2. Copy `node_modules` there; only `electron` may be a junction.
3. In that dir run `node scripts/build-native.mjs <licenses dir>`, `node scripts/build.mjs`, `node scripts/package.mjs`.
4. Copy the printed `dist/win-browser-XXXXXX` allocation into the repo `dist/`, the folder users register. Run `test:package` from the repo with `WB_PACKAGE_DIR` set to that copy's `win-browser` folder, then delete the temp copy.

Mixdog runs a registered package in place and keys its data by the folder path (`architecture.md` Data layout). Keep a registered package; a rebuilt package is a new folder that the user registers again.

## Versioning

Bump together: `package.json` `version`, `package-lock.json` (root and `packages[""]`), `plugin.json` `version`, server `version` in `src/mcp.mjs`.

## Release (explicit user request only)

1. Bump the version (Versioning). All suites pass on that tree; build the package with the clean package build.
2. Copy the package's `win-browser` folder to `dist/releases/v<ver>/win-browser`. This path has no random part and matches the ZIP content.
3. In `dist/releases/v<ver>` run `tar -a -c -f win-browser-v<ver>-windows-x64.zip win-browser`, which puts the folder at the archive root with `/` separators. Write `<zip>.sha256` containing `<sha256>  <zip name>` (two spaces, LF).
4. Extract the ZIP to a fresh temp dir and run `test:package` on the extracted `win-browser`.
5. Commit exactly that tree, tag `v<ver>`, push, then create the GitHub release on `eerraa/mixdog-browser-use-extension` with both assets. Korean notes: interface, default policy, per-layer verification counts, limits, unpinned compiler. Check that the uploaded asset digest equals the local sha256.
6. Users register the new folder themselves; existing registrations are never replaced automatically.

| Release | Commit | Assets |
| --- | --- | --- |
| v0.1.0 | `f9ed383`, before the history reset; not an ancestor of `main` | `win-browser-v0.1.0-windows-x64.zip` (sha256 `78aa171135fb61cec9e700c7039d0e41eb98db5173eba4a7eb6464724cff414b`) and its `.sha256` |
| v0.2.0 | tag `v0.2.0` on `main` | `win-browser-v0.2.0-windows-x64.zip` (sha256 `7c270649a7ac1463c51a2428a037520a7249349fe3b4ae648593a8fc4445da80`) and its `.sha256` |
| v0.3.0 | tag `v0.3.0` on `main` | `win-browser-v0.3.0-windows-x64.zip` (sha256 `4120dfb2846936072b04ab555fceb1acba5789eaf64dbc1aabe585e248a4b831`) and its `.sha256` |
| v0.3.1 | tag `v0.3.1` on `main` | `win-browser-v0.3.1-windows-x64.zip` (sha256 `e9e7ae9ba1f50cca4eb566534949baa084dfc0d110b68f1f2eb9ce22580bcd5c`) and its `.sha256` |

## Licensing

| `THIRD_PARTY_NOTICES.md` section | Update when |
| --- | --- |
| Mixdog browser source | `upstream.lock.json` or the `scripts/build.mjs` adapters change |
| Electron | the Electron pin changes |
| Bundled MCP dependencies | the SDK pin or `sdk-adapter.mjs` patch changes, or new bundled npm packages appear |
| Native helpers | `native/` or `scripts/build-native.mjs` changes |

- The package `LICENSE` is copied from `vendor/mixdog/LICENSE` (Apache-2.0); `vendor/mixdog/NOTICE.md` ships too.
- Banners in `scripts/build.mjs` cite the upstream commit; keep them equal to `upstream.lock.json`.
