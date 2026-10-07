import { describe, it, expect } from 'vitest'
import {
  fingerprintOf,
  hostFieldMatches,
  keyTypeOf,
  knownHostsName,
  matchKnownHosts,
  matchTrustedKeys,
} from '../knownHosts'

// Fixtures generated with OpenSSH (`ssh-keygen -t ed25519`, `ssh-keygen -lf`,
// `ssh-keygen -H`) so expectations come from the reference implementation.
const KEY1 = 'AAAAC3NzaC1lZDI1NTE5AAAAIGFtBD3Qpg30EbIqvedapYSsPYyF8uIgYKIwZKmBIhFx'
const KEY1_FINGERPRINT = 'SHA256:xKnb9PezoHKXZuSpMMT7c+br+DazQE/4vX0zxhNqoJ4'
const KEY2 = 'AAAAC3NzaC1lZDI1NTE5AAAAIAAxGjdH2btAlq+4X7kpGWgjZzF+HUL/VxyavS01jbO6'
const HASHED_EXAMPLE_COM = '|1|88YQ4iUD8P18T5sO4z7IiobALNA=|N0ZQ9FirHfYc3yX00ZHFEDlPgD8='
const HASHED_EXAMPLE_COM_2222 = '|1|fKMYYoy+x4b6XZbA18IFbfRUWPQ=|YaUMcbbdrh+79ROvkui7o6e2c0A='

describe('keyTypeOf', () => {
  it('reads the algorithm name from the key blob', () => {
    expect(keyTypeOf(Buffer.from(KEY1, 'base64'))).toBe('ssh-ed25519')
  })

  it('returns unknown for truncated or implausible blobs', () => {
    expect(keyTypeOf(Buffer.alloc(2))).toBe('unknown')
    expect(keyTypeOf(Buffer.from([0, 0, 0, 0]))).toBe('unknown')
    expect(keyTypeOf(Buffer.from([0, 0, 0, 200, 1, 2]))).toBe('unknown')
  })
})

describe('fingerprintOf', () => {
  it('matches ssh-keygen -lf', () => {
    expect(fingerprintOf(Buffer.from(KEY1, 'base64'))).toBe(KEY1_FINGERPRINT)
  })
})

describe('knownHostsName', () => {
  it('uses the bare host on port 22 and [host]:port elsewhere', () => {
    expect(knownHostsName('example.com', 22)).toBe('example.com')
    expect(knownHostsName('example.com', 2222)).toBe('[example.com]:2222')
  })
})

describe('hostFieldMatches', () => {
  it('matches plain, comma-separated and case-insensitive names', () => {
    expect(hostFieldMatches('a.com,example.com', 'example.com')).toBe(true)
    expect(hostFieldMatches('EXAMPLE.com', 'example.com')).toBe(true)
    expect(hostFieldMatches('other.com', 'example.com')).toBe(false)
  })

  it('supports * and ? wildcards without treating dots as regex', () => {
    expect(hostFieldMatches('*.example.com', 'web.example.com')).toBe(true)
    expect(hostFieldMatches('web?.example.com', 'web1.example.com')).toBe(true)
    expect(hostFieldMatches('example.com', 'exampleXcom')).toBe(false)
  })

  it('lets a negated pattern veto an otherwise matching field', () => {
    expect(hostFieldMatches('*.example.com,!db.example.com', 'db.example.com')).toBe(false)
  })

  it('matches OpenSSH hashed host names, including the [host]:port form', () => {
    expect(hostFieldMatches(HASHED_EXAMPLE_COM, 'example.com')).toBe(true)
    expect(hostFieldMatches(HASHED_EXAMPLE_COM, 'example.org')).toBe(false)
    expect(hostFieldMatches(HASHED_EXAMPLE_COM_2222, '[example.com]:2222')).toBe(true)
  })

  it('ignores malformed hashed entries', () => {
    expect(hostFieldMatches('|2|abc|def', 'example.com')).toBe(false)
    expect(hostFieldMatches('|1|abc', 'example.com')).toBe(false)
  })
})

