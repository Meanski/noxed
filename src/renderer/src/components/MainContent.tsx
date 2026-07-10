import React from 'react'
import { useAppStore, Tab } from '../store'
import TerminalView from './Terminal/TerminalView'
import SftpBrowser from './SFTP/SftpBrowser'
import K8sDashboard from './K8s/K8sDashboard'
import Dashboard from './Dashboard/Dashboard'
import ConnectionManager from './ConnectionManager/ConnectionManager'
import Settings from './Settings/Settings'
import RedisExplorer from './Redis/RedisExplorer'
import DatabaseExplorer from './Database/DatabaseExplorer'
import EditorTab from './Editor/EditorTab'
import TunnelsView from './Tunnels/TunnelsView'
import DockerDashboard from './Docker/DockerDashboard'
import RunnerView from './Runner/RunnerView'
import LocalTerminalView from './Terminal/LocalTerminalView'
import RdpView from './RDP/RdpView'

// ── Error boundary — prevents a crashed tab from taking down the whole app ──
class TabErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-full" style={{ background: 'var(--nox-bg)' }}>
          <div className="text-center max-w-sm px-6">
            <p className="font-['Plus_Jakarta_Sans'] font-semibold text-[15px] mb-2" style={{ color: 'var(--nox-text)' }}>
              Something went wrong
            </p>
            <p className="font-['Inter'] text-[12px] mb-4" style={{ color: 'var(--nox-text-2)' }}>
              {this.state.error.message}
            </p>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 rounded-md font-['Inter'] text-[12px] text-white"
              style={{ background: '#3B5CCC' }}
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Grid templates for 1–4 terminal panes; the third pane spans the bottom row.
const PANE_GRIDS: Record<number, React.CSSProperties> = {
  2: { gridTemplateColumns: '1fr 1fr' },
  3: { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' },
  4: { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' },
}

// Single-view tabs; terminal tabs are special-cased for split panes below.
function viewContent(tab: Tab): React.ReactNode {
  switch (tab.view) {
    case 'k8s':
      return tab.k8sContext
        ? <K8sDashboard context={tab.k8sContext} kubeconfigPath={tab.kubeconfigPath} tabId={tab.id} />
        : null
    case 'sftp': return <SftpBrowser tab={tab} />
    case 'database': return <DatabaseExplorer tab={tab} />
    case 'redis': return <RedisExplorer tab={tab} />
    case 'dashboard': return <Dashboard />
    case 'connections': return <ConnectionManager />
    case 'editor': return <EditorTab tab={tab} />
    case 'settings': return <Settings />
    case 'tunnels': return <TunnelsView />
    case 'docker': return <DockerDashboard tab={tab} />
    case 'runner': return <RunnerView />
    case 'local-term': return <LocalTerminalView tab={tab} />
    case 'rdp': return <RdpView tab={tab} />
    default: return null
  }
}

function TerminalPanes({ tab, style }: Readonly<{ tab: Tab; style: React.CSSProperties }>) {
  const tabs = useAppStore(s => s.tabs)
  const focusedPaneId = useAppStore(s => s.focusedPaneId)
  const setFocusedPane = useAppStore(s => s.setFocusedPane)

  const panes = [tab, ...tabs.filter(p => p.paneOf === tab.id)]
  const split = panes.length > 1
  return (
    <div style={style}>
      <div
        className="flex-1 min-w-0 min-h-0 overflow-hidden h-full"
        style={split
          ? { display: 'grid', gap: 1, background: 'var(--nox-border)', ...PANE_GRIDS[Math.min(panes.length, 4)] }
          : { display: 'flex', flexDirection: 'column' }}
      >
        {panes.map((pane, i) => (
          <div
            key={pane.id}
            className="relative flex-1 min-w-0 min-h-0 overflow-hidden"
            style={{
              ...(split && panes.length === 3 && i === 2 ? { gridColumn: 'span 2' } : {}),
              ...(split && focusedPaneId === pane.id ? { boxShadow: 'inset 0 0 0 1px rgba(124,58,237,0.45)' } : {}),
            }}
            onMouseDownCapture={() => { if (split) setFocusedPane(pane.id) }}
          >
            <TabErrorBoundary>
              <TerminalView tab={pane} />
            </TabErrorBoundary>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function MainContent() {
  const tabs = useAppStore(s => s.tabs)
  const activeTabId = useAppStore(s => s.activeTabId)

  // Keep every open tab mounted so switching views does not tear down live
  // terminal, database, SFTP, Redis, or K8s connections.
  return (
    <div className="relative h-full w-full min-w-0 min-h-0 overflow-hidden">
      {tabs.map(tab => {
        if (tab.paneOf) return null // rendered inside the parent's grid

        const style: React.CSSProperties = {
          display: tab.id === activeTabId ? 'flex' : 'none',
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          minWidth: 0,
          minHeight: 0,
        }

        if (tab.view === 'terminal') return <TerminalPanes key={tab.id} tab={tab} style={style} />

        const content = viewContent(tab)
        if (!content) return null
        return (
          <div key={tab.id} style={style}>
            <TabErrorBoundary>{content}</TabErrorBoundary>
          </div>
        )
      })}
    </div>
  )
}
