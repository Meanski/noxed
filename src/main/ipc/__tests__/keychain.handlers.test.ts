import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ipc, storeData, mockState } = vi.hoisted(() => ({
  ipc: { handlers: new Map<string, (...args: unknown[]) => unknown>() },
  storeData: new Map<string, Map<string, unknown>>(),
  mockState: { throwOnSettingsStore: false },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, fn)
    }),
    on: vi.fn(),
  },
  systemPreferences: {
    canPromptTouchID: vi.fn(() => false),
    promptTouchID: vi.fn(async () => {}),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}))

vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Map<string, unknown>

    constructor(opts?: { name?: string; defaults?: Record<string, unknown> }) {
      const name = opts?.name ?? 'config'
      if (mockState.throwOnSettingsStore && name === 'settings') {
        throw new Error('settings store unavailable')
      }
      let data = storeData.get(name)
      if (!data) {
        data = new Map()
        storeData.set(name, data)
      }
      this.data = data
      for (const [key, value] of Object.entries(opts?.defaults ?? {})) {
        if (!this.data.has(key)) this.data.set(key, value)
      }
    }

    get(key: string) { return this.data.get(key) }
    set(key: string, value: unknown) { this.data.set(key, value) }
  },
}))

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(async () => {}),
    getPassword: vi.fn(async () => null),
    deletePassword: vi.fn(async () => true),
  },
}))

import { systemPreferences, BrowserWindow } from 'electron'
import keytar from 'keytar'
import {
  registerKeychainHandlers,
  saveCredential,
  getCredential,
  deleteCredentials,
  isUnlocked,
  canUseTouchID,
  getAuthRateLimitState,
  resetAutoLockTimer,
  type AuthMode,
} from '../keychain'

registerKeychainHandlers()

function dataFor(name: string): Map<string, unknown> {
  let data = storeData.get(name)
  if (!data) {
    data = new Map()
    storeData.set(name, data)
  }
  return data
}

function makeEvent() {
  return { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } }
}

function handler(channel: string) {
  const fn = ipc.handlers.get(channel)
  if (!fn) throw new Error(`${channel} handler not registered`)
  return fn
}

interface AuthResult {
  success: boolean
  error?: string
}

function unlock(credential?: string): Promise<AuthResult> {
  return handler('auth:unlock')(makeEvent(), credential) as Promise<AuthResult>
}

function lock(): void {
  handler('auth:lock')(makeEvent())
}

function setup(mode: AuthMode | string, newCredential?: string, currentCredential?: string): Promise<AuthResult> {
  return handler('auth:setup')(makeEvent(), mode, newCredential, currentCredential) as Promise<AuthResult>
}

function authConfig(): { mode: string; hash?: string; salt?: string } {
  return dataFor('auth').get('auth') as { mode: string; hash?: string; salt?: string }
}

let now = new Date('2026-01-01T00:00:00Z').getTime()

// canUseTouchID() short-circuits on non-darwin platforms before consulting
// systemPreferences, so pin the platform to make these tests pass on Linux CI.
const realPlatform = process.platform

beforeEach(async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  vi.clearAllMocks()
  vi.useFakeTimers()
  // Jump an hour ahead each test so any lockout from a previous test has expired
  now += 60 * 60_000
  vi.setSystemTime(now)
  mockState.throwOnSettingsStore = false
  dataFor('auth').set('auth', { mode: 'none' })
  dataFor('settings').clear()
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
  vi.mocked(systemPreferences.canPromptTouchID).mockReturnValue(false)
  vi.mocked(systemPreferences.promptTouchID).mockResolvedValue(undefined as never)
  vi.mocked(keytar.deletePassword).mockResolvedValue(true)
  // A successful unlock in 'none' mode resets the brute-force counters,
  // then lock() returns the module to a clean locked state
  await unlock()
  lock()
  vi.clearAllMocks()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  vi.useRealTimers()
})

