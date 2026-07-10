import { useEffect, useState, useRef } from 'react'
import {
  Server, ChevronRight, Plus, GripVertical,
  LayoutGrid, Grid2x2, List,
} from 'lucide-react'
import { useAppStore, Session } from '../../store'
import { groupColor, metricColor } from '../../lib/colors'
import { CompactServerCard, HealthCard, ServerListRow } from './ServerViews'
import { ServerContextMenu } from '../ServerContextMenu'

type DashboardView = 'grid' | 'compact' | 'list'

const VIEW_OPTIONS: { id: DashboardView; label: string; Icon: typeof LayoutGrid }[] = [
  { id: 'grid', label: 'Cards', Icon: LayoutGrid },
  { id: 'compact', label: 'Compact', Icon: Grid2x2 },
  { id: 'list', label: 'List', Icon: List },
]

export default function Dashboard() {
  const sessions = useAppStore(s => s.sessions)
  const tabs = useAppStore(s => s.tabs)
  const openTab = useAppStore(s => s.openTab)
  const openDockerTab = useAppStore(s => s.openDockerTab)
  const openRdpTab = useAppStore(s => s.openRdpTab)
  const setShowAddConnection = useAppStore(s => s.setShowAddConnection)
  const setEditingConnectionId = useAppStore(s => s.setEditingConnectionId)
  const updateSession = useAppStore(s => s.updateSession)
  const removeSession = useAppStore(s => s.removeSession)
  const serverMetrics = useAppStore(s => s.serverMetrics)
  const projectGroupOrder = useAppStore(s => s.projectGroupOrder)
  const setProjectGroupOrder = useAppStore(s => s.setProjectGroupOrder)
  const groupColors = useAppStore(s => s.groupColors)

  // Right-click context menu, mirroring the sidebar's server actions.
  const [ctxMenu, setCtxMenu] = useState<{ session: Session; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const handler = () => setCtxMenu(null)
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  const openContextMenu = (e: React.MouseEvent, session: Session) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ session, x: e.clientX, y: e.clientY })
  }

  const handleColorChange = async (session: Session, color: string) => {
    const updated = await window.api.sessions.update(session.id, { color })
    updateSession(session.id, updated)
    setCtxMenu(null)
  }

  const handleToggleFavorite = async (session: Session) => {
    const updated = await window.api.sessions.update(session.id, { isFavorite: !session.isFavorite })
    updateSession(session.id, updated)
    setCtxMenu(null)
  }

  const handleMoveToProject = async (session: Session, group: string) => {
    const updated = await window.api.sessions.update(session.id, { group })
    updateSession(session.id, updated)
    setCtxMenu(null)
  }

  const editConnection = (session: Session) => {
    setEditingConnectionId(session.id)
    setShowAddConnection(true)
    setCtxMenu(null)
  }

  const handleDelete = async (session: Session) => {
    setCtxMenu(null)
    if (confirm(`Delete "${session.label || session.host}"?`)) {
      await window.api.sessions.delete(session.id)
      removeSession(session.id)
    }
  }

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [cardOrder, setCardOrder] = useState<Record<string, string[]>>({})
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [dragOverCard, setDragOverCard] = useState<string | null>(null)
  const dragGroup = useRef<string | null>(null)
  const dragCard = useRef<{ id: string; group: string } | null>(null)
  const canDragGroup = useRef(false)

  const [view, setView] = useState<DashboardView>('compact')

  const changeView = (v: DashboardView) => {
    setView(v)
    window.api.settings.set('dashboardView', v).catch((err: any) => {
      console.error('[dashboard] view save failed:', err?.message ?? err)
    })
  }

  // The Dashboard lists every connection type. SSH/untyped hosts show live
  // CPU/RAM from polling; other types (RDP, DB, Redis, K8s, SFTP) render as
  // launch cards without metrics.
  const dashboardSessions = sessions
  const connectedTabIds = new Set(tabs.filter(t => t.status === 'connected').map(t => t.sessionId))
  const connectedCount = dashboardSessions.filter(s => connectedTabIds.has(s.id)).length
  // Server health is derived from established tabs/metrics so saved hosts are
  // never touched in the background before the user connects.
  useEffect(() => {
    const apply = () => {
      window.api.settings.get().then((cfg: { dashboardView?: unknown }) => {
        if (cfg.dashboardView === 'compact' || cfg.dashboardView === 'list' || cfg.dashboardView === 'grid') {
          setView(cfg.dashboardView)
        }
      }).catch((err: any) => {
        console.error('[dashboard] settings read failed:', err?.message ?? err)
      })
    }
    apply()
    window.addEventListener('noxed:settings-changed', apply)
    return () => {
      window.removeEventListener('noxed:settings-changed', apply)
    }
  }, [])

  const rawGroups = dashboardSessions.reduce<Record<string, Session[]>>((acc, s) => {
    const g = s.group ?? 'Ungrouped'
    if (!acc[g]) acc[g] = []
    acc[g].push(s)
    return acc
  }, {})

  const allGroupNames = Object.keys(rawGroups)

  // Display order is derived, never written back: the sidebar owns the shared
  // group order, and groups missing from it (new, or non-SSH-only elsewhere)
  // still render, appended at the end. Writing from here used to fight the
  // sidebar's sync and could wipe the saved order while sessions were loading.
  const orderedGroupNames = [
    ...projectGroupOrder.filter(g => allGroupNames.includes(g)),
    ...allGroupNames
      .filter(g => !projectGroupOrder.includes(g))
      .sort((a, b) => {
        // 'Ungrouped' always sinks to the bottom.
        if (a === 'Ungrouped') return 1
        if (b === 'Ungrouped') return -1
        return a.localeCompare(b)
      }),
  ]

  useEffect(() => {
    setCardOrder(prev => {
      const next = { ...prev }
      for (const [g, groupSessions] of Object.entries(rawGroups)) {
        const ids = groupSessions.map(s => s.id)
        const existing = (prev[g] ?? []).filter(id => ids.includes(id))
        const added = ids.filter(id => !existing.includes(id))
        next[g] = [...existing, ...added]
      }
      return next
    })
  }, [dashboardSessions.length])

  const orderedGroups = orderedGroupNames
    .map(g => ({
      name: g,
      sessions: [
        ...(cardOrder[g] ?? []).map(id => rawGroups[g].find(s => s.id === id)).filter(Boolean),
        ...rawGroups[g].filter(s => !(cardOrder[g] ?? []).includes(s.id)),
      ] as Session[],
    }))

  function reorderGroups(srcGroup: string, dstGroup: string) {
    if (srcGroup === dstGroup) return
    const next = [...projectGroupOrder]
    const from = next.indexOf(srcGroup)
    const to = next.indexOf(dstGroup)
    if (from === -1 || to === -1) return
    next.splice(from, 1)
    next.splice(to, 0, srcGroup)
    setProjectGroupOrder(next)
  }

  function reorderCards(group: string, srcId: string, dstId: string) {
    if (srcId === dstId) return
    setCardOrder(prev => {
      const order = [...(prev[group] ?? [])]
      const from = order.indexOf(srcId)
      const to = order.indexOf(dstId)
      if (from === -1 || to === -1) return prev
      order.splice(from, 1)
      order.splice(to, 0, srcId)
      return { ...prev, [group]: order }
    })
  }

  function toggleCollapse(name: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }


  if (sessions.length === 0) return <EmptyDashboard onAdd={() => setShowAddConnection(true)} />

  return (
    <div className="h-full w-full min-w-0 overflow-y-auto" style={{ background: 'var(--nox-bg)' }}>
      <div className="px-6 py-6 w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="font-['Plus_Jakarta_Sans'] font-bold text-[20px]" style={{ color: 'var(--nox-text)' }}>
              Dashboard
            </h1>
            <p className="font-['Inter'] text-[12px] mt-0.5" style={{ color: 'var(--nox-text-2)' }}>
              {dashboardSessions.length} connection{dashboardSessions.length !== 1 ? 's' : ''} · {connectedCount} connected
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* View density switcher */}
            <div className="flex rounded-md p-0.5" style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}>
              {VIEW_OPTIONS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => changeView(id)}
                  title={label}
                  className="flex items-center justify-center w-7 h-6 rounded transition-colors"
                  style={{
                    background: view === id ? 'var(--nox-active)' : 'transparent',
                    color: view === id ? 'var(--nox-active-t)' : 'var(--nox-text-3)',
                  }}
                >
                  <Icon className="w-3.5 h-3.5" />
                </button>
              ))}
            </div>

          </div>
        </div>

        {dashboardSessions.length === 0 ? (
          <div className="rounded-xl p-8 text-center" style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}>
            <Server className="w-7 h-7 mx-auto mb-3" style={{ color: 'var(--nox-text-3)' }} />
            <p className="font-['Inter'] text-[13px] mb-3" style={{ color: 'var(--nox-text-2)' }}>
              Add a connection to get started
            </p>
            <button
              onClick={() => setShowAddConnection(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-['Inter'] text-[12px] text-[#3B5CCC] border border-[#3B5CCC]/30 hover:bg-[#EBF0FF] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> Add connection
            </button>
          </div>
        ) : (
          <div className="space-y-7">
            {orderedGroups.map(({ name, sessions: groupSessions }) => {
              const isCollapsed = collapsed.has(name)
              const connectedInGroup = groupSessions.filter(s => connectedTabIds.has(s.id))
              const metricsInGroup = connectedInGroup.map(s => serverMetrics[s.id]).filter(m => m?.available)
              const avgCpu = metricsInGroup.length
                ? Math.round(metricsInGroup.reduce((sum, m) => sum + m!.cpu, 0) / metricsInGroup.length)
                : null
              const color = name === 'Ungrouped' ? 'var(--nox-text-3)' : groupColor(name, groupColors)
              const allHealthy = connectedInGroup.length === groupSessions.length && groupSessions.length > 0
              const isGroupDropTarget = dragOverGroup === name && dragGroup.current !== name

              return (
                <div
                  key={name}
                  onDragOver={e => {
                    e.preventDefault()
                    if (dragGroup.current && dragGroup.current !== name) setDragOverGroup(name)
                  }}
                  onDrop={e => {
                    e.preventDefault()
                    if (dragGroup.current) { reorderGroups(dragGroup.current, name); dragGroup.current = null }
                    setDragOverGroup(null)
                  }}
                  onDragLeave={e => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverGroup(null)
                  }}
                  style={{
                    outline: isGroupDropTarget ? '2px dashed var(--nox-active-t)' : '2px solid transparent',
                    borderRadius: 10,
                    transition: 'outline 0.1s',
                  }}
                >
                  <div className="relative mb-4 group">
                    <span
                      className="absolute -left-5 top-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: 'var(--nox-text-3)' }}
                      draggable
                      onMouseDown={() => { canDragGroup.current = true }}
                      onDragStart={e => {
                        e.stopPropagation()
                        dragGroup.current = name
                      }}
                      onDragEnd={() => { dragGroup.current = null; setDragOverGroup(null); canDragGroup.current = false }}
                    >
                      <GripVertical className="w-3.5 h-3.5" />
                    </span>

                    <button
                      onClick={() => toggleCollapse(name)}
                      className="flex w-full items-center gap-3 rounded-md py-1.5 text-left transition-colors"
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--nox-hover)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                    >
                      <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[15px] truncate" style={{ color: 'var(--nox-text)' }}>
                        {name}
                      </span>
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
                      <span className="font-['Inter'] text-[12px] flex-shrink-0" style={{ color: 'var(--nox-text-3)' }}>
                        {groupSessions.length} connection{groupSessions.length !== 1 ? 's' : ''}
                      </span>
                      <span className="h-px flex-1 min-w-6" style={{ background: 'var(--nox-border)' }} />
                      <span className="font-['Inter'] text-[12px] flex-shrink-0" style={{ color: allHealthy ? '#10B981' : 'var(--nox-text-3)' }}>
                        {connectedInGroup.length}/{groupSessions.length} connected
                      </span>
                      {avgCpu !== null && (
                        <span className="font-['JetBrains_Mono'] text-[12px] flex-shrink-0" style={{ color: metricColor(avgCpu) }}>
                          {avgCpu}% CPU
                        </span>
                      )}
                      <ChevronRight
                        className="w-4 h-4 transition-transform flex-shrink-0"
                        style={{
                          color: 'var(--nox-text-3)',
                          transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                        }}
                      />
                    </button>
                  </div>

                  {!isCollapsed && view === 'grid' && (
                    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
                      {groupSessions.map(s => (
                        <HealthCard
                          key={s.id}
                          session={s}
                          metrics={serverMetrics[s.id]}
                          isConnected={connectedTabIds.has(s.id)}
                          isDropTarget={dragOverCard === s.id && dragCard.current?.id !== s.id}
                          onConnect={() => openTab(s)}
                          onContextMenu={e => openContextMenu(e, s)}
                          onDragStart={() => { dragCard.current = { id: s.id, group: name } }}
                          onDragOver={() => { if (dragCard.current?.group === name) setDragOverCard(s.id) }}
                          onDrop={() => {
                            if (dragCard.current?.group === name) reorderCards(name, dragCard.current.id, s.id)
                            dragCard.current = null
                            setDragOverCard(null)
                          }}
                          onDragEnd={() => { dragCard.current = null; setDragOverCard(null) }}
                        />
                      ))}
                    </div>
                  )}

                  {!isCollapsed && view === 'compact' && (
                    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                      {groupSessions.map(s => (
                        <CompactServerCard
                          key={s.id}
                          session={s}
                          metrics={serverMetrics[s.id]}
                          isConnected={connectedTabIds.has(s.id)}
                          onConnect={() => openTab(s)}
                          onContextMenu={e => openContextMenu(e, s)}
                        />
                      ))}
                    </div>
                  )}

                  {!isCollapsed && view === 'list' && (
                    <div
                      className="rounded-md overflow-hidden"
                      style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
                    >
                      {groupSessions.map((s, i) => (
                        <div key={s.id} style={i > 0 ? { borderTop: '1px solid var(--nox-border)' } : undefined}>
                          <ServerListRow
                            session={s}
                            metrics={serverMetrics[s.id]}
                            isConnected={connectedTabIds.has(s.id)}
                            onConnect={() => openTab(s)}
                            onContextMenu={e => openContextMenu(e, s)}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              )
            })}
          </div>
        )}
      </div>

      {ctxMenu && (
        <ServerContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          session={ctxMenu.session}
          allGroups={[...new Set(sessions.map(s => s.group).filter(Boolean) as string[])]}
          onEdit={() => editConnection(ctxMenu.session)}
          onRename={() => editConnection(ctxMenu.session)}
          onOpenDocker={(ctxMenu.session.type ?? 'ssh') === 'ssh'
            ? () => { openDockerTab(ctxMenu.session); setCtxMenu(null) }
            : undefined}
          onOpenRdp={window.api.platform === 'darwin' && ctxMenu.session?.type === 'rdp'
            ? () => { openRdpTab(ctxMenu.session); setCtxMenu(null) }
            : undefined}
          onColorChange={c => handleColorChange(ctxMenu.session, c)}
          onFavorite={() => handleToggleFavorite(ctxMenu.session)}
          onMoveToProject={g => handleMoveToProject(ctxMenu.session, g)}
          onDelete={() => handleDelete(ctxMenu.session)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

/* ── Empty state ─────────────────────────────────────────────────────────── */
function EmptyDashboard({ onAdd }: Readonly<{ onAdd: () => void }>) {
  return (
    <div className="h-full w-full flex items-center justify-center" style={{ background: 'var(--nox-bg)' }}>
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-6 w-24 h-24 flex items-center justify-center">
          <svg width="96" height="96" viewBox="0 0 96 96" fill="none" style={{ color: 'var(--nox-border)' }}>
            <rect x="12" y="20" width="72" height="56" rx="4" stroke="currentColor" strokeWidth="2"/>
            <rect x="18" y="26" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="38" y="26" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="58" y="26" width="20" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="18" y="40" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="38" y="40" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="58" y="40" width="20" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="18" y="54" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="38" y="54" width="40" height="10" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <circle cx="82" cy="22" r="6" stroke="#3B5CCC" strokeWidth="2" fill="none"/>
            <line x1="79" y1="22" x2="85" y2="22" stroke="#3B5CCC" strokeWidth="2" strokeLinecap="round"/>
            <line x1="82" y1="19" x2="82" y2="25" stroke="#3B5CCC" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </div>
        <h2 className="font-['Plus_Jakarta_Sans'] font-semibold text-[18px] mb-2" style={{ color: 'var(--nox-text)' }}>
          No connections yet
        </h2>
        <p className="font-['Inter'] text-[13px] mb-6 leading-relaxed" style={{ color: 'var(--nox-text-2)' }}>
          Add your first connection to start monitoring servers, managing Kubernetes clusters, and querying databases.
        </p>
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-2 text-white rounded-md px-5 py-2.5 font-['Inter'] text-[13px] font-medium transition-colors"
          style={{ background: '#3B5CCC' }}
          onMouseEnter={e => { e.currentTarget.style.background = '#2A4299' }}
          onMouseLeave={e => { e.currentTarget.style.background = '#3B5CCC' }}
        >
          <Plus className="w-4 h-4" />
          Add Connection
        </button>
      </div>
    </div>
  )
}
