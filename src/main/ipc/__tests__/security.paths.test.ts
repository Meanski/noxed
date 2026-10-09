import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A throwaway home directory with an allowed ~/.ssh, a file outside home, and
// symlinks inside home that point out of it.
const { fakeHome, outside } = vi.hoisted(() => {
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join: j } = require('node:path') as typeof import('node:path')
  return { fakeHome: mk(j(tmpdir(), 'noxed-home-')), outside: mk(j(tmpdir(), 'noxed-outside-')) }
})
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => fakeHome }))

import { isAllowedKeyPath, isInsideHome, isWithin } from '../security'

beforeAll(() => {
  mkdirSync(join(fakeHome, '.ssh'))
  writeFileSync(join(fakeHome, '.ssh', 'id_ed25519'), 'KEY')
  writeFileSync(join(outside, 'secret'), 'SECRET')
  symlinkSync(join(outside, 'secret'), join(fakeHome, '.ssh', 'sneaky'))
  symlinkSync(outside, join(fakeHome, 'linked-dir'))
  mkdirSync(join(fakeHome, 'data'))
  writeFileSync(join(fakeHome, 'data', 'app.sqlite'), '')
  symlinkSync(join(fakeHome, 'data'), join(fakeHome, 'data-link'))
})

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('isWithin', () => {
  it('accepts the directory itself and anything below it', () => {
    expect(isWithin('/home/me', '/home/me')).toBe(true)
    expect(isWithin('/home/me/a/b', '/home/me')).toBe(true)
  })

  it('rejects siblings that merely share a prefix, parents and other trees', () => {
    expect(isWithin('/home/meow/file', '/home/me')).toBe(false)
    expect(isWithin('/home', '/home/me')).toBe(false)
    expect(isWithin('/etc/passwd', '/home/me')).toBe(false)
  })

  it('accepts children whose names start with two dots', () => {
    expect(isWithin('/home/me/..cache', '/home/me')).toBe(true)
    expect(isWithin('/home/me/..', '/home/me')).toBe(false)
  })
})

describe('symlinks cannot escape allowed folders', () => {
  it('allows a real key file in ~/.ssh', () => {
    expect(isAllowedKeyPath(join(fakeHome, '.ssh', 'id_ed25519')).ok).toBe(true)
  })

  it('refuses a ~/.ssh entry that links outside it', () => {
    expect(isAllowedKeyPath(join(fakeHome, '.ssh', 'sneaky'))).toEqual({
      ok: false,
      reason: 'Access denied: key path must be inside an allowed directory',
    })
  })

  it('refuses home paths that resolve outside home, but allows new files inside it', () => {
    expect(isInsideHome(join(fakeHome, 'linked-dir', 'secret')).ok).toBe(false)
    expect(isInsideHome(join(fakeHome, 'not-created-yet.txt')).ok).toBe(true)
    expect(isInsideHome(join(outside, 'secret')).ok).toBe(false)
  })

  it('reports where an allowed path really lives, for opening without a re-check', () => {
    const check = isInsideHome(join(fakeHome, 'data-link', 'app.sqlite'))
    expect(check).toMatchObject({ ok: true, real: realpathSync(join(fakeHome, 'data', 'app.sqlite')) })
  })
})

