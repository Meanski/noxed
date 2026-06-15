import { ipcMain, systemPreferences, BrowserWindow } from 'electron'
import Store from 'electron-store'
import keytar from 'keytar'
import { pbkdf2Sync, randomBytes } from 'crypto'

export type AuthMode = 'none' | 'pin' | 'password' | 'biometrics'

interface AuthConfig {
  mode: AuthMode
  hash?: string
  salt?: string
}

const authStore = new Store<{ auth: AuthConfig }>({
  name: 'auth',
  defaults: { auth: { mode: 'none' } },
})

const KEYCHAIN_SERVICE = 'noxed'
let _unlocked = false

// Brute-force protection
const MAX_ATTEMPTS_BEFORE_LOCKOUT = 5
const LOCKOUT_ESCALATION = [30_000, 60_000, 300_000] // 30s, 60s, 5min
let _failedAttempts = 0
let _lockedUntil = 0

export function getAuthRateLimitState() {
  return { failedAttempts: _failedAttempts, lockedUntil: _lockedUntil }
}

function checkRateLimit(): string | null {
  const now = Date.now()
  if (_lockedUntil > now) {
    const secsLeft = Math.ceil((_lockedUntil - now) / 1000)
    return `Too many failed attempts. Try again in ${secsLeft}s`
  }
  return null
}

function recordFailedAttempt(): void {
  _failedAttempts++
  if (_failedAttempts >= MAX_ATTEMPTS_BEFORE_LOCKOUT) {
    const tier = Math.min(_failedAttempts - MAX_ATTEMPTS_BEFORE_LOCKOUT, LOCKOUT_ESCALATION.length - 1)
    _lockedUntil = Date.now() + LOCKOUT_ESCALATION[tier]
  }
}

function resetAttempts(): void {
  _failedAttempts = 0
  _lockedUntil = 0
}

export const isUnlocked = (): boolean => _unlocked

let _autoLockTimer: ReturnType<typeof setTimeout> | null = null

function parseTimeoutMs(setting: string): number {
  if (setting === 'Never') return 0
  if (setting === '5 minutes') return 5 * 60_000
  if (setting === '15 minutes') return 15 * 60_000
  if (setting === '30 minutes') return 30 * 60_000
  if (setting === '1 hour') return 60 * 60_000
  return 15 * 60_000
}

function startAutoLock(): void {
  clearAutoLock()
  let timeoutMs: number
  try {
    const ElectronStore = Store as any
    const settingsStore = new ElectronStore({ name: 'settings' })
    const settings = settingsStore.get('settings') as Record<string, unknown> | undefined
    timeoutMs = parseTimeoutMs((settings?.autoLockTimeout as string) ?? '15 minutes')
  } catch {
    timeoutMs = 15 * 60_000
  }
  if (timeoutMs <= 0) return
  _autoLockTimer = setTimeout(() => {
    _unlocked = false
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('auth:locked')
    }
  }, timeoutMs)
}

function clearAutoLock(): void {
  if (_autoLockTimer) { clearTimeout(_autoLockTimer); _autoLockTimer = null }
}

export function resetAutoLockTimer(): void {
  if (_unlocked) startAutoLock()
}

// ── Keychain helpers (used by sessions.ts) ────────────────────────────────

export async function saveCredential(sessionId: string, field: 'password', value: string): Promise<void> {
  await keytar.setPassword(KEYCHAIN_SERVICE, `${sessionId}:${field}`, value)
}

export async function getCredential(sessionId: string, field: 'password'): Promise<string | null> {
  if (!_unlocked) throw new Error('App is locked')
  return keytar.getPassword(KEYCHAIN_SERVICE, `${sessionId}:${field}`)
}

export async function deleteCredentials(sessionId: string): Promise<void> {
  try {
    await keytar.deletePassword(KEYCHAIN_SERVICE, `${sessionId}:password`)
  } catch (err) {
    // Best-effort delete: an absent entry returns false, but on locked keychain
    // or revoked permissions keytar throws. Either way we still want the caller
    // to remove the session from electron-store, so we log and continue.
    console.error(`[keychain] delete credential ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────

export function canUseTouchID(): boolean {
  try {
    return process.platform === 'darwin' && systemPreferences.canPromptTouchID()
  } catch {
    return false
  }
}

function hashCredential(credential: string, salt: string): string {
  return pbkdf2Sync(credential, salt, 100_000, 32, 'sha256').toString('hex')
}

// Verify the current credential without changing lock state
async function verifyCurrentAuth(
  credential?: string,
  reason = 'to authenticate'
): Promise<{ success: boolean; error?: string }> {
  const config = authStore.get('auth')

  switch (config.mode) {
    case 'none':
      return { success: true }

    case 'biometrics':
      if (!canUseTouchID()) {
        return { success: false, error: 'Touch ID is not available on this device' }
      }
      try {
        await systemPreferences.promptTouchID(reason)
        return { success: true }
      } catch {
        return { success: false, error: 'Touch ID failed — please try again' }
      }

    case 'pin':
    case 'password': {
      if (!credential) return { success: false, error: 'Credential required' }
      if (!config.hash || !config.salt) return { success: false, error: 'Auth not configured' }
      const hash = hashCredential(credential, config.salt)
      return hash === config.hash
        ? { success: true }
        : { success: false, error: config.mode === 'pin' ? 'Incorrect PIN' : 'Incorrect password' }
    }

    default:
      return { success: true }
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────

export function registerKeychainHandlers(): void {
  ipcMain.handle('auth:getMode', () => authStore.get('auth').mode)

  ipcMain.handle('auth:isAvailable', () => canUseTouchID())

  ipcMain.handle('auth:isUnlocked', () => _unlocked)

  ipcMain.handle('auth:unlock', async (_e, credential?: string) => {
    const rateLimitError = checkRateLimit()
    if (rateLimitError) return { success: false, error: rateLimitError }

    const result = await verifyCurrentAuth(credential, 'to unlock noxed')
    if (result.success) {
      _unlocked = true
      resetAttempts()
      startAutoLock()
    } else {
      const config = authStore.get('auth')
      if (config.mode !== 'none' && config.mode !== 'biometrics') {
        recordFailedAttempt()
      }
    }
    return result
  })

  ipcMain.handle('auth:lock', () => {
    _unlocked = false
    clearAutoLock()
  })

  // Change auth mode — requires verifying current credential first
  ipcMain.handle('auth:setup', async (
    _e,
    newMode: AuthMode,
    newCredential?: string,
    currentCredential?: string
  ) => {
    const current = authStore.get('auth')

    // Must verify current auth before allowing any change
    if (current.mode !== 'none') {
      const verify = await verifyCurrentAuth(currentCredential, 'to change noxed authentication')
      if (!verify.success) return { success: false, error: verify.error }
    }

    // Store new config
    if (newMode === 'none' || newMode === 'biometrics') {
      authStore.set('auth', { mode: newMode })
    } else {
      if (!newCredential) return { success: false, error: 'A credential is required for this mode' }
      const salt = randomBytes(16).toString('hex')
      const hash = hashCredential(newCredential, salt)
      authStore.set('auth', { mode: newMode, hash, salt })
    }

    return { success: true }
  })
}
