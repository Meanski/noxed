// Platforms that bundle the native FreeRDP sidecar. The RDP UI is gated to these
// so builds without a sidecar never offer a connection that can't run.
const RDP_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'win32'])

export function rdpSupported(): boolean {
  return RDP_PLATFORMS.has(window.api.platform)
}
