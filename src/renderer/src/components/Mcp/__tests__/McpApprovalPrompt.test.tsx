// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import McpApprovalPrompt from '../McpApprovalPrompt'
import { installWindowApi, seedStore, type WindowApiMock } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

let api: WindowApiMock
type Request = { requestId: string; kind: 'command' | 'read'; connection: string; detail: string }
const command: Request = { requestId: 'r1', kind: 'command', connection: 'web-01', detail: 'systemctl restart nginx' }
const read: Request = { requestId: 'r2', kind: 'read', connection: 'db', detail: 'read /etc/hosts' }

function setup(locked = false) {
  api = installWindowApi()
  seedStore({ isLocked: locked, notifications: [] })
  render(<McpApprovalPrompt />)
  const push = (r: Request) => act(() => (api.mcp.onApproval.mock.calls[0][0] as (r: Request) => void)(r))
  const dismiss = (id: string) => act(() => (api.mcp.onApprovalDismiss.mock.calls[0][0] as (id: string) => void)(id))
  return { push, dismiss }
}

beforeEach(() => cleanup())

describe('McpApprovalPrompt', () => {
  it('shows the exact command and answers in order', async () => {
    const { push } = setup()
    push(command)
    push(read)
    expect(screen.getByText('Claude Code wants to run a command')).toBeTruthy()
    expect(screen.getByText('systemctl restart nginx')).toBeTruthy()
    expect(screen.getByText('1 more waiting.')).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Deny')
    fireEvent.click(screen.getByText('Allow once'))
    expect(api.mcp.respond).toHaveBeenCalledWith('r1', 'once')
    expect(screen.getByText('Claude Code wants to read files')).toBeTruthy()
    fireEvent.click(screen.getByText('Allow for this session'))
    expect(api.mcp.respond).toHaveBeenLastCalledWith('r2', 'session')
    await waitFor(() => expect(screen.queryByText(/wants to/)).toBeNull())
  })

  it('denies on Deny, and drops prompts main withdraws', () => {
    const { push, dismiss } = setup()
    push(command)
    fireEvent.click(screen.getByText('Deny'))
    expect(api.mcp.respond).toHaveBeenCalledWith('r1', 'deny')
    push(read)
    dismiss('r2')
    expect(screen.queryByText(/wants to/)).toBeNull()
  })

  it('brings a prompt back when the answer could not be sent', async () => {
    const { push } = setup()
    api.mcp.respond.mockRejectedValueOnce(new Error('Unlock noxed to approve requests'))
    push(command)
    fireEvent.click(screen.getByText('Allow once'))
    await waitFor(() => expect(useAppStore.getState().notifications[0]?.message).toBe('Unlock noxed to approve requests'))
    expect(screen.getByText('systemctl restart nginx')).toBeTruthy()
  })

  it('stays hidden while locked', () => {
    const { push } = setup(true)
    push(command)
    expect(screen.queryByText(/wants to/)).toBeNull()
  })
})
