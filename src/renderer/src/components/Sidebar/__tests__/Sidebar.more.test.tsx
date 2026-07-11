// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Sidebar from '../Sidebar'
import { installWindowApi, seedStore, makeSession, WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

let api: WindowApiMock

function setup(state: Record<string, unknown> = {}) {
  api = installWindowApi({
    sessions: {
      update: vi.fn().mockImplementation((_id: string, data: Record<string, unknown>) => Promise.resolve(data)),
    },
  })
  seedStore({
    sessions: [], tabs: [], activeTabId: null, notifications: [],
    sidebarView: 'type', sectionOrder: {}, projectGroupOrder: [],
    groupColors: {}, focusedPaneId: null, showAddConnection: false,
    showCommandPalette: false, editingConnectionId: null, pendingConnectionGroup: null,
    ...state,
  })
  return render(<Sidebar />)
}

function rowFor(label: string): HTMLElement {
  return screen.getByText(label).closest('button') as HTMLElement
}

function isBefore(first: HTMLElement, second: HTMLElement): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
}

// ServerContextMenu color swatches carry no label — find them by inline background
function swatchFor(hex: string): HTMLElement {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const rgb = `rgb(${r}, ${g}, ${b})`
  const match = Array.from(document.querySelectorAll('button')).find(el => {
    const bg = el.style.background || el.style.backgroundColor
    return bg === rgb || bg.toLowerCase() === hex.toLowerCase()
  })
  if (!match) throw new Error(`no swatch found for ${hex}`)
  return match
}