describe('matchKnownHosts', () => {
  const file = [
    '# comment',
    '',
    `${HASHED_EXAMPLE_COM} ssh-ed25519 ${KEY1}`,
    `[example.com]:2222 ssh-ed25519 ${KEY2}`,
    `rsa-only.com ssh-rsa AAAAB3NzaC1yc2E=`,
    `@cert-authority *.example.com ssh-ed25519 ${KEY2}`,
    `@revoked revoked.com ssh-ed25519 ${KEY1}`,
  ].join('\n')

  it('accepts a matching key, hashed or not', () => {
    expect(matchKnownHosts(file, 'example.com', 22, 'ssh-ed25519', KEY1).verdict).toBe('match')
    expect(matchKnownHosts(file, 'example.com', 2222, 'ssh-ed25519', KEY2).verdict).toBe('match')
  })

  it('flags a different key of the same type as a mismatch', () => {
    expect(matchKnownHosts(file, 'example.com', 22, 'ssh-ed25519', KEY2).verdict).toBe('mismatch')
  })

  it('distinguishes hosts only known under another key type', () => {
    expect(matchKnownHosts(file, 'rsa-only.com', 22, 'ssh-ed25519', KEY1).verdict).toBe('other-type')
  })

  it('reports a @revoked key and ignores @cert-authority lines', () => {
    expect(matchKnownHosts(file, 'revoked.com', 22, 'ssh-ed25519', KEY1).verdict).toBe('revoked')
    expect(matchKnownHosts(file, 'web.example.com', 22, 'ssh-ed25519', KEY2).verdict).toBe('none')
  })

  it('lets a later @revoked line override an earlier match', () => {
    const revokedAfterMatch = `example.com ssh-ed25519 ${KEY1}\n@revoked * ssh-ed25519 ${KEY1}`
    expect(matchKnownHosts(revokedAfterMatch, 'example.com', 22, 'ssh-ed25519', KEY1).verdict).toBe('revoked')
  })

  it('returns the recorded keys of the same type on a mismatch', () => {
    expect(matchKnownHosts(file, 'example.com', 22, 'ssh-ed25519', KEY2)).toEqual({ verdict: 'mismatch', sameTypeKeys: [KEY1] })
  })

  it('ignores lines with unsupported markers instead of trusting them', () => {
    const text = `@future-marker example.com ssh-ed25519 ${KEY1}`
    expect(matchKnownHosts(text, 'example.com', 22, 'ssh-ed25519', KEY1).verdict).toBe('none')
  })

  it('returns none for unknown hosts and ports', () => {
    expect(matchKnownHosts(file, 'nowhere.com', 22, 'ssh-ed25519', KEY1).verdict).toBe('none')
    expect(matchKnownHosts(file, 'example.com', 2200, 'ssh-ed25519', KEY1).verdict).toBe('none')
  })
})

describe('matchTrustedKeys', () => {
  const entries = [
    { host: 'Example.com', port: 22, keyType: 'ssh-ed25519', key: KEY1 },
    { host: 'rsa.com', port: 22, keyType: 'ssh-rsa', key: 'AAAA' },
  ]

  it('mirrors the known_hosts verdicts for noxed-trusted keys', () => {
    expect(matchTrustedKeys(entries, 'example.com', 22, 'ssh-ed25519', KEY1)).toBe('match')
    expect(matchTrustedKeys(entries, 'example.com', 22, 'ssh-ed25519', KEY2)).toBe('mismatch')
    expect(matchTrustedKeys(entries, 'rsa.com', 22, 'ssh-ed25519', KEY1)).toBe('other-type')
    expect(matchTrustedKeys(entries, 'example.com', 2222, 'ssh-ed25519', KEY1)).toBe('none')
  })
})