describe('credential helpers', () => {
  it('saveCredential writes to the noxed keychain service', async () => {
    await saveCredential('sess-1', 'password', 'hunter2')
    expect(keytar.setPassword).toHaveBeenCalledWith('noxed', 'sess-1:password', 'hunter2')
  })

  it('getCredential throws while the app is locked', async () => {
    await expect(getCredential('sess-1', 'password')).rejects.toThrow('App is locked')
    expect(keytar.getPassword).not.toHaveBeenCalled()
  })

  it('getCredential reads from keytar once unlocked', async () => {
    await unlock()
    vi.mocked(keytar.getPassword).mockResolvedValue('secret')
    await expect(getCredential('sess-1', 'password')).resolves.toBe('secret')
    expect(keytar.getPassword).toHaveBeenCalledWith('noxed', 'sess-1:password')
  })

  it('deleteCredentials removes the password entry', async () => {
    await deleteCredentials('sess-1')
    expect(keytar.deletePassword).toHaveBeenCalledWith('noxed', 'sess-1:password')
  })

  it('deleteCredentials logs and continues when keytar throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(keytar.deletePassword).mockRejectedValue(new Error('keychain revoked'))
    await expect(deleteCredentials('sess-1')).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('keychain revoked'))
  })
})

describe('canUseTouchID and auth:isAvailable', () => {
  it('reflects systemPreferences availability', () => {
    vi.mocked(systemPreferences.canPromptTouchID).mockReturnValue(true)
    expect(canUseTouchID()).toBe(true)
    expect(handler('auth:isAvailable')(makeEvent())).toBe(true)

    vi.mocked(systemPreferences.canPromptTouchID).mockReturnValue(false)
    expect(canUseTouchID()).toBe(false)
    expect(handler('auth:isAvailable')(makeEvent())).toBe(false)
  })

  it('returns false when the platform check throws', () => {
    vi.mocked(systemPreferences.canPromptTouchID).mockImplementation(() => {
      throw new Error('not supported')
    })
    expect(canUseTouchID()).toBe(false)
  })
})

describe('auth:getMode and auth:isUnlocked', () => {
  it('reports the configured mode', async () => {
    expect(handler('auth:getMode')(makeEvent())).toBe('none')
    await setup('pin', '1234')
    expect(handler('auth:getMode')(makeEvent())).toBe('pin')
  })

  it('tracks the lock state across unlock and lock', async () => {
    expect(handler('auth:isUnlocked')(makeEvent())).toBe(false)
    expect(isUnlocked()).toBe(false)
    await expect(unlock()).resolves.toEqual({ success: true })
    expect(handler('auth:isUnlocked')(makeEvent())).toBe(true)
    lock()
    expect(isUnlocked()).toBe(false)
  })
})

describe('auth:unlock — biometrics', () => {
  beforeEach(async () => {
    await setup('biometrics')
  })

  it('fails when Touch ID is unavailable', async () => {
    vi.mocked(systemPreferences.canPromptTouchID).mockReturnValue(false)
    await expect(unlock()).resolves.toEqual({
      success: false,
      error: 'Touch ID is not available on this device',
    })
    expect(isUnlocked()).toBe(false)
  })

  it('unlocks when the Touch ID prompt succeeds', async () => {
    vi.mocked(systemPreferences.canPromptTouchID).mockReturnValue(true)
    await expect(unlock()).resolves.toEqual({ success: true })
    expect(systemPreferences.promptTouchID).toHaveBeenCalledWith('to unlock noxed')
    expect(isUnlocked()).toBe(true)
  })

  it('maps a rejected prompt to a friendly error without counting a failed attempt', async () => {
    vi.mocked(systemPreferences.canPromptTouchID).mockReturnValue(true)
    vi.mocked(systemPreferences.promptTouchID).mockRejectedValue(new Error('user canceled'))
    await expect(unlock()).resolves.toEqual({
      success: false,
      error: 'Touch ID failed — please try again',
    })
    expect(getAuthRateLimitState().failedAttempts).toBe(0)
  })
})

