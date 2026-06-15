import { describe, it, expect } from 'vitest'
import { isBlockedRedisCommand, getBlockedRedisCommands } from '../security'

describe('Redis command blocklist', () => {
  describe('isBlockedRedisCommand', () => {
    const blockedCommands = [
      'FLUSHALL',
      'FLUSHDB',
      'SHUTDOWN',
      'DEBUG',
      'SLAVEOF',
      'REPLICAOF',
      'CONFIG',
      'BGSAVE',
      'BGREWRITEAOF',
      'CLUSTER',
      'MIGRATE',
      'RESTORE',
      'SWAPDB',
      'FAILOVER',
      'RESET',
      'ACL',
      'MODULE',
      'MONITOR',
      'SUBSCRIBE',
      'PSUBSCRIBE',
      'UNSUBSCRIBE',
      'PUNSUBSCRIBE',
      'CLIENT',
    ]

    blockedCommands.forEach((cmd) => {
      it(`blocks "${cmd}" (uppercase)`, () => {
        expect(isBlockedRedisCommand(cmd)).toBe(true)
      })

      it(`blocks "${cmd.toLowerCase()}" (lowercase)`, () => {
        expect(isBlockedRedisCommand(cmd.toLowerCase())).toBe(true)
      })
    })

    it('blocks commands with arguments', () => {
      expect(isBlockedRedisCommand('FLUSHALL ASYNC')).toBe(true)
      expect(isBlockedRedisCommand('CONFIG SET maxmemory 100mb')).toBe(true)
      expect(isBlockedRedisCommand('shutdown nosave')).toBe(true)
    })

    it('blocks commands with leading/trailing whitespace', () => {
      expect(isBlockedRedisCommand('  FLUSHALL  ')).toBe(true)
      expect(isBlockedRedisCommand('\tSHUTDOWN\t')).toBe(true)
    })

    const allowedCommands = [
      'GET mykey',
      'SET mykey myval',
      'DEL mykey',
      'HGET hash field',
      'LPUSH list val',
      'PING',
      'INFO',
      'SCAN 0 MATCH * COUNT 100',
      'TTL mykey',
      'EXISTS mykey',
      'TYPE mykey',
      'KEYS *',
    ]

    allowedCommands.forEach((cmd) => {
      it(`allows "${cmd}"`, () => {
        expect(isBlockedRedisCommand(cmd)).toBe(false)
      })
    })

    it('handles empty string', () => {
      expect(isBlockedRedisCommand('')).toBe(false)
    })

    it('handles whitespace-only string', () => {
      expect(isBlockedRedisCommand('   ')).toBe(false)
    })
  })

  describe('getBlockedRedisCommands', () => {
    it('returns a sorted array of strings', () => {
      const cmds = getBlockedRedisCommands()
      expect(cmds.length).toBeGreaterThan(10)
      for (let i = 1; i < cmds.length; i++) {
        expect(cmds[i] >= cmds[i - 1]).toBe(true)
      }
    })

    it('includes critical destructive commands', () => {
      const cmds = getBlockedRedisCommands()
      expect(cmds).toContain('flushall')
      expect(cmds).toContain('flushdb')
      expect(cmds).toContain('shutdown')
      expect(cmds).toContain('debug')
    })
  })
})
