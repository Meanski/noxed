// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecentsSync } from '../useRecentsSync'
import { installWindowApi, seedStore, makeSession } from '../../__tests__/harness'
import { useAppStore } from '../../store'

beforeEach(() => {
  vi.useFakeTimers()
  seedStore({ recentConnections: [], notifications: [], tabs: [], sessions: [] })
})
afterEach(() => vi.useRealTimers())

describe('useRecentsSync', () => {
  it('loads saved recents, keeping anything opened before they arrived first', async () => {
    const api = installWindowApi()
    api.settings.get.mockResolvedValueOnce({ recentConnections: [{ id: 'old', at: 1 }, { id: 'fresh', at: 1 }] })
    useAppStore.setState({ recentConnections: [{ id: 'fresh', at: 5 }] })
    renderHook(() => useRecentsSync())
    await act(async () => {})
    expect(useAppStore.getState().recentConnections).toEqual([{ id: 'fresh', at: 5 }, { id: 'old', at: 1 }])
  })

  it('persists changes once they settle', async () => {
    const api = installWindowApi()
    renderHook(() => useRecentsSync())
    await act(async () => {})
    act(() => {
      useAppStore.getState().openTab(makeSession({ id: 'a' }))
      useAppStore.getState().openTab(makeSession({ id: 'b' }))
    })
    expect(api.settings.set).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(api.settings.set).toHaveBeenCalledTimes(1)
    expect(api.settings.set.mock.calls[0][0]).toBe('recentConnections')
    expect(api.settings.set.mock.calls[0][1].map((r: { id: string }) => r.id)).toEqual(['b', 'a'])
  })

  it('reports load and save failures', async () => {
    const api = installWindowApi()
    api.settings.get.mockRejectedValueOnce(new Error('store gone'))
    api.settings.set.mockRejectedValueOnce(new Error('disk full'))
    const { unmount } = renderHook(() => useRecentsSync())
    await act(async () => {})
    act(() => { useAppStore.getState().openTab(makeSession({ id: 'a' })) })
    await act(async () => { vi.advanceTimersByTime(1000) })
    const messages = useAppStore.getState().notifications.map((n) => n.message)
    expect(messages).toEqual(expect.arrayContaining(['store gone', 'disk full']))
    unmount()
  })
})
