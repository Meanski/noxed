import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) } }))
const unlocked = vi.hoisted(() => ({ value: true }))
vi.mock('../keychain', () => ({ isUnlocked: () => unlocked.value }))
vi.mock('../security', () => ({
  isAllowedKeyPath: (p: string) => (p.startsWith('~/.ssh/') ? { ok: true, resolved: `/home/me/.ssh/${p.slice(7)}` } : { ok: false, reason: 'Key files must live in ~/.ssh' }),
}))
vi.mock('node:fs', () => ({ readFileSync: (p: string) => `KEY:${p}` }))

import { readKeyFile, registerKeyFileHandlers } from '../keyFiles'
import { AuthError, ValidationError } from '../errors'

beforeEach(() => { unlocked.value = true })

describe('readKeyFile', () => {
  it('reads allowlisted key files while unlocked', () => {
    expect(readKeyFile('~/.ssh/id_ed25519')).toBe('KEY:/home/me/.ssh/id_ed25519')
    registerKeyFileHandlers()
    expect(handlers.get('fs:readFile')!({}, '~/.ssh/id_rsa')).toBe('KEY:/home/me/.ssh/id_rsa')
  })

  it('keeps key material behind the lock screen', () => {
    unlocked.value = false
    expect(() => readKeyFile('~/.ssh/id_ed25519')).toThrow(AuthError)
  })

  it('refuses paths outside the key directories and non-strings', () => {
    expect(() => readKeyFile('/etc/shadow')).toThrow('Key files must live in ~/.ssh')
    expect(() => readKeyFile(42)).toThrow(ValidationError)
  })
})
