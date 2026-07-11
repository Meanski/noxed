import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ipc } = vi.hoisted(() => ({
  ipc: {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
  },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, fn)
    }),
    on: vi.fn(),
  },
}))

vi.mock('node:os', () => ({
  homedir: () => '/home/tester',
}))

vi.mock('node:fs', () => ({
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

import { readdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { registerLocalFsHandlers } from '../localfs'
import { ValidationError } from '../errors'

registerLocalFsHandlers()

const event = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } }

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`${channel} handler not registered`)
  return handler(event, ...args)
}

function makeStats(overrides: Record<string, unknown> = {}) {
  return {
    size: 5,
    mtimeMs: 1111,
    mode: 0o644,
    isFile: () => true,
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(readdirSync).mockReset()
  vi.mocked(statSync).mockReset()
  vi.mocked(readFile).mockReset()
  vi.mocked(writeFile).mockReset()
})

describe('localfs:home', () => {
  it('returns the home directory', () => {
    expect(invoke('localfs:home')).toBe('/home/tester')
  })
})

describe('localfs:list', () => {
  it('lists directory entries with their stats', () => {
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'notes.txt', isDirectory: () => false },
      { name: 'projects', isDirectory: () => true },
    ] as never)
    vi.mocked(statSync).mockImplementation(((path: string) => {
      if (path === '/home/tester/docs/notes.txt') return makeStats({ size: 42, mtimeMs: 1234, mode: 0o600 })
      return makeStats({ size: 0, mtimeMs: 5678, mode: 0o755, isFile: () => false })
    }) as never)

    expect(invoke('localfs:list', '/home/tester/docs')).toEqual([
      {
        name: 'notes.txt',
        size: 42,
        mtime: 1234,
        permissions: 0o600,
        isDirectory: false,
        path: '/home/tester/docs/notes.txt',
      },
      {
        name: 'projects',
        size: 0,
        mtime: 5678,
        permissions: 0o755,
        isDirectory: true,
        path: '/home/tester/docs/projects',
      },
    ])
  })

  it('expands ~ to the home directory', () => {
    vi.mocked(readdirSync).mockReturnValue([] as never)
    expect(invoke('localfs:list', '~/docs')).toEqual([])
    expect(readdirSync).toHaveBeenCalledWith('/home/tester/docs', { withFileTypes: true })
  })

  it('falls back to zeroed stats for entries that cannot be statted', () => {
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'broken-link', isDirectory: () => false },
    ] as never)
    vi.mocked(statSync).mockImplementation(() => { throw new Error('ENOENT') })

    expect(invoke('localfs:list', '/home/tester')).toEqual([
      {
        name: 'broken-link',
        size: 0,
        mtime: 0,
        permissions: 0,
        isDirectory: false,
        path: '/home/tester/broken-link',
      },
    ])
  })

  it('rejects paths outside the home directory and invalid paths', () => {
    expect(() => invoke('localfs:list', '/etc')).toThrow(ValidationError)
    expect(() => invoke('localfs:list', '/home/tester/../../etc')).toThrow(ValidationError)
    expect(() => invoke('localfs:list', '')).toThrow(ValidationError)
    expect(() => invoke('localfs:list', 42)).toThrow(ValidationError)
    expect(readdirSync).not.toHaveBeenCalled()
  })
})

describe('localfs:readTextFile', () => {
  it('reads a text file as utf8', async () => {
    vi.mocked(statSync).mockReturnValue(makeStats() as never)
    vi.mocked(readFile).mockResolvedValue(Buffer.from('hello world') as never)
    await expect(invoke('localfs:readTextFile', '/home/tester/notes.txt')).resolves.toBe('hello world')
  })

  it('rejects paths outside the home directory', async () => {
    await expect(invoke('localfs:readTextFile', '/etc/passwd')).rejects.toThrow(ValidationError)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects non-regular files', async () => {
    vi.mocked(statSync).mockReturnValue(makeStats({ isFile: () => false }) as never)
    await expect(invoke('localfs:readTextFile', '/home/tester/somedir')).rejects.toThrow('Not a regular file')
  })

  it('rejects files with a known binary extension', async () => {
    vi.mocked(statSync).mockReturnValue(makeStats() as never)
    await expect(invoke('localfs:readTextFile', '/home/tester/photo.png'))
      .rejects.toThrow('Cannot open binary file in editor')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects files that are too large to open', async () => {
    vi.mocked(statSync).mockReturnValue(makeStats({ size: 11 * 1024 * 1024 }) as never)
    await expect(invoke('localfs:readTextFile', '/home/tester/huge.log'))
      .rejects.toThrow('Cannot open binary file in editor')
  })

  it('rejects files whose content sniffs as binary', async () => {
    vi.mocked(statSync).mockReturnValue(makeStats() as never)
    vi.mocked(readFile).mockResolvedValue(Buffer.from('ab\0cd') as never)
    await expect(invoke('localfs:readTextFile', '/home/tester/mystery'))
      .rejects.toThrow('File appears to be binary')
  })
})

describe('localfs:writeTextFile', () => {
  it('writes string content and resolves true', async () => {
    await expect(invoke('localfs:writeTextFile', '~/notes.txt', 'new content')).resolves.toBe(true)
    expect(writeFile).toHaveBeenCalledWith('/home/tester/notes.txt', 'new content', 'utf8')
  })

  it('rejects paths outside the home directory', async () => {
    await expect(invoke('localfs:writeTextFile', '/etc/hosts', 'evil')).rejects.toThrow(ValidationError)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('rejects non-string content', async () => {
    await expect(invoke('localfs:writeTextFile', '/home/tester/notes.txt', Buffer.from('x')))
      .rejects.toThrow('Invalid file content')
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('rejects content larger than the 10MB limit', async () => {
    const huge = 'x'.repeat(10 * 1024 * 1024 + 1)
    await expect(invoke('localfs:writeTextFile', '/home/tester/notes.txt', huge))
      .rejects.toThrow('File content is too large')
    expect(writeFile).not.toHaveBeenCalled()
  })
})
