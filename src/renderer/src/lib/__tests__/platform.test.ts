import { describe, it, expect, afterEach, vi } from 'vitest'
import { rdpSupported } from '../platform'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('rdpSupported', () => {
  it.each([
    ['darwin', true],
    ['win32', true],
    ['linux', false],
  ])('reports %s as %s', (platform, expected) => {
    vi.stubGlobal('window', { api: { platform } })
    expect(rdpSupported()).toBe(expected)
  })
})
