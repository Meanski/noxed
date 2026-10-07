// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import McpSection from '../McpSection'
import { installWindowApi, seedStore, type WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

let api: WindowApiMock
const notes = () => useAppStore.getState().notifications.map((n) => n.message)

beforeEach(() => {
  cleanup()
  api = installWindowApi()
  seedStore({ notifications: [] })
})

describe('McpSection', () => {
  it('turns access on and shows the setup command to copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<McpSection />)
    const toggle = await screen.findByLabelText('Allow Claude Code to use noxed')
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText('claude mcp add noxed tok')).toBeNull()
    fireEvent.click(toggle)
    expect(await screen.findByText('claude mcp add noxed tok')).toBeTruthy()
    expect(api.mcp.setEnabled).toHaveBeenCalledWith(true)
    expect(screen.getByText('Listening on 127.0.0.1:39847, for this computer only.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Copy setup command'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude mcp add noxed tok'))
    expect(notes()).toContain('Setup command copied. Run it in a terminal.')
  })

  it('refreshes the command after a new token', async () => {
    api.mcp.status.mockResolvedValue({ enabled: true, running: true, port: 39847, error: null })
    render(<McpSection />)
    await screen.findByText('claude mcp add noxed tok')
    api.mcp.connectionInfo.mockResolvedValueOnce({ url: 'u', token: 'new', command: 'claude mcp add noxed new' })
    fireEvent.click(screen.getByText('New token'))
    expect(await screen.findByText('claude mcp add noxed new')).toBeTruthy()
  })

  it('shows start errors and failures to change', async () => {
    api.mcp.status.mockResolvedValue({ enabled: true, running: false, port: 39847, error: 'Port 39847 is already in use' })
    api.mcp.setEnabled.mockRejectedValueOnce(new Error('Unlock noxed to change Claude Code access'))
    render(<McpSection />)
    expect((await screen.findByRole('alert')).textContent).toBe('Port 39847 is already in use')
    fireEvent.click(screen.getByLabelText('Allow Claude Code to use noxed'))
    await waitFor(() => expect(notes()).toContain('Unlock noxed to change Claude Code access'))
  })
})
