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

import { validateRunRequest } from '../runner'
import { ValidationError } from '../errors'

describe('validateRunRequest', () => {
  it('accepts hosts and a command, deduplicating ids', () => {
    const result = validateRunRequest(['a', 'b', 'a'], 'uptime')
    expect(result.sessionIds).toEqual(['a', 'b'])
    expect(result.command).toBe('uptime')
  })

  it('rejects empty selections and oversized fleets', () => {
    expect(() => validateRunRequest([], 'uptime')).toThrow(ValidationError)
    expect(() => validateRunRequest(new Array(51).fill('x').map((_, i) => `s${i}`), 'uptime')).toThrow(ValidationError)
  })

  it('rejects missing, blank, or oversized commands', () => {
    expect(() => validateRunRequest(['a'], '')).toThrow(ValidationError)
    expect(() => validateRunRequest(['a'], '   ')).toThrow(ValidationError)
    expect(() => validateRunRequest(['a'], 'x'.repeat(5000))).toThrow(ValidationError)
    expect(() => validateRunRequest(['a'], 42)).toThrow(ValidationError)
  })

  it('rejects non-string ids', () => {
    expect(() => validateRunRequest(['a', 42], 'uptime')).toThrow(ValidationError)
  })
})
