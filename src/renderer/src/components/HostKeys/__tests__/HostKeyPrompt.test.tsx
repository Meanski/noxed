// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import HostKeyPrompt from '../HostKeyPrompt'
import { installWindowApi, seedStore } from '../../../__tests__/harness'
import { useAppStore } from '../../../store'

type Prompt = Parameters<Parameters<Window['api']['hostKeys']['onPrompt']>[0]>[0]

const newPrompt = (over: Partial<Prompt> = {}): Prompt => ({
  requestId: 'req-1',
  host: 'example.com',
  port: 22,
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:abc',
  status: 'new',
  knownFingerprints: [],
  otherKeyTypes: [],
  ...over,
})

function setup() {
  let emitPrompt: (p: Prompt) => void = () => {}
  let emitDismiss: (id: string) => void = () => {}
  const api = installWindowApi({
    hostKeys: {
      onPrompt: vi.fn((cb: (p: Prompt) => void) => { emitPrompt = cb; return () => {} }),
      onDismiss: vi.fn((cb: (id: string) => void) => { emitDismiss = cb; return () => {} }),
    },
  })
  seedStore({})
  render(<HostKeyPrompt />)
  return {
    api,
    prompt: (p: Prompt) => act(() => emitPrompt(p)),
    dismiss: (id: string) => act(() => emitDismiss(id)),
  }
}

beforeEach(() => cleanup())

describe('HostKeyPrompt', () => {
  it('renders nothing until main asks', () => {
    setup()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks to trust a new host and forwards each choice', () => {
    const { api, prompt } = setup()
    prompt(newPrompt({ port: 2222, otherKeyTypes: ['ssh-rsa'] }))
    expect(screen.getByRole('dialog', { name: 'Trust example.com:2222?' })).toBeTruthy()
    expect(screen.getByText('SHA256:abc')).toBeTruthy()
    expect(screen.getByText(/already trusted with a different key type \(ssh-rsa\)/)).toBeTruthy()
    fireEvent.click(screen.getByText('Trust and connect'))
    expect(api.hostKeys.respond).toHaveBeenCalledWith('req-1', 'trust')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('supports connecting once and cancelling (including Escape)', () => {
    const { api, prompt } = setup()
    prompt(newPrompt({ requestId: 'a' }))
    prompt(newPrompt({ requestId: 'b', host: 'second.com' }))
    fireEvent.click(screen.getByText('Connect once'))
    expect(api.hostKeys.respond).toHaveBeenCalledWith('a', 'once')
    // Queued prompts are answered in order.
    expect(screen.getByRole('dialog', { name: 'Trust second.com?' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(api.hostKeys.respond).toHaveBeenCalledWith('b', 'reject')
  })

  it('warns loudly about a changed key and defaults to cancelling', () => {
    const { api, prompt } = setup()
    prompt(newPrompt({ status: 'changed', fingerprint: 'SHA256:new', knownFingerprints: ['SHA256:old'] }))
    expect(screen.getByRole('dialog', { name: 'Host key changed for example.com' })).toBeTruthy()
    expect(screen.getByText('SHA256:old')).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Cancel connection')
    fireEvent.click(screen.getByText('Replace key and connect'))
    expect(api.hostKeys.respond).toHaveBeenCalledWith('req-1', 'trust')
  })

  it('drops a prompt main has timed out', () => {
    const { prompt, dismiss } = setup()
    prompt(newPrompt())
    dismiss('req-1')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('surfaces a failed response as a notification', async () => {
    const { api, prompt } = setup()
    api.hostKeys.respond.mockRejectedValueOnce(new Error('gone'))
    prompt(newPrompt())
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() =>
      expect(useAppStore.getState().notifications.some((n) => n.message === 'gone')).toBe(true),
    )
  })
})
