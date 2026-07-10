// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ImportSshConfigModal from '../ImportSshConfigModal'
import { installWindowApi, makeSession, type WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

const initialState = useAppStore.getState()

let api: WindowApiMock
let onClose: ReturnType<typeof vi.fn<() => void>>

const hosts = [
  { alias: 'web', host: 'web.example.com', port: 22, username: 'root', keyPath: '~/.ssh/id_web' },
  { alias: 'app', host: 'app.example.com', port: 2222, username: 'deploy', proxyJump: 'web' },
  { alias: 'legacy', host: 'legacy.example.com', port: 22, username: 'root' },
]

beforeEach(() => {
  useAppStore.setState(initialState, true)
  onClose = vi.fn<() => void>()
  api = installWindowApi({ sshConfig: { hosts: vi.fn().mockResolvedValue(hosts) } })
})

/** Each host row is a label whose leading role=button div is the checkbox. */
function checkboxFor(alias: string) {
  const label = screen.getByText(alias).closest('label') as HTMLElement
  return label.querySelector('[role="button"]') as HTMLElement
}

describe('ImportSshConfigModal', () => {
  it('shows a loading state, then the discovered hosts with details', async () => {
    render(<ImportSshConfigModal onClose={onClose} />)
    expect(screen.getByText('Reading SSH config…')).toBeTruthy()

    expect(await screen.findByText('web')).toBeTruthy()
    expect(screen.getByText('root@web.example.com')).toBeTruthy()
    expect(screen.getByText('deploy@app.example.com:2222')).toBeTruthy()
    // Key icon carries the key path as tooltip
    expect(screen.getByTitle('~/.ssh/id_web')).toBeTruthy()
    // All new hosts preselected
    expect(screen.getByText('Import (3)')).toBeTruthy()
  })

  it('marks already-added hosts and leaves them unselected', async () => {
    useAppStore.setState({
      sessions: [makeSession({ host: 'legacy.example.com', port: 22, username: 'root', type: 'ssh' })],
    })
    render(<ImportSshConfigModal onClose={onClose} />)
    expect(await screen.findByText('already added')).toBeTruthy()
    expect(screen.getByText('Import (2)')).toBeTruthy()
  })

  it('toggles selection by click and by Enter/Space on the checkbox', async () => {
    render(<ImportSshConfigModal onClose={onClose} />)
    await screen.findByText('web')

    fireEvent.click(checkboxFor('web'))
    expect(screen.getByText('Import (2)')).toBeTruthy()

    fireEvent.keyDown(checkboxFor('app'), { key: 'Enter' })
    expect(screen.getByText('Import (1)')).toBeTruthy()

    fireEvent.keyDown(checkboxFor('legacy'), { key: ' ' })
    // Every host deselected — the button loses its count and disables
    const importButton = screen.getByText('Import', { exact: true }).closest('button') as HTMLButtonElement
    expect(importButton.disabled).toBe(true)

    // Irrelevant keys do nothing; Space re-selects
    fireEvent.keyDown(checkboxFor('web'), { key: 'x' })
    expect(importButton.disabled).toBe(true)
    fireEvent.keyDown(checkboxFor('web'), { key: ' ' })
    expect(screen.getByText('Import (1)')).toBeTruthy()
  })

  it('imports the selected hosts and links ProxyJump hops', async () => {
    let created = 0
    api.sessions.create.mockImplementation(async (data: any) => ({ id: `new-${++created}`, ...data }))
    api.sessions.update.mockImplementation(async (_id: string, data: any) => data)
    render(<ImportSshConfigModal onClose={onClose} />)
    await screen.findByText('web')

    // Drop 'legacy' so only two are imported
    fireEvent.click(checkboxFor('legacy'))
    fireEvent.click(screen.getByText('Import (2)'))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(api.sessions.create).toHaveBeenCalledTimes(2)
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      label: 'web', host: 'web.example.com', authType: 'key', keyPath: '~/.ssh/id_web', type: 'ssh',
    }))
    expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      label: 'app', host: 'app.example.com', port: 2222, authType: 'password',
    }))
    // Second pass wired app -> web as jump host
    expect(api.sessions.update).toHaveBeenCalledWith('new-2', { jumpHostId: 'new-1' })

    const state = useAppStore.getState()
    expect(state.sessions).toHaveLength(2)
    expect(state.notifications.some(n => n.message === 'Imported 2 connections from SSH config')).toBe(true)
  })

  it('shows an error and re-enables the form when the import fails', async () => {
    api.sessions.create.mockRejectedValue(new Error('keychain unavailable'))
    render(<ImportSshConfigModal onClose={onClose} />)
    await screen.findByText('web')
    fireEvent.click(screen.getByText('Import (3)'))
    expect(await screen.findByText('keychain unavailable')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the empty state when no hosts are found', async () => {
    api.sshConfig.hosts.mockResolvedValue([])
    render(<ImportSshConfigModal onClose={onClose} />)
    expect(await screen.findByText('No importable hosts found in ~/.ssh/config.')).toBeTruthy()
  })

  it('shows an error when the SSH config cannot be read', async () => {
    api.sshConfig.hosts.mockRejectedValue(new Error('EACCES: permission denied'))
    render(<ImportSshConfigModal onClose={onClose} />)
    expect(await screen.findByText('EACCES: permission denied')).toBeTruthy()
  })

  it('closes via the header button and backdrop mousedown', async () => {
    const { container } = render(<ImportSshConfigModal onClose={onClose} />)
    await screen.findByText('web')
    fireEvent.mouseDown(container.firstChild as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)

    const headerClose = screen.getByText('Import from SSH config')
      .closest('.flex.items-center.justify-between')!
      .querySelector('button') as HTMLElement
    fireEvent.click(headerClose)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