describe('auth:unlock — pin and password', () => {
  it('requires a credential', async () => {
    await setup('pin', '1234')
    await expect(unlock()).resolves.toEqual({ success: false, error: 'Credential required' })
    expect(isUnlocked()).toBe(false)
    expect(getAuthRateLimitState().failedAttempts).toBe(1)
  })

  it('rejects a wrong PIN and records the failure', async () => {
    await setup('pin', '1234')
    await expect(unlock('9999')).resolves.toEqual({ success: false, error: 'Incorrect PIN' })
    expect(isUnlocked()).toBe(false)
    expect(getAuthRateLimitState().failedAttempts).toBe(1)
  })

  it('rejects a wrong password with a password-specific message', async () => {
    await setup('password', 'correct horse')
    await expect(unlock('wrong horse')).resolves.toEqual({ success: false, error: 'Incorrect password' })
  })

  it('unlocks with the correct PIN and resets the failure counter', async () => {
    await setup('pin', '1234')
    await unlock('9999')
    await expect(unlock('1234')).resolves.toEqual({ success: true })
    expect(isUnlocked()).toBe(true)
    expect(getAuthRateLimitState()).toEqual({ failedAttempts: 0, lockedUntil: 0 })
  })

  it('fails when the stored config is missing its hash or salt', async () => {
    dataFor('auth').set('auth', { mode: 'pin' })
    await expect(unlock('1234')).resolves.toEqual({ success: false, error: 'Auth not configured' })
  })

  it('treats an unrecognized mode as unlocked (default branch)', async () => {
    dataFor('auth').set('auth', { mode: 'retina-scan' })
    await expect(unlock()).resolves.toEqual({ success: true })
    expect(isUnlocked()).toBe(true)
  })
})

describe('auth:unlock — brute-force lockout', () => {
  async function failTimes(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await unlock('wrong')
  }

  beforeEach(async () => {
    await setup('pin', '1234')
  })

  it('locks out after five failed attempts, even for the correct PIN', async () => {
    await failTimes(5)
    expect(getAuthRateLimitState().lockedUntil).toBe(Date.now() + 30_000)
    await expect(unlock('1234')).resolves.toEqual({
      success: false,
      error: 'Too many failed attempts. Try again in 30s',
    })
    expect(isUnlocked()).toBe(false)
  })

  it('counts down the remaining lockout seconds', async () => {
    await failTimes(5)
    vi.advanceTimersByTime(12_000)
    const result = await unlock('1234')
    expect(result.error).toBe('Too many failed attempts. Try again in 18s')
  })

  it('allows the correct PIN again once the lockout expires', async () => {
    await failTimes(5)
    vi.advanceTimersByTime(30_001)
    await expect(unlock('1234')).resolves.toEqual({ success: true })
    expect(getAuthRateLimitState()).toEqual({ failedAttempts: 0, lockedUntil: 0 })
  })

  it('escalates the lockout duration on repeated failures and caps at five minutes', async () => {
    await failTimes(5)
    expect(getAuthRateLimitState().lockedUntil - Date.now()).toBe(30_000)

    vi.advanceTimersByTime(30_001)
    await failTimes(1) // 6th failure -> 60s tier
    expect(getAuthRateLimitState().lockedUntil - Date.now()).toBe(60_000)

    vi.advanceTimersByTime(60_001)
    await failTimes(1) // 7th failure -> 5min tier
    expect(getAuthRateLimitState().lockedUntil - Date.now()).toBe(300_000)

    vi.advanceTimersByTime(300_001)
    await failTimes(1) // 8th failure -> still capped at 5min
    expect(getAuthRateLimitState().lockedUntil - Date.now()).toBe(300_000)
  })
})