describe('Sidebar (extended)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('sections and ordering', () => {
    it('renders a section per connection type plus favorites on darwin', () => {
      setup({
        sessions: [
          makeSession({ id: 'a', label: 'Ssh Box', isFavorite: true }),
          makeSession({ id: 'b', label: 'Files Box', type: 'sftp' }),
          makeSession({ id: 'c', label: 'Db Box', type: 'database' }),
          makeSession({ id: 'd', label: 'Cache Box', type: 'redis' }),
          makeSession({ id: 'e', label: 'Cluster Box', type: 'kubernetes' }),
          makeSession({ id: 'f', label: 'Desk Box', type: 'rdp' }),
        ],
      })

      for (const header of ['Favorites', 'SSH', 'SFTP', 'Databases', 'Redis', 'Kubernetes', 'Remote Desktop']) {
        expect(screen.getByText(header)).toBeTruthy()
      }
      // The favorite shows twice: once under Favorites, once under SSH
      expect(screen.getAllByText('Ssh Box')).toHaveLength(2)
    })

    it('applies a saved order to a section', () => {
      setup({
        sessions: [
          makeSession({ id: 'a', label: 'Alpha' }),
          makeSession({ id: 'b', label: 'Beta' }),
        ],
        sectionOrder: { ssh: ['b', 'a'] },
      })

      expect(isBefore(screen.getByText('Beta'), screen.getByText('Alpha'))).toBe(true)
    })

    it('persists a new order after dragging one row onto another', () => {
      setup({
        sessions: [
          makeSession({ id: 'a', label: 'Alpha' }),
          makeSession({ id: 'b', label: 'Beta' }),
        ],
      })

      const alphaWrap = rowFor('Alpha').parentElement as HTMLElement
      const betaWrap = rowFor('Beta').parentElement as HTMLElement

      fireEvent.dragStart(alphaWrap)
      fireEvent.dragOver(betaWrap)
      fireEvent.drop(betaWrap)
      fireEvent.dragEnd(alphaWrap)

      expect(useAppStore.getState().sectionOrder.ssh).toEqual(['b', 'a'])
      expect(isBefore(screen.getByText('Beta'), screen.getByText('Alpha'))).toBe(true)
    })

    it('opens the command palette from the search button', () => {
      setup()
      const search = screen.getByText('Search… ⌘K').closest('button') as HTMLElement

      fireEvent.mouseEnter(search)
      fireEvent.mouseLeave(search)
      fireEvent.click(search)

      expect(useAppStore.getState().showCommandPalette).toBe(true)
    })

    it('switches between type and project views', () => {
      setup()

      fireEvent.click(rowFor('Project'))
      expect(useAppStore.getState().sidebarView).toBe('project')

      fireEvent.click(rowFor('Type'))
      expect(useAppStore.getState().sidebarView).toBe('type')
    })

    it('highlights nav items and connection rows on hover', () => {
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      const nav = rowFor('Dashboard')
      fireEvent.mouseEnter(nav)
      expect(nav.style.background).toBeTruthy()
      fireEvent.mouseLeave(nav)
      expect(nav.style.background).toBe('')

      const row = rowFor('Alpha')
      fireEvent.mouseEnter(row)
      expect(row.style.background).toBeTruthy()
      fireEvent.mouseLeave(row)
      expect(row.style.background).toBe('')
    })
  })

  describe('session context menu', () => {
    it('opens the connection editor from Edit Connection', () => {
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(screen.getByText('Edit Connection'))

      const state = useAppStore.getState()
      expect(state.editingConnectionId).toBe('a')
      expect(state.showAddConnection).toBe(true)
      expect(screen.queryByText('Edit Connection')).toBeNull()
    })

    it('renames a session inline with Enter', async () => {
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(screen.getByText('Rename'))

      const input = screen.getByDisplayValue('Alpha')
      fireEvent.change(input, { target: { value: 'Renamed Box' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => expect(screen.queryByDisplayValue('Renamed Box')).toBeNull())
      expect(api.sessions.update).toHaveBeenCalledWith('a', { label: 'Renamed Box' })
      expect(useAppStore.getState().sessions[0].label).toBe('Renamed Box')
    })

    it('ignores an empty rename and cancels with Escape', () => {
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(screen.getByText('Rename'))

      const input = screen.getByDisplayValue('Alpha')
      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(api.sessions.update).not.toHaveBeenCalled()

      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByDisplayValue('   ')).toBeNull()
      expect(useAppStore.getState().sessions[0].label).toBe('Alpha')
    })

    it('commits a rename on blur', async () => {
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(screen.getByText('Rename'))

      const input = screen.getByDisplayValue('Alpha')
      fireEvent.change(input, { target: { value: 'Blurred' } })
      fireEvent.blur(input)

      await waitFor(() => expect(useAppStore.getState().sessions[0].label).toBe('Blurred'))
    })

    it('toggles favorites and surfaces the Favorites section', async () => {
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })
      expect(screen.queryByText('Favorites')).toBeNull()

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(screen.getByText('Add to Favorites'))

      await waitFor(() => expect(screen.getByText('Favorites')).toBeTruthy())
      expect(api.sessions.update).toHaveBeenCalledWith('a', { isFavorite: true })
    })

    it('changes the session color from the palette', async () => {
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(swatchFor('#EC4899'))

      await waitFor(() => expect(useAppStore.getState().sessions[0].color).toBe('#EC4899'))
      expect(api.sessions.update).toHaveBeenCalledWith('a', { color: '#EC4899' })
    })

    it('moves a session to another project through the submenu', async () => {
      setup({
        sessions: [
          makeSession({ id: 'a', label: 'Alpha' }),
          makeSession({ id: 'b', label: 'Beta', group: 'Crew' }),
        ],
      })

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(screen.getByText('Move to Project'))
      fireEvent.click(screen.getByText('Crew'))

      await waitFor(() => expect(useAppStore.getState().sessions[0].group).toBe('Crew'))
      expect(api.sessions.update).toHaveBeenCalledWith('a', { group: 'Crew' })
    })

    it('deletes a session after confirmation', async () => {
      vi.stubGlobal('confirm', vi.fn(() => true))
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(screen.getByText('Delete'))

      await waitFor(() => expect(useAppStore.getState().sessions).toHaveLength(0))
      expect(api.sessions.delete).toHaveBeenCalledWith('a')
    })

    it('keeps the session when deletion is cancelled', async () => {
      vi.stubGlobal('confirm', vi.fn(() => false))
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(screen.getByText('Delete'))

      await waitFor(() => expect(screen.queryByText('Delete')).toBeNull())
      expect(api.sessions.delete).not.toHaveBeenCalled()
      expect(useAppStore.getState().sessions).toHaveLength(1)
    })

    it('opens a docker dashboard tab for ssh sessions', () => {
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      fireEvent.contextMenu(rowFor('Alpha'))
      fireEvent.click(screen.getByText('Docker Dashboard'))

      expect(useAppStore.getState().tabs.some(t => t.view === 'docker' && t.sessionId === 'a')).toBe(true)
    })

    it('offers remote desktop instead of docker for rdp sessions', () => {
      setup({ sessions: [makeSession({ id: 'r', label: 'Desk', type: 'rdp' })] })

      fireEvent.contextMenu(rowFor('Desk'))
      expect(screen.queryByText('Docker Dashboard')).toBeNull()
      fireEvent.click(screen.getByText('Open Remote Desktop'))

      expect(useAppStore.getState().tabs.some(t => t.view === 'rdp' && t.sessionId === 'r')).toBe(true)
    })

    it('closes on an outside mousedown', () => {
      setup({ sessions: [makeSession({ id: 'a', label: 'Alpha' })] })

      fireEvent.contextMenu(rowFor('Alpha'))
      expect(screen.getByText('Edit Connection')).toBeTruthy()

      fireEvent.mouseDown(document.body)
      expect(screen.queryByText('Edit Connection')).toBeNull()
    })

    it('right-clicking empty sidebar space offers a new connection', () => {
      setup()

      fireEvent.contextMenu(screen.getByRole('navigation'))
      fireEvent.click(screen.getByText('New Connection'))

      expect(useAppStore.getState().showAddConnection).toBe(true)
      expect(screen.queryByText('New Connection')).toBeNull()
    })
  })

  describe('project view', () => {
    it('shows an empty state without connections', () => {
      setup({ sidebarView: 'project' })
      expect(screen.getByText('No connections')).toBeTruthy()
    })

    it('syncs the group order into the store and shows member counts', async () => {
      setup({
        sidebarView: 'project',
        sessions: [
          makeSession({ id: 'p1', label: 'Prod One', group: 'Prod' }),
          makeSession({ id: 'd1', label: 'Dev One', group: 'Dev' }),
          makeSession({ id: 'p2', label: 'Prod Two', group: 'Prod' }),
          makeSession({ id: 'u1', label: 'Loose One' }),
        ],
      })

      await waitFor(() =>
        expect(useAppStore.getState().projectGroupOrder).toEqual(['Prod', 'Dev', 'Ungrouped'])
      )
      expect(screen.getByText('2')).toBeTruthy()
    })

    it('reorders groups by dragging the grip handle', () => {
      setup({
        sidebarView: 'project',
        projectGroupOrder: ['Dev', 'Prod'],
        sessions: [
          makeSession({ id: 'p1', label: 'Prod One', group: 'Prod' }),
          makeSession({ id: 'd1', label: 'Dev One', group: 'Dev' }),
        ],
      })

      expect(isBefore(screen.getByText('Dev'), screen.getByText('Prod'))).toBe(true)

      const grip = rowFor('Dev').querySelector('span[draggable="true"]') as HTMLElement
      const prodContainer = rowFor('Prod').parentElement as HTMLElement

      fireEvent.dragStart(grip)
      fireEvent.dragOver(prodContainer)
      fireEvent.drop(prodContainer)
      fireEvent.dragEnd(grip)

      expect(useAppStore.getState().projectGroupOrder).toEqual(['Prod', 'Dev'])
    })

    it('moves a session into another group by dropping it on the header', async () => {
      setup({
        sidebarView: 'project',
        projectGroupOrder: ['Prod', 'Dev'],
        sessions: [
          makeSession({ id: 'a', label: 'Alpha', group: 'Prod' }),
          makeSession({ id: 'b', label: 'Beta', group: 'Dev' }),
        ],
      })

      fireEvent.click(rowFor('Prod'))
      const item = rowFor('Alpha')
      const devContainer = rowFor('Dev').parentElement as HTMLElement

      fireEvent.dragStart(item)
      fireEvent.dragOver(devContainer)
      // Leaving the target clears the highlight, re-entering restores it
      fireEvent.dragLeave(devContainer, { relatedTarget: document.body })
      fireEvent.dragOver(devContainer)
      fireEvent.drop(devContainer)
      fireEvent.dragEnd(item)

      await waitFor(() => expect(useAppStore.getState().sessions[0].group).toBe('Dev'))
      expect(api.sessions.update).toHaveBeenCalledWith('a', { group: 'Dev' })
    })

    it('reorders sessions within a group and honors the saved order', () => {
      setup({
        sidebarView: 'project',
        projectGroupOrder: ['Prod'],
        sessions: [
          makeSession({ id: 'a', label: 'Alpha', group: 'Prod' }),
          makeSession({ id: 'b', label: 'Beta', group: 'Prod' }),
        ],
      })

      fireEvent.click(rowFor('Prod'))
      const alpha = rowFor('Alpha')
      const beta = rowFor('Beta')

      fireEvent.dragStart(alpha)
      fireEvent.dragOver(beta)
      fireEvent.drop(beta)
      fireEvent.dragEnd(alpha)

      expect(useAppStore.getState().sectionOrder['project:Prod']).toEqual(['b', 'a'])
      expect(isBefore(screen.getByText('Beta'), screen.getByText('Alpha'))).toBe(true)
    })

    it('creates a new connection in a group from its context menu', () => {
      setup({
        sidebarView: 'project',
        projectGroupOrder: ['Prod'],
        sessions: [makeSession({ id: 'a', label: 'Alpha', group: 'Prod' })],
      })

      fireEvent.mouseEnter(rowFor('Prod'))
      fireEvent.mouseLeave(rowFor('Prod'))
      fireEvent.contextMenu(rowFor('Prod'))
      fireEvent.click(screen.getByText('New Connection in "Prod"'))

      const state = useAppStore.getState()
      expect(state.pendingConnectionGroup).toBe('Prod')
      expect(state.showAddConnection).toBe(true)
    })

    it('treats Ungrouped as no pending group for new connections', () => {
      setup({
        sidebarView: 'project',
        projectGroupOrder: ['Ungrouped'],
        pendingConnectionGroup: 'stale',
        sessions: [makeSession({ id: 'a', label: 'Alpha' })],
      })

      fireEvent.contextMenu(rowFor('Ungrouped'))
      fireEvent.click(screen.getByText('New Connection in Ungrouped'))

      const state = useAppStore.getState()
      expect(state.pendingConnectionGroup).toBeNull()
      expect(state.showAddConnection).toBe(true)
    })

    it('recolors a group and resets it to automatic', () => {
      setup({
        sidebarView: 'project',
        projectGroupOrder: ['Prod'],
        groupColors: { Prod: '#10B981' },
        sessions: [makeSession({ id: 'a', label: 'Alpha', group: 'Prod' })],
      })

      fireEvent.contextMenu(rowFor('Prod'))
      fireEvent.click(screen.getByTitle('#EC4899'))
      expect(useAppStore.getState().groupColors.Prod).toBe('#EC4899')

      fireEvent.contextMenu(rowFor('Prod'))
      fireEvent.click(screen.getByText('Reset to automatic'))
      expect(useAppStore.getState().groupColors.Prod).toBeFalsy()
    })

    it('closes the group menu on an outside mousedown', () => {
      setup({
        sidebarView: 'project',
        projectGroupOrder: ['Prod'],
        sessions: [makeSession({ id: 'a', label: 'Alpha', group: 'Prod' })],
      })

      fireEvent.contextMenu(rowFor('Prod'))
      expect(screen.getByText('Project color')).toBeTruthy()

      fireEvent.mouseDown(document.body)
      expect(screen.queryByText('Project color')).toBeNull()
    })
  })
})
