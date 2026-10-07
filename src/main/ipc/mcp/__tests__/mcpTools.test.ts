import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

const state = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  approval: null as Error | null,
  exec: { stdout: 'up 3 days\n', stderr: '', code: 0, truncated: false } as Record<string, unknown>,
  sftp: {} as Record<string, unknown>,
}))
const dispose = vi.hoisted(() => vi.fn())
vi.mock('../../sessions', () => ({
  listSessions: () => state.sessions,
  getSessionById: (id: string) => state.sessions.find((s) => s.id === id),
}))
vi.mock('../../sshClients', () => ({
  connectSessionClient: vi.fn(async () => ({
    client: { sftp: (cb: (err: Error | null, sftp: unknown) => void) => cb(null, state.sftp) },
    dispose,
  })),
  execCapture: vi.fn(async () => state.exec),
}))
vi.mock('../mcpApprovals', () => ({
  requestApproval: vi.fn(async () => { if (state.approval) throw state.approval }),
}))

import { MCP_TOOLS } from '../mcpTools'
import { requestApproval } from '../mcpApprovals'
import { execCapture } from '../../sshClients'

const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!
const web = { id: 's1', label: 'web-01', host: 'web.lan', port: 22, username: 'deploy', type: 'ssh' }

beforeEach(() => {
  state.sessions = [web, { id: 'd1', label: 'db', host: 'db.lan', port: 5432, username: 'pg', type: 'database' }, { id: 'old', host: 'h', port: 22, username: 'root' }]
  state.approval = null
  dispose.mockClear()
  vi.mocked(requestApproval).mockClear()
})

describe('list_connections', () => {
  it('lists names, hosts and types, never secrets', async () => {
    const list = JSON.parse(await tool('list_connections').run({}))
    expect(list).toEqual([
      { id: 's1', name: 'web-01', type: 'ssh', host: 'web.lan', port: 22, username: 'deploy' },
      { id: 'd1', name: 'db', type: 'database', host: 'db.lan', port: 5432, username: 'pg' },
      { id: 'old', name: 'root@h', type: 'ssh', host: 'h', port: 22, username: 'root' },
    ])
  })
})

describe('run_command', () => {
  it('runs an approved command and reports its output', async () => {
    const text = await tool('run_command').run({ connection_id: 's1', command: 'uptime' })
    expect(requestApproval).toHaveBeenCalledWith('command', 's1', 'web-01', 'uptime')
    expect(execCapture).toHaveBeenCalledWith(expect.anything(), 'uptime', { timeoutMs: 60_000, maxBytes: 256 * 1024 })
    expect(text).toBe('exit code: 0\n\nstdout:\nup 3 days\n')
    expect(dispose).toHaveBeenCalled()
  })

  it('reports stderr, truncation and signals', async () => {
    state.exec = { stdout: '', stderr: 'boom', code: null, truncated: true }
    const text = await tool('run_command').run({ connection_id: 'old', command: 'x', timeout_seconds: 5 })
    expect(text).toContain('exit code: none (terminated by a signal)')
    expect(text).toContain('stderr:\nboom')
    expect(text).toContain('(output cut at 256 KB per stream)')
    state.exec = { stdout: 'up 3 days\n', stderr: '', code: 0, truncated: false }
  })

  it('refuses blocked commands before asking anyone', async () => {
    await expect(tool('run_command').run({ connection_id: 's1', command: 'sudo rm -rf /' })).rejects.toThrow('Refused')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('stops when the user declines', async () => {
    state.approval = new Error('The user declined this request in noxed.')
    await expect(tool('run_command').run({ connection_id: 's1', command: 'ls' })).rejects.toThrow('declined')
    expect(execCapture).not.toHaveBeenCalledWith(expect.anything(), 'ls', expect.anything())
  })

  it('validates its arguments and the connection', async () => {
    const run = tool('run_command').run
    await expect(run({ command: 'ls' })).rejects.toThrow('"connection_id"')
    await expect(run({ connection_id: 'nope', command: 'ls' })).rejects.toThrow('use list_connections')
    await expect(run({ connection_id: 'd1', command: 'ls' })).rejects.toThrow('need an SSH server')
    await expect(run({ connection_id: 's1', command: '' })).rejects.toThrow('"command"')
    await expect(run({ connection_id: 's1', command: 'ls', timeout_seconds: 9999 })).rejects.toThrow('timeout_seconds')
  })
})

describe('list_directory and read_file', () => {
  it('list a directory and read a file over SFTP after approval', async () => {
    const stats = { size: 3, mtime: 1_700_000_000, mode: 0o100644 }
    state.sftp = {
      readdir: (_p: string, cb: (e: null, l: unknown[]) => void) => cb(null, [{ filename: 'syslog', attrs: stats }]),
      stat: (_p: string, cb: (e: null, s: unknown) => void) => cb(null, stats),
      createReadStream: () => Readable.from([Buffer.from('ok\n')]),
    }
    expect(await tool('list_directory').run({ connection_id: 's1', path: '/var/log' })).toContain('syslog')
    expect(requestApproval).toHaveBeenLastCalledWith('read', 's1', 'web-01', 'list /var/log')
    expect(await tool('read_file').run({ connection_id: 's1', path: '/etc/motd' })).toBe('ok\n')
    expect(requestApproval).toHaveBeenLastCalledWith('read', 's1', 'web-01', 'read /etc/motd')
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('shows an empty directory as such', async () => {
    state.sftp = { readdir: (_p: string, cb: (e: null, l: unknown[]) => void) => cb(null, []) }
    expect(await tool('list_directory').run({ connection_id: 's1', path: '/empty' })).toBe('(empty)')
  })
})
