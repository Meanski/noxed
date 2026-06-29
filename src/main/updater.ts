import { app, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

// One status channel the renderer subscribes to, instead of a fan of events.
export type UpdaterStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

function broadcast(status: UpdaterStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('updater:status', status)
  }
}

let wired = false

export function registerUpdaterHandlers(): void {
  if (wired) return
  wired = true

  // Download in the background as soon as an update is found, and stage it so
  // it installs on the next quit even if the user never clicks "Restart".
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => broadcast({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', (info) => broadcast({ state: 'not-available', version: info.version }))
  autoUpdater.on('download-progress', (p) => broadcast({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => broadcast({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => broadcast({ state: 'error', message: err?.message ?? String(err) }))

  ipcMain.handle('updater:version', () => app.getVersion())

  ipcMain.handle('updater:check', async () => {
    // checkForUpdates throws without a bundled app-update.yml (i.e. in dev).
    if (!app.isPackaged) {
      const status: UpdaterStatus = { state: 'error', message: 'Updates are only available in packaged builds' }
      broadcast(status)
      return status
    }
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err: any) {
      const status: UpdaterStatus = { state: 'error', message: err?.message ?? 'Update check failed' }
      broadcast(status)
      return status
    }
  })

  ipcMain.handle('updater:quitAndInstall', () => {
    // Defer so the IPC reply flushes before the app tears down.
    setImmediate(() => autoUpdater.quitAndInstall())
  })
}

// Fire-and-forget check shortly after launch. Packaged builds only; any error
// (offline, no release yet) is swallowed — the user can retry from Settings.
export function checkForUpdatesOnStartup(): void {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch(() => { /* offline or no published release */ })
}
