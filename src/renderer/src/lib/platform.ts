// Platforms with a bundled RDP sidecar. The native FreeRDP sidecar is built and
// shipped per-platform (macOS + Windows so far); the RDP UI is gated to these so
// builds without a sidecar don't surface a feature that can't run. Add 'linux'
// here once a Linux sidecar ships.
const RDP_PLATFORMS: ReadonlyArray<string> = ['darwin', 'win32']

export const rdpSupported: boolean = RDP_PLATFORMS.includes(window.api.platform)
