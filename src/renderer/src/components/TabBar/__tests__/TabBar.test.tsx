// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TabBar from '../TabBar'
import { installWindowApi, seedStore, makeTab, WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

let api: WindowApiMock

function reset(overrides: Record<string, any> = {}) {
  api = installWindowApi(overrides)
  seedStore({
    sessions: [], tabs: [], activeTabId: null, notifications: [],
    showCommandPalette: false, focusedPaneId: null,
  })
}

function closeButtonFor(label: string): HTMLElement {
  const pill = screen.getByText(label).closest('button')!
  return pill.querySelector('[role="button"]') as HTMLElement
}

describe('TabBar', () => {
  beforeEach(() => reset())

  it('renders a pill per tab with view-specific icons and activates on click', () => {
    const tabs = [
      makeTab({ id: 'dash', view: 'dashboard', label: 'Dashboard' }),
      makeTab({ id: 'term', view: 'terminal', label: 'web-1', status: 'connected' }),
      makeTab({ id: 'k8s', view: 'k8s', label: 'cluster', status: 'connected' }),
      makeTab({ id: 'db', view: 'database', label: 'postgres' }),
      makeTab({ id: 'ed', view: 'editor', label: 'notes.md', isDirty: true }),
      makeTab({ id: 'err', view: 'sftp', label: 'files', status: 'error' }),
      makeTab({ id: 'conn', view: 'terminal', label: 'connecting', status: 'connecting' }),
    ]
    seedStore({ tabs, activeTabId: 'term' })
    render(<TabBar />)

    fireEvent.click(screen.getByText('postgres'))
    expect(useAppStore.getState().activeTabId).toBe('db')
  })

  it('closes an idle tab directly without confirmation', () => {
    seedStore({ tabs: [makeTab({ id: 't1', view: 'terminal', label: 'idle-tab', status: 'idle' })], activeTabId: 't1' })
    render(<TabBar />)
    fireEvent.click(closeButtonFor('idle-tab'))
    expect(useAppStore.getState().tabs).toHaveLength(0)
  })

  it('asks for confirmation before closing a connected session and closes on confirm', async () => {
    seedStore({ tabs: [makeTab({ id: 't1', view: 'terminal', label: 'live-tab', status: 'connected' })], activeTabId: 't1' })
    render(<TabBar />)
    await waitFor(() => expect(api.settings.get).toHaveBeenCalled())

    fireEvent.click(closeButtonFor('live-tab'))
    expect(screen.getByText('Close active session?')).toBeTruthy()
    expect(screen.getByText(/has an active connection/)).toBeTruthy()

    fireEvent.click(screen.getByText('Close'))
    expect(useAppStore.getState().tabs).toHaveLength(0)
  })

  it('cancel and Escape both dismiss the confirm dialog without closing', async () => {
    seedStore({ tabs: [makeTab({ id: 't1', view: 'terminal', label: 'live-tab', status: 'connected' })], activeTabId: 't1' })
    render(<TabBar />)
    await waitFor(() => expect(api.settings.get).toHaveBeenCalled())

    fireEvent.click(closeButtonFor('live-tab'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Close active session?')).toBeNull()
    expect(useAppStore.getState().tabs).toHaveLength(1)

    fireEvent.click(closeButtonFor('live-tab'))
    fireEvent.keyDown(screen.getByText('Cancel'), { key: 'Escape' })
    expect(screen.queryByText('Close active session?')).toBeNull()
    expect(useAppStore.getState().tabs).toHaveLength(1)
  })

  it('clicking the dialog backdrop cancels', async () => {
    seedStore({ tabs: [makeTab({ id: 't1', view: 'terminal', label: 'live-tab', status: 'connected' })], activeTabId: 't1' })
    render(<TabBar />)
    await waitFor(() => expect(api.settings.get).toHaveBeenCalled())

    fireEvent.click(closeButtonFor('live-tab'))
    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(screen.queryByText('Close active session?')).toBeNull()
  })

  it('warns about unsaved edits when closing a dirty editor tab', () => {
    seedStore({ tabs: [makeTab({ id: 'e1', view: 'editor', label: 'notes.md', isDirty: true, status: 'idle' })], activeTabId: 'e1' })
    render(<TabBar />)
    fireEvent.click(closeButtonFor('notes.md'))
    expect(screen.getByText('Discard unsaved changes?')).toBeTruthy()
    expect(screen.getByText(/Closing will discard them/)).toBeTruthy()
  })

  it('supports Enter and Space on the close affordance', async () => {
    seedStore({ tabs: [makeTab({ id: 't1', view: 'terminal', label: 'live-tab', status: 'connected' })], activeTabId: 't1' })
    render(<TabBar />)
    await waitFor(() => expect(api.settings.get).toHaveBeenCalled())

    fireEvent.keyDown(closeButtonFor('live-tab'), { key: 'Enter' })
    expect(screen.getByText('Close active session?')).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))

    fireEvent.keyDown(closeButtonFor('live-tab'), { key: ' ' })
    expect(screen.getByText('Close active session?')).toBeTruthy()
  })

  it('skips confirmation when the user disabled confirmClose', async () => {
    reset({ settings: { get: vi.fn().mockResolvedValue({ confirmClose: false }) } })
    seedStore({ tabs: [makeTab({ id: 't1', view: 'terminal', label: 'live-tab', status: 'connected' })], activeTabId: 't1' })
    render(<TabBar />)
    await waitFor(() => expect(api.settings.get).toHaveBeenCalled())

    fireEvent.click(closeButtonFor('live-tab'))
    expect(screen.queryByText('Close active session?')).toBeNull()
    expect(useAppStore.getState().tabs).toHaveLength(0)
  })

  it('opens the command palette from the plus button', () => {
    seedStore({ tabs: [makeTab({ id: 't1', view: 'terminal', label: 'a-tab' })], activeTabId: 't1' })
    render(<TabBar />)
    fireEvent.click(screen.getByTitle('Open connection (⌘T)'))
    expect(useAppStore.getState().showCommandPalette).toBe(true)
  })
})
