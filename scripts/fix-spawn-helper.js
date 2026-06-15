// npm strips the execute bit from node-pty's prebuilt spawn-helper when it
// unpacks the tarball; without it every PTY spawn fails with
// "posix_spawnp failed." and takes the app down. Runs from postinstall.
const { chmodSync, existsSync } = require('fs')
const { join } = require('path')

if (process.platform === 'darwin') {
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', arch, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
