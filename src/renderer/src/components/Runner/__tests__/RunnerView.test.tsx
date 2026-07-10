// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import RunnerView from '../RunnerView'
import { installWindowApi, seedStore, makeSession, type WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

type OutputCb = (runId: string, sessionId: string, data: string) => void
type DoneCb = (runId: string, sessionId: string, exitCode: number | null, error: string | null) => void

function setup(runResult: 'ok' | 'fail' = 'ok') {
  const host1 = makeSession({ label: 'web-1', type: 'ssh' })
  const host2 = makeSession({ label: 'web-2', type: 'ssh' })
  const redis = makeSession({ label: 'cache', type: 'redis' })
  seedStore({ sessions: [host1, host2, redis], notifications: [] })

  let outputCb: OutputCb = () => {}
  let doneCb: DoneCb = () => {}
  const api = installWindowApi({
    runner: {
      run:
        runResult === 'ok'
          ? vi.fn().mockResolvedValue('run-1')
          : vi.fn().mockRejectedValue(new Error('spawn failed')),
      cancel: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn().mockImplementation((cb: OutputCb) => {
        outputCb = cb
        return () => {}
      }),
      onDone: vi.fn().mockImplementation((cb: DoneCb) => {
        doneCb = cb
        return () => {}
      }),
    },
  })
  render(<RunnerView />)
  return { host1, host2, redis, api, emitOutput: (...a: Parameters<OutputCb>) => outputCb(...a), emitDone: (...a: Parameters<DoneCb>) => doneCb(...a) }
}

function checkboxFor(label: string): HTMLElement {
  return screen.getByText(label).closest('label')!.querySelector('button') as HTMLElement
}

async function startRun(host1: ReturnType<typeof makeSession>, api: WindowApiMock, command = 'uptime') {
  fireEvent.click(checkboxFor(host1.label))
  fireEvent.change(screen.getByPlaceholderText(/runs on every selected host/), { target: { value: command } })
  fireEvent.click(screen.getByText('Run'))
  await waitFor(() => expect(api.runner.run).toHaveBeenCalledWith([host1.id], command))
}

describe('RunnerView', () => {
  beforeEach(() => {
    seedStore({ sessions: [], notifications: [] })
  })

  it('lists only SSH hosts and shows the empty state', () => {
    setup()
    expect(screen.getByText('Hosts (0/2)')).toBeTruthy()
    expect(screen.getByText('web-1')).toBeTruthy()
    expect(screen.getByText('web-2')).toBeTruthy()
    expect(screen.queryByText('cache')).toBeNull()
    expect(screen.getByText('Run a command across your fleet')).toBeTruthy()
  })

  it('toggles hosts via the checkbox button and reflects state in aria-pressed', () => {
    setup()
    const box = checkboxFor('web-1')
    expect(box.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(box)
    expect(screen.getByText('Hosts (1/2)')).toBeTruthy()
    expect(box.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(box)
    expect(screen.getByText('Hosts (0/2)')).toBeTruthy()
    expect(box.getAttribute('aria-pressed')).toBe('false')
  })

  it('selects all / none via the header toggle', () => {
    setup()
    fireEvent.click(screen.getByText('All'))
    expect(screen.getByText('Hosts (2/2)')).toBeTruthy()
    fireEvent.click(screen.getByText('None'))
    expect(screen.getByText('Hosts (0/2)')).toBeTruthy()
  })

  it('runs a command and streams output/exit codes into result cards', async () => {
    const { host1, host2, api, emitOutput, emitDone } = setup()
    fireEvent.click(screen.getByText('All'))
    fireEvent.change(screen.getByPlaceholderText(/runs on every selected host/), { target: { value: 'uptime' } })
    fireEvent.click(screen.getByText('Run'))

    await waitFor(() => expect(api.runner.run).toHaveBeenCalledWith([host1.id, host2.id], 'uptime'))
    expect(screen.getAllByText('running')).toHaveLength(2)

    // Output for a stale run id is ignored
    act(() => emitOutput('stale-run', host1.id, 'IGNORED'))
    expect(screen.queryByText(/IGNORED/)).toBeNull()

    act(() => {
      emitOutput('run-1', host1.id, 'load average: 0.1')
      emitOutput('run-1', host1.id, '\nmore')
    })
    expect(screen.getByText(/load average: 0\.1/)).toBeTruthy()

    act(() => emitDone('run-1', host1.id, 0, null))
    expect(screen.getByText('exit 0')).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy() // still running host2

    act(() => emitDone('run-1', host2.id, 3, null))
    expect(screen.getByText('exit 3')).toBeTruthy()
    // Everything finished — Run button returns
    expect(screen.getByText('Run')).toBeTruthy()

    // Stale done is ignored too
    act(() => emitDone('other', host1.id, 1, null))
    expect(screen.getByText('exit 0')).toBeTruthy()
  })

  it('marks a host as error when done reports an error message', async () => {
    const { host1, api, emitDone } = setup()
    await startRun(host1, api)
    act(() => emitDone('run-1', host1.id, null, 'ssh: connection refused'))
    expect(screen.getByText('error')).toBeTruthy()
    expect(screen.getByText('ssh: connection refused')).toBeTruthy()
  })

  it('supports Cmd+Enter to run and collapsing a result card', async () => {
    const { host1, api, emitOutput } = setup()
    fireEvent.click(checkboxFor('web-1'))
    const input = screen.getByPlaceholderText(/runs on every selected host/)
    fireEvent.change(input, { target: { value: 'whoami' } })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(api.runner.run).toHaveBeenCalledWith([host1.id], 'whoami'))

    act(() => emitOutput('run-1', host1.id, 'root'))
    expect(screen.getByText('root')).toBeTruthy()
    // Collapse the card header — the pre disappears. The sidebar label is not
    // inside a <button>, so closest('button') isolates the result-card header.
    const cardHeader = () =>
      screen.getAllByText('web-1').map(el => el.closest('button')).find(b => b !== null) as HTMLElement
    fireEvent.click(cardHeader())
    expect(screen.queryByText('root')).toBeNull()
    // Reopen
    fireEvent.click(cardHeader())
    expect(screen.getByText('root')).toBeTruthy()
  })

  it('cancel marks running hosts as failed with Cancelled', async () => {
    const { host1, api } = setup()
    await startRun(host1, api)
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() => expect(api.runner.cancel).toHaveBeenCalledWith('run-1'))
    expect(await screen.findByText('Cancelled')).toBeTruthy()
    expect(screen.getByText('error')).toBeTruthy()
  })

  it('does not run without a command or selection', () => {
    const { api } = setup()
    const runBtn = screen.getByText('Run').closest('button') as HTMLButtonElement
    expect(runBtn.disabled).toBe(true)
    fireEvent.click(runBtn)
    expect(api.runner.run).not.toHaveBeenCalled()
  })

  it('surfaces run failures as a notification and clears results', async () => {
    setup('fail')
    fireEvent.click(checkboxFor('web-1'))
    fireEvent.change(screen.getByPlaceholderText(/runs on every selected host/), { target: { value: 'uptime' } })
    fireEvent.click(screen.getByText('Run'))
    await waitFor(() => {
      const notes = useAppStore.getState().notifications
      expect(notes.some(n => n.type === 'error' && n.message === 'spawn failed')).toBe(true)
    })
    expect(screen.getByText('Run a command across your fleet')).toBeTruthy()
  })
})
