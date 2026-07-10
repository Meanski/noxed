// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Sidebar from '../Sidebar'
import { installWindowApi, seedStore, makeSession } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

function rowFor(label: string): HTMLElement {
  return screen.getByText(label).closest('[role="button"]') as HTMLElement
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

  it('activates nav items with Enter and Space', () => {
    render(<Sidebar />)

    fireEvent.keyDown(rowFor('Dashboard'), { key: 'Enter' })
    expect(useAppStore.getState().tabs.some(t => t.view === 'dashboard')).toBe(true)

    fireEvent.keyDown(rowFor('Tunnels'), { key: ' ' })
    expect(useAppStore.getState().tabs.some(t => t.view === 'tunnels')).toBe(true)

    // Unrelated keys do nothing
    fireEvent.keyDown(rowFor('Connections'), { key: 'a' })
    expect(useAppStore.getState().tabs.some(t => t.view === 'connections')).toBe(false)

    fireEvent.keyDown(rowFor('Settings'), { key: 'Enter' })
    expect(useAppStore.getState().tabs.some(t => t.view === 'settings')).toBe(true)
  })

  it('opens a session tab when a connection row receives Enter or Space', () => {
    seedStore({
      sessions: [
        makeSession({ id: 'ssh-1', label: 'Web Server' }),
        makeSession({ id: 'ssh-2', label: 'Db Server' }),
      ],
    })
    render(<Sidebar />)

    fireEvent.keyDown(rowFor('Web Server'), { key: 'Enter' })
    expect(useAppStore.getState().tabs.some(t => t.sessionId === 'ssh-1' && t.view === 'terminal')).toBe(true)

    fireEvent.keyDown(rowFor('Db Server'), { key: ' ' })
    expect(useAppStore.getState().tabs.some(t => t.sessionId === 'ssh-2')).toBe(true)
  })

  it('opens session tabs on click too', () => {
    seedStore({ sessions: [makeSession({ id: 'ssh-9', label: 'Clicky' })] })
    render(<Sidebar />)
    fireEvent.click(rowFor('Clicky'))
    expect(useAppStore.getState().tabs.some(t => t.sessionId === 'ssh-9')).toBe(true)
  })

  it('toggles project groups and connects to grouped sessions via keyboard', () => {
    seedStore({
      sidebarView: 'project',
      sessions: [makeSession({ id: 'p-1', label: 'Prod Box', group: 'Prod' })],
    })
    render(<Sidebar />)

    // Group is collapsed initially — the session row is hidden
    expect(screen.queryByText('Prod Box')).toBeNull()

    fireEvent.keyDown(rowFor('Prod'), { key: 'Enter' })
    expect(screen.getByText('Prod Box')).toBeTruthy()

    fireEvent.keyDown(rowFor('Prod Box'), { key: ' ' })
    expect(useAppStore.getState().tabs.some(t => t.sessionId === 'p-1')).toBe(true)

    // Space collapses the group again
    fireEvent.keyDown(rowFor('Prod'), { key: ' ' })
    expect(screen.queryByText('Prod Box')).toBeNull()
  })

  it('opens redis sessions through the redis tab action', () => {
    seedStore({ sessions: [makeSession({ id: 'r-1', label: 'Cache', type: 'redis' })] })
    render(<Sidebar />)
    fireEvent.keyDown(rowFor('Cache'), { key: 'Enter' })
    const tab = useAppStore.getState().tabs.find(t => t.sessionId === 'r-1')
    expect(tab?.view).toBe('redis')
  })
})
