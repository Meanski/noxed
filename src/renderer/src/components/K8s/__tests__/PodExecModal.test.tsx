// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react'
import { installWindowApi, WindowApiMock } from '../../../__tests__/harness'

// xterm needs a real canvas/renderer — replace it with a minimal stand-in
// that records every instance so tests can drive its callbacks.
const hoisted = vi.hoisted(() => ({ terms: [] as any[] }))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    open = vi.fn()
    write = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onResize = vi.fn(() => ({ dispose: vi.fn() }))
    constructor() { hoisted.terms.push(this) }
  }
  return { Terminal }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn() } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import PodExecModal from '../PodExecModal'

type DataCb = (sid: string, data: string) => void
type CloseCb = (sid: string) => void

let api: WindowApiMock
let dataCb: DataCb
let closeCb: CloseCb
let offData: ReturnType<typeof vi.fn>
let offClose: ReturnType<typeof vi.fn>

function term() {
  return hoisted.terms[hoisted.terms.length - 1]
}

function written() {
  return term().write.mock.calls.map((c: any[]) => c[0]).join('')
}

function setup(apiOverrides: Record<string, unknown> = {}) {
  offData = vi.fn()
  offClose = vi.fn()
  api = installWindowApi({
    k8s: {
      onExecData: vi.fn((cb: DataCb) => { dataCb = cb; return offData }),
      onExecClose: vi.fn((cb: CloseCb) => { closeCb = cb; return offClose }),
      ...(apiOverrides as Record<string, unknown>),
    },
  })
  return api
}

function renderModal(props: Partial<Parameters<typeof PodExecModal>[0]> = {}) {
  const onClose = vi.fn()
  const utils = render(
    <PodExecModal
      context="ctx"
      namespace="ns1"
      pod="web-abc"
      containers={['app']}
      onClose={onClose}
      {...props}
    />,
  )
  return { ...utils, onClose }
}

async function waitConnected() {
  await waitFor(() => expect(written()).toContain('Connected'))
}

beforeAll(() => {
  // jsdom lacks ResizeObserver; the component only needs it to exist
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  hoisted.terms.length = 0
})

describe('PodExecModal — connection lifecycle', () => {
  it('renders the header, opens the terminal and connects to the pod', async () => {
    setup({ execStart: vi.fn().mockResolvedValue('exec-1') })
    renderModal({ kubeconfigPath: '/kube/config' })

    expect(screen.getByText('Shell — web-abc')).toBeTruthy()
    expect(screen.getByText('ns1')).toBeTruthy()
    expect(term().open).toHaveBeenCalled()

    await waitConnected()
    expect(api.k8s.execStart).toHaveBeenCalledWith('ctx', 'ns1', 'web-abc', 'app', '/kube/config')
    expect(written()).toContain('Connecting to web-abc/app')
    // initial resize synced to the remote pty
    expect(api.k8s.execResize).toHaveBeenCalledWith('exec-1', 80, 24)
  })

  it('shows a connecting indicator while the session is pending', async () => {
    let resolve!: (sid: string) => void
    setup({ execStart: vi.fn(() => new Promise<string>(r => { resolve = r })) })
    renderModal()

    await waitFor(() => expect(screen.getByText('Connecting…')).toBeTruthy())
    act(() => resolve('exec-1'))
    await waitFor(() => expect(screen.queryByText('Connecting…')).toBeNull())
  })

  it('writes an error into the terminal when connecting fails', async () => {
    setup({ execStart: vi.fn().mockRejectedValue(new Error('pod gone')) })
    renderModal()
    await waitFor(() => expect(written()).toContain('Error: pod gone'))
    expect(screen.queryByText('Connecting…')).toBeNull()
  })

  it('reconnects on demand, stopping the previous session first', async () => {
    setup({ execStart: vi.fn().mockResolvedValueOnce('exec-1').mockResolvedValueOnce('exec-2') })
    renderModal()
    await waitConnected()

    fireEvent.click(screen.getByText('Reconnect'))
    await waitFor(() => expect(api.k8s.execStart).toHaveBeenCalledTimes(2))
    expect(api.k8s.execStop).toHaveBeenCalledWith('exec-1')
    expect(term().clear).toHaveBeenCalled()
  })
})

