// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import UnlockScreen from '../UnlockScreen'
import { installWindowApi, seedStore, WindowApiMock } from '../../__tests__/harness'
import { useAppStore } from '../../store'

let api: WindowApiMock

function setupPinMode(unlockResult: { success: boolean; error?: string }) {
  api = installWindowApi({
    auth: {
      getMode: vi.fn().mockResolvedValue('pin'),
      unlock: vi.fn().mockResolvedValue(unlockResult),
    },
  })
  seedStore({ isLocked: true })
}

function typeDigits(digits: string) {
  for (const d of digits) fireEvent.keyDown(window, { key: d })
}

describe('UnlockScreen (PIN mode)', () => {
  beforeEach(() => setupPinMode({ success: true }))

  it('submits after four keyboard digits and unlocks', async () => {
    render(<UnlockScreen />)
    await waitFor(() => expect(screen.getByText('Enter PIN')).toBeTruthy())

    typeDigits('1234')
    await waitFor(() => expect(api.auth.unlock).toHaveBeenCalledWith('1234'))
    await waitFor(() => expect(useAppStore.getState().isLocked).toBe(false))
  })

  it('ignores non-digit keys and honors Backspace', async () => {
    render(<UnlockScreen />)
    await waitFor(() => expect(screen.getByText('Enter PIN')).toBeTruthy())

    fireEvent.keyDown(window, { key: 'x' })
    typeDigits('9')
    fireEvent.keyDown(window, { key: 'Backspace' })
    typeDigits('5678')

    await waitFor(() => expect(api.auth.unlock).toHaveBeenCalledWith('5678'))
  })

  it('shows the error and keeps the lock on failure', async () => {
    setupPinMode({ success: false, error: 'Wrong PIN' })
    render(<UnlockScreen />)
    await waitFor(() => expect(screen.getByText('Enter PIN')).toBeTruthy())

    typeDigits('0000')
    await waitFor(() => expect(screen.getByText('Wrong PIN')).toBeTruthy())
    expect(useAppStore.getState().isLocked).toBe(true)
  })

  it('renders a numpad with a gap and a delete key', async () => {
    render(<UnlockScreen />)
    await waitFor(() => expect(screen.getByText('Enter PIN')).toBeTruthy())

    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫']) {
      expect(screen.getByText(key)).toBeTruthy()
    }

    // Clicking a digit then delete leaves the pad empty (no submit)
    fireEvent.click(screen.getByText('5'))
    fireEvent.click(screen.getByText('⌫'))
    expect(api.auth.unlock).not.toHaveBeenCalled()
  })
})
