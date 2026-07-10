// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import RdpView from '../RdpView'
import { installWindowApi, seedStore, makeSession, makeTab, WindowApiMock } from '../../../__tests__/harness'

// jsdom has no canvas: return a stub 2d context so blit() can run.
const putImageData = vi.fn()
const ctxStub = { putImageData } as unknown as CanvasRenderingContext2D

// Minimal ImageData for environments where jsdom does not provide one.
class FakeImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}

type FrameCb = (id: string, width: number, height: number, pixels: Uint8Array) => void
type CloseCb = (id: string, error?: string) => void

function setup(opts: {
  session?: ReturnType<typeof makeSession> | null
  password?: string
  connectImpl?: (...args: unknown[]) => Promise<string>
} = {}) {
  const session = opts.session === undefined ? makeSession({ type: 'rdp', port: 3389 }) : opts.session
  let frameCb: FrameCb = () => {}
  let closeCb: CloseCb = () => {}
  const api = installWindowApi({
    sessions: { getCredentials: vi.fn().mockResolvedValue({ password: opts.password ?? 'secret' }) },
    rdp: {
      connect: vi.fn(opts.connectImpl ?? (() => Promise.resolve('rdp-1'))),
      onFrame: vi.fn((cb: FrameCb) => { frameCb = cb; return () => {} }),
      onClose: vi.fn((cb: CloseCb) => { closeCb = cb; return () => {} }),
    },
  })
  seedStore({ sessions: session ? [session] : [] })
  const tab = makeTab({ view: 'rdp', sessionId: session?.id ?? 'missing' })
  const utils = render(<RdpView tab={tab} />)
  return { api, tab, session, getFrameCb: () => frameCb, getCloseCb: () => closeCb, ...utils }
}

async function flushConnect(api: WindowApiMock) {
  await waitFor(() => expect(api.rdp.connect).toHaveBeenCalled())
  await act(async () => {}) // let rdpId assignment settle
}

beforeEach(() => {
  cleanup()
  putImageData.mockClear()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  if (!(globalThis as any).ImageData) vi.stubGlobal('ImageData', FakeImageData)
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(ctxStub) as any
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RdpView', () => {
  it('errors when the tab has no associated session', () => {
    setup({ session: null })
    expect(screen.getByText('RDP connection failed')).toBeTruthy()
    expect(screen.getByText('No connection associated with this tab')).toBeTruthy()
  })

  it('errors when no password is saved (no connect attempt)', async () => {
    const { api } = setup({ password: '' })
    await waitFor(() =>
      expect(screen.getByText('No password saved for this connection. Edit it and add one.')).toBeTruthy(),
    )
    expect(api.rdp.connect).not.toHaveBeenCalled()
  })

  it('connects with session credentials and fallback geometry', async () => {
    const { api, session } = setup()
    await flushConnect(api)
    expect(api.rdp.connect).toHaveBeenCalledWith({
      host: session!.host,
      port: 3389,
      username: session!.username,
      password: 'secret',
      width: 1280, // pane not laid out in jsdom → fallback
      height: 800,
    })
    expect(screen.getByText('Connecting to RDP host…')).toBeTruthy()
  })

  it('falls back to port 3389 when the session has no port', async () => {
    const { api } = setup({ session: makeSession({ type: 'rdp', port: 0 }) })
    await flushConnect(api)
    expect(api.rdp.connect.mock.calls[0][0].port).toBe(3389)
  })

  it('paints incoming frames to the canvas and flips to connected', async () => {
    const { api, getFrameCb, container } = setup()
    await flushConnect(api)
    const pixels = new Uint8Array(2 * 2 * 4)
    act(() => { getFrameCb()('rdp-1', 2, 2, pixels) })
    expect(putImageData).toHaveBeenCalledTimes(1)
    const canvas = container.querySelector('canvas')!
    expect(canvas.width).toBe(2)
    expect(canvas.height).toBe(2)
    expect(canvas.style.display).toBe('block')
    expect(screen.queryByText('Connecting to RDP host…')).toBeNull()
  })

  it('ignores frames for other rdp session ids', async () => {
    const { api, getFrameCb } = setup()
    await flushConnect(api)
    act(() => { getFrameCb()('other-id', 2, 2, new Uint8Array(16)) })
    expect(putImageData).not.toHaveBeenCalled()
    expect(screen.getByText('Connecting to RDP host…')).toBeTruthy()
  })

  it('coalesces multiple frames per animation frame (latest wins)', async () => {
    let rafCb: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafCb = cb; return 1 })
    const { api, getFrameCb, container } = setup()
    await flushConnect(api)
    act(() => {
      getFrameCb()('rdp-1', 2, 2, new Uint8Array(16))
      getFrameCb()('rdp-1', 4, 4, new Uint8Array(64))
    })
    act(() => { rafCb!(0) })
    expect(putImageData).toHaveBeenCalledTimes(1)
    expect(container.querySelector('canvas')!.width).toBe(4)
  })

  it('shows an error when the sidecar closes with an error', async () => {
    const { api, getCloseCb } = setup()
    await flushConnect(api)
    act(() => { getCloseCb()('rdp-1', 'NLA sign-in failed') })
    expect(screen.getByText('RDP connection failed')).toBeTruthy()
    expect(screen.getByText('NLA sign-in failed')).toBeTruthy()
  })

  it('shows session ended on a clean close', async () => {
    const { api, getCloseCb } = setup()
    await flushConnect(api)
    act(() => { getCloseCb()('rdp-1') })
    expect(screen.getByText('RDP session ended')).toBeTruthy()
  })

  it('ignores close events for other ids', async () => {
    const { api, getCloseCb } = setup()
    await flushConnect(api)
    act(() => { getCloseCb()('someone-else', 'boom') })
    expect(screen.getByText('Connecting to RDP host…')).toBeTruthy()
  })

  it('surfaces connect failures', async () => {
    setup({ connectImpl: () => Promise.reject(new Error('sidecar missing')) })
    await waitFor(() => expect(screen.getByText('RDP connection failed')).toBeTruthy())
    expect(screen.getByText('sidecar missing')).toBeTruthy()
  })

  it('disconnects the session on unmount', async () => {
    const { api, unmount } = setup()
    await flushConnect(api)
    unmount()
    expect(api.rdp.disconnect).toHaveBeenCalledWith('rdp-1')
  })

  it('disconnects immediately when unmounted while connect is in flight', async () => {
    let resolveConnect: (id: string) => void = () => {}
    const { api, unmount } = setup({
      connectImpl: () => new Promise<string>(res => { resolveConnect = res }),
    })
    await waitFor(() => expect(api.rdp.connect).toHaveBeenCalled())
    unmount()
    await act(async () => { resolveConnect('late-id') })
    await waitFor(() => expect(api.rdp.disconnect).toHaveBeenCalledWith('late-id'))
  })
})