describe('PodExecModal — terminal <-> session wiring', () => {
  it('writes incoming exec data for the active session to the terminal', async () => {
    setup({ execStart: vi.fn().mockResolvedValue('exec-1') })
    renderModal()
    await waitConnected()

    act(() => { dataCb('exec-1', 'total 0\r\n') })
    expect(written()).toContain('total 0')
  })

  it('ignores exec data for other sessions', async () => {
    setup({ execStart: vi.fn().mockResolvedValue('exec-1') })
    renderModal()
    await waitConnected()

    act(() => { dataCb('exec-99', 'stray output') })
    expect(written()).not.toContain('stray output')
  })

  it('announces when the connection closes', async () => {
    setup({ execStart: vi.fn().mockResolvedValue('exec-1') })
    renderModal()
    await waitConnected()

    act(() => { closeCb('exec-1') })
    expect(written()).toContain('[Connection closed]')
  })

  it('forwards keystrokes to the exec session', async () => {
    setup({ execStart: vi.fn().mockResolvedValue('exec-1') })
    renderModal()
    await waitConnected()

    const onDataHandler = term().onData.mock.calls[0][0]
    onDataHandler('ls -la\r')
    expect(api.k8s.execSend).toHaveBeenCalledWith('exec-1', 'ls -la\r')
  })

  it('propagates terminal resizes to the remote pty', async () => {
    setup({ execStart: vi.fn().mockResolvedValue('exec-1') })
    renderModal()
    await waitConnected()

    const onResizeHandler = term().onResize.mock.calls[0][0]
    onResizeHandler({ cols: 132, rows: 43 })
    expect(api.k8s.execResize).toHaveBeenCalledWith('exec-1', 132, 43)
  })
})

describe('PodExecModal — containers', () => {
  it('does not show a container selector for a single container', async () => {
    setup()
    const { container } = renderModal()
    await waitConnected()
    expect(container.querySelector('select')).toBeNull()
  })

  it('reconnects to the newly selected container', async () => {
    const execStart = vi.fn().mockResolvedValueOnce('exec-1').mockResolvedValueOnce('exec-2')
    setup({ execStart })
    const { container } = renderModal({ containers: ['app', 'sidecar'] })
    await waitConnected()

    fireEvent.change(container.querySelector('select')!, { target: { value: 'sidecar' } })
    await waitFor(() => expect(execStart).toHaveBeenCalledWith('ctx', 'ns1', 'web-abc', 'sidecar', undefined))
    expect(api.k8s.execStop).toHaveBeenCalledWith('exec-1')
  })
})

describe('PodExecModal — close and cleanup', () => {
  it('stops the session and closes via the header close button', async () => {
    setup({ execStart: vi.fn().mockResolvedValue('exec-1') })
    const { container, onClose } = renderModal()
    await waitConnected()

    const buttons = Array.from(container.querySelectorAll('button'))
    const closeButton = buttons.find(b => b.textContent === '')!
    fireEvent.click(closeButton)
    expect(api.k8s.execStop).toHaveBeenCalledWith('exec-1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on backdrop mousedown but not on panel clicks', async () => {
    setup()
    const { container, onClose } = renderModal()
    await waitConnected()

    fireEvent.mouseDown(screen.getByText('Shell — web-abc'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(container.firstElementChild as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stops the session, disposes the terminal and removes listeners on unmount', async () => {
    setup({ execStart: vi.fn().mockResolvedValue('exec-1') })
    const { unmount } = renderModal()
    await waitConnected()
    const t = term()

    unmount()
    expect(api.k8s.execStop).toHaveBeenCalledWith('exec-1')
    expect(t.dispose).toHaveBeenCalled()
    expect(offData).toHaveBeenCalled()
    expect(offClose).toHaveBeenCalled()
  })
})
