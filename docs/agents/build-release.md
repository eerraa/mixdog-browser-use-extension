# Build and release

Owns: pins, build and package pipeline, clean package build, versioning, release
procedure and licensing upkeep.
Not here: notice texts (`THIRD_PARTY_NOTICES.md`, `third_party/mixdog/`), verification
(`testing.md`), package contents (`architecture.md` Package layout).
Update when: a pin, build or package step, version location, release step or notice
section changes.

## Pins

| Item | Pin | Source of truth |
| --- | --- | --- |
| Platform | Windows x64 | guard in `scripts/build-native.mjs` |
| Node.js | ≥ 22.19.0 | `package.json` `engines` |
| Electron (shipped runtime) | 44.9.1 | `package.json` `devDependencies`, `allowScripts` |
| esbuild | 0.28.2 | `package.json` |
| MCP SDK (bundled, patched) | 1.32.1 | `package.json`; `scripts/sdk-adapter.mjs` |
| Mixdog fork point (not tracked) | 1.3.4 at `968ee08965e75c3fa1999ab8d18d20e45229fc89` | `third_party/mixdog/provenance.json` |
| Native compiler | MinGW-w64 `g++` on PATH, not pinned, so rebuilds are not byte-identical | package `licenses/native/provenance.json` |

Not needed: Visual Studio, ATL/MFC, depot_tools, a custom Electron build.

## Pipeline

| Step | Command | Produces |
| --- | --- | --- |
| deps | `npm ci` | `node_modules/` |
| runtime | `node node_modules/electron/install.js` (when install scripts were skipped) | `node_modules/electron/dist/` |
| bundle | `npm run build` | `build/app/{mcp,hook,companion}.cjs` + maps, `build/app/toolbar-preload.cjs`, `build/app/runner-preload.cjs`, `build/bundle-inputs.json` |
| native | `npm run build:native -- "<licenses dir>"` | `build/bridge.exe`, `build/native-consent.exe`, `build/licenses/native/*` |
| package | `npm run package` | a new `dist/win-browser-XXXXXX/win-browser/`; prints `{directory}` |
| clean package | `npm run package:clean -- "<abs licenses dir>"` | native, bundle and package in a temp copy of the working tree (Clean package build); a new `dist/win-browser-XXXXXX/win-browser/`; prints `{directory}` |
| release folder | `npm run package:clean -- "<abs licenses dir>" --release` | the same from the committed `HEAD`: `dist/releases/v<ver>/` (Release) |
| verify | `$env:WB_PACKAGE_DIR="<directory>"; npm run test:package` | — |

- The licenses dir must contain `gcc/COPYING3`, `gcc/COPYING.RUNTIME`, `mingw-w64/COPYING.MinGW-w64-runtime.txt` and `winpthreads/COPYING`. MinGW-w64 ships it next to `bin`: `"$(Split-Path (Split-Path (Get-Command g++).Source))\licenses"`.
- `scripts/package.mjs` ships Mixdog's `LICENSE` and `NOTICE.md` and the fork record from `third_party/mixdog/` as `licenses/mixdog/`; `tests/package/layout.test.mjs` checks the notices against the blob ids in the record.
- The SDK patch (`adaptSdkCancellation`) matches files under `<repo>/node_modules/@modelcontextprotocol/sdk` by real path. In a copied tree, copy `node_modules` (only `electron` may be a junction); otherwise the patch silently skips and package cancellation tests fail.
- `scripts/package.mjs` copies an explicit list. A new shipped file needs `package.mjs` and `tests/package/layout.test.mjs`. npm license texts come from the real bundle graph (`build/bundle-inputs.json`); a bundled package without a LICENSE or NOTICE file fails packaging.

## Clean package build

Build in an isolated copy so the repo `build/` stays free of native helpers (live-test caveat in `testing.md`). `npm run package:clean -- "<abs licenses dir>"` (`scripts/clean-package.mjs`) does steps 1–4 and prints `{directory}`; run `test:package` from the repo with `WB_PACKAGE_DIR` set to it.

