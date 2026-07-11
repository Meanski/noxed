// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import NotificationHost from '../NotificationHost'
import { installWindowApi, seedStore } from '../../../__tests__/harness'
import { useAppStore, AppNotification } from '../../../store'

function makeNotification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: `n-${Math.random().toString(36).slice(2)}`,
    type: 'info',
    message: 'Something happened',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('NotificationHost', () => {
  beforeEach(() => {
    installWindowApi()
    seedStore({ notifications: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing when there are no notifications', () => {
    const { container } = render(<NotificationHost />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a toast per notification with type styling', () => {
    seedStore({
      notifications: [
        makeNotification({ id: 'n1', type: 'success', message: 'Saved!' }),
        makeNotification({ id: 'n2', type: 'error', message: 'Boom' }),
        makeNotification({ id: 'n3', type: 'warning', message: 'Careful' }),
        makeNotification({ id: 'n4', type: 'info', message: 'FYI' }),
      ],
    })
    render(<NotificationHost />)
    expect(screen.getByText('Saved!')).toBeTruthy()
    expect(screen.getByText('Boom')).toBeTruthy()
    expect(screen.getByText('Careful')).toBeTruthy()
    expect(screen.getByText('FYI')).toBeTruthy()
    const successIcon = screen.getByText('Saved!').parentElement?.querySelector('span') as HTMLElement
    expect(successIcon.style.color).toBe('rgb(16, 185, 129)')
  })

  it('shows only the five most recent notifications', () => {
    seedStore({
      notifications: Array.from({ length: 6 }, (_, i) =>
        makeNotification({ id: `n${i}`, message: `Message ${i}` })
      ),
    })
    render(<NotificationHost />)
    expect(screen.queryByText('Message 0')).toBeNull()
    expect(screen.getByText('Message 1')).toBeTruthy()
    expect(screen.getByText('Message 5')).toBeTruthy()
  })

  it('dismisses a toast via its close button', () => {
    seedStore({ notifications: [makeNotification({ id: 'n1', message: 'Dismiss me' })] })
    const { container } = render(<NotificationHost />)
    const close = container.querySelector('button') as HTMLElement
    fireEvent.mouseEnter(close)
    expect(close.style.color).toBe('var(--nox-text)')
    fireEvent.mouseLeave(close)
    expect(close.style.color).toBe('var(--nox-text-3)')
    fireEvent.click(close)
    expect(useAppStore.getState().notifications).toHaveLength(0)
    expect(screen.queryByText('Dismiss me')).toBeNull()
  })

  it('auto-dismisses after five seconds', () => {
    vi.useFakeTimers()
    seedStore({ notifications: [makeNotification({ id: 'n1', message: 'Fleeting' })] })
    render(<NotificationHost />)
    expect(screen.getByText('Fleeting')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(4999)
    })
    expect(useAppStore.getState().notifications).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(useAppStore.getState().notifications).toHaveLength(0)
  })
})
