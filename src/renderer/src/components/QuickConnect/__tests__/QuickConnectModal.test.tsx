// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import QuickConnectModal from '../QuickConnectModal'
import { installWindowApi, seedStore, makeSession } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'
import { resolveSshCredentials } from '../../../lib/sshCredentials'

function setup(initialTarget = '') {
  const api = installWindowApi()
  seedStore({ sessions: [], adhocSessions: [], tabs: [], activeTabId: null })
  const onClose = vi.fn()
  render(<QuickConnectModal initialTarget={initialTarget} onClose={onClose} />)
  const connect = () => fireEvent.click(screen.getByText('Connect'))
  return { api, onClose, connect }
}

beforeEach(() => cleanup())

describe('QuickConnectModal', () => {
  it('opens an unsaved session using the agent and default keys', () => {
    const { api, onClose, connect } = setup('deploy@web.example.com:2222')
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/user@host/))
    connect()
    const { adhocSessions, tabs } = useAppStore.getState()
    expect(adhocSessions).toEqual([
      expect.objectContaining({ host: 'web.example.com', port: 2222, username: 'deploy', authType: 'agent', label: 'deploy@web.example.com:2222', adhoc: true }),
    ])
    expect(tabs[0].sessionId).toBe(adhocSessions[0].id)
    expect(api.sessions.create).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('asks for a username when the host has none, and blocks until given', () => {
    const { connect } = setup('web.example.com')
    const button = screen.getByText('Connect') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'root' } })
    expect(button.disabled).toBe(false)
    connect()
    expect(useAppStore.getState().adhocSessions[0]).toEqual(expect.objectContaining({ username: 'root', label: 'root@web.example.com' }))
  })

  it('keeps a typed password in memory only, for this session', async () => {
    const { connect } = setup('root@box')
    fireEvent.click(screen.getByLabelText('Password'))
    fireEvent.change(screen.getAllByLabelText('Password')[1], { target: { value: 's3cret' } })
    connect()
    const session = useAppStore.getState().adhocSessions[0]
    expect(session).not.toHaveProperty('password')
    expect(await resolveSshCredentials(session)).toEqual({ password: 's3cret' })
  })

  it('needs a password before connecting with password auth', () => {
    setup('root@box')
    fireEvent.click(screen.getByLabelText('Password'))
    const button = screen.getByText('Connect') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getAllByLabelText('Password')[1], { target: { value: 'pw' } })
    expect(button.disabled).toBe(false)
  })

  it('saves agent authentication as such', async () => {
    const { api, onClose } = setup('root@box')
    api.sessions.create.mockResolvedValueOnce(makeSession({ id: 'saved-2', authType: 'agent' }))
    fireEvent.click(screen.getByLabelText('Save to connections'))
    fireEvent.click(screen.getByText('Connect'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ authType: 'agent', password: undefined }))
  })

  it('uses a key file when chosen', () => {
    const { connect } = setup('root@box')
    fireEvent.click(screen.getByLabelText('Key file'))
    fireEvent.change(screen.getByLabelText('Private key'), { target: { value: '~/.ssh/work' } })
    connect()
    expect(useAppStore.getState().adhocSessions[0]).toEqual(expect.objectContaining({ authType: 'key', keyPath: '~/.ssh/work' }))
  })

  it('saves to connections (password to the keychain) when asked', async () => {
    const { api, onClose } = setup('root@box')
    const saved = makeSession({ id: 'saved-1', host: 'box', username: 'root' })
    api.sessions.create.mockResolvedValueOnce(saved)
    fireEvent.click(screen.getByLabelText('Password'))
    fireEvent.change(screen.getAllByLabelText('Password')[1], { target: { value: 'pw' } })
    fireEvent.click(screen.getByLabelText('Save to connections'))
    // Enter in a field submits too.
    fireEvent.submit(screen.getByPlaceholderText(/user@host/).closest('form')!)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ host: 'box', username: 'root', password: 'pw', type: 'ssh' }))
    expect(useAppStore.getState().sessions).toEqual([saved])
    expect(useAppStore.getState().tabs[0].sessionId).toBe('saved-1')
    expect(useAppStore.getState().adhocSessions).toEqual([])
  })

  it('shows a save failure and stays open', async () => {
    const { api, onClose, connect } = setup('root@box')
    api.sessions.create.mockRejectedValueOnce(new Error('keychain unavailable'))
    fireEvent.click(screen.getByLabelText('Save to connections'))
    connect()
    expect((await screen.findByRole('alert')).textContent).toBe('keychain unavailable')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('flags input that is not a host', () => {
    setup('not a host')
    expect(screen.getByText("That doesn't look like a host.")).toBeTruthy()
    expect((screen.getByText('Connect') as HTMLButtonElement).disabled).toBe(true)
  })

  it('closes on Cancel', () => {
    const { onClose } = setup()
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })
})
