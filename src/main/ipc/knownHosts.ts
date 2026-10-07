import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// Pure helpers for SSH host-key trust: decoding the server's public key blob,
// OpenSSH-style fingerprints, and matching against known_hosts content.

export type HostKeyMatch = 'revoked' | 'match' | 'mismatch' | 'other-type' | 'none'

export interface KnownHostsVerdict {
  verdict: HostKeyMatch
  /** Keys recorded for this host under the presented key type (for mismatch prompts). */
  sameTypeKeys: string[]
}

export interface TrustedHostKey {
  host: string
  port: number
  keyType: string
  /** Base64 of the SSH wire-format public key blob (same as known_hosts). */
  key: string
}

/** The key type is the first length-prefixed string in the SSH key blob. */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const len = blob.readUInt32BE(0)
  if (len === 0 || len > 64 || blob.length < 4 + len) return 'unknown'
  return blob.toString('ascii', 4, 4 + len)
}

/** OpenSSH's `SHA256:` fingerprint: unpadded base64 of the blob's SHA-256. */
export function fingerprintOf(blob: Buffer): string {
  // '=' only ever appears as base64 padding, so stripping every one is safe.
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replaceAll('=', '')}`
}

/** The name OpenSSH records for a host: bare for port 22, `[host]:port` otherwise. */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${escaped}$`, 'i')
}

// Hashed entries are `|1|base64(salt)|base64(HMAC-SHA1(salt, name))`.
function hashedPatternMatches(pattern: string, name: string): boolean {
  const parts = pattern.split('|')
  if (parts.length !== 4 || parts[1] !== '1') return false
  const salt = Buffer.from(parts[2], 'base64')
  const expected = Buffer.from(parts[3], 'base64')
  const actual = createHmac('sha1', salt).update(name).digest()
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Whether a comma-separated known_hosts host field covers `name`. Negations win. */
export function hostFieldMatches(field: string, name: string): boolean {
  let matched = false
  for (const raw of field.split(',')) {
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    const hit = pattern.startsWith('|') ? hashedPatternMatches(pattern, name) : globToRegExp(pattern).test(name)
    if (hit && negated) return false
    if (hit) matched = true
  }
  return matched
}

const SUPPORTED_MARKERS = new Set(['@cert-authority', '@revoked'])

export interface KnownHostsLine {
  marker?: string
  hostField: string
  keyType: string
  key: string
}

/** Parses known_hosts text once so repeated host checks can reuse it. */
export function parseKnownHosts(text: string): KnownHostsLine[] {
  const entries: KnownHostsLine[] = []
  for (const rawLine of text.split('\n')) {
    const entry = parseKnownHostsLine(rawLine)
    if (entry) entries.push(entry)
  }
  return entries
}

function parseKnownHostsLine(rawLine: string): KnownHostsLine | null {
  const line = rawLine.trim()
  if (!line || line.startsWith('#')) return null
  const fields = line.split(/\s+/)
  const marker = fields[0].startsWith('@') ? fields.shift() : undefined
  // OpenSSH treats unknown markers as invalid lines; never read them as trust.
  if (marker !== undefined && !SUPPORTED_MARKERS.has(marker)) return null
  if (fields.length < 3) return null
  return { marker, hostField: fields[0], keyType: fields[1], key: fields[2] }
}

/**
 * Compares a presented key against OpenSSH known_hosts text. Every line is
 * scanned so an `@revoked` entry wins regardless of where it appears.
 * `mismatch` means the host is recorded with this key type but a different
 * key; `other-type` means it is only known under other key types.
 */
export function matchKnownHosts(text: string, host: string, port: number, keyType: string, key: string): KnownHostsVerdict {
  return matchKnownHostsEntries(parseKnownHosts(text), host, port, keyType, key)
}

/** matchKnownHosts over already-parsed entries. */
export function matchKnownHostsEntries(entries: readonly KnownHostsLine[], host: string, port: number, keyType: string, key: string): KnownHostsVerdict {
  const name = knownHostsName(host, port)
  const sameTypeKeys: string[] = []
  let matched = false
  let sawOtherType = false
  for (const entry of entries) {
    if (entry.marker === '@cert-authority' || !hostFieldMatches(entry.hostField, name)) continue
    if (entry.marker === '@revoked') {
      if (entry.key === key) return { verdict: 'revoked', sameTypeKeys: [] }
    } else if (entry.keyType !== keyType) {
      sawOtherType = true
    } else if (entry.key === key) {
      matched = true
    } else {
      sameTypeKeys.push(entry.key)
    }
  }
  if (matched) return { verdict: 'match', sameTypeKeys: [] }
  if (sameTypeKeys.length > 0) return { verdict: 'mismatch', sameTypeKeys }
  return { verdict: sawOtherType ? 'other-type' : 'none', sameTypeKeys: [] }
}

/** Same verdicts as matchKnownHosts, against noxed's own trusted-key list. */
export function matchTrustedKeys(entries: readonly TrustedHostKey[], host: string, port: number, keyType: string, key: string): HostKeyMatch {
  const forHost = entries.filter((e) => e.host.toLowerCase() === host.toLowerCase() && e.port === port)
  if (forHost.some((e) => e.keyType === keyType && e.key === key)) return 'match'
  if (forHost.some((e) => e.keyType === keyType)) return 'mismatch'
  return forHost.length > 0 ? 'other-type' : 'none'
}
