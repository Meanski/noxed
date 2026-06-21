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

  // Windows/Linux sidecars are a separate build (not yet produced); nothing to
  // verify until extraResources ships them for those platforms.
  console.log(`[verify-sidecar] no sidecar check for ${platform} (not bundled yet)`)
}
