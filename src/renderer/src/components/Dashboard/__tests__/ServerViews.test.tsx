// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HealthCard, CompactServerCard, ServerListRow, reachabilityInfo } from '../ServerViews'
import { makeSession } from '../../../__tests__/harness'
import type { ServerMetrics } from '../../../store'

function liveMetrics(overrides: Partial<ServerMetrics> = {}): ServerMetrics {
  return {
    cpu: 42,
    memUsed: 4 * 1024 ** 3,
    memTotal: 8 * 1024 ** 3,
    diskUsed: 50 * 1024 ** 3,
    diskTotal: 100 * 1024 ** 3,
    load1: 1.23,
    uptimeSec: 86400 * 3,
    available: true,
    lastUpdated: Date.now(),
    cpuHistory: [10, 20, 42],
    ...overrides,
  }
}

const noop = () => {}

const dragProps = {
  isDropTarget: false,
  onDragStart: noop,
  onDragOver: noop,
  onDrop: noop,
  onDragEnd: noop,
}

describe('reachabilityInfo', () => {
  it('maps connection state to label/color', () => {
    expect(reachabilityInfo(true)).toEqual({ label: 'Connected', color: '#10B981' })
    expect(reachabilityInfo(false).label).toBe('Disconnected')
  })
})

describe('HealthCard', () => {
  it('renders live metrics with disk, load and uptime', () => {
    const session = makeSession({ label: 'Prod 1' })
    render(
      <HealthCard
        session={session}
        metrics={liveMetrics()}
        isConnected
        onConnect={noop}
        {...dragProps}
      />
    )
    expect(screen.getByText('Prod 1')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('CPU')).toBeTruthy()
    expect(screen.getByText('MEM')).toBeTruthy()
    expect(screen.getByText('DISK')).toBeTruthy()
    expect(screen.getByText(/load 1\.23/)).toBeTruthy()
    expect(screen.getByText(/^up /)).toBeTruthy()
    // Connected cards do not offer a Connect button
    expect(screen.queryByText('Connect')).toBeNull()
  })

  it('colors metric bars by warning thresholds', () => {
    const session = makeSession()
    const { container } = render(
      <HealthCard
        session={session}
        metrics={liveMetrics({ cpu: 85, memUsed: 6.5 * 1024 ** 3, memTotal: 10 * 1024 ** 3, diskUsed: 10, diskTotal: 100 })}
        isConnected
        onConnect={noop}
        {...dragProps}
      />
    )
    const bars = Array.from(container.querySelectorAll('.h-full.rounded-full')) as HTMLElement[]
    // cpu 85 → red, mem 65% → amber, disk 10% → session accent
    expect(bars[0].style.background).toBe('rgb(239, 68, 68)')
    expect(bars[1].style.background).toBe('rgb(245, 158, 11)')
    expect(bars[2].style.background).toBe('rgb(59, 92, 204)')
  })

  it('fires onConnect for click, Enter and Space (but not other keys)', () => {
    const onConnect = vi.fn()
    const session = makeSession({ label: 'KeyCard' })
    render(
      <HealthCard session={session} metrics={undefined} isConnected={false} onConnect={onConnect} {...dragProps} />
    )
    const card = screen.getByText('KeyCard').closest('[role="button"]') as HTMLElement
    fireEvent.click(card)
    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.keyDown(card, { key: ' ' })
    fireEvent.keyDown(card, { key: 'a' })
    expect(onConnect).toHaveBeenCalledTimes(3)
  })

  it('shows a Connect button when disconnected that stops propagation', () => {
    const onConnect = vi.fn()
    render(
      <HealthCard session={makeSession()} isConnected={false} onConnect={onConnect} {...dragProps} />
    )
    fireEvent.click(screen.getByText('Connect'))
    expect(onConnect).toHaveBeenCalledTimes(1)
  })

  it('shows the waiting placeholder when connected without metrics yet', () => {
    render(
      <HealthCard session={makeSession({ type: 'ssh' })} isConnected onConnect={noop} {...dragProps} />
    )
    expect(screen.getByText('waiting for metrics')).toBeTruthy()
  })

  it('shows connect hint for disconnected metric-capable hosts', () => {
    render(
      <HealthCard session={makeSession()} isConnected={false} onConnect={noop} {...dragProps} />
    )
    expect(screen.getByText('Connect to start live metrics')).toBeTruthy()
  })

  it('shows click-to-open status for non-metric hosts', () => {
    const { rerender } = render(
      <HealthCard session={makeSession({ type: 'redis' })} isConnected={false} onConnect={noop} {...dragProps} />
    )
    expect(screen.getByText('Click to open')).toBeTruthy()
    rerender(
      <HealthCard session={makeSession({ type: 'redis' })} isConnected onConnect={noop} {...dragProps} />
    )
    expect(screen.getByText('Connected — click to open')).toBeTruthy()
  })

  it('handles drag lifecycle and drop-target styling', () => {
    const onDragStart = vi.fn()
    const onDragOver = vi.fn()
    const onDrop = vi.fn()
    const onDragEnd = vi.fn()
    const session = makeSession({ label: 'DragCard', color: '#AA00FF' })
    render(
      <HealthCard
        session={session}
        isConnected={false}
        onConnect={noop}
        isDropTarget
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      />
    )
    const card = screen.getByText('DragCard').closest('[role="button"]') as HTMLElement
    expect(card.style.border).toContain('dashed')
    fireEvent.dragStart(card)
    fireEvent.dragOver(card)
    fireEvent.drop(card)
    fireEvent.dragEnd(card)
    expect(onDragStart).toHaveBeenCalledTimes(1)
    expect(onDragOver).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })

  it('calls onContextMenu on right-click', () => {
    const onContextMenu = vi.fn()
    render(
      <HealthCard
        session={makeSession({ label: 'CtxCard' })}
        isConnected={false}
        onConnect={noop}
        onContextMenu={onContextMenu}
        {...dragProps}
      />
    )
    fireEvent.contextMenu(screen.getByText('CtxCard').closest('[role="button"]') as HTMLElement)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })
})

