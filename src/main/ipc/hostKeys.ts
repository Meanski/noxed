import { BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HostVerifier } from 'ssh2'
import { ValidationError, toMessage } from './errors'
import {
  fingerprintOf,
  keyTypeOf,
  matchKnownHosts,
  matchTrustedKeys,
  type HostKeyMatch,
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
  status: 'new' | 'changed'
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
const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024
const DECISIONS = new Set<HostKeyDecision>(['trust', 'once', 'reject'])

interface PendingPrompt {
  webContentsId: number
  resolve: (decision: HostKeyDecision) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingPrompt>()
// Several connections to the same unknown host (restored split panes, the
// multi-host runner) share one prompt instead of stacking duplicates.
const inflight = new Map<string, Promise<boolean>>()

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
    const timer = setTimeout(() => {
      pending.delete(requestId)
      if (!target.isDestroyed()) target.send('hostkeys:dismiss', requestId)
      resolve('reject')
    }, PROMPT_TIMEOUT_MS)
    pending.set(requestId, { webContentsId: target.id, resolve, timer })
    target.send('hostkeys:prompt', { ...prompt, requestId })
  })
}

async function decide(host: string, port: number, blob: Buffer): Promise<boolean> {
  const keyType = keyTypeOf(blob)
  const key = blob.toString('base64')
  const fingerprint = fingerprintOf(blob)
  const trusted = listTrustedHostKeys()

  let verdict: HostKeyMatch = matchTrustedKeys(trusted, host, port, keyType, key)
  if (verdict === 'match') return true
  if (verdict !== 'mismatch') {
    // noxed has no record for this key type; fall back to OpenSSH's file so
    // hosts the user already trusts there don't prompt again.
    const openssh = matchKnownHosts(readOpenSshKnownHosts(), host, port, keyType, key)
    if (openssh === 'match') return true
    if (openssh === 'mismatch' || verdict === 'none') verdict = openssh
  }

  const forHost = trusted.filter((e) => e.host.toLowerCase() === host.toLowerCase() && e.port === port)
  const changed = verdict === 'mismatch'
  const decision = await askUser({
    host,
    port,
    keyType,
    fingerprint,
    status: changed ? 'changed' : 'new',
    knownFingerprints: changed
      ? forHost.filter((e) => e.keyType === keyType).map((e) => fingerprintOfB64(e.key))
      : [],
    otherKeyTypes: changed ? [] : [...new Set(forHost.map((e) => e.keyType))],
  })
  if (decision === 'trust') saveTrustedHostKey(host, port, keyType, key, fingerprint)
  return decision !== 'reject'
}

/** Resolves true when the presented host key is trusted (or the user accepts it). */
export function verifyHostKey(host: string, port: number, blob: Buffer): Promise<boolean> {
  const dedupeKey = `${host.toLowerCase()}|${port}|${blob.toString('base64')}`
  const existing = inflight.get(dedupeKey)
  if (existing !== undefined) return existing
  const result = decide(host, port, blob)
    .catch((err) => {
      console.error(`[hostkeys] verification failed for ${host}:${port}: ${toMessage(err)}`)
      return false
    })
    .finally(() => inflight.delete(dedupeKey))
  inflight.set(dedupeKey, result)
  return result
}

/** ssh2 `hostVerifier` for a connection to host:port. */
export function hostVerifierFor(host: string, port: number): HostVerifier {
  return (key, verify) => {
    verifyHostKey(host, port, key).then(verify)
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
    pending.delete(rawRequestId)
    clearTimeout(entry.timer)
    entry.resolve(rawDecision as HostKeyDecision)
  })
}
