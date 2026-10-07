import { BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Client, ConnectConfig } from 'ssh2'
import { AuthError, ValidationError, toMessage } from './errors'
import {
  entriesForHost,
  fingerprintOf,
  keyTypeOf,
  matchKnownHostsEntries,
  matchTrustedKeys,
  parseKnownHosts,
  type KnownHostsLine,
  type TrustedHostKey,
} from './knownHosts'
import { isUnlocked } from './keychain'
import { isUuid, validateHost, validatePort } from './security'

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
  /** Withdraws the open prompt (rejecting it); set while one is shown. */
  cancelPrompt?: () => void
  /** Every connection waiting on this check has gone away. */
  abandoned: boolean
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

// Parsed once per file version, and narrowed once per host: the runner can
// verify many hosts in a burst, and every hashed line costs an HMAC per host.
const MAX_CACHED_HOSTS = 256
let knownHostsCache: { mtimeMs: number; size: number; entries: KnownHostsLine[]; byHost: Map<string, KnownHostsLine[]> } | null = null

function readOpenSshKnownHosts(host: string, port: number): KnownHostsLine[] {
  const path = join(homedir(), '.ssh', 'known_hosts')
  try {
    const { mtimeMs, size } = statSync(path)
    if (size > MAX_KNOWN_HOSTS_BYTES) return []
    if (knownHostsCache?.mtimeMs !== mtimeMs || knownHostsCache.size !== size) {
      knownHostsCache = { mtimeMs, size, entries: parseKnownHosts(readFileSync(path, 'utf-8')), byHost: new Map() }
    }
    const hostKey = `${host.toLowerCase()}:${port}`
    let forHost = knownHostsCache.byHost.get(hostKey)
    if (!forHost) {
      if (knownHostsCache.byHost.size >= MAX_CACHED_HOSTS) knownHostsCache.byHost.clear()
      forHost = entriesForHost(knownHostsCache.entries, host, port)
      knownHostsCache.byHost.set(hostKey, forHost)
    }
    return forHost
  } catch (err) {
    // Missing or unreadable known_hosts just means OpenSSH has no opinion.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[hostkeys] could not read ${path}: ${toMessage(err)}`)
    }
    return []
  }
}

function fingerprintOfB64(key: string): string {
  return fingerprintOf(Buffer.from(key, 'base64'))
}

function promptTarget(): Electron.WebContents | null {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  return win && !win.isDestroyed() ? win.webContents : null
}

interface AskHooks {
  /** Called once the prompt is on screen, with a way to withdraw it. */
  onOpen?: (cancel: () => void) => void
  /** Checked before a queued prompt is shown; true skips it as rejected. */
  cancelled?: () => boolean
}

interface QueuedAsk {
  prompt: Omit<HostKeyPrompt, 'requestId'>
  hooks: AskHooks
  resolve: (decision: HostKeyDecision) => void
}

// The renderer shows one prompt at a time, so main presents them one at a time
// too: each prompt's timeout only starts when it's actually on screen (the
// runner can hit dozens of new hosts at once).
const askQueue: QueuedAsk[] = []
let presenting = false

function askUser(prompt: Omit<HostKeyPrompt, 'requestId'>, hooks: AskHooks = {}): Promise<HostKeyDecision> {
  return new Promise((resolve) => {
    askQueue.push({ prompt, hooks, resolve })
    presentNext()
  })
}

// webContents.send throws if the renderer crashed or is going away; that must
// never stop a prompt settling or the queue advancing.
function safeSend(target: Electron.WebContents, channel: string, payload: unknown): boolean {
  if (target.isDestroyed()) return false
  try {
    target.send(channel, payload)
    return true
  } catch (err) {
    console.error(`[hostkeys] could not send ${channel}: ${toMessage(err)}`)
    return false
  }
}

function presentNext(): void {
  if (presenting) return
  const next = askQueue.shift()
  if (!next) return
  if (next.hooks.cancelled?.()) {
    next.resolve('reject')
    presentNext()
    return
  }
  presenting = true
  present(next.prompt, next.hooks.onOpen).catch((): HostKeyDecision => 'reject').then((decision) => {
    presenting = false
    next.resolve(decision)
    presentNext()
  })
}

function present(prompt: Omit<HostKeyPrompt, 'requestId'>, onOpen?: (cancel: () => void) => void): Promise<HostKeyDecision> {
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
      safeSend(target, 'hostkeys:dismiss', requestId)
      settle('reject')
    }, PROMPT_TIMEOUT_MS)
    target.once('destroyed', onDestroyed)
    pending.set(requestId, { webContentsId: target.id, settle })
    if (!safeSend(target, 'hostkeys:prompt', { ...prompt, requestId })) {
      settle('reject')
      return
    }
    onOpen?.(() => {
      safeSend(target, 'hostkeys:dismiss', requestId)
      settle('reject')
    })
  })
}

