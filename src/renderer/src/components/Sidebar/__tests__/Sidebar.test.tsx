// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Sidebar from '../Sidebar'
import { installWindowApi, seedStore, makeSession } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

function rowFor(label: string): HTMLElement {
  return screen.getByText(label).closest('button') as HTMLElement
}

describe('Sidebar', () => {
  beforeEach(() => {
    installWindowApi()
    seedStore({
      sessions: [], tabs: [], activeTabId: null, notifications: [],
      sidebarView: 'type', sectionOrder: {}, projectGroupOrder: [],
      groupColors: {}, focusedPaneId: null, showAddConnection: false,
    })
  })

  it('activates nav items on click', () => {
    render(<Sidebar />)

    fireEvent.click(rowFor('Dashboard'))
    expect(useAppStore.getState().tabs.some(t => t.view === 'dashboard')).toBe(true)

    fireEvent.click(rowFor('Tunnels'))
    expect(useAppStore.getState().tabs.some(t => t.view === 'tunnels')).toBe(true)

    fireEvent.click(rowFor('Settings'))
    expect(useAppStore.getState().tabs.some(t => t.view === 'settings')).toBe(true)
  })

  it('opens a session tab when a connection row is clicked', () => {
    seedStore({
      sessions: [
        makeSession({ id: 'ssh-1', label: 'Web Server' }),
        makeSession({ id: 'ssh-2', label: 'Db Server' }),
      ],
    })
    render(<Sidebar />)

    fireEvent.click(rowFor('Web Server'))
    expect(useAppStore.getState().tabs.some(t => t.sessionId === 'ssh-1' && t.view === 'terminal')).toBe(true)

    fireEvent.click(rowFor('Db Server'))
    expect(useAppStore.getState().tabs.some(t => t.sessionId === 'ssh-2')).toBe(true)
  })

  it('opens session tabs on click too', () => {
    seedStore({ sessions: [makeSession({ id: 'ssh-9', label: 'Clicky' })] })
    render(<Sidebar />)
    fireEvent.click(rowFor('Clicky'))
    expect(useAppStore.getState().tabs.some(t => t.sessionId === 'ssh-9')).toBe(true)
  })

  it('toggles project groups and connects to grouped sessions on click', () => {
    seedStore({
      sidebarView: 'project',
      sessions: [makeSession({ id: 'p-1', label: 'Prod Box', group: 'Prod' })],
    })
    render(<Sidebar />)

    // Group is collapsed initially — the session row is hidden
    expect(screen.queryByText('Prod Box')).toBeNull()

    fireEvent.click(rowFor('Prod'))
    expect(screen.getByText('Prod Box')).toBeTruthy()

    fireEvent.click(rowFor('Prod Box'))
    expect(useAppStore.getState().tabs.some(t => t.sessionId === 'p-1')).toBe(true)

    // Clicking the header again collapses the group
    fireEvent.click(rowFor('Prod'))
    expect(screen.queryByText('Prod Box')).toBeNull()
  })

  it('opens redis sessions through the redis tab action', () => {
    seedStore({ sessions: [makeSession({ id: 'r-1', label: 'Cache', type: 'redis' })] })
    render(<Sidebar />)
    fireEvent.click(rowFor('Cache'))
    const tab = useAppStore.getState().tabs.find(t => t.sessionId === 'r-1')
    expect(tab?.view).toBe('redis')
  })
})
