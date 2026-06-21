# RDP — session handoff / TODO

Status as of 2026-06-21. Branch: **`feat/windows-rdp`** (PR #1). Read this first.

## TL;DR
Windows RDP support is built and **working in-app**. **macOS is production-ready**
(self-contained sidecar, bundled + signed/notarized via CI). **Your job next:
the Windows sidecar** so RDP works in the Windows build too. You'll be on a
Windows machine — perfect for it.

---

## What already works (done)

- **RDP is a first-class connection type.** Add-connection form (port 3389,
  user/pass), sidebar "Remote Desktop" section, Monitor icons everywhere.
- **Architecture = sidecar process.** A native FreeRDP binary connects to the
  host and streams composed frames to stdout; the Electron main process parses
  them and blits to a `<canvas>`. Output-only (no input injection yet).
- **Verified against a real Windows host** — rendered a live Server Manager
  desktop.
- **macOS production packaging is complete and verified** (zero Homebrew deps,
  bundled in the .app, runs standalone, CI builds it).
- **The RDP UI is gated to macOS** (`window.api.platform === 'darwin'`) so the
  current Windows/Linux builds don't show a feature that can't run.

### Key files
| File | Role |
|------|------|
| `native/rdp-spike/sidecar.c` | The sidecar. **Cross-platform FreeRDP C** — should compile on Windows too. |
| `native/rdp-spike/build-freerdp-static.sh` | Builds minimal static FreeRDP (macOS). Windows needs an equivalent. |
| `native/rdp-spike/Makefile` | `rdp-sidecar` (dev, dynamic) + `rdp-sidecar-static` (prod). |
| `src/main/ipc/rdp.ts` | Sidecar manager: spawn, frame parser (resyncs on stray bytes), `sidecarPath()` (already handles `.exe`). |
| `src/renderer/src/components/RDP/RdpView.tsx` | Canvas pane. |
| `electron-builder.yml` | `mac.extraResources` bundles the sidecar; `afterPack` guard. |
| `scripts/verify-sidecar.js` | afterPack guard — fails build if sidecar isn't self-contained. |
| `.github/workflows/release.yml` | Builds + caches the static sidecar on the mac runner. |

### Wire protocol (sidecar stdout → rdp.ts)
`"NXF1"` magic + u32 LE width + u32 LE height + u32 LE dataLen + dataLen bytes
(tightly-packed RGBA). Diagnostics go to **stderr only** — stdout is binary.

---

## What to do next: Windows sidecar

Goal: produce a self-contained **`rdp-sidecar.exe`**, bundle it for the Windows
build, and un-gate the UI on Windows.

### 1. Build FreeRDP + the sidecar on Windows
- Easiest path: **vcpkg with the static triplet** so there are no loose DLLs:
  - `vcpkg install freerdp:x64-windows-static` (pulls openssl etc. static)
  - Compile `sidecar.c` with MSVC (`cl`) or CMake, linking the vcpkg static libs.
- Mirror the macOS trim where possible (no X11/ffmpeg/audio/redirection
  channels) to keep it small — but vcpkg's FreeRDP may not expose all those
  flags; a from-source CMake build (like `build-freerdp-static.sh`) gives full
  control. Either is fine for v1; static is the priority.
- Produce `native/rdp-spike/rdp-sidecar.exe`.

### 2. ⚠️ CRITICAL Windows gotcha — stdout binary mode
On Windows, stdout defaults to **text mode** and will translate `\n` → `\r\n`,
which **corrupts the binary frame stream**. At the top of `main()` in
`sidecar.c`, add (guarded for Windows):
```c
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
  _setmode(_fileno(stdout), _O_BINARY);
#endif
```
Without this you'll see frame desync / garbled pixels even though it "connects."

### 3. Bundle it
In `electron-builder.yml`, add a `win:` `extraResources` block (mirror the mac
one) pointing at `native/rdp-spike/rdp-sidecar.exe` → `rdp-sidecar.exe`.
`sidecarPath()` already resolves `.exe` on win32, so no main-process change.

### 4. Guard it
In `scripts/verify-sidecar.js`, add a `win32` branch: confirm the `.exe` exists
in the packaged Resources, and (if not static) that its DLL deps are bundled.
`dumpbin /dependents` or a known-DLL allowlist works.

### 5. Un-gate the UI
Three spots currently check `window.api.platform === 'darwin'` — extend to also
allow `'win32'`:
- `src/renderer/src/components/ConnectionManager/AddConnectionModal.tsx` (TYPE_OPTIONS filter)
- `src/renderer/src/components/Sidebar/Sidebar.tsx` (`onOpenRdp`)
- `src/renderer/src/components/Dashboard/Dashboard.tsx` (`onOpenRdp`)
Consider a small helper like `const rdpSupported = ['darwin','win32'].includes(window.api.platform)`.

### 6. CI
In `.github/workflows/release.yml`, add a Windows step that builds the sidecar
(vcpkg + compile) before `electron-builder`, cached like the mac one.

### 7. Test
`npm run dev`, add a Remote Desktop connection to a reachable RDP host,
right-click → Open Remote Desktop. Then `npm run pack` and confirm the guard
passes and the bundled `.exe` runs from `dist/win-unpacked/...`.

---

## After Windows
- **Linux sidecar** — same pattern (apt FreeRDP dev libs or static build),
  `linux.extraResources`, add `'linux'` to the UI gate, CI step.
- **Input injection** — mouse/keyboard from `RdpView` over the sidecar's stdin
  (define an input message format; FreeRDP `freerdp_input_send_*`). Biggest
  usefulness jump; makes RDP interactive instead of view-only.
- **Friendlier connect errors** — map FreeRDP error codes to human text in
  `sidecar.c` (currently surfaces e.g. `connect failed err=0x00020006`).

## Open question to confirm
Did reconnecting to the macOS Test box confirm the **trimmed static** sidecar
still renders? (Codecs/channels were stripped vs the original dynamic build.)
If yes, the macOS release is good to tag (`v0.1.4`). If garbled, revisit which
codecs got trimmed in `build-freerdp-static.sh`.

## Lessons learned (don't relearn the hard way)
- FreeRDP's WLog sends **INFO to stdout** → corrupts the frame channel. Fixed in
  `sidecar.c` via `quiet_wlog_to_stderr()` (pins appender to stderr, ERROR level).
- Static FreeRDP link needs: trim channels (urbdrc/remdesk/rdpsnd/audin caused
  undefined symbols), disable Opus (`opus/opus.h` not found), and on macOS add
  `-lobjc` + CoreFoundation/Foundation/CoreServices/Security/IOKit frameworks +
  static jansson. Windows will have its own equivalent link set.
