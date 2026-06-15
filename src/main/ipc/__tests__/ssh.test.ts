import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data = new Map<string, unknown>()
    get(key: string) { return this.data.get(key) }
    set(key: string, value: unknown) { this.data.set(key, value) }
  },
}))

import { parseKeepaliveIntervalMs, sshConnectOptions } from '../ssh'

describe('parseKeepaliveIntervalMs', () => {
  it('disables keep-alive when set to Off', () => {
    expect(parseKeepaliveIntervalMs('Off')).toBe(0)
  })

  it('maps each interval option', () => {
    expect(parseKeepaliveIntervalMs('15 seconds')).toBe(15_000)
    expect(parseKeepaliveIntervalMs('30 seconds')).toBe(30_000)
    expect(parseKeepaliveIntervalMs('60 seconds')).toBe(60_000)
  })

  it('falls back to 30 seconds for unknown or missing values', () => {
    expect(parseKeepaliveIntervalMs(undefined)).toBe(30_000)
    expect(parseKeepaliveIntervalMs('2 hours')).toBe(30_000)
    expect(parseKeepaliveIntervalMs(15_000)).toBe(30_000)
  })
})

describe('sshConnectOptions', () => {
  it('applies the stored keepalive default to connect options', () => {
    const opts = sshConnectOptions()
    expect(opts.keepaliveInterval).toBe(30_000)
    expect(opts.readyTimeout).toBe(30_000)
    expect(opts.keepaliveCountMax).toBe(4)
  })
})
