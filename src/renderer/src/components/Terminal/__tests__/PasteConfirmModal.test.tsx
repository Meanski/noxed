// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import PasteConfirmModal from '../PasteConfirmModal'
import { installWindowApi, seedStore } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

function setup(text: string) {
  const api = installWindowApi()
  seedStore({ notifications: [] })
  const onPaste = vi.fn()
  const onCancel = vi.fn()
  render(<PasteConfirmModal text={text} onPaste={onPaste} onCancel={onCancel} />)
  return { api, onPaste, onCancel }
}

beforeEach(() => cleanup())

describe('PasteConfirmModal', () => {
  it('counts lines and previews the first few', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `cmd ${i + 1}`)
    setup(lines.join('\n'))
    expect(screen.getByRole('dialog', { name: 'Paste 12 lines?' })).toBeTruthy()
    expect(screen.getByText(/cmd 8/)).toBeTruthy()
    expect(screen.queryByText(/cmd 9/)).toBeNull()
    expect(screen.getByText(/… 4 more lines/)).toBeTruthy()
  })

  it('calls out a single line that ends with Enter', () => {
    setup('sudo reboot\n')
    expect(screen.getByRole('dialog', { name: 'Paste a line that ends with Enter?' })).toBeTruthy()
  })

  it('pastes, focused by default, without changing settings', () => {
    const { api, onPaste } = setup('a\r\nb')
    expect(document.activeElement?.textContent).toBe('Paste')
    fireEvent.click(screen.getByText('Paste'))
    expect(onPaste).toHaveBeenCalled()
    expect(api.settings.set).not.toHaveBeenCalled()
  })

  it('turns the confirmation off when asked not to ask again', async () => {
    const { api, onPaste } = setup('a\nb')
    const changed = vi.fn()
    window.addEventListener('noxed:settings-changed', changed)
    fireEvent.click(screen.getByLabelText(/Don't ask again/))
    fireEvent.click(screen.getByText('Paste'))
    expect(onPaste).toHaveBeenCalled()
    expect(api.settings.set).toHaveBeenCalledWith('confirmMultilinePaste', false)
    await waitFor(() => expect(changed).toHaveBeenCalled())
    window.removeEventListener('noxed:settings-changed', changed)
  })

  it('warns if the preference cannot be saved', async () => {
    const { api } = setup('a\nb')
    api.settings.set.mockRejectedValueOnce(new Error('read-only'))
    fireEvent.click(screen.getByLabelText(/Don't ask again/))
    fireEvent.click(screen.getByText('Paste'))
    await waitFor(() => expect(useAppStore.getState().notifications.some((n) => n.message === 'read-only')).toBe(true))
  })

  it('cancels via the button or Escape', () => {
    const { onCancel } = setup('a\nb')
    fireEvent.click(screen.getByText('Cancel'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
