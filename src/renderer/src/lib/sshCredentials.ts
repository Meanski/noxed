import type { Session } from '../store'
import { ipcErrorMessage } from './format'

// Quick-connect sessions are never saved, so a password typed for one lives
// only in memory for as long as its tabs do (cleared when the last one closes).
const adhocPasswords = new Map<string, string>()

export function setAdhocPassword(sessionId: string, password: string): void {
  adhocPasswords.set(sessionId, password)
}

export function clearAdhocPassword(sessionId: string): void {
  adhocPasswords.delete(sessionId)
}

/** Reads a key file through main, which refuses while noxed is locked. */
export async function readPrivateKey(keyPath: string): Promise<string> {
  const privateKey = await window.api.fs.readFile(keyPath).catch((err: unknown) => {
    if (ipcErrorMessage(err, '').includes('locked')) throw new Error('App is locked — unlock noxed to use your keys')
    return undefined
  })
  if (!privateKey) throw new Error(`Cannot read private key: ${keyPath}`)
  return privateKey
}

export interface SshCredentials {
  password?: string
  privateKey?: string
}

/**
 * Credentials to hand to ssh:connect / sftp:connect for a session. An empty
 * result is valid: main then falls back to the SSH agent and ~/.ssh default
 * keys. `requirePassword` makes a saved password session with nothing in the
 * keychain an error instead (the terminal wants to say so up front).
 */
export async function resolveSshCredentials(session: Session, { requirePassword = false } = {}): Promise<SshCredentials> {
  if (session.authType === 'key') {
    if (!session.keyPath) throw new Error('Key authentication selected but no key file path is configured')
    return { privateKey: await readPrivateKey(session.keyPath) }
  }

  // Main tries the SSH agent, then default keys, when given nothing.
  if (session.authType === 'agent') return {}
  if (session.adhoc) return { password: adhocPasswords.get(session.id) }

  const creds = await window.api.sessions.getCredentials(session.id).catch((err: unknown) => {
    const message = ipcErrorMessage(err, 'Failed to retrieve credentials')
    if (message.includes('locked')) throw new Error('App is locked — unlock noxed to reconnect')
    if (requirePassword) throw new Error(message)
    return null
  })
  const password = creds?.password
  if (requirePassword && password === undefined) {
    throw new Error('No password found for this session — re-enter credentials in Settings')
  }
  return { password }
}
