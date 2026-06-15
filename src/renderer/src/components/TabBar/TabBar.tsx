import { useState, useEffect, useRef } from 'react'
import { LayoutDashboard, List, Settings, Terminal, Boxes, Database, FolderOpen, X, Layers, Plus, FileCode } from 'lucide-react'
import { useAppStore, Tab } from '../../store'

export default function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, setShowAddConnection } = useAppStore()
  const confirmCloseRef = useRef(true)
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)

  useEffect(() => {
    window.api.settings.get().then((cfg: any) => {
      confirmCloseRef.current = cfg.confirmClose ?? true
    })
  }, [])

  const handleClose = (e: React.MouseEvent, tab: Tab) => {
    e.stopPropagation()
    const hasUnsavedEdits = tab.view === 'editor' && tab.isDirty
    const isActiveSession = tab.status === 'connected' && (tab.view === 'terminal' || tab.view === 'local-term' || tab.view === 'database' || tab.view === 'redis' || tab.view === 'k8s')
    if (hasUnsavedEdits || (isActiveSession && confirmCloseRef.current)) {
      setPendingCloseId(tab.id)
    } else {
      closeTab(tab.id)
    }
  }

  const pendingTab = pendingCloseId ? tabs.find(t => t.id === pendingCloseId) : undefined

  return (
    <>
      <div
        className="flex items-stretch flex-shrink-0 drag overflow-x-hidden"
        style={{
          height: 36,
          background: 'var(--nox-shell)',
          borderBottom: '1px solid var(--nox-border)',
        }}
      >
        <div className="flex items-stretch flex-1 min-w-0 no-drag overflow-x-hidden">
          {tabs.filter(tab => !tab.paneOf).map(tab => (
            <TabPill
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              onActivate={() => setActiveTab(tab.id)}
              onClose={e => handleClose(e, tab)}
            />
          ))}

          <button
            onClick={() => setShowAddConnection(true)}
            title="New tab (⌘T)"
            className="flex items-center justify-center w-8 h-full flex-shrink-0 transition-colors"
            style={{ color: 'var(--nox-text-3)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--nox-text)'; (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--nox-text-3)'; (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <Plus size={12} />
          </button>
        </div>

        <div
          className="flex-1"
          onDoubleClick={() => setShowAddConnection(true)}
          title="Double-click to add connection"
        />
      </div>

      {pendingCloseId && (
        <CloseConfirmDialog
          tabLabel={pendingTab?.label ?? 'this tab'}
          unsavedEdits={pendingTab?.view === 'editor'}
          onConfirm={() => { closeTab(pendingCloseId); setPendingCloseId(null) }}
          onCancel={() => setPendingCloseId(null)}
        />
      )}
    </>
  )
}

function CloseConfirmDialog({ tabLabel, unsavedEdits, onConfirm, onCancel }: { tabLabel: string; unsavedEdits?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div
        className="rounded-lg shadow-xl max-w-sm w-full mx-4 p-5"
        style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
      >
        <h3 className="font-['Plus_Jakarta_Sans'] font-bold text-[15px] mb-1.5" style={{ color: 'var(--nox-text)' }}>
          {unsavedEdits ? 'Discard unsaved changes?' : 'Close active session?'}
        </h3>
        <p className="font-['Inter'] text-[12.5px] mb-4" style={{ color: 'var(--nox-text-2)' }}>
          {unsavedEdits
            ? `"${tabLabel}" has unsaved changes. Closing will discard them.`
            : `"${tabLabel}" has an active connection. Closing will disconnect.`}
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md font-['Inter'] text-[12px] transition-colors"
            style={{ border: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-md font-['Inter'] text-[12px] font-medium text-white transition-colors"
            style={{ background: '#EF4444' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#DC2626' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#EF4444' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function tabIcon(view: Tab['view'], active: boolean) {
  const color = active ? '#3B5CCC' : 'var(--nox-text-2)'
  const size = 11
  switch (view) {
    case 'dashboard': return <LayoutDashboard size={size} style={{ color }} />
    case 'connections': return <List size={size} style={{ color }} />
    case 'settings': return <Settings size={size} style={{ color }} />
    case 'terminal': return <Terminal size={size} style={{ color }} />
    case 'k8s': return <Boxes size={size} style={{ color: active ? '#8B5CF6' : 'var(--nox-text-2)' }} />
    case 'database': return <Database size={size} style={{ color: active ? '#10B981' : 'var(--nox-text-2)' }} />
    case 'sftp': return <FolderOpen size={size} style={{ color: active ? '#EC4899' : 'var(--nox-text-2)' }} />
    case 'redis': return <Layers size={size} style={{ color: active ? '#DC382D' : 'var(--nox-text-2)' }} />
    case 'editor': return <FileCode size={size} style={{ color: active ? '#F59E0B' : 'var(--nox-text-2)' }} />
    case 'docker': return <Boxes size={size} style={{ color: active ? '#2496ED' : 'var(--nox-text-2)' }} />
    case 'local-term': return <Terminal size={size} style={{ color: active ? '#10B981' : 'var(--nox-text-2)' }} />
    default: return <Terminal size={size} style={{ color }} />
  }
}

function TabPill({ tab, active, onActivate, onClose }: {
  tab: Tab
  active: boolean
  onActivate: () => void
  onClose: (e: React.MouseEvent) => void
}) {
  return (
    <button
      onClick={onActivate}
      className="group relative flex items-center gap-1.5 px-3 h-full text-xs flex-shrink-0 max-w-[200px] transition-colors"
      style={{
        color: active ? 'var(--nox-text)' : 'var(--nox-text-2)',
        background: active ? 'var(--nox-bg)' : 'transparent',
        borderRight: '1px solid var(--nox-border)',
        borderBottom: active ? '2px solid #3B5CCC' : '2px solid transparent',
        marginBottom: active ? -1 : 0,
        fontWeight: active ? 500 : 400,
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--nox-sidebar)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      {tabIcon(tab.view, active)}

      <span className="truncate min-w-0 font-['Inter']" style={{ maxWidth: 140, fontSize: 12 }}>
        {tab.label}
      </span>

      {tab.status === 'connecting' && (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[#3B5CCC] animate-pulse" />
      )}
      {tab.status === 'connected' && tab.view === 'terminal' && (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[#10B981]" />
      )}
      {tab.view === 'k8s' && tab.status === 'connected' && (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[#8B5CF6]" />
      )}
      {tab.status === 'error' && (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[#EF4444]" />
      )}
      {tab.view === 'editor' && tab.isDirty && (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[#fbbf24]" title="Unsaved changes" />
      )}

      {tab.view !== 'dashboard' && (
        <span
          role="button"
          onClick={onClose}
          className="w-4 h-4 flex items-center justify-center rounded transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0 hover:bg-[#E5E7EB]"
          style={{ color: 'var(--nox-text-3)' }}
        >
          <X size={9} />
        </span>
      )}
    </button>
  )
}
