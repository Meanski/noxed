import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ipc, storeData } = vi.hoisted(() => ({
  ipc: { handlers: new Map<string, (...args: unknown[]) => unknown>() },
  storeData: new Map<string, Map<string, unknown>>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, fn)
    }),
    on: vi.fn(),
  },
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
}))

vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Map<string, unknown>

    constructor(opts?: { name?: string; defaults?: Record<string, unknown> }) {
      const name = opts?.name ?? 'config'
      let data = storeData.get(name)
      if (!data) {
        data = new Map()
        storeData.set(name, data)
      }
      this.data = data
      for (const [key, value] of Object.entries(opts?.defaults ?? {})) {
        if (!this.data.has(key)) this.data.set(key, value)
      }
    }

    get(key: string) { return this.data.get(key) }
    set(key: string, value: unknown) { this.data.set(key, value) }
  },
}))

vi.mock('../keychain', () => ({
  saveCredential: vi.fn(async () => {}),
  getCredential: vi.fn(async () => null),
  deleteCredentials: vi.fn(async () => {}),
  isUnlocked: vi.fn(() => true),
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(async () => {}),
}))

import { dialog, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { registerSessionHandlers, getSessionById, listSessions, type Session } from '../sessions'
import { saveCredential, getCredential, deleteCredentials, isUnlocked } from '../keychain'
import { ValidationError } from '../errors'

registerSessionHandlers()

interface StoredSession extends Session {
  password?: string
}

function seed(sessions: StoredSession[]): void {
  storeData.get('config')?.set('sessions', sessions)
}

function stored(): StoredSession[] {
  return storeData.get('config')?.get('sessions') as StoredSession[]
}

function makeEvent() {
  return { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } }
}

function invoke<T = unknown>(channel: string, ...args: unknown[]): T {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`${channel} handler not registered`)
  return handler(makeEvent(), ...args) as T
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'session-1',
    label: 'Prod',
    host: 'prod.example.com',
    port: 22,
    username: 'root',
    authType: 'password',
    createdAt: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isUnlocked).mockReturnValue(true)
  vi.mocked(getCredential).mockResolvedValue(null)
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as never)
  seed([])
})

describe('getSessionById and listSessions', () => {
  it('returns the session without its legacy password', () => {
    seed([makeSession({ password: 'legacy' })])
    const session = getSessionById('session-1')
    expect(session).toBeDefined()
    expect(session).not.toHaveProperty('password')
    expect(session?.host).toBe('prod.example.com')
  })

  it('returns undefined for an unknown id', () => {
    seed([makeSession()])
    expect(getSessionById('nope')).toBeUndefined()
  })

  it('listSessions strips passwords from every session', () => {
    seed([makeSession({ password: 'legacy' }), makeSession({ id: 'session-2' })])
    const sessions = listSessions()
    expect(sessions).toHaveLength(2)
    for (const s of sessions) expect(s).not.toHaveProperty('password')
  })
})

describe('sessions:list', () => {
  it('returns sessions with derived hasPassword flags', async () => {
    seed([
      makeSession({ id: 'a', hasPassword: true }),
      makeSession({ id: 'b' }),
    ])
    const result = await invoke<Promise<Session[]>>('sessions:list')
    expect(result).toHaveLength(2)
    expect(result[0].hasPassword).toBe(true)
    expect(result[1].hasPassword).toBe(false)
  })

  it('migrates legacy plaintext passwords into the keychain', async () => {
    seed([
      makeSession({ id: 'legacy', password: 'old-secret' }),
      makeSession({ id: 'clean' }),
    ])
    const result = await invoke<Promise<Session[]>>('sessions:list')

    expect(saveCredential).toHaveBeenCalledTimes(1)
    expect(saveCredential).toHaveBeenCalledWith('legacy', 'password', 'old-secret')
    expect(result[0]).not.toHaveProperty('password')
    expect(result[0].hasPassword).toBe(true)
    expect(stored()[0]).not.toHaveProperty('password')
    expect(stored()[0].hasPassword).toBe(true)
  })

  it('does not migrate again on subsequent lists', async () => {
    seed([makeSession({ id: 'legacy', password: 'old-secret' })])
    await invoke<Promise<Session[]>>('sessions:list')
    await invoke<Promise<Session[]>>('sessions:list')
    expect(saveCredential).toHaveBeenCalledTimes(1)
  })
})

