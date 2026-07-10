import { Client, Algorithms, ClientChannel, ConnectConfig } from 'ssh2'
import { readFileSync } from 'node:fs'
import { getSessionById, Session } from './sessions'
import { getCredential, isUnlocked } from './keychain'
import { isAllowedKeyPath } from './security'
import { getStoredSettings } from './settings'
import { AuthError, ConnectionError, NotFoundError, ValidationError, toMessage } from './errors'

const SSH_ALGORITHMS: Algorithms = {
  kex: [
    'curve25519-sha256@libssh.org',
    'curve25519-sha256',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group15-sha512',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group17-sha512',
    'diffie-hellman-group18-sha512',
    // Older fallbacks — many production servers (especially fail2ban-protected
    // boxes) still negotiate sha1-based key exchange. ssh2 omits these by
    // default, which is the leading cause of mysterious "no matching kex"
    // failures we want to avoid.
    'diffie-hellman-group-exchange-sha1',
    'diffie-hellman-group14-sha1',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-rsa',
  ],
  cipher: [
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
    'aes256-cbc',
    'aes192-cbc',
    'aes128-cbc',
  ],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
    'hmac-sha1',
  ],
}

export const SSH_CONNECT_DEFAULTS = {
  readyTimeout: 30_000,
  keepaliveInterval: 30_000,
  keepaliveCountMax: 4,
  algorithms: SSH_ALGORITHMS,
}

// 0 disables keep-alive pings entirely (ssh2 semantics).
export function parseKeepaliveIntervalMs(setting: unknown): number {
  if (setting === 'Off') return 0
  if (setting === '15 seconds') return 15_000
  if (setting === '60 seconds') return 60_000
  return 30_000
}

export function sshConnectOptions(): typeof SSH_CONNECT_DEFAULTS {
  return {
    ...SSH_CONNECT_DEFAULTS,
    keepaliveInterval: parseKeepaliveIntervalMs(getStoredSettings().sshKeepalive),
  }
}

/**
 * A connected client plus its jump-host chain. Always call dispose() — ending
 * only the leaf client would leak the bastion connections beneath it.
 */
export interface ManagedSshConnection {
  client: Client
  dispose: () => void
}

export interface SshTarget {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  sock?: ClientChannel
}

export function connectRawClient(target: SshTarget): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false

    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      if (!target.password) { finish([]); return }
      finish(prompts.map(() => target.password ?? ''))
    })
    client.on('ready', () => {
      settled = true
      client.setNoDelay(true)
      resolve(client)
    })
    client.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(new ConnectionError(toMessage(err)))
      }
    })

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
      sock: target.sock,
      agent: process.env.SSH_AUTH_SOCK,
      tryKeyboard: true,
      ...sshConnectOptions(),
      algorithms: { ...SSH_ALGORITHMS },
    }
    client.connect(config)
  })
}

/** Opens a TCP channel through `via` to the destination, for ProxyJump-style chaining. */
export function openJumpSocket(via: Client, destHost: string, destPort: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    via.forwardOut('127.0.0.1', 0, destHost, destPort, (err, stream) => {
      if (err) reject(new ConnectionError(`Jump host could not reach ${destHost}:${destPort}: ${toMessage(err)}`))
      else resolve(stream)
    })
  })
}

const MAX_JUMP_DEPTH = 3

export async function credentialsForSession(session: Session): Promise<{ password?: string; privateKey?: string }> {
  if (session.authType === 'key') {
    if (!session.keyPath) {
      throw new ValidationError(`${session.label || session.host}: key authentication selected but no key file configured`)
    }
    const check = isAllowedKeyPath(session.keyPath)
    if (!check.ok) throw new ValidationError(check.reason)
    return { privateKey: readFileSync(check.resolved, 'utf-8') }
  }

  if (!isUnlocked()) throw new AuthError('App is locked — unlock noxed to access credentials')
  const password = await getCredential(session.id, 'password')
  if (password == null) {
    throw new AuthError(`No password stored for ${session.label || session.host}`)
  }
  return { password }
}

/**
 * Connects an SSH client for a saved session entirely in the main process:
 * credentials come from the OS keychain or allowlisted key files, and
 * jump-host chains are resolved recursively.
 */
export async function connectSessionClient(sessionId: string, depth = 0): Promise<ManagedSshConnection> {
  const session = getSessionById(sessionId)
  if (!session) throw new NotFoundError(`Connection ${sessionId}`)
  if (!session.host || !session.username) {
    throw new ValidationError(`${session.label || sessionId} is missing a host or username`)
  }

  let upstream: ManagedSshConnection | null = null
  let sock: ClientChannel | undefined

  if (session.jumpHostId) {
    if (depth >= MAX_JUMP_DEPTH) {
      throw new ConnectionError(`Jump host chain deeper than ${MAX_JUMP_DEPTH} hops`)
    }
    upstream = await connectSessionClient(session.jumpHostId, depth + 1)
    try {
      sock = await openJumpSocket(upstream.client, session.host, session.port)
    } catch (err) {
      upstream.dispose()
      throw err
    }
  }

  let client: Client
  try {
    const creds = await credentialsForSession(session)
    client = await connectRawClient({
      host: session.host,
      port: session.port,
      username: session.username,
      ...creds,
      sock,
    })
  } catch (err) {
    upstream?.dispose()
    throw err
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try { client.end() } catch (err) { console.error(`[ssh] end client for ${sessionId}: ${toMessage(err)}`) }
    upstream?.dispose()
  }
  client.on('close', dispose)

  return { client, dispose }
}
