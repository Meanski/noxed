import { ipcMain, dialog, BrowserWindow } from 'electron'
import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { saveCredential, getCredential, deleteCredentials, isUnlocked } from './keychain'
import { serializeSessions, parseSessionsExport, connectionDedupKey } from './sessionTransfer'

export interface Session {
  id: string
  label: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  // password is NEVER stored here — lives in macOS Keychain
  keyPath?: string
  group?: string
  createdAt: number
  type?: 'ssh' | 'sftp' | 'database' | 'kubernetes' | 'redis'
  color?: string
  tags?: string[]
  isFavorite?: boolean
  pollingEnabled?: boolean
  pollingIntervalSeconds?: number
  dbType?: string
  databaseName?: string
  sslMode?: string
  redisDb?: number
  connectOnStart?: boolean
  // Kubernetes-specific
  contextName?: string
  kubeconfigPath?: string
  // Connect through another saved SSH connection (ProxyJump)
  jumpHostId?: string
  // UI hint: a credential exists in the keychain for this session
  hasPassword?: boolean
}

// Legacy shape: sessions that may have plaintext passwords from before the keychain migration
interface LegacySession extends Session {
  password?: string
}

interface StoreSchema {
  sessions: LegacySession[]
}

const store = new Store<StoreSchema>({
  defaults: { sessions: [] }
})

export function getSessionById(id: string): Session | undefined {
  const found = (store.get('sessions') as LegacySession[]).find((s) => s.id === id)
  if (!found) return undefined
  const { password: _pw, ...session } = found
  return session
}

export function listSessions(): Session[] {
  return (store.get('sessions') as LegacySession[]).map(({ password: _pw, ...s }) => s)
}

async function migrateLegacyPasswords(): Promise<void> {
  const sessions = store.get('sessions') as LegacySession[]
  let dirty = false

  for (const s of sessions) {
    if (s.password) {
      await saveCredential(s.id, 'password', s.password)
      delete s.password
      s.hasPassword = true
      dirty = true
    }
  }

  if (dirty) {
    store.set('sessions', sessions)
  }
}

export function registerSessionHandlers(): void {
  ipcMain.handle('sessions:list', async () => {
    // Migrate any plaintext passwords on first access
    await migrateLegacyPasswords()

    const sessions = store.get('sessions') as LegacySession[]
    return sessions.map(({ password: _pw, ...s }) => ({
      ...s,
      hasPassword: s.hasPassword ?? !!_pw,
    }))
  })

  ipcMain.handle('sessions:create', async (_e, data: Omit<LegacySession, 'id' | 'createdAt'>) => {
    // hasPassword is derived here, never trusted from the renderer — a stale
    // flag would point at a keychain entry that does not exist
    const { password, hasPassword: _claimed, ...rest } = data
    const session: Session = { ...rest, id: randomUUID(), createdAt: Date.now(), hasPassword: false }

    if (password) {
      await saveCredential(session.id, 'password', password)
      session.hasPassword = true
    }

    const sessions = store.get('sessions')
    store.set('sessions', [...sessions, session])
    return session
  })

  ipcMain.handle('sessions:update', async (_e, id: string, data: Partial<LegacySession>) => {
    const { password, ...rest } = data
    // hasPassword is derived from the keychain writes below, never trusted
    // from the renderer
    delete rest.hasPassword

    if (password !== undefined) {
      if (password) {
        await saveCredential(id, 'password', password)
        rest.hasPassword = true
      } else {
        await deleteCredentials(id)
        rest.hasPassword = false
      }
    }

    const sessions = store.get('sessions')
    const updated = sessions.map((s) => (s.id === id ? { ...s, ...rest } : s))
    store.set('sessions', updated)
    return updated.find((s) => s.id === id)
  })

  ipcMain.handle('sessions:delete', async (_e, id: string) => {
    await deleteCredentials(id)
    const sessions = store.get('sessions').filter((s) => s.id !== id)
    store.set('sessions', sessions)
  })

  // Returns credentials for a session — requires the app to be unlocked
  ipcMain.handle('sessions:getCredentials', async (_e, sessionId: string) => {
    if (!isUnlocked()) {
      throw new Error('App is locked — unlock noxed to access credentials')
    }
    const password = await getCredential(sessionId, 'password')
    return { password: password ?? undefined }
  })

  ipcMain.handle('sessions:count', () => {
    return store.get('sessions').length
  })

  ipcMain.handle('sessions:clearAll', async () => {
    const sessions = store.get('sessions')
    for (const s of sessions) {
      await deleteCredentials(s.id)
    }
    store.set('sessions', [])
  })

  // Backup of connection settings only — credentials stay in the keychain
  ipcMain.handle('sessions:export', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('No window for export dialog')
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export connections',
      defaultPath: 'noxed-connections.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { exported: 0, canceled: true }

    const sessions = store.get('sessions').map(({ password: _pw, ...s }) => s)
    await writeFile(filePath, serializeSessions(sessions), 'utf-8')
    return { exported: sessions.length, canceled: false }
  })

  ipcMain.handle('sessions:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('No window for import dialog')
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import connections',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return { imported: 0, skipped: 0, canceled: true }

    const content = await readFile(filePaths[0], 'utf-8')
    const incoming = parseSessionsExport(content)

    const sessions = store.get('sessions')
    const existingKeys = new Set(sessions.map(connectionDedupKey))
    let skipped = 0

    for (const conn of incoming) {
      const key = connectionDedupKey(conn)
      if (existingKeys.has(key)) {
        skipped++
        continue
      }
      existingKeys.add(key)
      sessions.push({ ...conn, id: randomUUID(), createdAt: Date.now() })
    }

    store.set('sessions', sessions)
    return { imported: incoming.length - skipped, skipped, canceled: false }
  })
}