describe('CompactServerCard', () => {
  it('shows cpu/mem summary when live', () => {
    render(
      <CompactServerCard
        session={makeSession({ label: 'Compact' })}
        metrics={liveMetrics({ cpu: 12, memUsed: 1 * 1024 ** 3, memTotal: 4 * 1024 ** 3 })}
        isConnected
        onConnect={noop}
      />
    )
    expect(screen.getByText('cpu 12% · mem 25%')).toBeTruthy()
  })

  it('shows Disconnected when offline', () => {
    render(
      <CompactServerCard session={makeSession()} isConnected={false} onConnect={noop} />
    )
    expect(screen.getByText('Disconnected')).toBeTruthy()
  })

  it('shows waiting for metrics when connected without data, and Connected for non-metric types', () => {
    const { rerender } = render(
      <CompactServerCard session={makeSession({ type: 'ssh' })} isConnected onConnect={noop} />
    )
    expect(screen.getByText('waiting for metrics')).toBeTruthy()
    rerender(
      <CompactServerCard session={makeSession({ type: 'database' })} isConnected onConnect={noop} />
    )
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('fires onConnect on click', () => {
    const onConnect = vi.fn()
    render(<CompactServerCard session={makeSession()} isConnected={false} onConnect={onConnect} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onConnect).toHaveBeenCalledTimes(1)
  })
})

describe('ServerListRow', () => {
  it('renders live metric cells, uptime and reachability', () => {
    const session = makeSession({ label: 'RowHost', username: 'admin', host: 'row.example.com' })
    render(
      <ServerListRow
        session={session}
        metrics={liveMetrics({ cpu: 55 })}
        isConnected
        onConnect={noop}
      />
    )
    expect(screen.getByText('RowHost')).toBeTruthy()
    expect(screen.getByText(/admin@/)).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('55%')).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy() // disk pct
    expect(screen.getByText(/^up /)).toBeTruthy()
  })

  it('renders em-dash placeholders when metrics are missing', () => {
    render(
      <ServerListRow session={makeSession()} isConnected={false} onConnect={noop} />
    )
    expect(screen.getAllByText('—').length).toBe(3)
    expect(screen.getByText('Disconnected')).toBeTruthy()
  })

  it('fires onConnect for click, Enter and Space keyboard activation', () => {
    const onConnect = vi.fn()
    const session = makeSession({ label: 'RowKeys' })
    render(<ServerListRow session={session} isConnected={false} onConnect={onConnect} />)
    const row = screen.getByText('RowKeys').closest('[role="button"]') as HTMLElement
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(onConnect).toHaveBeenCalledTimes(3)
  })

  it('offers a Connect action button when disconnected', () => {
    const onConnect = vi.fn()
    render(<ServerListRow session={makeSession()} isConnected={false} onConnect={onConnect} />)
    fireEvent.click(screen.getByTitle('Connect'))
    expect(onConnect).toHaveBeenCalledTimes(1)
  })
})
