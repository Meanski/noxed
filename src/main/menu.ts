import { app, Menu, BrowserWindow, MenuItemConstructorOptions } from 'electron'

// Forward a menu command to the focused renderer. The React layer subscribes
// via window.api.menu.* and routes each to the matching store action.
function send(channel: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(channel)
}

// A real application menu replaces Electron's default one. We do this for two
// reasons the default menu can't satisfy:
//   1. macOS binds ⌘` to "Cycle Through Windows", swallowing it before the
//      renderer ever sees it — so we reclaim ⌘` for "New Local Terminal".
//   2. The default menu's zoom items are inconsistent with our shortcuts; the
//      explicit zoomIn/zoomOut roles make ⌘+/⌘-/⌘0 work reliably.
// Standard Edit roles are kept so copy/paste/select-all still work in terminals.
export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ] as MenuItemConstructorOptions[],
        } as MenuItemConstructorOptions]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Connection…', accelerator: 'CmdOrCtrl+N', click: () => send('menu:new-connection') },
        { label: 'Open Connection…', accelerator: 'CmdOrCtrl+T', click: () => send('menu:open-connection') },
        { label: 'New Local Terminal', accelerator: 'CmdOrCtrl+`', click: () => send('menu:new-local-terminal') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('menu:close-tab') },
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'quit' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' },
            ]
          : [
              { role: 'delete' },
              { type: 'separator' },
              { role: 'selectAll' },
            ]) as MenuItemConstructorOptions[],
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' },
            ]
          : [{ role: 'close' }]) as MenuItemConstructorOptions[],
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
