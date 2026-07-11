// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CommandPalette from '../CommandPalette'
import { installWindowApi, seedStore, makeSession, makeTab } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

// jsdom does not implement scrollIntoView, which the palette calls on selection
Element.prototype.scrollIntoView = vi.fn()

describe('CommandPalette', () => {
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    installWindowApi()
    onClose = vi.fn()
    seedStore({
      sessions: [], tabs: [], activeTabId: null, showAddSession: false,
      groupColors: {}, notifications: [],
    })
  })

  const type = (value: string) =>
    fireEvent.change(screen.getByPlaceholderText('Search servers, commands…'), { target: { value } })

  it('renders search input, quick action, sessions and command sections', () => {
    seedStore({
      sessions: [
        makeSession({ id: 'p1', label: 'Prod Web', host: 'prod.example.com', group: 'Prod' }),
        makeSession({ id: 'd1', label: 'Dev Box', host: 'dev.example.com' }),
      ],
      tabs: [makeTab({ sessionId: 'p1', status: 'connected' })],
    })
    render(<CommandPalette onClose={onClose} />)

    expect(screen.getByPlaceholderText('Search servers, commands…')).toBeTruthy()
    expect(screen.getByText('Quick actions')).toBeTruthy()
    expect(screen.getByText('New Local Terminal')).toBeTruthy()
    // connected session lands in the Active section (label + row badge), idle one under Servers
    expect(screen.getAllByText('Active')).toHaveLength(2)
    expect(screen.getByText('Prod Web')).toBeTruthy()
    expect(screen.getByText('Servers')).toBeTruthy()
    expect(screen.getByText('Dev Box')).toBeTruthy()
    expect(screen.getByText('Commands')).toBeTruthy()
    expect(screen.getByText('New SSH Session')).toBeTruthy()
    expect(screen.getByText('Open Dashboard')).toBeTruthy()
    expect(screen.getByText('Open Tunnels')).toBeTruthy()
    expect(screen.getByText('Run Command on Hosts…')).toBeTruthy()
    // group chip renders for grouped sessions
    expect(screen.getByText('Prod')).toBeTruthy()
    // per-host Docker commands are hidden until searched for
    expect(screen.queryByText(/Docker on/)).toBeNull()
  })

  it('filters sessions by query and hides section labels while searching', () => {
    seedStore({
      sessions: [
        makeSession({ id: 'p1', label: 'Prod Web', host: 'prod.example.com' }),
        makeSession({ id: 'd1', label: 'Dev Box', host: 'dev.example.com' }),
      ],
    })
    render(<CommandPalette onClose={onClose} />)
    type('prod web')

    expect(screen.getByText('Prod Web')).toBeTruthy()
    expect(screen.queryByText('Dev Box')).toBeNull()
    expect(screen.queryByText('New Local Terminal')).toBeNull()
    expect(screen.queryByText('Servers')).toBeNull()
    expect(screen.queryByText('Commands')).toBeNull()
  })

  it('matches sessions on host, username and group', () => {
    seedStore({
      sessions: [
        makeSession({ id: 'h1', label: 'ByHost', host: 'special-host.io', username: 'root' }),
        makeSession({ id: 'g1', label: 'ByGroup', host: 'other.io', username: 'deploy', group: 'staging' }),
      ],
    })
    render(<CommandPalette onClose={onClose} />)

    type('special-host')
    expect(screen.getByText('ByHost')).toBeTruthy()
    expect(screen.queryByText('ByGroup')).toBeNull()

    type('staging')
    expect(screen.getByText('ByGroup')).toBeTruthy()
    expect(screen.queryByText('ByHost')).toBeNull()

    type('deploy')
    expect(screen.getByText('ByGroup')).toBeTruthy()
  })

  it('shows the empty state when nothing matches', () => {
    seedStore({ sessions: [makeSession({ id: 's1', label: 'Alpha' })] })
    render(<CommandPalette onClose={onClose} />)
    type('zzz-no-match')

    expect(screen.getByText('No results')).toBeTruthy()
    expect(screen.getByText(/Nothing matches/)).toBeTruthy()
  })

  it('clears the query with the clear button', () => {
    render(<CommandPalette onClose={onClose} />)
    const input = screen.getByPlaceholderText('Search servers, commands…') as HTMLInputElement
    type('zzz-no-match')
    expect(screen.getByText('No results')).toBeTruthy()

    const clearBtn = input.parentElement!.querySelector('button')!
    fireEvent.click(clearBtn)
    expect(input.value).toBe('')
    expect(screen.getByText('New Local Terminal')).toBeTruthy()
  })

  it('opens a local terminal tab on Enter for the default selection', () => {
    render(<CommandPalette onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Enter' })

    const { tabs, activeTabId } = useAppStore.getState()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].view).toBe('local-term')
    expect(activeTabId).toBe(tabs[0].id)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('navigates with arrow keys and activates a session with Enter', () => {
    seedStore({ sessions: [makeSession({ id: 's1', label: 'Only Server', host: 'one.example.com' })] })
    render(<CommandPalette onClose={onClose} />)

    // item 0 = New Local Terminal, item 1 = the session
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })

    const { tabs } = useAppStore.getState()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].sessionId).toBe('s1')
    expect(tabs[0].view).toBe('terminal')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clamps arrow navigation at the list edges', () => {
    seedStore({ sessions: [] })
    render(<CommandPalette onClose={onClose} />)

    // ArrowUp at the top stays on New Local Terminal
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(useAppStore.getState().tabs[0].view).toBe('local-term')

    // ArrowDown past the end stays on the last command (Run Command on Hosts…)
    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })
    const { tabs } = useAppStore.getState()
    expect(tabs[tabs.length - 1].view).toBe('runner')
  })

  it('closes on Escape without touching the store', () => {
    render(<CommandPalette onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabs).toHaveLength(0)
  })

  it('closes when clicking the backdrop but not the panel', () => {
    const { container } = render(<CommandPalette onClose={onClose} />)
    const backdrop = container.firstChild as HTMLElement

    fireEvent.click(screen.getByPlaceholderText('Search servers, commands…'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens the add-session modal when clicking New SSH Session', () => {
    render(<CommandPalette onClose={onClose} />)
    fireEvent.click(screen.getByText('New SSH Session'))

    expect(useAppStore.getState().showAddSession).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens dashboard and tunnels singleton tabs from commands', () => {
    render(<CommandPalette onClose={onClose} />)
    fireEvent.click(screen.getByText('Open Dashboard'))
    fireEvent.click(screen.getByText('Open Tunnels'))

    const views = useAppStore.getState().tabs.map((t) => t.view)
    expect(views).toContain('dashboard')
    expect(views).toContain('tunnels')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('surfaces per-host Docker commands when searched and opens a docker tab', () => {
    seedStore({
      sessions: [
        makeSession({ id: 's1', label: 'Web One', host: 'web1.example.com' }),
        makeSession({ id: 'k1', label: 'Cluster', host: 'k8s.example.com', type: 'k8s' }),
      ],
    })
    render(<CommandPalette onClose={onClose} />)
    type('docker')

    // only ssh sessions get a docker entry
    expect(screen.getByText('Docker on Web One')).toBeTruthy()
    expect(screen.queryByText('Docker on Cluster')).toBeNull()

    fireEvent.click(screen.getByText('Docker on Web One'))
    const { tabs } = useAppStore.getState()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].view).toBe('docker')
    expect(tabs[0].sessionId).toBe('s1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('switches to the existing tab when activating a connected session', () => {
    const tab = makeTab({ sessionId: 's1', status: 'connected' })
    seedStore({
      sessions: [makeSession({ id: 's1', label: 'Live Box', host: 'live.example.com' })],
      tabs: [tab],
      activeTabId: null,
    })
    render(<CommandPalette onClose={onClose} />)
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('Live Box'))
    const state = useAppStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(tab.id)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('marks a connecting session and selects rows on hover', () => {
    seedStore({
      sessions: [makeSession({ id: 's1', label: 'Spinning Up', host: 'boot.example.com' })],
      tabs: [makeTab({ sessionId: 's1', status: 'connecting' })],
    })
    render(<CommandPalette onClose={onClose} />)

    const row = screen.getByText('Spinning Up').closest('button')!
    // not selected yet: no Connect affordance
    expect(screen.queryByText('Connect')).toBeNull()

    fireEvent.mouseMove(row)
    expect(screen.getByText('Connect')).toBeTruthy()
  })
})
