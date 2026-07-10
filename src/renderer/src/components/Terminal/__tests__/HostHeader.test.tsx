// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import HostHeader from '../HostHeader'
import { installWindowApi, seedStore, makeSession } from '../../../__tests__/harness'

const session = makeSession({ id: 'h1', label: 'Primary', host: 'h1.example.com', username: 'root', port: 2222 })

function renderHeader(overrides: Partial<React.ComponentProps<typeof HostHeader>> = {}) {
  const props = {
    session,
    status: 'connected',
    elapsed: '5m',
    metrics: { cpu: 42, memUsed: 2e9, memTotal: 8e9, available: true },
    cpuHistory: [10, 20, 30],
    filesOpen: false,
    snippetsOpen: false,
    broadcastEnabled: false,
    onToggleFiles: vi.fn(),
    onToggleSnippets: vi.fn(),
    onToggleBroadcast: vi.fn(),
    ...overrides,
  }
  render(<HostHeader {...props} />)
  return props
}

describe('HostHeader', () => {
  beforeEach(() => {
    installWindowApi()
    seedStore({ sessions: [session, makeSession({ id: 'h2', label: 'Secondary' })], tabs: [] })
  })

  it('shows identity, uptime and metrics while connected', () => {
    renderHeader()
    expect(screen.getByText((_, el) => el?.textContent === 'root@h1.example.com:2222' && el?.tagName === 'SPAN')).toBeTruthy()
    expect(screen.getByText('5m')).toBeTruthy()
    expect(screen.getByText('42%')).toBeTruthy()
  })

  it('renders the connecting state', () => {
    renderHeader({ status: 'connecting', metrics: null, elapsed: '' })
    expect(screen.getByText('Connecting…')).toBeTruthy()
  })

  it('renders the disconnected state without metrics', () => {
    renderHeader({ status: 'error', metrics: null, elapsed: '' })
    expect(screen.queryByText('Connecting…')).toBeNull()
    expect(screen.queryByText(/%$/)).toBeNull()
  })

  it('wires up the panel toggles', () => {
    const props = renderHeader()
    fireEvent.click(screen.getByText('Snippets'))
    expect(props.onToggleSnippets).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Files'))
    expect(props.onToggleFiles).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Broadcast'))
    expect(props.onToggleBroadcast).toHaveBeenCalled()
  })

  it('offers a split picker when allowed and a close button for panes', () => {
    const onSplitPick = vi.fn()
    const onClosePane = vi.fn()
    renderHeader({ onSplitPick, onClosePane })

    fireEvent.click(screen.getByText('Split'))
    fireEvent.click(screen.getByText('Primary (again)'))
    expect(onSplitPick).toHaveBeenCalledWith(session)

    fireEvent.click(screen.getByTitle('Close pane'))
    expect(onClosePane).toHaveBeenCalled()
  })

  it('lists other ssh sessions in the split menu', () => {
    const onSplitPick = vi.fn()
    renderHeader({ onSplitPick })
    fireEvent.click(screen.getByText('Split'))
    fireEvent.click(screen.getByText('Secondary'))
    expect(onSplitPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'h2' }))
  })
})
