import React from 'react'
import { useAppStore } from '../store'
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

export default function MainContent() {
  const tabs = useAppStore(s => s.tabs)
  const activeTabId = useAppStore(s => s.activeTabId)
  const focusedPaneId = useAppStore(s => s.focusedPaneId)
  const setFocusedPane = useAppStore(s => s.setFocusedPane)

  // Keep every open tab mounted so switching views does not tear down live
  // terminal, database, SFTP, Redis, or K8s connections.
  return (
    <div className="relative h-full w-full min-w-0 min-h-0 overflow-hidden">
      {tabs.map(tab => {
        if (tab.paneOf) return null // rendered inside the parent's grid

        const isActive = tab.id === activeTabId
        const style: React.CSSProperties = {
          display: isActive ? 'flex' : 'none',
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          minWidth: 0,
          minHeight: 0,
        }

        if (tab.view === 'terminal') {
          const panes = [tab, ...tabs.filter(p => p.paneOf === tab.id)]
          const split = panes.length > 1
          return (
            <div key={tab.id} style={style}>
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

        if (tab.view === 'k8s' && tab.k8sContext) {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <K8sDashboard context={tab.k8sContext} kubeconfigPath={tab.kubeconfigPath} tabId={tab.id} />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'sftp') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <SftpBrowser tab={tab} />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'database') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <DatabaseExplorer tab={tab} />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'redis') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <RedisExplorer tab={tab} />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'dashboard') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <Dashboard />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'connections') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <ConnectionManager />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'editor') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <EditorTab tab={tab} />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'settings') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <Settings />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'tunnels') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <TunnelsView />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'docker') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <DockerDashboard tab={tab} />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'runner') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <RunnerView />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'local-term') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <LocalTerminalView tab={tab} />
              </TabErrorBoundary>
            </div>
          )
        }

        if (tab.view === 'rdp') {
          return (
            <div key={tab.id} style={style}>
              <TabErrorBoundary>
                <RdpView tab={tab} />
              </TabErrorBoundary>
            </div>
          )
        }

        return null
      })}
    </div>
  )
}