describe('sessions:create', () => {
  it('creates a session with a generated id and createdAt', async () => {
    const before = Date.now()
    const session = await invoke<Promise<Session>>('sessions:create', {
      label: 'New', host: 'new.example.com', port: 2222, username: 'deploy', authType: 'key',
    })
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(session.createdAt).toBeGreaterThanOrEqual(before)
    expect(session.hasPassword).toBe(false)
    expect(saveCredential).not.toHaveBeenCalled()
    expect(stored()).toHaveLength(1)
    expect(stored()[0].host).toBe('new.example.com')
  })

  it('stores the password in the keychain, never in the store', async () => {
    const session = await invoke<Promise<Session>>('sessions:create', {
      label: 'PW', host: 'pw.example.com', port: 22, username: 'u', authType: 'password', password: 'hunter2',
    })
    expect(saveCredential).toHaveBeenCalledWith(session.id, 'password', 'hunter2')
    expect(session.hasPassword).toBe(true)
    expect(session).not.toHaveProperty('password')
    expect(stored()[0]).not.toHaveProperty('password')
  })

  it('ignores a renderer-claimed hasPassword flag', async () => {
    const session = await invoke<Promise<Session>>('sessions:create', {
      label: 'Claim', host: 'c.example.com', port: 22, username: 'u', authType: 'password', hasPassword: true,
    })
    expect(session.hasPassword).toBe(false)
  })
})

describe('sessions:update', () => {
  it('merges fields and returns the updated session', async () => {
    seed([makeSession(), makeSession({ id: 'session-2', label: 'Other' })])
    const updated = await invoke<Promise<Session>>('sessions:update', 'session-1', { label: 'Renamed', port: 2200 })
    expect(updated.label).toBe('Renamed')
    expect(updated.port).toBe(2200)
    expect(updated.host).toBe('prod.example.com')
    expect(stored()[1].label).toBe('Other')
    expect(saveCredential).not.toHaveBeenCalled()
    expect(deleteCredentials).not.toHaveBeenCalled()
  })

  it('saves a new password to the keychain and sets hasPassword', async () => {
    seed([makeSession()])
    const updated = await invoke<Promise<Session>>('sessions:update', 'session-1', { password: 'new-pw' })
    expect(saveCredential).toHaveBeenCalledWith('session-1', 'password', 'new-pw')
    expect(updated.hasPassword).toBe(true)
    expect(stored()[0]).not.toHaveProperty('password')
  })

  it('deletes credentials when the password is cleared with an empty string', async () => {
    seed([makeSession({ hasPassword: true })])
    const updated = await invoke<Promise<Session>>('sessions:update', 'session-1', { password: '' })
    expect(deleteCredentials).toHaveBeenCalledWith('session-1')
    expect(saveCredential).not.toHaveBeenCalled()
    expect(updated.hasPassword).toBe(false)
  })

  it('never trusts a renderer-supplied hasPassword flag', async () => {
    seed([makeSession()])
    const updated = await invoke<Promise<Session>>('sessions:update', 'session-1', { hasPassword: true })
    expect(updated.hasPassword).toBeUndefined()
  })

  it('returns undefined for an unknown id', async () => {
    seed([makeSession()])
    const updated = await invoke<Promise<Session | undefined>>('sessions:update', 'missing', { label: 'x' })
    expect(updated).toBeUndefined()
    expect(stored()[0].label).toBe('Prod')
  })
})

describe('sessions:delete', () => {
  it('deletes the session and its credentials', async () => {
    seed([makeSession(), makeSession({ id: 'session-2' })])
    await invoke<Promise<void>>('sessions:delete', 'session-1')
    expect(deleteCredentials).toHaveBeenCalledWith('session-1')
    expect(stored()).toHaveLength(1)
    expect(stored()[0].id).toBe('session-2')
  })
})

describe('sessions:getCredentials', () => {
  it('throws when the app is locked', async () => {
    vi.mocked(isUnlocked).mockReturnValue(false)
    await expect(invoke<Promise<unknown>>('sessions:getCredentials', 'session-1'))
      .rejects.toThrow('App is locked — unlock noxed to access credentials')
    expect(getCredential).not.toHaveBeenCalled()
  })

  it('returns the stored password when unlocked', async () => {
    vi.mocked(getCredential).mockResolvedValue('secret')
    const result = await invoke<Promise<{ password?: string }>>('sessions:getCredentials', 'session-1')
    expect(getCredential).toHaveBeenCalledWith('session-1', 'password')
    expect(result).toEqual({ password: 'secret' })
  })

  it('maps a missing credential to undefined', async () => {
    const result = await invoke<Promise<{ password?: string }>>('sessions:getCredentials', 'session-1')
    expect(result).toEqual({ password: undefined })
  })
})

