import type { Session } from '../store'
import { resolveSshCredentials } from './sshCredentials'

/**
 * Opens an SFTP channel for a session. When a live SSH stream id is provided,
 * the channel piggybacks on that connection — no second handshake and no
 * credential lookup. Otherwise credentials come from resolveSshCredentials; a
 * missing password is not fatal because main falls back to the SSH agent and
 * default keys.
 */
export async function connectSftp(session: Session, streamId?: string): Promise<string> {
  const { password, privateKey } = streamId ? {} : await resolveSshCredentials(session)
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
