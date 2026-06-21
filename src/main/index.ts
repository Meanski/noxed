import { app, shell, BrowserWindow, ipcMain, session } from 'electron'

// k8s API calls can reject with malformed responses; those rejections are
// already caught inside ipcMain.handle wrappers, but a double-rejection or an
// error event on an http.IncomingMessage stream can still escape.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})

import { join } from 'path'
import { readFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerSshHandlers, disposeSshStreamsForSender } from './ipc/ssh'
import { registerSftpHandlers, disposeSftpClientsForSender } from './ipc/sftp'
import { registerK8sHandlers, disposeK8sSessionsForSender } from './ipc/k8s'
import { registerSessionHandlers } from './ipc/sessions'
import { registerSshConfigHandlers } from './ipc/sshConfig'
import { registerTunnelHandlers, disposeAllTunnels } from './ipc/tunnels'
import { registerDockerHandlers, disposeDockerSessionsForSender } from './ipc/docker'
import { registerRunnerHandlers, disposeRunsForSender } from './ipc/runner'
import { registerLocalTerminalHandlers, disposeLocalPtysForSender } from './ipc/localTerminal'
import { registerRedisHandlers, disposeRedisClientsForSender } from './ipc/redis'
import { registerKeychainHandlers } from './ipc/keychain'
import { registerSettingsHandlers } from './ipc/settings'
import { registerDatabaseHandlers, disposeDatabaseConnectionsForSender } from './ipc/database'
import { registerLocalFsHandlers } from './ipc/localfs'
import { registerRdpHandlers, disposeRdpSessionsForSender } from './ipc/rdp'
import { isAllowedKeyPath } from './ipc/security'
import { ValidationError } from './ipc/errors'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#00000000',
    vibrancy: 'sidebar',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  // macOS grabs Ctrl+Tab before the renderer can see it; intercept here and
  // dispatch a sentinel event the React layer subscribes to.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.key === 'Tab') {
      event.preventDefault()
      win.webContents.send('tab:cycle', input.shift ? 'prev' : 'next')
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Strip every long-lived per-window resource when the WebContents is gone.
  // Without this, log/exec/port-forward/db/redis/ssh sessions leak forever.
  const senderId = win.webContents.id
  win.webContents.on('destroyed', () => {
    disposeSshStreamsForSender(senderId)
    disposeSftpClientsForSender(senderId)
    disposeK8sSessionsForSender(senderId)
    disposeRedisClientsForSender(senderId)
    disposeDatabaseConnectionsForSender(senderId)
    disposeDockerSessionsForSender(senderId)
    disposeRunsForSender(senderId)
    disposeLocalPtysForSender(senderId)
    disposeRdpSessionsForSender(senderId)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('app.noxed')

  // CSP: restrict the renderer to its own bundle plus the Google Fonts assets
  // it needs. Anything else (eval, remote scripts, mixed content) is denied.
  // Skipped in dev because Vite's dev server injects inline scripts and HMR
  // websockets that a strict policy would block.
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders }
      headers['Content-Security-Policy'] = [
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          "img-src 'self' data: blob:",
          "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
        ].join('; '),
      ]
      callback({ responseHeaders: headers })
    })
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerKeychainHandlers()
  registerSessionHandlers()
  registerSshConfigHandlers()
  registerTunnelHandlers()
  registerDockerHandlers()
  registerRunnerHandlers()
  registerLocalTerminalHandlers()
  registerSettingsHandlers()
  registerSshHandlers()
  registerSftpHandlers()
  registerK8sHandlers()
  registerRedisHandlers()
  registerDatabaseHandlers()
  registerLocalFsHandlers()
  registerRdpHandlers()

  ipcMain.handle('fs:readFile', (_e, filePath: unknown) => {
    if (typeof filePath !== 'string') throw new ValidationError('Path is required')
    const check = isAllowedKeyPath(filePath)
    if (!check.ok) throw new ValidationError(check.reason)
    return readFileSync(check.resolved, 'utf-8')
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  disposeAllTunnels()
})
