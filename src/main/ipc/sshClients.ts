import { Client, Algorithms, ClientChannel, ConnectConfig, OpenSSHAgent, utils, type BaseAgent, type GetStreamCallback, type IdentityCallback, type ParsedKey, type SignCallback, type SigningRequestOptions } from 'ssh2'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSessionById, Session } from './sessions'
import { getCredential, isUnlocked } from './keychain'
import { isAllowedKeyPath } from './security'
import { getStoredSettings } from './settings'
import { AuthError, ConnectionError, NotFoundError, ValidationError, toMessage } from './errors'
import { describeSshError, SSH_HANDSHAKE_TIMEOUT_MS, verifiedHandshake } from './hostKeys'

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
  readyTimeout: SSH_HANDSHAKE_TIMEOUT_MS,
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
  agentForward?: boolean
}

/** A keyboard-interactive listener that answers every prompt with the password (or gives up without one). */
export function answerPromptsWith(password: string | undefined) {
  return (_name: string, _instructions: string, _lang: string, prompts: unknown[], finish: (answers: string[]) => void): void => {
    finish(password ? prompts.map(() => password) : [])
  }
}

export function connectRawClient(target: SshTarget): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false

    client.on('keyboard-interactive', answerPromptsWith(target.password))
    client.on('ready', () => {
      settled = true
      client.setNoDelay(true)
      resolve(client)
    })
    client.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(new ConnectionError(describeSshError(err)))
      }
    })

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
      sock: target.sock,
      agent: localAgent(),
      ...agentForwardOptions(target.agentForward),
      tryKeyboard: true,
      authHandler: target.password || target.privateKey ? undefined : defaultAuthMethods(target.username),
      ...sshConnectOptions(),
      ...verifiedHandshake(client, target.host, target.port),
      algorithms: { ...SSH_ALGORITHMS },
    }
    client.connect(config)
  })
}

export interface ExecResult {
  stdout: string
  stderr: string
  /** Null when the server reported no exit status (e.g. killed by a signal). */
  code: number | null
  /** True when output beyond `maxBytes` was dropped. */
  truncated: boolean
}

/**
 * Runs one command on a connected client and collects its output, keeping at
 * most `maxBytes` of each stream and giving up after `timeoutMs`.
 */
export function execCapture(client: Client, command: string, { timeoutMs, maxBytes }: { timeoutMs: number; maxBytes: number }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(new ConnectionError(toMessage(err)))
      const out = { stdout: '', stderr: '', truncated: false }
      const collect = (key: 'stdout' | 'stderr') => (d: Buffer) => {
        if (out[key].length < maxBytes) out[key] += d.toString('utf8')
        else out.truncated = true
      }
      const timer = setTimeout(() => {
        stream.close()
        reject(new ConnectionError('Remote command timed out'))
      }, timeoutMs)
      stream.on('data', collect('stdout'))
      stream.stderr.on('data', collect('stderr'))
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolve({ ...out, code: code ?? null })
      })
      stream.on('error', (e: unknown) => {
        clearTimeout(timer)
        reject(new ConnectionError(toMessage(e)))
      })
    })
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

// Windows' built-in OpenSSH agent listens on this pipe and doesn't set
// SSH_AUTH_SOCK; ssh2 speaks to it the same way as a Unix socket.
const WINDOWS_OPENSSH_AGENT_PIPE = String.raw`\\.\pipe\openssh-ssh-agent`

/**
 * The local SSH agent to authenticate (and optionally forward) with, if any.
 * The agent signs with the user's keys, so like them it's off-limits while
 * noxed is locked.
 */
export function localAgentPath(): string | undefined {
  if (!isUnlocked()) return undefined
  return process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? WINDOWS_OPENSSH_AGENT_PIPE : undefined)
}

const lockedAgentError = () => new AuthError('noxed is locked, so your SSH agent is unavailable')

/**
 * The local agent, checking the lock on every use rather than only at connect
 * time: locking hides noxed without closing its connections, and a server
 * holding a forwarded agent must not keep signing with it.
 */
