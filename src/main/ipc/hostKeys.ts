import { BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Client, ConnectConfig } from 'ssh2'
import { ValidationError, toMessage } from './errors'
import {
  fingerprintOf,
  keyTypeOf,
  matchKnownHosts,
  matchTrustedKeys,
  type TrustedHostKey,
} from './knownHosts'
import { validateHost, validatePort } from './security'

export type HostKeyDecision = 'trust' | 'once' | 'reject'

export interface StoredHostKey extends TrustedHostKey {
  fingerprint: string
  addedAt: number
}

export interface HostKeyPrompt {
  requestId: string
  host: string
  port: number
  keyType: string
  fingerprint: string
  /** `revoked` is informational: the connection is refused whatever the answer. */
  status: 'new' | 'changed' | 'revoked'
  /** Fingerprint(s) previously trusted for this key type (changed keys only). */
  knownFingerprints: string[]
  /** Other key types this host is already trusted under (new keys only). */
  otherKeyTypes: string[]
}

const store = new Store<{ hosts: StoredHostKey[] }>({
  name: 'known-hosts',
  defaults: { hosts: [] },
})

// An unanswered prompt rejects the connection rather than hanging it forever.
const PROMPT_TIMEOUT_MS = 120_000
/** How long an SSH handshake may take, not counting time spent in a host-key prompt. */
export const SSH_HANDSHAKE_TIMEOUT_MS = 30_000
const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024
const DECISIONS = new Set<HostKeyDecision>(['trust', 'once', 'reject'])

interface PendingPrompt {
  webContentsId: number
  settle: (decision: HostKeyDecision) => void
}

/** Told when verification starts and stops waiting on the user. */
interface PromptWatcher {
  onPromptStart: () => void
  onPromptEnd: () => void
}

interface InflightCheck {
  result: Promise<boolean>
  watchers: Set<PromptWatcher>
  prompting: boolean
}

const pending = new Map<string, PendingPrompt>()
// Several connections to the same unknown host (restored split panes, the
// multi-host runner) share one prompt instead of stacking duplicates.
const inflight = new Map<string, InflightCheck>()

export function listTrustedHostKeys(): StoredHostKey[] {
  return store.get('hosts')
}

function saveTrustedHostKey(host: string, port: number, keyType: string, key: string, fingerprint: string): void {
  const sameHost = (e: StoredHostKey) => e.host.toLowerCase() === host.toLowerCase() && e.port === port
  // Trusting a replacement key drops the old key of the same type.
  const kept = store.get('hosts').filter((e) => !(sameHost(e) && e.keyType === keyType))
  store.set('hosts', [...kept, { host, port, keyType, key, fingerprint, addedAt: Date.now() }])
}

function readOpenSshKnownHosts(): string {
  const path = join(homedir(), '.ssh', 'known_hosts')
  try {
    if (statSync(path).size > MAX_KNOWN_HOSTS_BYTES) return ''
    return readFileSync(path, 'utf-8')
  } catch (err) {
    // Missing or unreadable known_hosts just means OpenSSH has no opinion.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[hostkeys] could not read ${path}: ${toMessage(err)}`)
    }
    return ''
  }
}

function fingerprintOfB64(key: string): string {
  return fingerprintOf(Buffer.from(key, 'base64'))
}

function promptTarget(): Electron.WebContents | null {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  return win && !win.isDestroyed() ? win.webContents : null
}

function askUser(prompt: Omit<HostKeyPrompt, 'requestId'>): Promise<HostKeyDecision> {
  const target = promptTarget()
  if (!target) return Promise.resolve('reject')
  const requestId = randomUUID()
  return new Promise((resolve) => {
    // Every exit path (answer, timeout, window closed) goes through settle so
    // the timer and the destroyed listener are always released.
    const settle = (decision: HostKeyDecision) => {
      pending.delete(requestId)
      clearTimeout(timer)
      target.removeListener('destroyed', onDestroyed)
      resolve(decision)
    }
    const onDestroyed = () => settle('reject')
    const timer = setTimeout(() => {
      if (!target.isDestroyed()) target.send('hostkeys:dismiss', requestId)
      settle('reject')
    }, PROMPT_TIMEOUT_MS)
    target.once('destroyed', onDestroyed)
    pending.set(requestId, { webContentsId: target.id, settle })
    target.send('hostkeys:prompt', { ...prompt, requestId })
  })
}

// Pauses every waiting connection's handshake timer while the user decides.
async function askWhileWatched(check: InflightCheck, prompt: Omit<HostKeyPrompt, 'requestId'>): Promise<HostKeyDecision> {
  check.prompting = true
  check.watchers.forEach((w) => w.onPromptStart())
  try {
    return await askUser(prompt)
  } finally {
    check.prompting = false
    check.watchers.forEach((w) => w.onPromptEnd())
  }
}

async function askAndRemember(check: InflightCheck, prompt: Omit<HostKeyPrompt, 'requestId'>, key: string): Promise<boolean> {
  const decision = await askWhileWatched(check, prompt)
  if (decision === 'trust') saveTrustedHostKey(prompt.host, prompt.port, prompt.keyType, key, prompt.fingerprint)
  return decision !== 'reject'
}

