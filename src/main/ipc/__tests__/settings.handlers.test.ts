import { describe, it, expect, vi } from 'vitest'

const { ipc } = vi.hoisted(() => ({
  ipc: {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
  },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, fn)
    }),
    on: vi.fn(),
  },
}))

vi.mock('electron-store', () => ({
  // Like the real electron-store, values round-trip through JSON so callers
  // never share object references with the store.
  default: class MockStore {
    private data: Map<string, unknown>
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      this.data = new Map(Object.entries(structuredClone(opts?.defaults ?? {})))
    }
    get(key: string) { return structuredClone(this.data.get(key)) }
    set(key: string, value: unknown) { this.data.set(key, structuredClone(value)) }
  },
}))

import { registerSettingsHandlers, getStoredSettings, type AppSettings } from '../settings'

registerSettingsHandlers()

const event = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } }

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`${channel} handler not registered`)
  return handler(event, ...args)
}

describe('settings:get', () => {
  it('returns the stored settings seeded with defaults', () => {
    const settings = invoke('settings:get') as AppSettings
    expect(settings).toMatchObject({
      dateFormat: 'YYYY-MM-DD HH:mm',
      sidebarDefault: 'expanded',
      terminalFontSize: 14,
      isDarkMode: false,
      groupColors: {},
      projectGroupOrder: [],
    })
  })
})

describe('getStoredSettings', () => {
  it('merges defaults with whatever is stored', () => {
    expect(getStoredSettings()).toMatchObject({
      terminalFont: 'JetBrains Mono',
      scrollbackSize: 100000,
      confirmClose: true,
    })
  })
})

describe('settings:set', () => {
  it('updates a known key and returns the full settings object', () => {
    const settings = invoke('settings:set', 'terminalFontSize', 18) as AppSettings
    expect(settings.terminalFontSize).toBe(18)
    expect((invoke('settings:get') as AppSettings).terminalFontSize).toBe(18)
    expect(getStoredSettings().terminalFontSize).toBe(18)
  })

  it('accepts namespaced snippet keys', () => {
    const settings = invoke('settings:set', 'snippets:session-1', [{ name: 'restart' }]) as AppSettings
    expect(settings['snippets:session-1']).toEqual([{ name: 'restart' }])
  })

  it('rejects unknown keys', () => {
    expect(() => invoke('settings:set', 'evilKey', true)).toThrow('Unknown setting: evilKey')
    expect((invoke('settings:get') as AppSettings)).not.toHaveProperty('evilKey')
  })
})

describe('settings:reset', () => {
  it('restores the defaults', () => {
    invoke('settings:set', 'isDarkMode', true)
    const defaults = invoke('settings:reset') as AppSettings
    expect(defaults.isDarkMode).toBe(false)
    expect(defaults.terminalFontSize).toBe(14)
    expect((invoke('settings:get') as AppSettings).isDarkMode).toBe(false)
  })
})
