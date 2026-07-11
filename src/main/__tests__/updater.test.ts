import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  ipc: {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
  },
  updaterEvents: new Map<string, (...args: unknown[]) => unknown>(),
  app: { isPackaged: false, getVersion: () => '9.9.9' },
  windows: [] as Array<{ webContents: { isDestroyed: () => boolean; send: (...args: unknown[]) => void } }>,
}))

vi.mock('electron', () => ({
  app: state.app,
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      state.ipc.handlers.set(channel, fn)
    }),
    on: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => state.windows,
  },
}))

vi.mock('electron-updater', () => {
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    on: vi.fn((event: string, fn: (...args: unknown[]) => unknown) => {
      state.updaterEvents.set(event, fn)
      return autoUpdater
    }),
    checkForUpdates: vi.fn(() => Promise.resolve({})),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    quitAndInstall: vi.fn(),
  }
  return { autoUpdater }
})

import { ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { registerUpdaterHandlers, checkForUpdatesOnStartup } from '../updater'

registerUpdaterHandlers()

function makeWindow(destroyed = false) {
  const win = { webContents: { isDestroyed: () => destroyed, send: vi.fn() } }
  state.windows.push(win)
  return win
}

function invoke(channel: string): unknown {
  const handler = state.ipc.handlers.get(channel)
  if (!handler) throw new Error(`${channel} handler not registered`)
  return handler({ sender: { id: 1, send: vi.fn(), isDestroyed: () => false } })
}

beforeEach(() => {
  state.windows.length = 0
  state.app.isPackaged = false
  vi.mocked(autoUpdater.checkForUpdates).mockClear().mockResolvedValue({} as never)
  vi.mocked(autoUpdater.downloadUpdate).mockClear().mockResolvedValue([] as never)
  vi.mocked(autoUpdater.quitAndInstall).mockClear()
  vi.mocked(ipcMain.handle).mockClear()
})

describe('registerUpdaterHandlers', () => {
  it('configures manual download with install-on-quit staging', () => {
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('only wires handlers once', () => {
    registerUpdaterHandlers()
    expect(ipcMain.handle).not.toHaveBeenCalled()
  })
})

describe('status broadcasting', () => {
  it('broadcasts each autoUpdater event to all live windows', () => {
    const win = makeWindow()
    const dead = makeWindow(true)

    state.updaterEvents.get('checking-for-update')?.()
    state.updaterEvents.get('update-available')?.({ version: '2.0.0' })
    state.updaterEvents.get('update-not-available')?.({ version: '1.0.0' })
    state.updaterEvents.get('download-progress')?.({ percent: 41.7 })
    state.updaterEvents.get('update-downloaded')?.({ version: '2.0.0' })
    state.updaterEvents.get('error')?.(new Error('boom'))

    expect(win.webContents.send.mock.calls).toEqual([
      ['updater:status', { state: 'checking' }],
      ['updater:status', { state: 'available', version: '2.0.0' }],
      ['updater:status', { state: 'not-available', version: '1.0.0' }],
      ['updater:status', { state: 'downloading', percent: 42 }],
      ['updater:status', { state: 'downloaded', version: '2.0.0' }],
      ['updater:status', { state: 'error', message: 'boom' }],
    ])
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })

  it('stringifies errors that have no message', () => {
    const win = makeWindow()
    state.updaterEvents.get('error')?.(undefined)
    expect(win.webContents.send).toHaveBeenCalledWith('updater:status', {
      state: 'error',
      message: 'undefined',
    })
  })
})

describe('updater:version', () => {
  it('returns the app version', () => {
    expect(invoke('updater:version')).toBe('9.9.9')
  })
})

describe('updater:check', () => {
  it('refuses to check in unpackaged (dev) builds and broadcasts the error', async () => {
    const win = makeWindow()
    const status = { state: 'error', message: 'Updates are only available in packaged builds' }
    await expect(invoke('updater:check')).resolves.toEqual(status)
    expect(win.webContents.send).toHaveBeenCalledWith('updater:status', status)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks for updates in packaged builds', async () => {
    state.app.isPackaged = true
    await expect(invoke('updater:check')).resolves.toEqual({ ok: true })
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('broadcasts and returns an error status when the check fails', async () => {
    state.app.isPackaged = true
    const win = makeWindow()
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(new Error('net down'))
    await expect(invoke('updater:check')).resolves.toEqual({ state: 'error', message: 'net down' })
    expect(win.webContents.send).toHaveBeenCalledWith('updater:status', { state: 'error', message: 'net down' })
  })

  it('falls back to a generic message for message-less failures', async () => {
    state.app.isPackaged = true
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce({})
    await expect(invoke('updater:check')).resolves.toEqual({ state: 'error', message: 'Update check failed' })
  })
})

describe('updater:download', () => {
  it('downloads the update', async () => {
    await expect(invoke('updater:download')).resolves.toEqual({ ok: true })
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('broadcasts and returns an error status when the download fails', async () => {
    const win = makeWindow()
    vi.mocked(autoUpdater.downloadUpdate).mockRejectedValueOnce(new Error('disk full'))
    await expect(invoke('updater:download')).resolves.toEqual({ state: 'error', message: 'disk full' })
    expect(win.webContents.send).toHaveBeenCalledWith('updater:status', { state: 'error', message: 'disk full' })
  })

  it('falls back to a generic message for message-less failures', async () => {
    vi.mocked(autoUpdater.downloadUpdate).mockRejectedValueOnce({})
    await expect(invoke('updater:download')).resolves.toEqual({ state: 'error', message: 'Download failed' })
  })
})

describe('updater:quitAndInstall', () => {
  it('defers the install so the IPC reply can flush first', async () => {
    invoke('updater:quitAndInstall')
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    await new Promise((r) => setImmediate(r))
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})

describe('checkForUpdatesOnStartup', () => {
  it('does nothing in unpackaged builds', () => {
    checkForUpdatesOnStartup()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks in packaged builds and swallows failures', async () => {
    state.app.isPackaged = true
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(new Error('offline'))
    checkForUpdatesOnStartup()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    await new Promise((r) => setImmediate(r))
  })
})