class LockAwareAgent extends OpenSSHAgent {
  getIdentities(cb: IdentityCallback<ParsedKey>): void {
    if (!isUnlocked()) return cb(lockedAgentError())
    super.getIdentities(cb)
  }

  sign(pubKey: ParsedKey | Buffer | string, data: Buffer, options?: SigningRequestOptions | SignCallback, cb?: SignCallback): boolean {
    const done = typeof options === 'function' ? options : cb
    if (!isUnlocked()) {
      done?.(lockedAgentError())
      return false
    }
    return typeof options === 'function' ? super.sign(pubKey, data, options) : super.sign(pubKey, data, options ?? {}, cb)
  }

  // Each agent connection the server opens over a forwarded channel.
  getStream(cb: GetStreamCallback): void {
    if (!isUnlocked()) return cb(lockedAgentError())
    super.getStream(cb)
  }
}

/** The local agent for ssh2's `agent` option, or undefined when there's none (or noxed is locked). */
export function localAgent(): BaseAgent | undefined {
  const path = localAgentPath()
  return path ? new LockAwareAgent(path) : undefined
}

/**
 * ssh2 options for agent forwarding. Off unless the connection opted in, and
 * only when a local agent exists (ssh2 refuses agentForward without one).
 */
export function agentForwardOptions(enabled: boolean | undefined): Pick<ConnectConfig, 'agentForward'> {
  return { agentForward: enabled === true && localAgentPath() !== undefined }
}

// OpenSSH's default identities, in the order `ssh` tries them. Its security-key
// (*_sk) defaults need a hardware-token prompt noxed can't drive; an agent
// holding them still offers them first.
const DEFAULT_IDENTITY_FILES = ['id_rsa', 'id_ecdsa', 'id_ed25519']
const MAX_IDENTITY_BYTES = 64 * 1024

function readDefaultIdentities(): string[] {
  const keys: string[] = []
  for (const name of DEFAULT_IDENTITY_FILES) {
    const path = join(homedir(), '.ssh', name)
    try {
      if (statSync(path).size > MAX_IDENTITY_BYTES) continue
      const contents = readFileSync(path, 'utf-8')
      // Passphrase-protected keys can't be used without prompting; skip them
      // rather than failing the whole connection (the agent may hold them).
      if (!(utils.parseKey(contents) instanceof Error)) keys.push(contents)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[ssh] could not read default identity ${path}: ${toMessage(err)}`)
      }
    }
  }
  return keys
}

/**
 * Auth for a connection given no password or key — what `ssh user@host` does:
 * the SSH agent, then unencrypted default keys from ~/.ssh. Undefined when
 * neither exists, leaving ssh2's own defaults in place.
 */
export function defaultAuthMethods(username: string): ConnectConfig['authHandler'] {
  // Keys are secrets like stored passwords: nothing reads or offers them
  // while noxed is locked.
  if (!isUnlocked()) throw new AuthError('App is locked — unlock noxed to use your SSH keys')
  const methods: Array<{ type: 'agent'; username: string; agent: BaseAgent } | { type: 'publickey'; username: string; key: string }> = []
  const agent = localAgent()
  if (agent) methods.push({ type: 'agent', username, agent })
  for (const key of readDefaultIdentities()) methods.push({ type: 'publickey', username, key })
  return methods.length > 0 ? methods : undefined
}

export async function credentialsForSession(session: Session): Promise<{ password?: string; privateKey?: string }> {
  if (session.authType === 'key') {
    if (!session.keyPath) {
      throw new ValidationError(`${session.label || session.host}: key authentication selected but no key file configured`)
    }
    const check = isAllowedKeyPath(session.keyPath)
    if (!check.ok) throw new ValidationError(check.reason)
    return { privateKey: readFileSync(check.resolved, 'utf-8') }
  }
  // No stored secret: connectRawClient falls back to the agent and default keys.
  if (session.authType === 'agent') return {}

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
      agentForward: session.agentForward,
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
