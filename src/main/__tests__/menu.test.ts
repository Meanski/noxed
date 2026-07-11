import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { name: 'noxed' },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    setApplicationMenu: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
}))

import { Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { buildAppMenu } from '../menu'

const realPlatform = process.platform

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value })
}

function buildTemplate(): MenuItemConstructorOptions[] {
  buildAppMenu()
  const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0]
  if (!template) throw new Error('Menu.buildFromTemplate was not called')
  return template as MenuItemConstructorOptions[]
}

function submenuOf(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const menu = template.find((item) => item.label === label)
  if (!menu) throw new Error(`no ${label} menu`)
  return menu.submenu as MenuItemConstructorOptions[]
}

function makeWindow() {
  return { webContents: { send: vi.fn() } }
}

afterEach(() => {
  setPlatform(realPlatform)
  vi.mocked(BrowserWindow.getFocusedWindow).mockReset().mockReturnValue(null)
  vi.mocked(BrowserWindow.getAllWindows).mockReset().mockReturnValue([])
})

describe('buildAppMenu', () => {
  it('installs the built menu as the application menu', () => {
    buildAppMenu()
    const built = vi.mocked(Menu.buildFromTemplate).mock.results.at(-1)?.value
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(built)
  })

  it('includes the macOS app menu and mac-only roles on darwin', () => {
    setPlatform('darwin')
    const template = buildTemplate()
    expect(template.map((item) => item.label)).toEqual(['noxed', 'File', 'Edit', 'View', 'Window'])

    const appMenu = template[0].submenu as MenuItemConstructorOptions[]
    expect(appMenu.map((item) => item.role ?? item.type)).toContain('quit')

    // Quit lives in the app menu, not in File
    expect(submenuOf(template, 'File').some((item) => item.role === 'quit')).toBe(false)
    expect(submenuOf(template, 'Edit').some((item) => item.role === 'pasteAndMatchStyle')).toBe(true)
    expect(submenuOf(template, 'Window').some((item) => item.role === 'front')).toBe(true)
  })

  it('omits the app menu and moves Quit into File on Windows/Linux', () => {
    setPlatform('win32')
    const template = buildTemplate()
    expect(template.map((item) => item.label)).toEqual(['File', 'Edit', 'View', 'Window'])
    expect(submenuOf(template, 'File').at(-1)).toEqual({ role: 'quit' })
    expect(submenuOf(template, 'Edit').some((item) => item.role === 'pasteAndMatchStyle')).toBe(false)
    expect(submenuOf(template, 'Window').some((item) => item.role === 'close')).toBe(true)
  })

  it('binds the documented accelerators to the File commands', () => {
    const file = submenuOf(buildTemplate(), 'File')
    const accelerators = Object.fromEntries(
      file.filter((item) => item.label).map((item) => [item.label, item.accelerator])
    )
    expect(accelerators).toEqual({
      'New Connection…': 'CmdOrCtrl+N',
      'Open Connection…': 'CmdOrCtrl+T',
      'New Local Terminal': 'CmdOrCtrl+`',
      'Close Tab': 'CmdOrCtrl+W',
    })
  })
})

describe('menu command routing', () => {
  function clickItem(label: string): void {
    const item = submenuOf(buildTemplate(), 'File').find((entry) => entry.label === label)
    if (!item?.click) throw new Error(`no clickable ${label} item`)
    ;(item.click as () => void)()
  }

  it('sends the command to the focused window', () => {
    const focused = makeWindow()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(focused as never)
    clickItem('New Connection…')
    expect(focused.webContents.send).toHaveBeenCalledWith('menu:new-connection')
  })

  it('falls back to the first window when none is focused', () => {
    const fallback = makeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([fallback] as never)
    clickItem('Open Connection…')
    expect(fallback.webContents.send).toHaveBeenCalledWith('menu:open-connection')
  })

  it('does nothing when no window exists', () => {
    expect(() => clickItem('New Local Terminal')).not.toThrow()
    expect(() => clickItem('Close Tab')).not.toThrow()
  })
})
