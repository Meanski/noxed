import { describe, it, expect } from 'vitest'
import { serializeSessions, parseSessionsExport, connectionDedupKey } from '../sessionTransfer'
import { ValidationError } from '../errors'
import type { Session } from '../sessions'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'abc-123',
    label: 'Web Server',
    host: 'web.example.com',
    port: 22,
    username: 'deploy',
    authType: 'key',
    keyPath: '~/.ssh/id_ed25519',
    createdAt: 1700000000000,
    type: 'ssh',
    hasPassword: true,
    ...overrides,
  }
}

describe('serializeSessions', () => {
  it('produces a versioned document without ids, timestamps, or credential flags', () => {
    const json = serializeSessions([makeSession()])
    const doc = JSON.parse(json)
    expect(doc.format).toBe('noxed-connections')
    expect(doc.version).toBe(1)
    expect(doc.connections).toHaveLength(1)
    expect(doc.connections[0]).not.toHaveProperty('id')
    expect(doc.connections[0]).not.toHaveProperty('createdAt')
    expect(doc.connections[0]).not.toHaveProperty('hasPassword')
    expect(doc.connections[0]).not.toHaveProperty('password')
    expect(doc.connections[0].host).toBe('web.example.com')
  })

  it('round-trips through parseSessionsExport', () => {
    const original = makeSession({ tags: ['prod'], group: 'Acme', isFavorite: true })
    const imported = parseSessionsExport(serializeSessions([original]))
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({
      label: 'Web Server',
      host: 'web.example.com',
      port: 22,
      username: 'deploy',
      authType: 'key',
      keyPath: '~/.ssh/id_ed25519',
      tags: ['prod'],
      group: 'Acme',
      isFavorite: true,
    })
  })
})

describe('parseSessionsExport', () => {
  function wrap(connections: unknown[]): string {
    return JSON.stringify({ format: 'noxed-connections', version: 1, connections })
  }

  it('rejects invalid JSON', () => {
    expect(() => parseSessionsExport('not json')).toThrow(ValidationError)
  })

  it('rejects documents without the export format marker', () => {
    expect(() => parseSessionsExport('{"connections": []}')).toThrow(ValidationError)
    expect(() => parseSessionsExport('[]')).toThrow(ValidationError)
  })

  it('drops entries without a host', () => {
    const result = parseSessionsExport(wrap([{ label: 'broken', port: 22 }]))
    expect(result).toEqual([])
  })

  it('keeps kubernetes entries that have a context but no host', () => {
    const result = parseSessionsExport(wrap([{ type: 'kubernetes', contextName: 'prod-cluster' }]))
    expect(result).toHaveLength(1)
    expect(result[0].contextName).toBe('prod-cluster')
  })

  it('never accepts passwords from the import file', () => {
    const result = parseSessionsExport(wrap([{ host: 'a.example.com', password: 'hunter2' }]))
    expect(result[0]).not.toHaveProperty('password')
  })

  it('defaults malformed ports and auth types', () => {
    const result = parseSessionsExport(wrap([
      { host: 'a.example.com', port: 'not-a-port', authType: 'magic' },
    ]))
    expect(result[0].port).toBe(22)
    expect(result[0].authType).toBe('password')
  })

  it('filters non-string tags', () => {
    const result = parseSessionsExport(wrap([{ host: 'a.example.com', tags: ['ok', 42, null] }]))
    expect(result[0].tags).toEqual(['ok'])
  })
})

describe('connectionDedupKey', () => {
  it('treats same host, port, user, and type as duplicates', () => {
    const a = makeSession()
    const b = makeSession({ id: 'other', label: 'Different Label' })
    expect(connectionDedupKey(a)).toBe(connectionDedupKey(b))
  })

  it('distinguishes by type and username', () => {
    const ssh = makeSession()
    const sftp = makeSession({ type: 'sftp' })
    const otherUser = makeSession({ username: 'root' })
    expect(connectionDedupKey(ssh)).not.toBe(connectionDedupKey(sftp))
    expect(connectionDedupKey(ssh)).not.toBe(connectionDedupKey(otherUser))
  })
})
