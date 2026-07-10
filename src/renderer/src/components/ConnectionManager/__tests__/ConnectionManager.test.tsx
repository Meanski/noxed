// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import ConnectionManager from '../ConnectionManager'
import { installWindowApi, makeSession, makeTab, type WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

const initialState = useAppStore.getState()

let api: WindowApiMock

const sshSession = makeSession({ id: 'ssh-1', label: 'Web Server', host: 'web.example.com', type: 'ssh', tags: ['prod'] })
const dbSession = makeSession({ id: 'db-1', label: 'Postgres', host: 'db.example.com', port: 5432, type: 'database' })
const k8sSession = makeSession({ id: 'k8s-1', label: 'Cluster', host: 'https://k8s', type: 'kubernetes' })

beforeEach(() => {
  useAppStore.setState(initialState, true)
  api = installWindowApi()
  useAppStore.setState({
    sessions: [sshSession, dbSession, k8sSession],
    tabs: [makeTab({ sessionId: 'ssh-1', status: 'connected' })],
  })
})

/** The filter dropdown renders checkbox-like buttons inside each label. */
function filterCheckbox(labelText: string) {
  const dropdown = screen.getByText('Connection Type').parentElement as HTMLElement
  const label = within(dropdown).getByText(labelText).closest('label') as HTMLElement
  return label.querySelector('button') as HTMLElement
}

function openFilterDropdown() {
  fireEvent.click(screen.getByText(/^Filter/))
}

function rowNames(): string[] {
  return screen.getAllByRole('row').slice(1).map(r => (r as HTMLElement).querySelector('td span')?.textContent ?? '')
}

describe('ConnectionManager', () => {
  it('lists all connections with type, host and status', () => {
    render(<ConnectionManager />)
    expect(screen.getByText('3 connections configured')).toBeTruthy()
    expect(screen.getByText('Web Server')).toBeTruthy()
    expect(screen.getByText('web.example.com:22')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getAllByText('Idle')).toHaveLength(2)
    expect(screen.getByText('prod')).toBeTruthy()
  })

  it('filters by search text', () => {
    render(<ConnectionManager />)
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'postgres' } })
    expect(rowNames()).toEqual(['Postgres'])
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'zzz' } })
    expect(screen.getByText('No connections match your search.')).toBeTruthy()
  })

  it('toggles type filters with the mouse', () => {
    render(<ConnectionManager />)
    openFilterDropdown()
    expect(screen.getByText('Connection Type')).toBeTruthy()

    const sshLabel = filterCheckbox('SSH').closest('label') as HTMLElement
    fireEvent.mouseEnter(sshLabel)
    fireEvent.mouseLeave(sshLabel)

    fireEvent.click(filterCheckbox('SSH'))
    expect(screen.getByText('Filter (1)')).toBeTruthy()
    expect(rowNames()).toEqual(['Web Server'])

    fireEvent.click(filterCheckbox('Database'))
    expect(screen.getByText('Filter (2)')).toBeTruthy()
    expect(rowNames()).toEqual(['Web Server', 'Postgres'])

    // Unchecking removes the filter again
    fireEvent.click(filterCheckbox('SSH'))
    expect(rowNames()).toEqual(['Postgres'])
  })

  it('toggles type filters via the checkbox buttons and reflects aria-pressed', () => {
    render(<ConnectionManager />)
    openFilterDropdown()

    expect(filterCheckbox('Kubernetes').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(filterCheckbox('Kubernetes'))
    expect(rowNames()).toEqual(['Cluster'])
    expect(filterCheckbox('Kubernetes').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(filterCheckbox('Kubernetes'))
    expect(rowNames()).toEqual(['Web Server', 'Postgres', 'Cluster'])
    expect(filterCheckbox('Kubernetes').getAttribute('aria-pressed')).toBe('false')
  })

  it('filters by online/offline status', () => {
    render(<ConnectionManager />)
    openFilterDropdown()
    const dropdown = screen.getByText('Connection Type').parentElement as HTMLElement
    expect(within(dropdown).getByText('Status')).toBeTruthy()

    const onlineLabel = filterCheckbox('online').closest('label') as HTMLElement
    fireEvent.mouseEnter(onlineLabel)
    fireEvent.mouseLeave(onlineLabel)

    fireEvent.click(filterCheckbox('online'))
    expect(rowNames()).toEqual(['Web Server'])

    fireEvent.click(filterCheckbox('online'))
    fireEvent.click(filterCheckbox('offline'))
    expect(rowNames()).toEqual(['Postgres', 'Cluster'])

    // Status filters combine with type filters as an OR
    fireEvent.click(filterCheckbox('SSH'))
    expect(rowNames()).toEqual(['Web Server', 'Postgres', 'Cluster'])
  })

  it('closes and reopens the filter dropdown', () => {
    render(<ConnectionManager />)
    openFilterDropdown()
    expect(screen.getByText('Connection Type')).toBeTruthy()
    openFilterDropdown()
    expect(screen.queryByText('Connection Type')).toBeNull()
  })

  it('opens a tab on Connect but not for kubernetes rows', () => {
    render(<ConnectionManager />)
    const connectButtons = screen.getAllByTitle('Connect')
    fireEvent.click(connectButtons[2]) // Cluster — kubernetes is ignored
    expect(useAppStore.getState().tabs).toHaveLength(1)
    fireEvent.click(connectButtons[1]) // Postgres
    const tabs = useAppStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs.some(t => t.sessionId === 'db-1' && t.view === 'database')).toBe(true)
  })

  it('starts editing a connection', () => {
    render(<ConnectionManager />)
    fireEvent.click(screen.getAllByTitle('Edit')[1])
    expect(useAppStore.getState().editingConnectionId).toBe('db-1')
    expect(useAppStore.getState().showAddConnection).toBe(true)
  })

  it('duplicates a connection including stored credentials', async () => {
    useAppStore.setState({ sessions: [{ ...sshSession, hasPassword: true }] })
    api.sessions.create.mockResolvedValue(makeSession({ id: 'copy-1', label: 'Web Server (copy)' }))
    render(<ConnectionManager />)
    fireEvent.click(screen.getByTitle('Duplicate'))
    await waitFor(() => expect(api.sessions.create).toHaveBeenCalled())
    expect(api.sessions.getCredentials).toHaveBeenCalledWith('ssh-1')
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Web Server (copy)',
      password: 'pw',
    }))
    await waitFor(() => expect(useAppStore.getState().sessions).toHaveLength(2))
  })

  it('deletes a connection after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ConnectionManager />)
    fireEvent.click(screen.getAllByTitle('Delete')[0])
    await waitFor(() => expect(api.sessions.delete).toHaveBeenCalledWith('ssh-1'))
    expect(useAppStore.getState().sessions.some(s => s.id === 'ssh-1')).toBe(false)
  })

  it('does not delete when the confirmation is dismissed', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ConnectionManager />)
    fireEvent.click(screen.getAllByTitle('Delete')[0])
    expect(api.sessions.delete).not.toHaveBeenCalled()
  })

  it('shows the empty state with an inline Add Connection action', () => {
    useAppStore.setState({ sessions: [], tabs: [] })
    render(<ConnectionManager />)
    expect(screen.getByText('No connections configured yet.')).toBeTruthy()
    const addButtons = screen.getAllByText('Add Connection')
    fireEvent.click(addButtons[addButtons.length - 1])
    expect(useAppStore.getState().showAddConnection).toBe(true)
  })

  it('opens the SSH-config import modal', async () => {
    render(<ConnectionManager />)
    fireEvent.click(screen.getByText('Import'))
    expect(await screen.findByText('Import from SSH config')).toBeTruthy()
    expect(api.sshConfig.hosts).toHaveBeenCalled()
  })
})
