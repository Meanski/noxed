// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import Dashboard from '../Dashboard'
import { installWindowApi, seedStore, makeSession, makeTab } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

describe('Dashboard', () => {
  beforeEach(() => {
    installWindowApi()
    seedStore({
      sessions: [], tabs: [], activeTabId: null, notifications: [],
      serverMetrics: {}, projectGroupOrder: [], groupColors: {},
      showAddConnection: false, recentConnections: [], quickConnectTarget: null,
    })
  })

  it('waits for saved connections to load before calling it a first run', () => {
    useAppStore.setState({ sessions: [], sessionsLoaded: false, sessionsLoadError: null })
    render(<Dashboard />)
    expect(screen.queryByText('Welcome to noxed')).toBeNull()
    expect(screen.queryByText(/No connections match/)).toBeNull()
    expect(screen.getByLabelText('Loading connections')).toBeTruthy()
  })

  it('explains a failed load and retries it', async () => {
    const api = installWindowApi()
    api.sessions.list.mockResolvedValueOnce([])
    useAppStore.setState({ sessions: [], sessionsLoaded: false, sessionsLoadError: 'Could not load your saved connections' })
    render(<Dashboard />)
    expect(screen.getByRole('alert').textContent).toBe('Could not load your saved connections')
    fireEvent.click(screen.getByText('Retry'))
    expect(await screen.findByText('Welcome to noxed')).toBeTruthy()
  })

  it('welcomes first-run users with ways to start', async () => {
    useAppStore.setState({ sessions: [], sessionsLoaded: true })
    render(<Dashboard />)
    expect(screen.getByText('Welcome to noxed')).toBeTruthy()
    fireEvent.click(screen.getByText('New connection'))
    expect(useAppStore.getState().showAddConnection).toBe(true)
    fireEvent.click(screen.getByText('Quick connect'))
    expect(useAppStore.getState().quickConnectTarget).toBe('')
    fireEvent.click(screen.getByText('Local terminal'))
    expect(useAppStore.getState().tabs.some((t) => t.view === 'local-term')).toBe(true)
    fireEvent.click(screen.getByText('Import ~/.ssh/config'))
    expect(await screen.findByText('Import from SSH config')).toBeTruthy()
    // Tunnels and Run command stay out of the first-run grid.
    expect(screen.queryByText('Tunnels')).toBeNull()
  })

  it('offers quick actions, including tunnels and the runner, above saved connections', () => {
    seedStore({ sessions: [makeSession({ id: 's1', label: 'Web' })] })
    render(<Dashboard />)
    fireEvent.click(screen.getByText('Tunnels'))
    expect(useAppStore.getState().tabs.some((t) => t.view === 'tunnels')).toBe(true)
    fireEvent.click(screen.getByText('Run command'))
    expect(useAppStore.getState().tabs.some((t) => t.view === 'runner')).toBe(true)
  })

  it('filters connections by name, host, user, group or tag', () => {
    seedStore({
      sessions: [
        makeSession({ id: 'a', label: 'Web One', host: 'web1.example.com', group: 'Prod' }),
        makeSession({ id: 'b', label: 'Database', host: 'db.internal', tags: ['postgres'] }),
      ],
    })
    render(<Dashboard />)
    const filter = screen.getByPlaceholderText('Filter connections')
    fireEvent.change(filter, { target: { value: 'POSTGRES' } })
    expect(screen.getByText('Database')).toBeTruthy()
    expect(screen.queryByText('Web One')).toBeNull()
    fireEvent.change(filter, { target: { value: 'nothing-here' } })
    expect(screen.getByText(/No connections match/)).toBeTruthy()
    fireEvent.click(screen.getByText('Clear filter'))
    expect(screen.getByText('Web One')).toBeTruthy()
  })

  it('lists recent connections that still exist and reopens them', () => {
    const web = makeSession({ id: 'web', label: 'Web' })
    seedStore({
      sessions: [web],
      recentConnections: [{ id: 'deleted', at: Date.now() }, { id: 'web', at: Date.now() - 120_000 }],
    })
    render(<Dashboard />)
    const recent = screen.getByRole('region', { name: 'Recent connections' })
    expect(within(recent).getByText('2m ago')).toBeTruthy()
    fireEvent.click(within(recent).getByText('Web'))
    expect(useAppStore.getState().tabs.some((t) => t.sessionId === 'web')).toBe(true)
  })

  it('sorts unsaved groups alphabetically with Ungrouped last', () => {
    seedStore({
      sessions: [
        makeSession({ id: 'z1', label: 'Zed', group: 'Zeta' }),
        makeSession({ id: 'u1', label: 'Loose' }), // no group → Ungrouped
        makeSession({ id: 'a1', label: 'Ay', group: 'Alpha' }),
      ],
    })
    const { container } = render(<Dashboard />)
    const text = container.textContent ?? ''
    const alpha = text.indexOf('Alpha')
    const zeta = text.indexOf('Zeta')
    const ungrouped = text.indexOf('Ungrouped')
    expect(alpha).toBeGreaterThan(-1)
    expect(alpha).toBeLessThan(zeta)
    expect(zeta).toBeLessThan(ungrouped)
  })

  it('respects the saved project group order before falling back to sort', () => {
    seedStore({
      projectGroupOrder: ['Zeta', 'Alpha'],
      sessions: [
        makeSession({ id: 'a1', label: 'Ay', group: 'Alpha' }),
        makeSession({ id: 'z1', label: 'Zed', group: 'Zeta' }),
      ],
    })
    const { container } = render(<Dashboard />)
    const text = container.textContent ?? ''
    expect(text.indexOf('Zeta')).toBeLessThan(text.indexOf('Alpha'))
  })

  it('renders average group CPU with the shared metric color', () => {
    seedStore({
      sessions: [makeSession({ id: 's1', label: 'Hot Box', group: 'Prod' })],
      tabs: [makeTab({ sessionId: 's1', status: 'connected' })],
      serverMetrics: {
        s1: { cpu: 85, memUsed: 4e9, memTotal: 8e9, available: true, lastUpdated: Date.now() },
      },
    })
    render(<Dashboard />)
    const cpu = screen.getByText('85% CPU')
    expect(cpu).toBeTruthy()
    // 85% is in the red band
    expect((cpu as HTMLElement).style.color).toBe('rgb(239, 68, 68)')
  })

  it('renders a healthy group with green CPU', () => {
    seedStore({
      sessions: [makeSession({ id: 's2', label: 'Cool Box', group: 'Prod' })],
      tabs: [makeTab({ sessionId: 's2', status: 'connected' })],
      serverMetrics: {
        s2: { cpu: 12, memUsed: 1e9, memTotal: 8e9, available: true, lastUpdated: Date.now() },
      },
    })
    render(<Dashboard />)
    const cpu = screen.getByText('12% CPU')
    expect((cpu as HTMLElement).style.color).toBe('rgb(16, 185, 129)')
  })
})
