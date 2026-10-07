// npm strips the execute bit from node-pty's prebuilt spawn-helper when it
// unpacks the tarball; without it every PTY spawn fails with
// "posix_spawnp failed." and takes the app down. Runs from postinstall.
const { chmodSync, existsSync } = require('fs')
const { execFileSync } = require('child_process')
const { join } = require('path')

if (process.platform === 'darwin') {
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', arch, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }

  // macOS XProtect false-flags the stock (unsigned) Electron dev binary as
  // malware and silently deletes Electron.app, leaving `npm run dev` to die
  // with "spawn .../Electron ENOENT". Re-signing ad-hoc changes the CDHash so
  // the XProtect rule no longer matches. Dev-only: electron-builder re-signs
  // the packaged app with the Developer ID cert, so this doesn't touch dist.
  const electronApp = join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app')
  if (existsSync(electronApp)) {
    try {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', electronApp], { stdio: 'ignore' })
    } catch {
      // codesign missing (no Xcode CLT) or failed — leave the binary as-is
      // rather than breaking the whole install.
    }
  }
}