async function decide(check: InflightCheck, host: string, port: number, blob: Buffer): Promise<boolean> {
  const keyType = keyTypeOf(blob)
  const key = blob.toString('base64')
  const fingerprint = fingerprintOf(blob)
  const prompt = { host, port, keyType, fingerprint, knownFingerprints: [] as string[], otherKeyTypes: [] as string[] }

  // OpenSSH's file is always consulted first: an @revoked key is refused even
  // if noxed trusted it earlier.
  const openssh = matchKnownHosts(readOpenSshKnownHosts(), host, port, keyType, key)
  if (openssh.verdict === 'revoked') {
    await askWhileWatched(check, { ...prompt, status: 'revoked' })
    return false
  }

  const trusted = listTrustedHostKeys()
  const ours = matchTrustedKeys(trusted, host, port, keyType, key)
  if (ours === 'match') return true
  // A key noxed holds for this type wins over OpenSSH's file, so "Replace key"
  // really retires the old key instead of leaving it valid via known_hosts.
  if (ours !== 'mismatch' && openssh.verdict === 'match') return true

  const forHost = trusted.filter((e) => e.host.toLowerCase() === host.toLowerCase() && e.port === port)
  if (ours === 'mismatch' || openssh.verdict === 'mismatch') {
    const previous = [...forHost.filter((e) => e.keyType === keyType).map((e) => e.key), ...openssh.sameTypeKeys]
    return askAndRemember(check, { ...prompt, status: 'changed', knownFingerprints: [...new Set(previous.map(fingerprintOfB64))] }, key)
  }
  return askAndRemember(check, { ...prompt, status: 'new', otherKeyTypes: [...new Set(forHost.map((e) => e.keyType))] }, key)
}

/** Resolves true when the presented host key is trusted (or the user accepts it). */
export function verifyHostKey(host: string, port: number, blob: Buffer, watcher?: PromptWatcher): Promise<boolean> {
  const dedupeKey = `${host.toLowerCase()}|${port}|${blob.toString('base64')}`
  const existing = inflight.get(dedupeKey)
  if (existing !== undefined) {
    if (watcher) {
      existing.watchers.add(watcher)
      if (existing.prompting) watcher.onPromptStart()
    }
    return existing.result
  }
  const check: InflightCheck = { result: Promise.resolve(false), watchers: new Set(watcher ? [watcher] : []), prompting: false }
  check.result = decide(check, host, port, blob)
    .catch((err) => {
      console.error(`[hostkeys] verification failed for ${host}:${port}: ${toMessage(err)}`)
      return false
    })
    .finally(() => inflight.delete(dedupeKey))
  inflight.set(dedupeKey, check)
  return check.result
}

/**
 * Connect options that verify the host key and enforce the handshake timeout
 * ourselves. ssh2's own readyTimeout can't be paused, so it would kill the
 * connection while the user is still reading a fingerprint; this timer stops
 * while a prompt is open and restarts once it's answered.
 */
export function verifiedHandshake(client: Client, host: string, port: number): Pick<ConnectConfig, 'readyTimeout' | 'hostVerifier'> {
  let timer: NodeJS.Timeout | undefined
  let finished = false
  const disarm = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const arm = () => {
    disarm()
    if (finished) return
    timer = setTimeout(() => {
      client.emit('error', Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' }))
      client.destroy()
    }, SSH_HANDSHAKE_TIMEOUT_MS)
  }
  const finish = () => {
    finished = true
    disarm()
  }
  client.once('ready', finish)
  client.once('error', finish)
  client.once('close', finish)
  arm()

  const watcher: PromptWatcher = { onPromptStart: disarm, onPromptEnd: arm }
  return {
    readyTimeout: 0,
    hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
      verifyHostKey(host, port, key, watcher).then(verify)
    },
  }
}

// ssh2 reports a rejected host key as a generic handshake failure.
export function describeSshError(err: unknown): string {
  const message = toMessage(err)
  return message.includes('Host denied (verification failed)')
    ? 'Host key not trusted — connection cancelled'
    : message
}

export function registerHostKeyHandlers(): void {
  ipcMain.handle('hostkeys:list', () => listTrustedHostKeys())

  ipcMain.handle('hostkeys:remove', (_e, rawHost: unknown, rawPort: unknown, rawKeyType: unknown) => {
    const host = validateHost(rawHost)
    const port = validatePort(rawPort)
    if (typeof rawKeyType !== 'string' || !/^[\w@.-]{1,64}$/.test(rawKeyType)) {
      throw new ValidationError('Invalid key type')
    }
    const remaining = listTrustedHostKeys().filter(
      (e) => !(e.host.toLowerCase() === host.toLowerCase() && e.port === port && e.keyType === rawKeyType),
    )
    store.set('hosts', remaining)
  })

  ipcMain.handle('hostkeys:respond', (event, rawRequestId: unknown, rawDecision: unknown) => {
    if (typeof rawRequestId !== 'string' || !DECISIONS.has(rawDecision as HostKeyDecision)) {
      throw new ValidationError('Invalid host key response')
    }
    const entry = pending.get(rawRequestId)
    // Only the window that was asked may answer; anything else is ignored.
    if (!entry || entry.webContentsId !== event.sender.id) return
    entry.settle(rawDecision as HostKeyDecision)
  })
}
