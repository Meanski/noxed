// electron-builder afterPack hook: verify the bundled RDP sidecar is
// self-contained before the app gets signed/shipped. On macOS the sidecar must
// NOT reference Homebrew dylibs (/opt/homebrew, /usr/local) — otherwise it runs
// here but fails on any clean machine. Build it via:
//   cd native/rdp-spike && ./build-freerdp-static.sh && make rdp-sidecar-static
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function verifySidecar(context) {
  const platform = context.electronPlatformName
  const appOutDir = context.appOutDir

  if (platform === 'darwin') {
    const appName = context.packager.appInfo.productFilename
    const sidecar = join(appOutDir, `${appName}.app`, 'Contents', 'Resources', 'rdp-sidecar')
    if (!existsSync(sidecar)) {
      throw new Error(
        `[verify-sidecar] RDP sidecar missing from package: ${sidecar}\n` +
          `Build it first: cd native/rdp-spike && ./build-freerdp-static.sh && make rdp-sidecar-static`,
      )
    }
    const deps = execFileSync('otool', ['-L', sidecar], { encoding: 'utf8' })
    const leaked = deps
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/opt/homebrew') || l.startsWith('/usr/local'))
    if (leaked.length > 0) {
      throw new Error(
        `[verify-sidecar] RDP sidecar links non-redistributable libraries:\n  ${leaked.join('\n  ')}\n` +
          `Rebuild statically: cd native/rdp-spike && ./build-freerdp-static.sh && make rdp-sidecar-static`,
      )
    }
    console.log('[verify-sidecar] macOS RDP sidecar is self-contained ✓')
    return
  }

  if (platform === 'win32') {
    // win.extraResources lands under <appOutDir>/resources/.
    const sidecar = join(appOutDir, 'resources', 'rdp-sidecar.exe')
    if (!existsSync(sidecar)) {
      throw new Error(
        `[verify-sidecar] RDP sidecar missing from package: ${sidecar}\n` +
          `Build it first (vcpkg static FreeRDP): see native/rdp-spike/CMakeLists.txt`,
      )
    }
    // The vcpkg x64-windows-static build + static CRT should leave no FreeRDP/
    // OpenSSL/vcpkg DLL dependencies — only Windows system DLLs. Best-effort
    // check via dumpbin; skip quietly if the VS toolchain isn't on PATH.
    try {
      const deps = execFileSync('dumpbin', ['/dependents', sidecar], { encoding: 'utf8' })
      const leaked = deps
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /\.dll$/i.test(l))
        .filter((l) => /freerdp|winpr|libssl|libcrypto|zlib|vcruntime|msvcp/i.test(l))
      if (leaked.length > 0) {
        throw new Error(
          `[verify-sidecar] RDP sidecar links non-redistributable DLLs:\n  ${leaked.join('\n  ')}\n` +
            `Rebuild static: vcpkg install freerdp:x64-windows-static + the static CRT (see CMakeLists.txt).`,
        )
      }
      console.log('[verify-sidecar] Windows RDP sidecar is self-contained ✓')
    } catch (err) {
      if (err.message && err.message.startsWith('[verify-sidecar]')) throw err
      console.log('[verify-sidecar] Windows RDP sidecar present (dumpbin unavailable, skipped dep scan) ✓')
    }
    return
  }

  // Linux sidecar is a separate build (not yet produced); nothing to verify
  // until extraResources ships it for that platform.
  console.log(`[verify-sidecar] no sidecar check for ${platform} (not bundled yet)`)
}