1. Copy `src`, `scripts`, `native`, `third_party`, `skills`, `hooks`, `plugin.json`, `browser-policy.json`, `README.md`, `THIRD_PARTY_NOTICES.md`, `package.json` and `LICENSE` (`SOURCES`) to a fresh temp dir (`%TEMP%\win-browser-build-*`).
2. Copy `node_modules` there; only `electron` may be a junction.
3. In that dir run `node scripts/build-native.mjs <licenses dir>`, `node scripts/build.mjs`, `node scripts/package.mjs`.
4. Copy the printed `dist/win-browser-XXXXXX` allocation into the repo `dist/`, the folder users register. Remove the `electron` junction first, then the temp copy, so no recursive delete reaches the repository runtime.

Mixdog runs a registered package in place and keys its data by the folder path (`architecture.md` Data layout). Keep a registered package; a rebuilt package is a new folder that the user registers again.

## Versioning

Bump together: `package.json` `version`, `package-lock.json` (root and `packages[""]`), `plugin.json` `version`, server `version` in `src/mcp/main.mjs`.

## Release (explicit user request only)

1. Bump the version (Versioning) and commit. All suites pass on that tree.
2. `npm run package:clean -- "<abs licenses dir>" --release` refuses uncommitted tracked changes, a version that differs between `package.json`, `plugin.json` and `src/mcp/main.mjs`, and an existing `dist/releases/v<ver>`. It runs the clean package build on `git archive` of `HEAD` with `core.autocrlf=false`, after checking every exported file against its blob id in the commit, and writes `dist/releases/v<ver>/`:
   - `win-browser/`: the package. This path has no random part and matches the ZIP content.
   - `win-browser-v<ver>-windows-x64.zip`: `tar -a -c -f` (Windows `tar.exe`) of `win-browser`, the folder at the archive root with `/` separators; `<zip>.sha256` holds `<sha256>  <zip name>` (two spaces, LF).
   - `win-browser-v<ver>-files.sha256`: one `<sha256>  win-browser/<path>` line per packaged file; `release.json`: version, source commit, ZIP name and digest.
3. Run `test:package` on `dist/releases/v<ver>/win-browser`, and on the `win-browser` of the ZIP extracted to a fresh temp dir.
4. On explicit request only: tag `v<ver>` on that commit, push, then create the GitHub release on `eerraa/mixdog-browser-use-extension` with the ZIP and its `.sha256`. Korean notes: interface, default policy, per-layer verification counts, limits, unpinned compiler. Check that the uploaded asset digest equals the local sha256.
5. Users register the new folder themselves; existing registrations are never replaced automatically. Mixdog: the `dist/releases/v<ver>/win-browser` folder. Claude Code: `claude mcp remove --scope user win-browser` for an earlier entry, then `claude mcp add --scope user win-browser -e WB_AUTHORITY=connection -e WB_DATA_DIR=<abs dir> -- <abs repo>\dist\releases\v<ver>\win-browser\bin\bridge.exe --mcp`, checked with `claude mcp get win-browser`; running sessions see it after `/mcp` reconnect or a restart.

Published releases are the `v<ver>` git tags and their GitHub releases.

## Licensing

| `THIRD_PARTY_NOTICES.md` section | Update when |
| --- | --- |
| Mixdog browser source (independent fork) | a derived file changes, moves or is added (`third_party/mixdog/provenance.json` `derived`) |
| Electron | the Electron pin changes |
| Bundled MCP dependencies | the SDK pin or `sdk-adapter.mjs` patch changes, or new bundled npm packages appear |
| Native helpers | `native/` or `scripts/build-native.mjs` changes |

- The package `LICENSE` is the repository `LICENSE` (Apache-2.0). `licenses/mixdog/` ships Mixdog's unmodified `LICENSE` and `NOTICE.md` and the fork record.
- The bundle banner in `scripts/build.mjs` and each derived file's header cite the fork point; keep them equal to `third_party/mixdog/provenance.json`.
