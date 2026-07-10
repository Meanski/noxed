// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import DisconnectedOverlay from '../DisconnectedOverlay'

const baseProps = {
  onReconnect: vi.fn(),
  connecting: false,
  cooldown: 0,
  failCount: 0,
  onDismiss: vi.fn(),
  onClose: vi.fn(),
}

describe('DisconnectedOverlay', () => {
  it('renders the connection-lost message', () => {
    render(<DisconnectedOverlay {...baseProps} message="Broken pipe" />)
    expect(screen.getByText('Connection lost')).toBeTruthy()
    expect(screen.getByText('Broken pipe')).toBeTruthy()
  })

  it('offers Reconnect when idle and fires onReconnect', () => {
    const onReconnect = vi.fn()
    render(<DisconnectedOverlay {...baseProps} onReconnect={onReconnect} />)
    fireEvent.click(screen.getByText('Reconnect'))
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('shows countdown while cooling down', () => {
    render(<DisconnectedOverlay {...baseProps} cooldown={7} />)
    expect(screen.getByText('Retry in 7s')).toBeTruthy()
  })

  it('shows reconnecting state while connecting', () => {
    render(<DisconnectedOverlay {...baseProps} connecting />)
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
  })

  it('hints at fail2ban after repeated timeouts', () => {
    render(<DisconnectedOverlay {...baseProps} failCount={3} message="connect timeout" />)
    expect(screen.getByText(/fail2ban/i)).toBeTruthy()
  })
})
