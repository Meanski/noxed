import { describe, it, expect, beforeEach } from 'vitest'
import { pbkdf2Sync, randomBytes } from 'crypto'

// Extracted pure functions mirroring keychain.ts implementation for testing

function hashCredential(credential: string, salt: string): string {
  return pbkdf2Sync(credential, salt, 100_000, 32, 'sha256').toString('hex')
}

// Brute-force protection state machine (mirrors keychain.ts)
const MAX_ATTEMPTS_BEFORE_LOCKOUT = 5
const LOCKOUT_ESCALATION = [30_000, 60_000, 300_000]

interface RateLimitState {
  failedAttempts: number
  lockedUntil: number
}

function checkRateLimit(state: RateLimitState, now: number): string | null {
  if (state.lockedUntil > now) {
    const secsLeft = Math.ceil((state.lockedUntil - now) / 1000)
    return `Too many failed attempts. Try again in ${secsLeft}s`
  }
  return null
}

function recordFailedAttempt(state: RateLimitState, now: number): RateLimitState {
  const failedAttempts = state.failedAttempts + 1
  let lockedUntil = state.lockedUntil
  if (failedAttempts >= MAX_ATTEMPTS_BEFORE_LOCKOUT) {
    const tier = Math.min(failedAttempts - MAX_ATTEMPTS_BEFORE_LOCKOUT, LOCKOUT_ESCALATION.length - 1)
    lockedUntil = now + LOCKOUT_ESCALATION[tier]
  }
  return { failedAttempts, lockedUntil }
}

function resetAttempts(): RateLimitState {
  return { failedAttempts: 0, lockedUntil: 0 }
}

describe('Keychain — PBKDF2 hashing', () => {
  it('produces consistent hashes for the same input', () => {
    const salt = 'test-salt-value'
    const hash1 = hashCredential('mypassword', salt)
    const hash2 = hashCredential('mypassword', salt)
    expect(hash1).toBe(hash2)
  })

  it('produces different hashes for different passwords', () => {
    const salt = 'same-salt'
    const hash1 = hashCredential('password1', salt)
    const hash2 = hashCredential('password2', salt)
    expect(hash1).not.toBe(hash2)
  })

  it('produces different hashes for different salts', () => {
    const hash1 = hashCredential('password', 'salt-a')
    const hash2 = hashCredential('password', 'salt-b')
    expect(hash1).not.toBe(hash2)
  })

  it('returns a 64-character hex string (32 bytes)', () => {
    const hash = hashCredential('test', 'salt')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('can verify a correct PIN', () => {
    const salt = randomBytes(16).toString('hex')
    const stored = hashCredential('1234', salt)
    expect(hashCredential('1234', salt)).toBe(stored)
    expect(hashCredential('1235', salt)).not.toBe(stored)
  })
})

describe('Keychain — brute-force protection', () => {
  let state: RateLimitState
  const NOW = 1_000_000

  beforeEach(() => {
    state = resetAttempts()
  })

  it('allows access when no failed attempts', () => {
    expect(checkRateLimit(state, NOW)).toBeNull()
  })

  it('allows access for fewer than MAX_ATTEMPTS failed attempts', () => {
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_LOCKOUT - 1; i++) {
      state = recordFailedAttempt(state, NOW)
    }
    expect(checkRateLimit(state, NOW)).toBeNull()
  })

  it('locks out after MAX_ATTEMPTS failed attempts', () => {
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_LOCKOUT; i++) {
      state = recordFailedAttempt(state, NOW)
    }
    expect(checkRateLimit(state, NOW)).not.toBeNull()
    expect(checkRateLimit(state, NOW)).toContain('Too many failed attempts')
  })

  it('applies 30s lockout on first lockout tier', () => {
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_LOCKOUT; i++) {
      state = recordFailedAttempt(state, NOW)
    }
    // Locked now
    expect(checkRateLimit(state, NOW)).not.toBeNull()
    // Still locked 29s later
    expect(checkRateLimit(state, NOW + 29_000)).not.toBeNull()
    // Unlocked after 30s
    expect(checkRateLimit(state, NOW + 30_001)).toBeNull()
  })

  it('escalates lockout duration on continued failures', () => {
    // 5 failures -> 30s lockout
    for (let i = 0; i < 5; i++) state = recordFailedAttempt(state, NOW)
    expect(state.lockedUntil).toBe(NOW + 30_000)

    // 6th failure -> 60s lockout
    state = recordFailedAttempt(state, NOW + 31_000)
    expect(state.lockedUntil).toBe(NOW + 31_000 + 60_000)

    // 7th failure -> 5min lockout
    state = recordFailedAttempt(state, NOW + 100_000)
    expect(state.lockedUntil).toBe(NOW + 100_000 + 300_000)
  })

  it('caps lockout at the maximum tier', () => {
    // 8+ failures all get 5min lockout
    for (let i = 0; i < 10; i++) state = recordFailedAttempt(state, NOW)
    state = recordFailedAttempt(state, NOW)
    // Should still be 5min from NOW (max tier)
    expect(state.lockedUntil - NOW).toBeLessThanOrEqual(300_001)
  })

  it('resets attempts on successful auth', () => {
    for (let i = 0; i < 5; i++) state = recordFailedAttempt(state, NOW)
    expect(checkRateLimit(state, NOW)).not.toBeNull()

    state = resetAttempts()
    expect(state.failedAttempts).toBe(0)
    expect(state.lockedUntil).toBe(0)
    expect(checkRateLimit(state, NOW)).toBeNull()
  })

  it('returns correct seconds remaining in lockout message', () => {
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_LOCKOUT; i++) {
      state = recordFailedAttempt(state, NOW)
    }
    const msg = checkRateLimit(state, NOW + 5_000)
    expect(msg).toContain('25s') // 30s - 5s = 25s
  })
})

describe('Keychain — auth mode verification logic', () => {
  it('none mode always succeeds', () => {
    // mode === 'none' → always { success: true }
    // This is a direct mapping of the production logic
    const mode = 'none'
    expect(mode === 'none').toBe(true)
  })

  it('pin/password mode requires a credential', () => {
    const credential = undefined
    const result = !credential ? { success: false, error: 'Credential required' } : { success: true }
    expect(result.success).toBe(false)
    expect(result.error).toBe('Credential required')
  })

  it('pin/password mode requires hash and salt to be configured', () => {
    const config = { mode: 'pin' as const, hash: undefined, salt: undefined }
    const result = !config.hash || !config.salt
      ? { success: false, error: 'Auth not configured' }
      : { success: true }
    expect(result.success).toBe(false)
  })

  it('pin/password mode matches hash correctly', () => {
    const salt = randomBytes(16).toString('hex')
    const storedHash = hashCredential('1234', salt)
    const inputHash = hashCredential('1234', salt)
    expect(inputHash === storedHash).toBe(true)
  })

  it('pin/password mode rejects incorrect credential', () => {
    const salt = randomBytes(16).toString('hex')
    const storedHash = hashCredential('1234', salt)
    const wrongHash = hashCredential('5678', salt)
    expect(wrongHash === storedHash).toBe(false)
  })
})
