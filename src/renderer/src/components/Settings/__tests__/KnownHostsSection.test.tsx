// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import KnownHostsSection from '../KnownHostsSection'
import { installWindowApi, seedStore } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

const entry = {
  host: 'example.com',
  port: 2222,
  keyType: 'ssh-ed25519',
  key: 'AAAA',
  fingerprint: 'SHA256:abc',
  addedAt: Date.now() - 3_600_000,
}

beforeEach(() => cleanup())

describe('KnownHostsSection', () => {
  it('shows an empty state', async () => {
    installWindowApi()
    seedStore({})
    render(<KnownHostsSection />)
    expect(await screen.findByText('No host keys trusted in noxed yet.')).toBeTruthy()
  })

  it('lists trusted keys and removes one', async () => {
    const api = installWindowApi()
    api.hostKeys.list.mockResolvedValueOnce([entry]).mockResolvedValueOnce([])
    seedStore({})
    render(<KnownHostsSection />)
    expect(await screen.findByText('SHA256:abc')).toBeTruthy()
    expect(screen.getByText('example.com:2222')).toBeTruthy()
    expect(screen.getByText(/ssh-ed25519 · added 1h ago/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove ssh-ed25519 host key for example.com:2222' }))
    await waitFor(() => expect(api.hostKeys.remove).toHaveBeenCalledWith('example.com', 2222, 'ssh-ed25519'))
    expect(await screen.findByText('No host keys trusted in noxed yet.')).toBeTruthy()
  })

  it('reports list and remove failures', async () => {
    const api = installWindowApi()
    api.hostKeys.list.mockRejectedValueOnce(new Error('store broken')).mockResolvedValueOnce([entry])
    seedStore({})
    const { unmount } = render(<KnownHostsSection />)
    await waitFor(() => expect(useAppStore.getState().notifications.some((n) => n.message === 'store broken')).toBe(true))
    unmount()

    api.hostKeys.remove.mockRejectedValueOnce(new Error('nope'))
    render(<KnownHostsSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove ssh-ed25519 host key for example.com:2222' }))
    await waitFor(() => expect(useAppStore.getState().notifications.some((n) => n.message === 'nope')).toBe(true))
  })
})
