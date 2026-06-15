import { describe, it, expect } from 'vitest'

// Session type matching the production code
interface Session {
  id: string
  label: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  keyPath?: string
  group?: string
  createdAt: number
  type?: 'ssh' | 'sftp' | 'database' | 'kubernetes' | 'redis'
  hasPassword?: boolean
  password?: string
}

// Extracted pure logic from sessions.ts for testing

function stripPasswordFromSession(session: Session): Omit<Session, 'password'> & { hasPassword: boolean } {
  const { password: _pw, ...rest } = session
  return { ...rest, hasPassword: !!_pw }
}

function sessionsNeedMigration(sessions: Session[]): boolean {
  return sessions.some((s) => !!s.password)
}

function migrateSessionPasswords(sessions: Session[]): { sessions: Session[]; passwordMap: Map<string, string> } {
  const passwordMap = new Map<string, string>()
  const migrated = sessions.map((s) => {
    if (s.password) {
      passwordMap.set(s.id, s.password)
      const { password: _, ...rest } = s
      return rest as Session
    }
    return s
  })
  return { sessions: migrated, passwordMap }
}

describe('Session CRUD logic', () => {
  describe('stripPasswordFromSession', () => {
    it('removes password and sets hasPassword to true when password exists', () => {
      const session: Session = {
        id: '1', label: 'Test', host: 'localhost', port: 22,
        username: 'user', authType: 'password', createdAt: Date.now(),
        password: 'secret123',
      }
      const result = stripPasswordFromSession(session)
      expect(result).not.toHaveProperty('password')
      expect(result.hasPassword).toBe(true)
      expect(result.id).toBe('1')
    })

    it('sets hasPassword to false when no password', () => {
      const session: Session = {
        id: '2', label: 'Key Auth', host: 'server.com', port: 22,
        username: 'deploy', authType: 'key', createdAt: Date.now(),
        keyPath: '~/.ssh/id_rsa',
      }
      const result = stripPasswordFromSession(session)
      expect(result.hasPassword).toBe(false)
      expect(result).not.toHaveProperty('password')
    })

    it('preserves all non-password fields', () => {
      const session: Session = {
        id: '3', label: 'Full', host: '10.0.0.1', port: 2222,
        username: 'admin', authType: 'password', createdAt: 1000,
        type: 'ssh', group: 'production', password: 'pw',
      }
      const result = stripPasswordFromSession(session)
      expect(result.label).toBe('Full')
      expect(result.host).toBe('10.0.0.1')
      expect(result.port).toBe(2222)
      expect(result.username).toBe('admin')
      expect(result.type).toBe('ssh')
      expect(result.group).toBe('production')
    })
  })

  describe('sessionsNeedMigration', () => {
    it('returns true when sessions have plaintext passwords', () => {
      const sessions: Session[] = [
        { id: '1', label: 'A', host: 'a', port: 22, username: 'u', authType: 'password', createdAt: 0, password: 'pw' },
        { id: '2', label: 'B', host: 'b', port: 22, username: 'u', authType: 'key', createdAt: 0 },
      ]
      expect(sessionsNeedMigration(sessions)).toBe(true)
    })

    it('returns false when no sessions have passwords', () => {
      const sessions: Session[] = [
        { id: '1', label: 'A', host: 'a', port: 22, username: 'u', authType: 'key', createdAt: 0 },
      ]
      expect(sessionsNeedMigration(sessions)).toBe(false)
    })

    it('returns false for empty array', () => {
      expect(sessionsNeedMigration([])).toBe(false)
    })
  })

  describe('migrateSessionPasswords', () => {
    it('extracts passwords into a map and removes them from sessions', () => {
      const sessions: Session[] = [
        { id: '1', label: 'A', host: 'a', port: 22, username: 'u', authType: 'password', createdAt: 0, password: 'secret1' },
        { id: '2', label: 'B', host: 'b', port: 22, username: 'u', authType: 'password', createdAt: 0, password: 'secret2' },
      ]
      const result = migrateSessionPasswords(sessions)
      expect(result.passwordMap.size).toBe(2)
      expect(result.passwordMap.get('1')).toBe('secret1')
      expect(result.passwordMap.get('2')).toBe('secret2')
      result.sessions.forEach((s) => expect(s).not.toHaveProperty('password'))
    })

    it('does not touch sessions without passwords', () => {
      const sessions: Session[] = [
        { id: '1', label: 'A', host: 'a', port: 22, username: 'u', authType: 'key', createdAt: 0 },
      ]
      const result = migrateSessionPasswords(sessions)
      expect(result.passwordMap.size).toBe(0)
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0].id).toBe('1')
    })

    it('handles mixed sessions correctly', () => {
      const sessions: Session[] = [
        { id: '1', label: 'With PW', host: 'a', port: 22, username: 'u', authType: 'password', createdAt: 0, password: 'pw' },
        { id: '2', label: 'Key Only', host: 'b', port: 22, username: 'u', authType: 'key', createdAt: 0 },
        { id: '3', label: 'Also PW', host: 'c', port: 22, username: 'u', authType: 'password', createdAt: 0, password: 'pw2' },
      ]
      const result = migrateSessionPasswords(sessions)
      expect(result.passwordMap.size).toBe(2)
      expect(result.sessions).toHaveLength(3)
      expect(result.sessions[1].label).toBe('Key Only')
    })
  })
})