// Pauses every waiting connection's handshake timer while the user decides.
async function askWhileWatched(check: InflightCheck, prompt: Omit<HostKeyPrompt, 'requestId'>): Promise<HostKeyDecision> {
  check.prompting = true
  check.watchers.forEach((w) => w.onPromptStart())
  try {
    return await askUser(prompt, {
      onOpen: (cancel) => { check.cancelPrompt = cancel },
      cancelled: () => check.abandoned,
    })
  } finally {
    check.prompting = false
    check.cancelPrompt = undefined
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
  const openssh = matchKnownHostsEntries(readOpenSshKnownHosts(host, port), host, port, keyType, key)
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

// Decisions for one host:port happen one after another, so a second key that
// arrives while the first is being decided is judged against the outcome
// (e.g. as a changed key once the first was trusted), not a stale snapshot.
const hostTurns = new Map<string, Promise<void>>()

async function decideInTurn(check: InflightCheck, host: string, port: number, blob: Buffer): Promise<boolean> {
  const turnKey = `${host.toLowerCase()}|${port}`
  const previous = hostTurns.get(turnKey)
  let release = () => {}
  const mine = new Promise<void>((resolve) => { release = resolve })
  const queued = (previous ?? Promise.resolve()).then(() => mine)
  hostTurns.set(turnKey, queued)
  try {
    if (previous) {
      // Waiting on someone else's prompt counts as prompting: keep this
      // connection's handshake clock stopped meanwhile.
      check.prompting = true
      check.watchers.forEach((w) => w.onPromptStart())
      await previous
      check.prompting = false
      check.watchers.forEach((w) => w.onPromptEnd())
    }
    return await decide(check, host, port, blob)
  } finally {
    release()
    if (hostTurns.get(turnKey) === queued) hostTurns.delete(turnKey)
  }
}

/** Resolves true when the presented host key is trusted (or the user accepts it). */
export function verifyHostKey(host: string, port: number, blob: Buffer, watcher?: PromptWatcher): Promise<boolean> {
  const dedupeKey = `${host.toLowerCase()}|${port}|${blob.toString('base64')}`
  const existing = inflight.get(dedupeKey)
  if (existing !== undefined) {
    if (watcher) {
      existing.watchers.add(watcher)
      // A new connection revives a check whose earlier connections all left.
      existing.abandoned = false
      if (existing.prompting) watcher.onPromptStart()
    }
    return existing.result
  }
  const check: InflightCheck = { result: Promise.resolve(false), watchers: new Set(watcher ? [watcher] : []), prompting: false, abandoned: false }
  check.result = decideInTurn(check, host, port, blob)
    .catch((err) => {
      console.error(`[hostkeys] verification failed for ${host}:${port}: ${toMessage(err)}`)
      return false
    })
    .finally(() => inflight.delete(dedupeKey))
  inflight.set(dedupeKey, check)
  return check.result
}

/**
 * A connection gave up (closed or errored) before its host key was decided.
 * Once no connection is waiting on a check, its prompt is withdrawn so a late
 * "Trust" can't save a key for a connection that no longer exists.
 */
function abandonWatcher(watcher: PromptWatcher): void {
  for (const check of inflight.values()) {
    if (!check.watchers.delete(watcher)) continue
    if (check.watchers.size === 0) {
      check.abandoned = true
      check.cancelPrompt?.()
    }
  }
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
  const watcher: PromptWatcher = { onPromptStart: disarm, onPromptEnd: arm }
  const finish = () => {
    finished = true
    disarm()
  }
  const abandon = () => {
    finish()
    abandonWatcher(watcher)
  }
  client.once('ready', finish)
  client.once('error', abandon)
  client.once('close', abandon)
  arm()

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
    if (!isUuid(rawRequestId) || !DECISIONS.has(rawDecision as HostKeyDecision)) {
      throw new ValidationError('Invalid host key response')
    }
    const entry = pending.get(rawRequestId)
    // Only the window that was asked may answer; anything else is ignored.
    if (!entry || entry.webContentsId !== event.sender.id) return
    // Trusting a key is a privileged action, so it waits behind the lock
    // screen; the prompt stays pending until the app is unlocked.
    if (rawDecision !== 'reject' && !isUnlocked()) throw new AuthError('Unlock noxed to trust a host key')
    entry.settle(rawDecision as HostKeyDecision)
  })
}
