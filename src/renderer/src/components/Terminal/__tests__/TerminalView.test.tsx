// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { installWindowApi, seedStore, makeSession, makeTab, WindowApiMock } from '../../../__tests__/harness'
import { useAppStore, Session, Tab } from '../../../store'

// xterm needs a real canvas/renderer — replace it with a minimal stand-in.
vi.mock('@xterm/xterm', () => {
  const disposable = () => ({ dispose: vi.fn() })
  class Terminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    buffer = { active: { type: 'normal', baseY: 0, viewportY: 0, length: 0 } }
    open = vi.fn()
    write = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    resize = vi.fn()
    scrollLines = vi.fn()
    loadAddon = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    hasSelection = vi.fn(() => false)
    getSelection = vi.fn(() => '')
    onSelectionChange = vi.fn(disposable)
    onBell = vi.fn(disposable)
    onData = vi.fn(disposable)
    onResize = vi.fn(disposable)
  }
  return { Terminal }
})
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext = vi.fn()
    findPrevious = vi.fn()
    clearDecorations = vi.fn()
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }))
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import TerminalView from '../TerminalView'

let api: WindowApiMock

function setup(sessionOverrides: Partial<Session> = {}, apiOverrides: Record<string, unknown> = {}): Tab {
  api = installWindowApi(apiOverrides)
  const session = makeSession({ id: 's1', host: 'h1.example.com', username: 'root', ...sessionOverrides })
  const tab = makeTab({ id: 't1', sessionId: 's1', view: 'terminal', status: 'idle' })
  seedStore({
    sessions: [session], tabs: [tab], activeTabId: 't1',
    notifications: [], serverMetrics: {}, focusedPaneId: null, broadcastEnabled: false,
  })
  return tab
}

function storeTab(): Tab {
  return useAppStore.getState().tabs.find(t => t.id === 't1')!
}

describe('TerminalView', () => {
  beforeAll(() => {
    // jsdom lacks both of these; the component only needs them to exist.
    ;(globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(document, 'fonts', {
      value: { ready: Promise.resolve() },
      configurable: true,
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('connects with the stored password and starts metrics', async () => {
    const tab = setup(
      { authType: 'password' },
      { sessions: { getCredentials: vi.fn().mockResolvedValue({ password: 'hunter2' }) } },
    )
    render(<TerminalView tab={tab} />)

    await waitFor(() => expect(storeTab().status).toBe('connected'))
    expect(api.ssh.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: 'h1.example.com', username: 'root', password: 'hunter2', privateKey: undefined,
    }))
    expect(storeTab().streamId).toBe('stream-1')

    // Metrics polling starts shortly after the connection settles
    await waitFor(() => expect(api.ssh.startMetrics).toHaveBeenCalledWith('stream-1'), { timeout: 3000 })
  })

  it('connects with a private key when the session uses key auth', async () => {
    const tab = setup(
      { authType: 'key', keyPath: '/home/user/.ssh/id_ed25519' },
      { fs: { readFile: vi.fn().mockResolvedValue('PRIVATE KEY MATERIAL') } },
    )
    render(<TerminalView tab={tab} />)

    await waitFor(() => expect(storeTab().status).toBe('connected'))
    expect(api.fs.readFile).toHaveBeenCalledWith('/home/user/.ssh/id_ed25519')
    expect(api.ssh.connect).toHaveBeenCalledWith(expect.objectContaining({
      privateKey: 'PRIVATE KEY MATERIAL', password: undefined,
    }))
  })

  it('fails fast when key auth has no key path configured', async () => {
    const tab = setup({ authType: 'key', keyPath: undefined })
    render(<TerminalView tab={tab} />)

    await waitFor(() => expect(storeTab().status).toBe('error'))
    expect(storeTab().errorMessage).toBe('Key authentication selected but no key file path is configured')
    expect(api.ssh.connect).not.toHaveBeenCalled()
  })

  it('reports an unreadable key file', async () => {
    const tab = setup(
      { authType: 'key', keyPath: '/nope/id_rsa' },
      { fs: { readFile: vi.fn().mockRejectedValue(new Error('EACCES')) } },
    )
    render(<TerminalView tab={tab} />)

    await waitFor(() => expect(storeTab().status).toBe('error'))
    expect(storeTab().errorMessage).toBe('Cannot read private key: /nope/id_rsa')
  })

  it('translates a locked keychain into a friendly message', async () => {
    const tab = setup(
      { authType: 'password' },
      { sessions: { getCredentials: vi.fn().mockRejectedValue(new Error('keystore is locked')) } },
    )
    render(<TerminalView tab={tab} />)

    await waitFor(() => expect(storeTab().status).toBe('error'))
    expect(storeTab().errorMessage).toBe('App is locked — unlock noxed to reconnect')
  })

  it('errors when no password is stored for the session', async () => {
    const tab = setup(
      { authType: 'password' },
      { sessions: { getCredentials: vi.fn().mockResolvedValue({}) } },
    )
    render(<TerminalView tab={tab} />)

    await waitFor(() => expect(storeTab().status).toBe('error'))
    expect(storeTab().errorMessage).toBe('No password found for this session — re-enter credentials in Settings')
  })

  it('starts a reconnect cooldown after a failure and counts it down', async () => {
    const tab = setup({ authType: 'key', keyPath: undefined })
    const { rerender } = render(<TerminalView tab={tab} />)

    await waitFor(() => expect(storeTab().status).toBe('error'))

    // The overlay keys off the tab prop — re-render with the errored tab
    rerender(<TerminalView tab={storeTab()} />)
    expect(screen.getByText(/Retry in [45]s/)).toBeTruthy()

    // One interval tick decrements the countdown
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1150))
    })
    expect(screen.getByText(/Retry in [34]s/)).toBeTruthy()
  })
})