describe('auto-lock', () => {
  function fakeWindow() {
    return { webContents: { send: vi.fn() } }
  }

  it('locks after the default 15 minutes and notifies every window', async () => {
    const win = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([win] as never)
    await unlock()

    vi.advanceTimersByTime(15 * 60_000 - 1)
    expect(isUnlocked()).toBe(true)

    vi.advanceTimersByTime(1)
    expect(isUnlocked()).toBe(false)
    expect(win.webContents.send).toHaveBeenCalledWith('auth:locked')
  })

  it.each([
    ['5 minutes', 5],
    ['15 minutes', 15],
    ['30 minutes', 30],
    ['1 hour', 60],
  ])('honors the %s auto-lock setting', async (setting, minutes) => {
    dataFor('settings').set('settings', { autoLockTimeout: setting })
    await unlock()
    vi.advanceTimersByTime(minutes * 60_000 - 1)
    expect(isUnlocked()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(isUnlocked()).toBe(false)
  })

  it('never locks when the timeout is set to Never', async () => {
    dataFor('settings').set('settings', { autoLockTimeout: 'Never' })
    await unlock()
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(isUnlocked()).toBe(true)
  })

  it('falls back to 15 minutes for an unrecognized setting', async () => {
    dataFor('settings').set('settings', { autoLockTimeout: '2 fortnights' })
    await unlock()
    vi.advanceTimersByTime(15 * 60_000)
    expect(isUnlocked()).toBe(false)
  })

  it('falls back to 15 minutes when the settings store is unavailable', async () => {
    mockState.throwOnSettingsStore = true
    await unlock()
    vi.advanceTimersByTime(15 * 60_000)
    expect(isUnlocked()).toBe(false)
  })

  it('resetAutoLockTimer restarts the countdown while unlocked', async () => {
    await unlock()
    vi.advanceTimersByTime(10 * 60_000)
    resetAutoLockTimer()
    vi.advanceTimersByTime(10 * 60_000)
    expect(isUnlocked()).toBe(true) // only 10 of the fresh 15 minutes have elapsed
    vi.advanceTimersByTime(5 * 60_000)
    expect(isUnlocked()).toBe(false)
  })

  it('resetAutoLockTimer does nothing while locked', async () => {
    resetAutoLockTimer()
    vi.advanceTimersByTime(60 * 60_000)
    expect(isUnlocked()).toBe(false)
    expect(BrowserWindow.getAllWindows).not.toHaveBeenCalled()
  })

  it('locking manually cancels the pending auto-lock timer', async () => {
    const win = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([win] as never)
    await unlock()
    lock()
    vi.advanceTimersByTime(60 * 60_000)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})

describe('auth:setup', () => {
  it('sets up a PIN from scratch, storing a salted hash instead of the credential', async () => {
    await expect(setup('pin', '1234')).resolves.toEqual({ success: true })
    const config = authConfig()
    expect(config.mode).toBe('pin')
    expect(config.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(config.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(config)).not.toContain('1234')
  })

  it('requires a credential for pin and password modes', async () => {
    await expect(setup('pin')).resolves.toEqual({
      success: false,
      error: 'A credential is required for this mode',
    })
    expect(authConfig().mode).toBe('none')
  })

  it('refuses to change modes without the current credential', async () => {
    await setup('pin', '1234')
    await expect(setup('none')).resolves.toEqual({ success: false, error: 'Credential required' })
    await expect(setup('none', undefined, '9999')).resolves.toEqual({ success: false, error: 'Incorrect PIN' })
    expect(authConfig().mode).toBe('pin')
  })

  it('changes from pin to password after verifying the current PIN', async () => {
    await setup('pin', '1234')
    await expect(setup('password', 'long passphrase', '1234')).resolves.toEqual({ success: true })
    expect(authConfig().mode).toBe('password')
    await expect(unlock('long passphrase')).resolves.toEqual({ success: true })
  })

  it('disables auth entirely once the current PIN is verified', async () => {
    await setup('pin', '1234')
    await expect(setup('none', undefined, '1234')).resolves.toEqual({ success: true })
    expect(authConfig()).toEqual({ mode: 'none' })
    await expect(unlock()).resolves.toEqual({ success: true })
  })

  it('stores biometrics mode without any hash material', async () => {
    await expect(setup('biometrics')).resolves.toEqual({ success: true })
    expect(authConfig()).toEqual({ mode: 'biometrics' })
  })

  it('verifies via Touch ID when the current mode is biometrics', async () => {
    await setup('biometrics')
    vi.mocked(systemPreferences.canPromptTouchID).mockReturnValue(true)
    vi.mocked(systemPreferences.promptTouchID).mockRejectedValueOnce(new Error('nope'))
    await expect(setup('none')).resolves.toEqual({
      success: false,
      error: 'Touch ID failed — please try again',
    })

    await expect(setup('none')).resolves.toEqual({ success: true })
    expect(systemPreferences.promptTouchID).toHaveBeenCalledWith('to change noxed authentication')
  })
})
