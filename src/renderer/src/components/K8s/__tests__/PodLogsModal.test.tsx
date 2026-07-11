// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react'
import PodLogsModal from '../PodLogsModal'
import { installWindowApi, WindowApiMock } from '../../../__tests__/harness'

type ChunkCb = (sid: string, data: string) => void
type EndCb = (sid: string) => void

let api: WindowApiMock
let chunkCb: ChunkCb
let endCb: EndCb
let offChunk: ReturnType<typeof vi.fn>
let offEnd: ReturnType<typeof vi.fn>

function setup(apiOverrides: Record<string, unknown> = {}) {
  offChunk = vi.fn()
  offEnd = vi.fn()
  api = installWindowApi({
    k8s: {
      onLogChunk: vi.fn((cb: ChunkCb) => { chunkCb = cb; return offChunk }),
      onLogEnd: vi.fn((cb: EndCb) => { endCb = cb; return offEnd }),
      ...(apiOverrides as Record<string, unknown>),
    },
  })
  return api
}

function renderModal(props: Partial<Parameters<typeof PodLogsModal>[0]> = {}) {
  const onClose = vi.fn()
  const utils = render(
    <PodLogsModal
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

async function startStream() {
  fireEvent.click(screen.getByText('Stream'))
  // flush the logsStream promise so streamIdRef is set
  await act(async () => {})
  await waitFor(() => expect(api.k8s.logsStream).toHaveBeenCalled())
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PodLogsModal — initial fetch and rendering', () => {
  it('renders the header and fetches logs for the first container', async () => {
    setup({ logsGet: vi.fn().mockResolvedValue('line one\nline two') })
    renderModal({ kubeconfigPath: '/kube/config' })

    expect(screen.getByText('Logs — web-abc')).toBeTruthy()
    expect(screen.getByText('ns1')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/line one/)).toBeTruthy())
    expect(api.k8s.logsGet).toHaveBeenCalledWith('ctx', 'ns1', 'web-abc', 'app', 500, '/kube/config')
    expect(screen.getByText('2 lines')).toBeTruthy()
  })

  it('shows a placeholder when there are no logs', async () => {
    setup({ logsGet: vi.fn().mockResolvedValue('') })
    renderModal()
    await waitFor(() => expect(screen.getByText('No logs available')).toBeTruthy())
    expect(screen.getByText('0 lines')).toBeTruthy()
  })

  it('renders an error message when the fetch fails', async () => {
    setup({ logsGet: vi.fn().mockRejectedValue(new Error('forbidden')) })
    renderModal()
    await waitFor(() => expect(screen.getByText('Error: forbidden')).toBeTruthy())
  })

  it('does not render a container selector for a single container', async () => {
    setup()
    const { container } = renderModal()
    await waitFor(() => expect(api.k8s.logsGet).toHaveBeenCalled())
    expect(container.querySelectorAll('select')).toHaveLength(1) // only the tail selector
  })

  it('refetches when the container is switched', async () => {
    const logsGet = vi.fn().mockResolvedValue('x')
    setup({ logsGet })
    const { container } = renderModal({ containers: ['app', 'sidecar'] })
    await waitFor(() => expect(logsGet).toHaveBeenCalledTimes(1))

    const select = container.querySelectorAll('select')[0]
    fireEvent.change(select, { target: { value: 'sidecar' } })
    await waitFor(() => expect(logsGet).toHaveBeenCalledWith('ctx', 'ns1', 'web-abc', 'sidecar', 500, undefined))
  })

  it('refetches when the tail line count changes', async () => {
    const logsGet = vi.fn().mockResolvedValue('x')
    setup({ logsGet })
    const { container } = renderModal()
    await waitFor(() => expect(logsGet).toHaveBeenCalledTimes(1))

    const tailSelect = container.querySelectorAll('select')[0]
    fireEvent.change(tailSelect, { target: { value: '1000' } })
    await waitFor(() => expect(logsGet).toHaveBeenCalledWith('ctx', 'ns1', 'web-abc', 'app', 1000, undefined))
  })

  it('refreshes via the refresh button', async () => {
    const logsGet = vi.fn().mockResolvedValue('x')
    setup({ logsGet })
    renderModal()
    await waitFor(() => expect(logsGet).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTitle('Refresh'))
    await waitFor(() => expect(logsGet).toHaveBeenCalledTimes(2))
  })
})

describe('PodLogsModal — filtering', () => {
  it('filters displayed lines and reports the filtered count', async () => {
    setup({ logsGet: vi.fn().mockResolvedValue('alpha error\nbeta ok\ngamma ERROR') })
    renderModal()
    await waitFor(() => expect(screen.getByText(/alpha error/)).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('Filter lines…'), { target: { value: 'error' } })
    const pre = document.querySelector('pre')!
    expect(pre.textContent).toContain('alpha error\ngamma ERROR')
    expect(pre.textContent).not.toContain('beta ok')
    expect(document.body.textContent).toContain('2 lines (filtered from 3)')
  })
})

