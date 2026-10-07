import { ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { AuthError, ValidationError } from './errors'
import { isUnlocked } from './keychain'
import { isAllowedKeyPath } from './security'

/**
 * Reads a private key for a connection the renderer is about to open. Key
 * material is a secret like a stored password, so it stays behind the lock
 * screen, and only files in the allowlisted key directories can be read.
 */
export function readKeyFile(filePath: unknown): string {
  if (typeof filePath !== 'string') throw new ValidationError('Path is required')
  if (!isUnlocked()) throw new AuthError('App is locked — unlock noxed to use your keys')
  const check = isAllowedKeyPath(filePath)
  if (!check.ok) throw new ValidationError(check.reason)
  return readFileSync(check.resolved, 'utf-8')
}

export function registerKeyFileHandlers(): void {
  ipcMain.handle('fs:readFile', (_e, filePath: unknown) => readKeyFile(filePath))
}
