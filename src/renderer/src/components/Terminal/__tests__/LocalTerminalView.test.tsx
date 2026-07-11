// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { installWindowApi, seedStore, makeTab, WindowApiMock } from '../../../__tests__/harness'
import { Tab } from '../../../store'

// Capture mock instances created inside the hoisted vi.mock factories.
const held = vi.hoisted(() => ({
  terminals: [] as any[],
  fits: [] as any[],
  observers: [] as any[],
}))

// xterm needs a real canvas/renderer — replace it with a minimal stand-in.
vi.mock('@xterm/xterm', () => {
  const disposable = () => ({ dispose: vi.fn() })
  class Terminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    dataCb: ((data: string) => void) | null = null
    resizeCb: ((size: { cols: number; rows: number }) => void) | null = null
    selectionCb: (() => void) | null = null
    bellCb: (() => void) | null = null
    open = vi.fn()
    write = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    loadAddon = vi.fn()
    hasSelection = vi.fn(() => true)
    getSelection = vi.fn(() => 'selected text')
    onSelectionChange = vi.fn((cb: () => void) => { this.selectionCb = cb; return disposable() })
    onBell = vi.fn((cb: () => void) => { this.bellCb = cb; return disposable() })
    onData = vi.fn((cb: (d: string) => void) => { this.dataCb = cb; return disposable() })
    onResize = vi.fn((cb: (s: { cols: number; rows: number }) => void) => { this.resizeCb = cb; return disposable() })
    constructor() { held.terminals.push(this) }
  }
  return { Terminal }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
    constructor() { held.fits.push(this) }
  },
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext = vi.fn()
    findPrevious = vi.fn()
    clearDecorations = vi.fn()
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }))
  },
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import LocalTerminalView from '../LocalTerminalView'

let api: WindowApiMock
let ptyData: ((id: string, data: string) => void) | null
let ptyExit: ((id: string, code: number) => void) | null
let clipboardWrite: ReturnType<typeof vi.fn>

function setup(opts: {
  activeTabId?: string
  localpty?: Record<string, unknown>
  settings?: Record<string, unknown>
} = {}): Tab {
  ptyData = null
  ptyExit = null
  api = installWindowApi({
    localpty: {
      onData: vi.fn((cb: typeof ptyData) => { ptyData = cb; return () => {} }),
      onExit: vi.fn((cb: typeof ptyExit) => { ptyExit = cb; return () => {} }),
      ...(opts.localpty ?? {}),
    },
    ...(opts.settings ? { settings: opts.settings } : {}),
  })
  const tab = makeTab({ id: 'lt-1', view: 'local-term' as Tab['view'], label: 'Local' })
  seedStore({ tabs: [tab], activeTabId: opts.activeTabId ?? 'lt-1', sessions: [], notifications: [] })
  return tab
}

function term(): any {
  return held.terminals[held.terminals.length - 1]
}

// Let start()/settings promises and requestAnimationFrame callbacks flush.
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })

