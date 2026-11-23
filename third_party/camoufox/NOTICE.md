# Camoufox / Mozilla Firefox Notice

This plugin drives Camoufox (patched Mozilla Firefox 158.0.1, build `beta.41`)
as its default browser engine via Firefox's Juggler pipe and local read-only
Firefox DevTools Remote Debugging Protocol (RDP).

- Project: Camoufox — https://github.com/daijro/camoufox
- Upstream browser: Mozilla Firefox 158.0.1 — https://www.mozilla.org/firefox/
- License: Mozilla Public License, Version 2.0 (MPL-2.0) — https://www.mozilla.org/en-US/MPL/2.0/
- Recorded runtime build: `158.0.1-beta.41` (Windows x64, SHA-256 `2644bd14f1cc345c768f6a70b576bcc87eb3d0bf0df54856d6fe0bbc3027515f`)

Under the MPL-2.0, source code for Mozilla Firefox and Camoufox patches is
available from their respective upstream repositories above. This plugin does
not modify Firefox/Camoufox binaries or link against Firefox internal libraries;
it launches the unmodified `camoufox.exe` process out-of-process over standard
pipes/loopback sockets.

In shared-runtime installations, the Camoufox runtime directory is stored once
under `<installRoot>/win-browser-runtime/camoufox/` (or `camoufox/` inside the
package, or at `WB_CAMOUFOX_PATH`) and shared across versioned plugin folders.
