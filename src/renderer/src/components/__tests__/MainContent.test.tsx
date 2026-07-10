// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Tab } from '../../store'
import { useAppStore } from '../../store'
import { installWindowApi, seedStore, makeTab } from '../../__tests__/harness'

// Keep the render shallow: every routed child becomes a labeled stub so this
// test only exercises MainContent's own routing/layout logic.
vi.mock('../Terminal/TerminalView', () => ({
  default: ({ tab }: { tab: Tab }) => <div data-testid={`terminal-${tab.id}`}>terminal:{tab.id}</div>,
}))
vi.mock('../SFTP/SftpBrowser', () => ({ default: () => <div>stub-sftp</div> }))
vi.mock('../K8s/K8sDashboard', () => ({
  default: ({ context }: { context: string }) => <div>stub-k8s:{context}</div>,
}))
vi.mock('../Dashboard/Dashboard', () => ({ default: () => <div>stub-dashboard</div> }))
vi.mock('../ConnectionManager/ConnectionManager', () => ({ default: () => <div>stub-connections</div> }))
vi.mock('../Settings/Settings', () => ({ default: () => <div>stub-settings</div> }))
vi.mock('../Redis/RedisExplorer', () => ({ default: () => <div>stub-redis</div> }))
vi.mock('../Database/DatabaseExplorer', () => ({ default: () => <div>stub-database</div> }))
vi.mock('../Editor/EditorTab', () => ({ default: () => <div>stub-editor</div> }))
vi.mock('../Tunnels/TunnelsView', () => ({ default: () => <div>stub-tunnels</div> }))
vi.mock('../Docker/DockerDashboard', () => ({ default: () => <div>stub-docker</div> }))
vi.mock('../Runner/RunnerView', () => ({ default: () => <div>stub-runner</div> }))
vi.mock('../Terminal/LocalTerminalView', () => ({ default: () => <div>stub-local-term</div> }))
vi.mock('../RDP/RdpView', () => ({
  default: ({ tab }: { tab: Tab }) => {
    if (tab.label === 'explode') throw new Error('rdp blew up')
    return <div>stub-rdp</div>
  },
}))

import MainContent from '../MainContent'

beforeEach(() => {
  cleanup()
  installWindowApi()
  seedStore({ sessions: [], tabs: [], activeTabId: null, focusedPaneId: null })
})

const VIEW_STUBS: Array<[Tab['view'], string]> = [
  ['sftp', 'stub-sftp'],
  ['database', 'stub-database'],
  ['redis', 'stub-redis'],
  ['dashboard', 'stub-dashboard'],
  ['connections', 'stub-connections'],
  ['editor', 'stub-editor'],
  ['settings', 'stub-settings'],
  ['tunnels', 'stub-tunnels'],
  ['docker', 'stub-docker'],
  ['runner', 'stub-runner'],
  ['local-term', 'stub-local-term'],
  ['rdp', 'stub-rdp'],
]

describe('MainContent view routing', () => {
  it.each(VIEW_STUBS)('routes a %s tab to its view', (view, stubText) => {
    const tab = makeTab({ view })
    seedStore({ tabs: [tab], activeTabId: tab.id })
    render(<MainContent />)
    expect(screen.getByText(stubText)).toBeTruthy()
  })

  it('routes k8s tabs with a context and passes it through', () => {
    const tab = makeTab({ view: 'k8s', k8sContext: 'prod-cluster' })
    seedStore({ tabs: [tab], activeTabId: tab.id })
    render(<MainContent />)
    expect(screen.getByText('stub-k8s:prod-cluster')).toBeTruthy()
  })

  it('renders nothing for a k8s tab without a context', () => {
    const tab = makeTab({ view: 'k8s' })
    seedStore({ tabs: [tab], activeTabId: tab.id })
    const { container } = render(<MainContent />)
    expect(container.textContent).toBe('')
  })

  it('keeps every tab mounted but only the active tab visible', () => {
    const a = makeTab({ view: 'settings' })
    const b = makeTab({ view: 'runner' })
    seedStore({ tabs: [a, b], activeTabId: b.id })
    render(<MainContent />)
    const settings = screen.getByText('stub-settings').parentElement as HTMLElement
    const runner = screen.getByText('stub-runner').parentElement as HTMLElement
    expect(settings.style.display).toBe('none')
    expect(runner.style.display).toBe('flex')
  })
})

describe('MainContent terminal panes', () => {
  it('renders a single terminal without a split grid', () => {
    const tab = makeTab({ view: 'terminal' })
    seedStore({ tabs: [tab], activeTabId: tab.id })
    render(<MainContent />)
    const pane = screen.getByTestId(`terminal-${tab.id}`)
    expect(pane).toBeTruthy()
    // stub → pane wrapper → grid container
    const grid = pane.parentElement!.parentElement as HTMLElement
    expect(grid.style.display).toBe('flex')
  })

  it('renders split panes in a grid and skips pane tabs at the top level', () => {
    const parent = makeTab({ view: 'terminal' })
    const paneA = makeTab({ view: 'terminal', paneOf: parent.id })
    const paneB = makeTab({ view: 'terminal', paneOf: parent.id })
    seedStore({ tabs: [parent, paneA, paneB], activeTabId: parent.id })
    render(<MainContent />)
    // all three terminals mount exactly once
    expect(screen.getAllByText(/terminal:/)).toHaveLength(3)
    const grid = screen.getByTestId(`terminal-${parent.id}`).parentElement!.parentElement as HTMLElement
    expect(grid.style.display).toBe('grid')
    // three panes → third spans both columns
    const third = screen.getByTestId(`terminal-${paneB.id}`).parentElement as HTMLElement
    expect(third.style.gridColumn).toBe('span 2')
  })

  it('focuses a pane on mouse down when split', () => {
    const parent = makeTab({ view: 'terminal' })
    const pane = makeTab({ view: 'terminal', paneOf: parent.id })
    seedStore({ tabs: [parent, pane], activeTabId: parent.id, focusedPaneId: null })
    render(<MainContent />)
    const paneEl = screen.getByTestId(`terminal-${pane.id}`).parentElement as HTMLElement
    fireEvent.mouseDown(paneEl)
    expect(useAppStore.getState().focusedPaneId).toBe(pane.id)
  })
})

describe('MainContent error boundary', () => {
  it('catches a crashing tab and recovers via Try again', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tab = makeTab({ view: 'rdp', label: 'explode' })
    seedStore({ tabs: [tab], activeTabId: tab.id })
    render(<MainContent />)
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(screen.getByText('rdp blew up')).toBeTruthy()
    // Try again resets the boundary; the child throws again and is re-caught
    fireEvent.click(screen.getByText('Try again'))
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    spy.mockRestore()
  })
})
