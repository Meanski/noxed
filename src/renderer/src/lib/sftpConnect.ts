import { Session } from '../store'

/**
 * Opens an SFTP channel for a session. When a live SSH stream id is provided,
 * the channel piggybacks on that connection — no second handshake and no
 * credential lookup. Otherwise credentials are gathered per the session's auth
 * type; a missing password is not fatal because the main process also offers
 * agent auth (SSH_AUTH_SOCK).
 */
export async function connectSftp(session: Session, streamId?: string): Promise<string> {
  let password: string | undefined
  let privateKey: string | undefined

  if (!streamId) {
    if (session.authType === 'key') {
      if (!session.keyPath) throw new Error('Key authentication selected but no key file path is configured')
      privateKey = await window.api.fs.readFile(session.keyPath).catch(() => undefined)
      if (!privateKey) throw new Error(`Cannot read private key: ${session.keyPath}`)
    } else {
      const creds = await window.api.sessions.getCredentials(session.id).catch((err: any) => {
        if (err?.message?.includes('locked')) throw new Error('App is locked — unlock noxed to reconnect')
        return null
      })
      password = creds?.password
    }
  }

  return window.api.sftp.connect({
    host: session.host,
    port: session.port,
    username: session.username,
    password,
    privateKey,
    streamId,
    jumpHostId: session.jumpHostId,
  })
}
