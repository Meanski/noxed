// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TopBar from '../TopBar'
import { installWindowApi, seedStore } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'
import type { WindowApiMock } from '../../../__tests__/harness'

describe('TopBar', () => {
  let api: WindowApiMock

  beforeEach(() => {
    api = installWindowApi()
    seedStore({
      tabs: [], activeTabId: null,
      showCommandPalette: false, showAddConnection: false,
      isDarkMode: false, updateStatus: null,
    })
  })

  it('renders the logo and opens the dashboard tab on click', () => {
    render(<TopBar />)
    fireEvent.click(screen.getByText('noxed'))
    const { tabs, activeTabId } = useAppStore.getState()
    expect(tabs.some(t => t.view === 'dashboard')).toBe(true)
    expect(activeTabId).toBe(tabs.find(t => t.view === 'dashboard')?.id)
  })

  it('opens the command palette from the search bar', () => {
    render(<TopBar />)
    const search = screen.getByText(/Search connections/).closest('button') as HTMLElement
    fireEvent.mouseEnter(search)
    expect(search.style.borderColor).toBe('rgb(59, 92, 204)')
    fireEvent.mouseLeave(search)
    expect(search.style.background).toBe('var(--nox-bg)')
    fireEvent.click(search)
    expect(useAppStore.getState().showCommandPalette).toBe(true)
  })

  it('opens the add-connection modal from New Connection', () => {
    render(<TopBar />)
    const btn = screen.getByText('New Connection').closest('button') as HTMLElement
    fireEvent.mouseEnter(btn)
    expect(btn.style.background).toBe('rgb(42, 66, 153)')
    fireEvent.mouseLeave(btn)
    fireEvent.click(btn)
    expect(useAppStore.getState().showAddConnection).toBe(true)
  })

  it('toggles dark mode', () => {
    render(<TopBar />)
    const toggle = screen.getByTitle('Switch to dark mode')
    fireEvent.mouseEnter(toggle)
    fireEvent.mouseLeave(toggle)
    fireEvent.click(toggle)
    expect(useAppStore.getState().isDarkMode).toBe(true)
    expect(screen.getByTitle('Switch to light mode')).toBeTruthy()
  })

  it('renders no update pill without a status', () => {
    render(<TopBar />)
    expect(screen.queryByText('Update available')).toBeNull()
    expect(screen.queryByText(/Updating/)).toBeNull()
    expect(screen.queryByText('Restart to update')).toBeNull()
  })

  it('renders no update pill while checking', () => {
    seedStore({ updateStatus: { state: 'checking' } })
    render(<TopBar />)
    expect(screen.queryByText('Update available')).toBeNull()
  })

  it('starts the download when an update is available', () => {
    seedStore({ updateStatus: { state: 'available', version: '1.2.3' } })
    render(<TopBar />)
    const pill = screen.getByText('Update available').closest('button') as HTMLElement
    expect(pill.title).toContain('1.2.3')
    fireEvent.mouseEnter(pill)
    expect(pill.style.background).toBe('rgb(5, 150, 105)')
    fireEvent.mouseLeave(pill)
    fireEvent.click(pill)
    expect(api.updater.download).toHaveBeenCalledTimes(1)
  })

  it('shows download progress while downloading', () => {
    seedStore({ updateStatus: { state: 'downloading', percent: 42 } })
    render(<TopBar />)
    expect(screen.getByText(/Updating/).textContent).toContain('42%')
  })

  it('quits and installs once downloaded', () => {
    seedStore({ updateStatus: { state: 'downloaded', version: '1.2.3' } })
    render(<TopBar />)
    const pill = screen.getByText('Restart to update').closest('button') as HTMLElement
    fireEvent.mouseEnter(pill)
    fireEvent.mouseLeave(pill)
    fireEvent.click(pill)
    expect(api.updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
