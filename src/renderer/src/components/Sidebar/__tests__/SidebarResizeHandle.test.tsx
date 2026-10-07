// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import SidebarResizeHandle, { clampSidebarWidth } from '../SidebarResizeHandle'
import { installWindowApi, seedStore } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

beforeEach(() => {
  cleanup()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('clampSidebarWidth', () => {
  it('keeps the sidebar between its minimum and maximum', () => {
    expect(clampSidebarWidth(100)).toBe(180)
    expect(clampSidebarWidth(900)).toBe(480)
    expect(clampSidebarWidth(250.4)).toBe(250)
    expect(clampSidebarWidth(Number.NaN)).toBe(220)
  })
})

describe('SidebarResizeHandle', () => {
  it('updates the width live and persists it once dragging settles', async () => {
    const api = installWindowApi()
    seedStore({ sidebarWidth: 220 })
    render(<SidebarResizeHandle />)
    const handle = screen.getByLabelText('Resize sidebar').parentElement as HTMLElement
    fireEvent.pointerDown(handle, { button: 0, clientX: 220 })
    fireEvent.pointerMove(handle, { clientX: 260 })
    fireEvent.pointerMove(handle, { clientX: 300 })
    expect(useAppStore.getState().sidebarWidth).toBe(300)
    expect(api.settings.set).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(api.settings.set).toHaveBeenCalledTimes(1)
    expect(api.settings.set).toHaveBeenCalledWith('sidebarWidth', 300)
  })

  it('warns when the width cannot be saved', async () => {
    const api = installWindowApi()
    api.settings.set.mockRejectedValueOnce(new Error('disk full'))
    seedStore({ sidebarWidth: 220 })
    render(<SidebarResizeHandle />)
    fireEvent.change(screen.getByLabelText('Resize sidebar'), { target: { value: '260' } })
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(useAppStore.getState().notifications.some((n) => n.message === 'disk full')).toBe(true)
  })

  it('cancels a pending save when unmounted', async () => {
    const api = installWindowApi()
    seedStore({ sidebarWidth: 220 })
    const { unmount } = render(<SidebarResizeHandle />)
    fireEvent.change(screen.getByLabelText('Resize sidebar'), { target: { value: '260' } })
    unmount()
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(api.settings.set).not.toHaveBeenCalled()
  })
})