describe('sessions:count and sessions:clearAll', () => {
  it('counts stored sessions', () => {
    seed([makeSession(), makeSession({ id: 'session-2' })])
    expect(invoke<number>('sessions:count')).toBe(2)
  })

  it('clearAll deletes credentials for every session and empties the store', async () => {
    seed([makeSession(), makeSession({ id: 'session-2' })])
    await invoke<Promise<void>>('sessions:clearAll')
    expect(deleteCredentials).toHaveBeenCalledTimes(2)
    expect(deleteCredentials).toHaveBeenCalledWith('session-1')
    expect(deleteCredentials).toHaveBeenCalledWith('session-2')
    expect(stored()).toEqual([])
  })
})

describe('sessions:export', () => {
  it('throws when no window is attached to the sender', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null as never)
    await expect(invoke<Promise<unknown>>('sessions:export')).rejects.toThrow('No window for export dialog')
  })

  it('returns canceled without writing when the dialog is dismissed', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: undefined } as never)
    const result = await invoke<Promise<unknown>>('sessions:export')
    expect(result).toEqual({ exported: 0, canceled: true })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('writes a credential-free export file', async () => {
    seed([makeSession({ password: 'legacy', hasPassword: true }), makeSession({ id: 'session-2', host: 'other.example.com' })])
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' } as never)

    const result = await invoke<Promise<unknown>>('sessions:export')
    expect(result).toEqual({ exported: 2, canceled: false })
    expect(writeFile).toHaveBeenCalledTimes(1)

    const [path, content, encoding] = vi.mocked(writeFile).mock.calls[0]
    expect(path).toBe('/tmp/out.json')
    expect(encoding).toBe('utf-8')
    const doc = JSON.parse(content as string)
    expect(doc.format).toBe('noxed-connections')
    expect(doc.connections).toHaveLength(2)
    for (const conn of doc.connections) {
      expect(conn).not.toHaveProperty('password')
      expect(conn).not.toHaveProperty('id')
      expect(conn).not.toHaveProperty('hasPassword')
    }
  })
})

describe('sessions:import', () => {
  function exportDoc(connections: unknown[]): string {
    return JSON.stringify({ format: 'noxed-connections', version: 1, connections })
  }

  it('throws when no window is attached to the sender', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null as never)
    await expect(invoke<Promise<unknown>>('sessions:import')).rejects.toThrow('No window for import dialog')
  })

  it('returns canceled when the dialog is dismissed', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] } as never)
    const result = await invoke<Promise<unknown>>('sessions:import')
    expect(result).toEqual({ imported: 0, skipped: 0, canceled: true })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('imports new connections and skips duplicates of existing sessions', async () => {
    seed([makeSession({ host: 'dup.example.com', username: 'u' })])
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['/tmp/in.json'] } as never)
    vi.mocked(readFile).mockResolvedValue(exportDoc([
      { label: 'Fresh', host: 'fresh.example.com', port: 22, username: 'u', authType: 'password', type: 'ssh' },
      { label: 'Dup', host: 'dup.example.com', port: 22, username: 'u', authType: 'password', type: 'ssh' },
    ]) as never)

    const result = await invoke<Promise<unknown>>('sessions:import')
    expect(readFile).toHaveBeenCalledWith('/tmp/in.json', 'utf-8')
    expect(result).toEqual({ imported: 1, skipped: 1, canceled: false })
    expect(stored()).toHaveLength(2)
    const imported = stored()[1]
    expect(imported.host).toBe('fresh.example.com')
    expect(imported.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(imported.createdAt).toBeGreaterThan(0)
  })

  it('skips duplicates within the imported file itself', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['/tmp/in.json'] } as never)
    const conn = { label: 'Twin', host: 'twin.example.com', port: 22, username: 'u', authType: 'password', type: 'ssh' }
    vi.mocked(readFile).mockResolvedValue(exportDoc([conn, { ...conn }]) as never)

    const result = await invoke<Promise<unknown>>('sessions:import')
    expect(result).toEqual({ imported: 1, skipped: 1, canceled: false })
    expect(stored()).toHaveLength(1)
  })

  it('rejects files that are not valid noxed exports', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['/tmp/in.json'] } as never)
    vi.mocked(readFile).mockResolvedValue('this is not json' as never)
    await expect(invoke<Promise<unknown>>('sessions:import')).rejects.toThrow(ValidationError)
  })
})