describe('PodLogsModal — streaming', () => {
  it('starts a stream and appends incoming chunks', async () => {
    setup({ logsStream: vi.fn().mockResolvedValue('log-1') })
    renderModal()
    await waitFor(() => expect(api.k8s.logsGet).toHaveBeenCalled())

    await startStream()
    expect(api.k8s.logsStream).toHaveBeenCalledWith('ctx', 'ns1', 'web-abc', 'app', 500, undefined)
    expect(screen.getByText('Streaming')).toBeTruthy()
    expect(screen.getByText('Stop')).toBeTruthy()

    act(() => { chunkCb('log-1', 'first chunk\n') })
    act(() => { chunkCb('log-1', 'second chunk\n') })
    expect(document.querySelector('pre')!.textContent).toContain('first chunk\nsecond chunk')
  })

  it('ignores chunks and end events for other stream ids', async () => {
    setup({ logsStream: vi.fn().mockResolvedValue('log-1') })
    renderModal()
    await startStream()

    act(() => { chunkCb('other-stream', 'noise\n') })
    expect(screen.queryByText(/noise/)).toBeNull()

    act(() => { endCb('other-stream') })
    expect(screen.getByText('Streaming')).toBeTruthy()
  })

  it('stops streaming when the stream ends', async () => {
    setup({ logsStream: vi.fn().mockResolvedValue('log-1') })
    renderModal()
    await startStream()

    act(() => { endCb('log-1') })
    expect(screen.queryByText('Streaming')).toBeNull()
    expect(screen.getByText('Stream')).toBeTruthy()
  })

  it('stops the stream via the Stop button', async () => {
    setup({ logsStream: vi.fn().mockResolvedValue('log-1') })
    renderModal()
    await startStream()

    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => expect(api.k8s.logsStop).toHaveBeenCalledWith('log-1'))
    await waitFor(() => expect(screen.queryByText('Streaming')).toBeNull())
  })

  it('shows an error and resets when the stream fails to start', async () => {
    setup({ logsStream: vi.fn().mockRejectedValue(new Error('no pod')) })
    renderModal()
    await waitFor(() => expect(api.k8s.logsGet).toHaveBeenCalled())

    fireEvent.click(screen.getByText('Stream'))
    await waitFor(() => expect(screen.getByText('Error: no pod')).toBeTruthy())
    expect(screen.queryByText('Streaming')).toBeNull()
  })

  it('stops a running stream before starting a new one', async () => {
    setup({ logsStream: vi.fn().mockResolvedValueOnce('log-1').mockResolvedValueOnce('log-2') })
    renderModal()
    await startStream()

    // stop, then stream again — the second start must not stop anything (id was cleared)
    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => expect(screen.getByText('Stream')).toBeTruthy())
    expect(api.k8s.logsStop).toHaveBeenCalledTimes(1)

    await startStream()
    expect(api.k8s.logsStream).toHaveBeenCalledTimes(2)
  })

  it('stops the stream when the tail selection changes mid-stream', async () => {
    setup({ logsStream: vi.fn().mockResolvedValue('log-1') })
    const { container } = renderModal()
    await startStream()

    const tailSelect = container.querySelectorAll('select')[0]
    fireEvent.change(tailSelect, { target: { value: '100' } })
    await waitFor(() => expect(api.k8s.logsStop).toHaveBeenCalledWith('log-1'))
    await waitFor(() => expect(screen.queryByText('Streaming')).toBeNull())
  })

  it('stops the stream and removes listeners on unmount', async () => {
    setup({ logsStream: vi.fn().mockResolvedValue('log-1') })
    const { unmount } = renderModal()
    await startStream()

    unmount()
    expect(api.k8s.logsStop).toHaveBeenCalledWith('log-1')
    expect(offChunk).toHaveBeenCalled()
    expect(offEnd).toHaveBeenCalled()
  })

  it('caps the log buffer so a chatty stream cannot grow without bound', async () => {
    setup({ logsStream: vi.fn().mockResolvedValue('log-1') })
    renderModal()
    await startStream()

    const big = `${'a'.repeat(600_000)}\n${'b'.repeat(1_500_000)}\n`
    act(() => { chunkCb('log-1', big) })
    act(() => { chunkCb('log-1', 'tail-marker\n') })
    const pre = document.querySelector('pre')!
    expect(pre.textContent).toContain('tail-marker')
    expect(pre.textContent!.length).toBeLessThan(2_000_000)
    expect(pre.textContent).not.toContain('aaa')
  })
})

describe('PodLogsModal — chrome', () => {
  it('downloads the logs as a blob named after pod and container', async () => {
    setup({ logsGet: vi.fn().mockResolvedValue('some logs') })
    const createObjectURL = vi.fn().mockReturnValue('blob:fake')
    const revokeObjectURL = vi.fn()
    ;(URL as any).createObjectURL = createObjectURL
    ;(URL as any).revokeObjectURL = revokeObjectURL
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderModal()
    await waitFor(() => expect(screen.getByText(/some logs/)).toBeTruthy())
    fireEvent.click(screen.getByTitle('Download logs'))

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake')
    click.mockRestore()
  })

  it('closes on backdrop mousedown but not on panel clicks', async () => {
    setup()
    const { container, onClose } = renderModal()
    await waitFor(() => expect(api.k8s.logsGet).toHaveBeenCalled())

    fireEvent.mouseDown(container.querySelector('pre')!)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(container.firstElementChild as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via the header close button', async () => {
    setup()
    const { container, onClose } = renderModal()
    await waitFor(() => expect(api.k8s.logsGet).toHaveBeenCalled())

    const headerClose = container.querySelectorAll('button')[0]
    fireEvent.click(headerClose)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toggles auto-scroll via the checkbox', async () => {
    setup({ logsGet: vi.fn().mockResolvedValue('x') })
    const { container } = renderModal()
    await waitFor(() => expect(screen.getByText('x')).toBeTruthy())

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(false)
  })
})
