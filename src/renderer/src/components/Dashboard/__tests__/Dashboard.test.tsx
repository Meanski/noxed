// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Dashboard from '../Dashboard'
import { installWindowApi, seedStore, makeSession, makeTab } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

describe('Dashboard', () => {
  beforeEach(() => {
    installWindowApi()
    seedStore({
      sessions: [], tabs: [], activeTabId: null, notifications: [],
      serverMetrics: {}, projectGroupOrder: [], groupColors: {},
      showAddConnection: false,
    })
  })

  it('shows the empty state and opens the add-connection modal', () => {
    render(<Dashboard />)
    expect(screen.getByText('No connections yet')).toBeTruthy()
    fireEvent.click(screen.getByText('Add Connection'))
    expect(useAppStore.getState().showAddConnection).toBe(true)
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
