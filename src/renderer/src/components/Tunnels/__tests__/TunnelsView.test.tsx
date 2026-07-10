// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TunnelsView from '../TunnelsView'
import { installWindowApi, seedStore, makeSession, WindowApiMock } from '../../../__tests__/harness'

const tunnels = [
  {
    id: 'tun-1', sessionId: 'ssh-1', type: 'local', label: 'DB',
    listenPort: 5433, targetHost: 'db.internal', targetPort: 5432,
    status: 'active', connections: 2,
  },
  {
    id: 'tun-2', sessionId: 'ssh-1', type: 'dynamic', label: 'Proxy',
    listenPort: 1080, status: 'stopped', connections: 0,
  },
]

let api: WindowApiMock

describe('TunnelsView', () => {
  beforeEach(() => {
    api = installWindowApi({ tunnels: { list: vi.fn().mockResolvedValue(tunnels) } })
    seedStore({
      sessions: [makeSession({ id: 'ssh-1', label: 'Bastion' })],
      tabs: [], notifications: [],
    })
  })

  it('renders tunnel cards with the right toggle affordance', async () => {
    render(<TunnelsView />)
    await waitFor(() => expect(screen.getByText('DB')).toBeTruthy())
    // Active tunnel offers Stop, stopped one offers Start
    expect(screen.getByText('Stop')).toBeTruthy()
    expect(screen.getByText('Start')).toBeTruthy()
  })

  it('starts and stops tunnels from the card button', async () => {
    render(<TunnelsView />)
    await waitFor(() => expect(screen.getByText('Start')).toBeTruthy())

    fireEvent.click(screen.getByText('Start'))
    await waitFor(() => expect(api.tunnels.start).toHaveBeenCalledWith('tun-2'))

    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => expect(api.tunnels.stop).toHaveBeenCalledWith('tun-1'))
  })

  it('validates ports before saving a new tunnel', async () => {
    render(<TunnelsView />)
    await waitFor(() => expect(screen.getByText('New Tunnel')).toBeTruthy())
    fireEvent.click(screen.getByText('New Tunnel'))

    // Empty listen port
    fireEvent.click(screen.getByText('Create Tunnel'))
    expect(screen.getByText('Listen port must be 1–65535')).toBeTruthy()

    // Valid listen port but bogus target port
    fireEvent.change(screen.getByPlaceholderText('8080'), { target: { value: '8080' } })
    fireEvent.change(screen.getByPlaceholderText('db.internal'), { target: { value: 'db.internal' } })
    fireEvent.change(screen.getByPlaceholderText('5432'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByText('Create Tunnel'))
    expect(screen.getByText('Target port must be 1–65535')).toBeTruthy()

    // Fixing the target port saves the tunnel
    fireEvent.change(screen.getByPlaceholderText('5432'), { target: { value: '5432' } })
    fireEvent.click(screen.getByText('Create Tunnel'))
    await waitFor(() => expect(api.tunnels.save).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ssh-1', type: 'local', listenPort: 8080, targetHost: 'db.internal', targetPort: 5432 }),
      undefined,
    ))
    // Editor closes after a successful save
    await waitFor(() => expect(screen.queryByText('Create Tunnel')).toBeNull())
  })

  it('opens the editor pre-filled when editing an existing tunnel', async () => {
    render(<TunnelsView />)
    await waitFor(() => expect(screen.getByText('DB')).toBeTruthy())

    fireEvent.click(screen.getAllByTitle('Edit')[0])
    expect(screen.getByText('Edit Tunnel')).toBeTruthy()
    expect((screen.getByPlaceholderText('8080') as HTMLInputElement).value).toBe('5433')

    // Escape closes the editor
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Edit Tunnel')).toBeNull())
  })
})
