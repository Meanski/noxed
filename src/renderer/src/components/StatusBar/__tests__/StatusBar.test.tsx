// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import StatusBar from '../StatusBar'
import { installWindowApi, seedStore, makeSession, makeTab } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

describe('StatusBar', () => {
  beforeEach(() => {
    seedStore({ sessions: [], tabs: [], notifications: [] })
  })

  it('counts only active tunnels', async () => {
    installWindowApi({
      tunnels: {
        list: vi.fn().mockResolvedValue([
          { status: 'active' }, { status: 'stopped' }, { status: 'error' },
        ]),
      },
    })
    render(<StatusBar />)
    await waitFor(() => expect(screen.getByText('1 tunnel active')).toBeTruthy())

    fireEvent.click(screen.getByTitle('View tunnels'))
    expect(useAppStore.getState().tabs.some(t => t.view === 'tunnels')).toBe(true)
  })

  it('hides the tunnel badge when nothing is active and shows session counts', async () => {
    const api = installWindowApi({ tunnels: { list: vi.fn().mockResolvedValue([{ status: 'stopped' }]) } })
    seedStore({
      sessions: [makeSession(), makeSession()],
      tabs: [
        makeTab({ view: 'terminal', status: 'connected' }),
        makeTab({ view: 'terminal', status: 'error' }),
        makeTab({ view: 'dashboard', status: 'connected' }),
      ],
    })
    render(<StatusBar />)
    await waitFor(() => expect(api.tunnels.list).toHaveBeenCalled())

    expect(screen.queryByTitle('View tunnels')).toBeNull()
    expect(screen.getByText(/2 connections configured/)).toBeTruthy()
    expect(screen.getByText('1 connection lost')).toBeTruthy()
  })
})
