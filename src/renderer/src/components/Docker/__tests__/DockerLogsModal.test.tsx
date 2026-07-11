// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react'
import DockerLogsModal from '../DockerLogsModal'
import { installWindowApi, WindowApiMock } from '../../../__tests__/harness'

type ChunkCb = (logId: string, data: string) => void
type EndCb = (logId: string, err?: string) => void

let api: WindowApiMock
let chunkCb: ChunkCb
let endCb: EndCb
let offChunk: ReturnType<typeof vi.fn>
let offEnd: ReturnType<typeof vi.fn>

function setup(apiOverrides: Record<string, unknown> = {}) {
  offChunk = vi.fn()
  offEnd = vi.fn()
  api = installWindowApi({
    docker: {
      onLogChunk: vi.fn((cb: ChunkCb) => { chunkCb = cb; return offChunk }),
      onLogEnd: vi.fn((cb: EndCb) => { endCb = cb; return offEnd }),
      ...(apiOverrides as Record<string, unknown>),
    },
  })
  return api
}

function renderModal() {
  const onClose = vi.fn()
  const utils = render(
    <DockerLogsModal dockerId="docker-1" containerName="nginx-proxy" containerId="c1" onClose={onClose} />,
  )
  return { ...utils, onClose }
}

async function renderStarted() {
  const result = renderModal()
  // flush the logsStart promise so logIdRef is set
  await act(async () => {})
  await waitFor(() => expect(api.docker.logsStart).toHaveBeenCalled())
  return result
}

function pre(container: HTMLElement) {
  return container.querySelector('pre')!
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DockerLogsModal — rendering and streaming', () => {
  it('renders the container name and starts streaming with the default tail', async () => {
    setup()
    await renderStarted()
    expect(screen.getByText('nginx-proxy')).toBeTruthy()
    expect(screen.getByText('streaming')).toBeTruthy()
    expect(api.docker.logsStart).toHaveBeenCalledWith('docker-1', 'c1', 500)
  })

  it('appends incoming chunks for its own log id', async () => {
    setup({ logsStart: vi.fn().mockResolvedValue('dlog-1') })
    const { container } = await renderStarted()

    act(() => { chunkCb('dlog-1', 'GET / 200\n') })
    act(() => { chunkCb('dlog-1', 'GET /health 200\n') })
    expect(pre(container).textContent).toBe('GET / 200\nGET /health 200\n')
  })

  it('ignores chunks and end events for other log ids', async () => {
    setup({ logsStart: vi.fn().mockResolvedValue('dlog-1') })
    const { container } = await renderStarted()

    act(() => { chunkCb('dlog-other', 'noise\n') })
    expect(pre(container).textContent).toBe('')

    act(() => { endCb('dlog-other', 'other failed') })
    expect(screen.getByText('streaming')).toBeTruthy()
    expect(screen.queryByText('other failed')).toBeNull()
  })

  it('stops the streaming indicator when the stream ends cleanly', async () => {
    setup({ logsStart: vi.fn().mockResolvedValue('dlog-1') })
    await renderStarted()

    act(() => { endCb('dlog-1') })
    expect(screen.queryByText('streaming')).toBeNull()
  })

  it('surfaces a stream-end error', async () => {
    setup({ logsStart: vi.fn().mockResolvedValue('dlog-1') })
    await renderStarted()

    act(() => { endCb('dlog-1', 'container exited') })
    expect(screen.getByText('container exited')).toBeTruthy()
    expect(screen.queryByText('streaming')).toBeNull()
  })

  it('shows an error when the stream fails to start', async () => {
    setup({ logsStart: vi.fn().mockRejectedValue(new Error('daemon unreachable')) })
    renderModal()
    await waitFor(() => expect(screen.getByText('daemon unreachable')).toBeTruthy())
    expect(screen.queryByText('streaming')).toBeNull()
  })

  it('restarts the stream when the tail selection changes', async () => {
    const logsStart = vi.fn().mockResolvedValueOnce('dlog-1').mockResolvedValueOnce('dlog-2')
    setup({ logsStart })
    const { container } = await renderStarted()

    fireEvent.change(container.querySelector('select')!, { target: { value: '5000' } })
    await waitFor(() => expect(logsStart).toHaveBeenCalledWith('docker-1', 'c1', 5000))
    expect(api.docker.logsStop).toHaveBeenCalledWith('dlog-1')
    expect(offChunk).toHaveBeenCalled()
    expect(offEnd).toHaveBeenCalled()
  })
})

describe('DockerLogsModal — follow control', () => {
  it('follows output by default and scrolls on new chunks', async () => {
    setup({ logsStart: vi.fn().mockResolvedValue('dlog-1') })
    const { container } = await renderStarted()
    expect(screen.getByTitle('Stop following')).toBeTruthy()

    const el = pre(container)
    Object.defineProperty(el, 'scrollHeight', { value: 400, configurable: true })
    act(() => { chunkCb('dlog-1', 'line\n') })
    expect(el.scrollTop).toBe(400)
  })

  it('toggles follow off via the button and does not scroll new chunks', async () => {
    setup({ logsStart: vi.fn().mockResolvedValue('dlog-1') })
    const { container } = await renderStarted()

    fireEvent.click(screen.getByTitle('Stop following'))
    expect(screen.getByTitle('Follow output')).toBeTruthy()

    const el = pre(container)
    Object.defineProperty(el, 'scrollHeight', { value: 400, configurable: true })
    act(() => { chunkCb('dlog-1', 'line\n') })
    expect(el.scrollTop).toBe(0)
  })

  it('disables follow when the user scrolls the log pane', async () => {
    setup({ logsStart: vi.fn().mockResolvedValue('dlog-1') })
    const { container } = await renderStarted()

    fireEvent.wheel(pre(container))
    expect(screen.getByTitle('Follow output')).toBeTruthy()
  })
})

describe('DockerLogsModal — close and cleanup', () => {
  it('closes on Escape', async () => {
    setup()
    const { onClose } = await renderStarted()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', async () => {
    setup()
    const { onClose } = await renderStarted()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on backdrop mousedown but not on panel clicks', async () => {
    setup()
    const { container, onClose } = await renderStarted()

    fireEvent.mouseDown(screen.getByText('nginx-proxy'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(container.firstElementChild as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via the close button', async () => {
    setup()
    const { container, onClose } = await renderStarted()
    const buttons = Array.from(container.querySelectorAll('button'))
    fireEvent.click(buttons[buttons.length - 1])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stops the stream and removes listeners on unmount', async () => {
    setup({ logsStart: vi.fn().mockResolvedValue('dlog-1') })
    const { unmount } = await renderStarted()

    unmount()
    expect(api.docker.logsStop).toHaveBeenCalledWith('dlog-1')
    expect(offChunk).toHaveBeenCalled()
    expect(offEnd).toHaveBeenCalled()
  })

  it('stops a stream that resolves after unmount', async () => {
    let resolve!: (id: string) => void
    setup({ logsStart: vi.fn(() => new Promise<string>(r => { resolve = r })) })
    const { unmount } = renderModal()
    await waitFor(() => expect(api.docker.logsStart).toHaveBeenCalled())

    unmount()
    await act(async () => { resolve('dlog-late') })
    expect(api.docker.logsStop).toHaveBeenCalledWith('dlog-late')
  })
})