describe('LocalTerminalView', () => {
  beforeAll(() => {
    ;(globalThis as any).ResizeObserver = class {
      cb: () => void
      constructor(cb: () => void) { this.cb = cb; held.observers.push(this) }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(document, 'fonts', {
      value: { ready: Promise.resolve() },
      configurable: true,
    })
    // fitAndResize bails out when the container has no height in jsdom
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 480,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => ({ writeText: clipboardWrite }),
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    held.terminals.length = 0
    held.fits.length = 0
    held.observers.length = 0
    clipboardWrite = vi.fn().mockResolvedValue(undefined)
  })

  it('spawns a shell sized to the terminal and focuses it', async () => {
    const tab = setup()
    render(<LocalTerminalView tab={tab} />)

    expect(held.fits[0].fit).toHaveBeenCalled()
    expect(api.localpty.start).toHaveBeenCalledWith(80, 24)
    await settle()
    expect(term().open).toHaveBeenCalled()
    expect(term().focus).toHaveBeenCalled()
  })

  it('routes pty output and exit to the terminal, then stops forwarding input', async () => {
    const tab = setup()
    render(<LocalTerminalView tab={tab} />)
    await settle()

    act(() => { ptyData!('someone-else', 'nope') })
    expect(term().write).not.toHaveBeenCalledWith('nope')

    act(() => { ptyData!('pty-1', 'hello world') })
    expect(term().write).toHaveBeenCalledWith('hello world')

    // Exit for another pty is ignored
    act(() => { ptyExit!('someone-else', 9) })
    expect(screen.queryByText(/shell exited — close this tab/)).toBeNull()

    act(() => { ptyExit!('pty-1', 3) })
    expect(screen.getByText(/shell exited — close this tab/)).toBeTruthy()
    expect(term().write).toHaveBeenCalledWith(expect.stringContaining('shell exited (3)'))

    // The pty is gone — keystrokes are no longer forwarded
    act(() => { term().dataCb('ls\r') })
    expect(api.localpty.write).not.toHaveBeenCalled()
  })

  it('forwards keystrokes and terminal resizes to the pty', async () => {
    const tab = setup()
    render(<LocalTerminalView tab={tab} />)
    await settle()

    act(() => { term().dataCb('echo hi\r') })
    expect(api.localpty.write).toHaveBeenCalledWith('pty-1', 'echo hi\r')

    act(() => { term().resizeCb({ cols: 120, rows: 50 }) })
    expect(api.localpty.resize).toHaveBeenCalledWith('pty-1', 120, 50)
  })

  it('shows a failure message when the shell cannot start', async () => {
    const tab = setup({
      localpty: { start: vi.fn().mockRejectedValue(new Error('spawn fail')) },
    })
    render(<LocalTerminalView tab={tab} />)

    await waitFor(() => expect(screen.getByText(/shell exited — close this tab/)).toBeTruthy())
    expect(term().write).toHaveBeenCalledWith(expect.stringContaining('Failed to start shell: spawn fail'))
  })

  it('kills the pty and disposes the terminal on unmount', async () => {
    const tab = setup()
    const { unmount } = render(<LocalTerminalView tab={tab} />)
    await settle()

    unmount()
    expect(api.localpty.kill).toHaveBeenCalledWith('pty-1')
    expect(term().dispose).toHaveBeenCalled()
  })

  it('kills a pty that finishes starting after unmount', async () => {
    let resolveStart: (id: string) => void = () => {}
    const tab = setup({
      localpty: { start: vi.fn(() => new Promise<string>(resolve => { resolveStart = resolve })) },
    })
    const { unmount } = render(<LocalTerminalView tab={tab} />)

    unmount()
    resolveStart('pty-late')
    await waitFor(() => expect(api.localpty.kill).toHaveBeenCalledWith('pty-late'))
    expect(term().focus).not.toHaveBeenCalled()
  })

  it('opens scrollback search with Cmd+F and closes it back to the terminal', async () => {
    const tab = setup()
    render(<LocalTerminalView tab={tab} />)
    await settle()

    // Shifted or plain keypresses do not open the search bar
    fireEvent.keyDown(window, { key: 'f', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'f' })
    expect(screen.queryByPlaceholderText('Search')).toBeNull()

    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(screen.getByPlaceholderText('Search')).toBeTruthy()

    term().focus.mockClear()
    fireEvent.click(screen.getByTitle('Close (Esc)'))
    expect(screen.queryByPlaceholderText('Search')).toBeNull()
    expect(term().focus).toHaveBeenCalled()
  })

  it('ignores Cmd+F when the tab is not active', async () => {
    const tab = setup({ activeTabId: 'some-other-tab' })
    render(<LocalTerminalView tab={tab} />)
    await settle()

    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(screen.queryByPlaceholderText('Search')).toBeNull()
  })

  it('copies the selection when copy-on-select is enabled', async () => {
    const tab = setup({
      settings: { get: vi.fn().mockResolvedValue({ copyOnSelect: true }) },
    })
    render(<LocalTerminalView tab={tab} />)
    await settle()

    act(() => { term().selectionCb() })
    expect(clipboardWrite).toHaveBeenCalledWith('selected text')
  })

  it('skips copy-on-select when disabled and survives the bell without AudioContext', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tab = setup()
    render(<LocalTerminalView tab={tab} />)
    await settle()

    act(() => { term().selectionCb() })
    expect(clipboardWrite).not.toHaveBeenCalled()

    // bellSound defaults to on; jsdom has no AudioContext so the bell fails softly
    act(() => { term().bellCb() })
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('re-applies terminal settings when the app broadcasts a change', async () => {
    const tab = setup()
    render(<LocalTerminalView tab={tab} />)
    await settle()

    const before = (api.settings.get as any).mock.calls.length
    act(() => { window.dispatchEvent(new Event('noxed:settings-changed')) })
    await waitFor(() => expect((api.settings.get as any).mock.calls.length).toBeGreaterThan(before))
  })

  it('refits and resizes the pty when the container resizes', async () => {
    const tab = setup()
    render(<LocalTerminalView tab={tab} />)
    await settle()

    ;(api.localpty.resize as any).mockClear()
    act(() => { held.observers[0].cb() })
    expect(held.fits[0].fit).toHaveBeenCalled()
    expect(api.localpty.resize).toHaveBeenCalledWith('pty-1', 80, 24)
  })
})
