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

import { parseJsonLines, validateContainerRef, validateContainerAction } from '../docker'
import { ValidationError } from '../errors'

describe('parseJsonLines', () => {
  it('parses one JSON object per line', () => {
    const out = '{"ID":"abc","Names":"web"}\n{"ID":"def","Names":"db"}\n'
    expect(parseJsonLines(out)).toEqual([
      { ID: 'abc', Names: 'web' },
      { ID: 'def', Names: 'db' },
    ])
  })

  it('skips blank lines, noise, and truncated JSON', () => {
    const out = '\nWARNING: something\n{"ID":"abc"}\n{"ID":"trunc'
    expect(parseJsonLines(out)).toEqual([{ ID: 'abc' }])
  })

  it('returns an empty array for empty output', () => {
    expect(parseJsonLines('')).toEqual([])
  })
})

describe('validateContainerRef', () => {
  it('accepts ids and conventional names', () => {
    expect(validateContainerRef('3f4a9b2c1d')).toBe('3f4a9b2c1d')
    expect(validateContainerRef('my-app_1.web')).toBe('my-app_1.web')
  })

  it('rejects shell metacharacters and bad shapes', () => {
    for (const bad of ['a; rm -rf /', 'a b', '$(reboot)', '-leading-dash', '', 'a'.repeat(200), 42]) {
      expect(() => validateContainerRef(bad)).toThrow(ValidationError)
    }
  })
})

describe('validateContainerAction', () => {
  it('accepts the four supported actions', () => {
    for (const action of ['start', 'stop', 'restart', 'rm']) {
      expect(validateContainerAction(action)).toBe(action)
    }
  })

  it('rejects anything else', () => {
    for (const bad of ['exec', 'kill --signal', '', undefined]) {
      expect(() => validateContainerAction(bad)).toThrow(ValidationError)
    }
  })
})
