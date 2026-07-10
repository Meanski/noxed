import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ipc, readFileMock } = vi.hoisted(() => ({
  ipc: { handlers: new Map<string, (...args: unknown[]) => unknown>() },
  readFileMock: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, fn)
    }),
    on: vi.fn(),
  },
}))
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}))

import { parseSshConfig, registerSshConfigHandlers } from '../sshConfig'

describe('parseSshConfig', () => {
  it('parses a basic host block', () => {
    const hosts = parseSshConfig(`
Host web
  HostName web.example.com
  Port 2222
  User deploy
  IdentityFile ~/.ssh/id_ed25519
`)
    expect(hosts).toEqual([
      { alias: 'web', host: 'web.example.com', port: 2222, username: 'deploy', keyPath: '~/.ssh/id_ed25519' },
    ])
  })

  it('falls back to the alias when HostName is missing', () => {
    const hosts = parseSshConfig('Host db.internal\n  User admin\n')
    expect(hosts).toEqual([
      { alias: 'db.internal', host: 'db.internal', port: 22, username: 'admin', keyPath: undefined },
    ])
  })

  it('defaults the port to 22 and ignores invalid ports', () => {
    const hosts = parseSshConfig('Host a\n  HostName a.example.com\n  Port 99999\n')
    expect(hosts[0].port).toBe(22)
  })

  it('skips wildcard and negated host patterns', () => {
    const hosts = parseSshConfig(`
Host *
  User root
Host web-?
  Port 2222
Host !bastion staging
  HostName staging.example.com
`)
    expect(hosts).toEqual([
      { alias: 'staging', host: 'staging.example.com', port: 22, username: undefined, keyPath: undefined },
    ])
  })

  it('expands multiple aliases on one Host line into separate entries', () => {
    const hosts = parseSshConfig('Host web1 web2\n  HostName 10.0.0.5\n  User app\n')
    expect(hosts.map(h => h.alias)).toEqual(['web1', 'web2'])
    expect(hosts.every(h => h.host === '10.0.0.5' && h.username === 'app')).toBe(true)
  })

  it('keeps the first IdentityFile when several are listed', () => {
    const hosts = parseSshConfig(`
Host multi
  IdentityFile ~/.ssh/primary
  IdentityFile ~/.ssh/fallback
`)
    expect(hosts[0].keyPath).toBe('~/.ssh/primary')
  })

  it('supports Key=Value syntax and quoted values', () => {
    const hosts = parseSshConfig('Host q\n  HostName=q.example.com\n  IdentityFile "~/.ssh/my key"\n')
    expect(hosts[0].host).toBe('q.example.com')
    expect(hosts[0].keyPath).toBe('~/.ssh/my key')
  })

  it('ignores comments, blank lines, and Match blocks', () => {
    const hosts = parseSshConfig(`
# global defaults
Host real
  HostName real.example.com

Match host *.example.com
  User matched

Host after-match
  User direct
`)
    expect(hosts).toEqual([
      { alias: 'real', host: 'real.example.com', port: 22, username: undefined, keyPath: undefined },
      { alias: 'after-match', host: 'after-match', port: 22, username: 'direct', keyPath: undefined },
    ])
  })

  it('captures the first ProxyJump hop and ignores "none"', () => {
    const hosts = parseSshConfig(`
Host inner
  HostName 10.0.0.8
  ProxyJump bastion
Host multi
  HostName 10.0.0.9
  ProxyJump user@jump1:2222, jump2
Host direct
  HostName 10.0.0.10
  ProxyJump none
`)
    expect(hosts[0].proxyJump).toBe('bastion')
    expect(hosts[1].proxyJump).toBe('user@jump1:2222')
    expect(hosts[2].proxyJump).toBeUndefined()
  })

  it('returns an empty list for empty or comment-only content', () => {
    expect(parseSshConfig('')).toEqual([])
    expect(parseSshConfig('# nothing here\n')).toEqual([])
  })

  it('skips directives without a value', () => {
    // A bare keyword ("Host" with no argument) is not a valid directive
    const hosts = parseSshConfig('Host\nHost real\n  HostName\n  Port\n')
    expect(hosts).toEqual([
      { alias: 'real', host: 'real', port: 22, username: undefined, keyPath: undefined },
    ])
  })

  it('ignores unrelated directives inside a host block', () => {
    const hosts = parseSshConfig('Host web\n  ServerAliveInterval 60\n  Compression yes\n')
    expect(hosts).toEqual([
      { alias: 'web', host: 'web', port: 22, username: undefined, keyPath: undefined },
    ])
  })

  it('drops quoted wildcard patterns and keeps quoted concrete aliases', () => {
    const hosts = parseSshConfig('Host "web prod" "*"\n  HostName 10.0.0.4\n')
    // "web prod" splits on whitespace before unquoting, so each token is checked on its own
    expect(hosts.every(h => h.host === '10.0.0.4')).toBe(true)
    expect(hosts.some(h => h.alias.includes('*'))).toBe(false)
  })
})

describe('sshconfig:hosts handler', () => {
  registerSshConfigHandlers()
  const invoke = () => {
    const handler = ipc.handlers.get('sshconfig:hosts')
    if (!handler) throw new Error('sshconfig:hosts handler not registered')
    return handler() as Promise<unknown>
  }

  beforeEach(() => {
    readFileMock.mockReset()
  })

  it('reads ~/.ssh/config and returns parsed hosts', async () => {
    readFileMock.mockResolvedValue('Host web\n  HostName web.example.com\n  Port 2200\n')
    await expect(invoke()).resolves.toEqual([
      { alias: 'web', host: 'web.example.com', port: 2200, username: undefined, keyPath: undefined },
    ])
    expect(readFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]\.ssh[/\\]config$/),
      'utf-8'
    )
  })

  it('returns an empty list when the config file does not exist', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(invoke()).resolves.toEqual([])
  })

  it('wraps other read errors with a descriptive message', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(invoke()).rejects.toThrow('Cannot read ~/.ssh/config: permission denied')
  })

  it('stringifies non-Error rejection reasons', async () => {
    readFileMock.mockRejectedValue('disk on fire')
    await expect(invoke()).rejects.toThrow('Cannot read ~/.ssh/config: disk on fire')
  })
})
