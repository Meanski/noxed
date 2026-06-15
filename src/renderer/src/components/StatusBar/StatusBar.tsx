import { useEffect, useState } from 'react'
import { Shield, Cable } from 'lucide-react'
import { useAppStore } from '../../store'

export default function StatusBar() {
  const sessions = useAppStore(s => s.sessions)
  const tabs = useAppStore(s => s.tabs)
  const openTunnelsTab = useAppStore(s => s.openTunnelsTab)
  const [activeTunnels, setActiveTunnels] = useState(0)

  // System tabs (dashboard, settings, …) are born with status 'connected';
  // only tabs backed by a real remote connection count as sessions here.
  const CONNECTION_VIEWS = new Set(['terminal', 'sftp', 'database', 'redis', 'k8s', 'docker'])
  const connectionTabs = tabs.filter(t => CONNECTION_VIEWS.has(t.view))
  const connectedCount = connectionTabs.filter(t => t.status === 'connected').length
  const errorCount = connectionTabs.filter(t => t.status === 'error').length
  const totalConnections = sessions.length

  useEffect(() => {
    const refresh = () => {
      window.api.tunnels.list()
        .then(list => setActiveTunnels(list.filter(t => t.status === 'active').length))
        .catch(() => setActiveTunnels(0))
    }
    refresh()
    return window.api.tunnels.onChanged(refresh)
  }, [])

  return (
    <div
      className="flex items-center flex-shrink-0 px-4 gap-4"
      style={{
        height: 28,
        background: 'var(--nox-sidebar)',
        borderTop: '1px solid var(--nox-border)',
        fontSize: 10.5,
        color: 'var(--nox-text-2)',
      }}
    >
      {errorCount > 0 ? (
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444]" />
          <span>{errorCount} connection{errorCount !== 1 ? 's' : ''} lost</span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
          <span>All connections healthy</span>
        </div>
      )}

      <span style={{ color: 'var(--nox-text-3)' }}>|</span>

      <span>
        {totalConnections} connection{totalConnections !== 1 ? 's' : ''} configured
        {' · '}
        {connectedCount} active session{connectedCount !== 1 ? 's' : ''}
      </span>

      <div className="ml-auto flex items-center gap-3">
        {activeTunnels > 0 && (
          <button
            onClick={openTunnelsTab}
            className="flex items-center gap-1.5 transition-colors"
            style={{ color: '#10B981' }}
            title="View tunnels"
          >
            <Cable className="w-3 h-3" />
            <span>{activeTunnels} tunnel{activeTunnels !== 1 ? 's' : ''} active</span>
          </button>
        )}
        <div className="flex items-center gap-1.5">
          <Shield className="w-3 h-3 text-[#10B981]" />
          <span>Credentials encrypted</span>
        </div>
      </div>
    </div>
  )
}
