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

  it('saves nothing after a failed load, so the saved list survives', async () => {
    const api = installWindowApi()
    api.settings.get.mockRejectedValueOnce(new Error('store gone'))
    const { unmount } = renderHook(() => useRecentsSync())
    await act(async () => {})
    act(() => { useAppStore.getState().openTab(makeSession({ id: 'a' })) })
    await act(async () => { vi.advanceTimersByTime(1000) })
    unmount()
    expect(api.settings.set).not.toHaveBeenCalled()
    expect(useAppStore.getState().notifications.map((n) => n.message)).toContain('store gone')
  })

  it('saves a pending change straight away when it unmounts', async () => {
    const api = installWindowApi()
    const { unmount } = renderHook(() => useRecentsSync())
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(1000) })
    api.settings.set.mockClear()
    act(() => { useAppStore.getState().openTab(makeSession({ id: 'a' })) })
    unmount()
    expect(api.settings.set).toHaveBeenCalledWith('recentConnections', [expect.objectContaining({ id: 'a' })])
  })

  it('saves a pending change when the window is closed', async () => {
    const api = installWindowApi()
    renderHook(() => useRecentsSync())
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(1000) })
    api.settings.set.mockClear()
    act(() => { useAppStore.getState().openTab(makeSession({ id: 'w' })) })
    window.dispatchEvent(new Event('pagehide'))
    expect(api.settings.set).toHaveBeenCalledWith('recentConnections', [expect.objectContaining({ id: 'w' })])
  })

  it('reports a failed save', async () => {
    const api = installWindowApi()
    api.settings.set.mockRejectedValue(new Error('disk full'))
    const { unmount } = renderHook(() => useRecentsSync())
    await act(async () => {})
    act(() => { useAppStore.getState().openTab(makeSession({ id: 'a' })) })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(useAppStore.getState().notifications.map((n) => n.message)).toContain('disk full')
    unmount()
  })
})
