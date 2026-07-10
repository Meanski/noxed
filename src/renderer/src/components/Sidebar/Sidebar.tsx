import { useState, useRef, useEffect } from 'react'
import {
  LayoutDashboard, List, Star, Terminal, FolderOpen, Database,
  Settings, ChevronRight, Search, FolderKanban, Layers,
  Plus, GripVertical, Cable, TerminalSquare, Monitor,
} from 'lucide-react'
import { useAppStore, Session, groupColor } from '../../store'
import K8sIcon from '../K8sIcon'
import { ServerContextMenu, MenuItem, useMenuBehavior, COLORS } from '../ServerContextMenu'

// Sorts a session list by a saved id order; unknown ids keep their position at the end.
function applySavedOrder(list: Session[], order?: string[]): Session[] {
  if (!order?.length) return list
  return [...list].sort((a, b) => {
    const ai = order.indexOf(a.id)
    const bi = order.indexOf(b.id)
    if (ai === -1 && bi === -1) return 0
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

export default function Sidebar() {
  const {
    sessions, tabs, activeTabId,
    openTab, openDashboardTab, openConnectionsTab, openSettingsTab, openRedisTab,
    openTunnelsTab, openRunnerTab, openDockerTab, openRdpTab, openLocalTerminalTab,
    sidebarView, setSidebarView,
    setShowCommandPalette,
    sectionOrder, setSectionOrder,
    projectGroupOrder, setProjectGroupOrder,
    updateSession, removeSession,
    setEditingConnectionId, setShowAddConnection,
  } = useAppStore()

  const activeTab = tabs.find(t => t.id === activeTabId)
  const currentView = activeTab?.view ?? null

  const sshSessions = sessions.filter(s => !s.type || s.type === 'ssh')
  const sftpSessions = sessions.filter(s => s.type === 'sftp')
  const dbSessions = sessions.filter(s => s.type === 'database')
  const redisSessions = sessions.filter(s => s.type === 'redis')
  const k8sSessions = sessions.filter(s => s.type === 'kubernetes')
  const rdpSessions = sessions.filter(s => s.type === 'rdp')
  const favSessions = sessions.filter(s => s.isFavorite)

  const connectedIds = new Set(tabs.filter(t => t.status === 'connected').map(t => t.sessionId))

  // Context menu state — session-specific or empty-area
  const [ctxMenu, setCtxMenu] = useState<{ session?: Session; x: number; y: number } | null>(null)
  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null)

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return
    const handler = () => setCtxMenu(null)
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  const handleContextMenu = (e: React.MouseEvent, session: Session) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ session, x: e.clientX, y: e.clientY })
  }

  const handleEmptyContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  const handleRename = async (session: Session, newLabel: string) => {
    if (!newLabel.trim()) return
    const updated = await window.api.sessions.update(session.id, { label: newLabel.trim() })
    updateSession(session.id, updated)
    setRenamingId(null)
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

  const handleDelete = async (session: Session) => {
    setCtxMenu(null)
    if (confirm(`Delete "${session.label || session.host}"?`)) {
      await window.api.sessions.delete(session.id)
      removeSession(session.id)
    }
  }

  const handleMoveToProject = async (session: Session, group: string) => {
    const updated = await window.api.sessions.update(session.id, { group })
    updateSession(session.id, updated)
    setCtxMenu(null)
  }

  const openSession = (s: Session) => {
    if (s.type === 'redis') return openRedisTab(s)
    openTab(s)
  }


  const applyOrder = (section: string, list: Session[]) => applySavedOrder(list, sectionOrder[section])

  return (
    <div
      className="flex flex-col flex-shrink-0 h-full overflow-hidden"
      style={{ width: 220, background: 'var(--nox-sidebar)', borderRight: '1px solid var(--nox-border)' }}
    >
      {/* Search */}
      <div className="px-3 py-2 flex-shrink-0">
        <button
          onClick={() => setShowCommandPalette(true)}
          className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors"
          style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#3B5CCC' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--nox-border)' }}
        >
          <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
          <span className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-3)' }}>Search… ⌘K</span>
        </button>
      </div>

      {/* View toggle */}
      <div className="px-3 mb-2 flex-shrink-0">
        <div className="flex rounded-md p-0.5" style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}>
          {(['type', 'project'] as const).map((v, i) => (
            <button
              key={v}
              onClick={() => setSidebarView(v)}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[11px] font-medium transition-all"
              style={sidebarView === v ? { background: '#3B5CCC', color: '#fff' } : { color: 'var(--nox-text-2)' }}
            >
              {i === 0 ? <List className="w-3 h-3" /> : <FolderKanban className="w-3 h-3" />}
              {i === 0 ? 'Type' : 'Project'}
            </button>
          ))}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 overflow-y-auto pb-4" style={{ scrollbarWidth: 'none' }} onContextMenu={handleEmptyContextMenu}>
        <NavItem icon={<LayoutDashboard className="w-4 h-4" />} label="Dashboard" active={currentView === 'dashboard'} onClick={openDashboardTab} />
        <NavItem icon={<List className="w-4 h-4" />} label="Connections" active={currentView === 'connections'} onClick={openConnectionsTab} />
        <NavItem icon={<Cable className="w-4 h-4" />} label="Tunnels" active={currentView === 'tunnels'} onClick={openTunnelsTab} />
        <NavItem icon={<TerminalSquare className="w-4 h-4" />} label="Run Command" active={currentView === 'runner'} onClick={openRunnerTab} />
        <NavItem icon={<Terminal className="w-4 h-4" />} label="Local Terminal" active={currentView === 'local-term'} onClick={openLocalTerminalTab} />

        {sidebarView === 'type' ? (
          <>
            {favSessions.length > 0 && (
              <SectionGroup label="Favorites" icon={<Star className="w-3 h-3" />}>
                {favSessions.map(s => (
                  <ConnectionItem
                    key={s.id}
                    session={s}
                    connected={connectedIds.has(s.id)}
                    isRenaming={renamingId === s.id}
                    onContextMenu={e => handleContextMenu(e, s)}
                    onClick={() => openSession(s)}
                    onRename={newLabel => handleRename(s, newLabel)}
                    onRenameCancel={() => setRenamingId(null)}
                  />
                ))}
              </SectionGroup>
            )}

            {sshSessions.length > 0 && (
              <DraggableSection
                label="SSH"
                sessions={applyOrder('ssh', sshSessions)}
                connectedIds={connectedIds}
                renamingId={renamingId}
                onContextMenu={handleContextMenu}
                onOpen={openSession}
                onRename={handleRename}
                onRenameCancel={() => setRenamingId(null)}
                onReorder={order => setSectionOrder('ssh', order)}
              />
            )}

            {sftpSessions.length > 0 && (
              <DraggableSection
                label="SFTP"
                sessions={applyOrder('sftp', sftpSessions)}
                connectedIds={connectedIds}
                renamingId={renamingId}
                onContextMenu={handleContextMenu}
                onOpen={openSession}
                onRename={handleRename}
                onRenameCancel={() => setRenamingId(null)}
                onReorder={order => setSectionOrder('sftp', order)}
              />
            )}

            {dbSessions.length > 0 && (
              <DraggableSection
                label="Databases"
                sessions={applyOrder('database', dbSessions)}
                connectedIds={connectedIds}
                renamingId={renamingId}
                onContextMenu={handleContextMenu}
                onOpen={openSession}
                onRename={handleRename}
                onRenameCancel={() => setRenamingId(null)}
                onReorder={order => setSectionOrder('database', order)}
              />
            )}

            {redisSessions.length > 0 && (
              <DraggableSection
                label="Redis"
                sessions={applyOrder('redis', redisSessions)}
                connectedIds={connectedIds}
                renamingId={renamingId}
                onContextMenu={handleContextMenu}
                onOpen={openSession}
                onRename={handleRename}
                onRenameCancel={() => setRenamingId(null)}
                onReorder={order => setSectionOrder('redis', order)}
              />
            )}

            {k8sSessions.length > 0 && (
              <DraggableSection
                label="Kubernetes"
                sessions={applyOrder('kubernetes', k8sSessions)}
                connectedIds={connectedIds}
                renamingId={renamingId}
                onContextMenu={handleContextMenu}
                onOpen={openSession}
                onRename={handleRename}
                onRenameCancel={() => setRenamingId(null)}
                onReorder={order => setSectionOrder('kubernetes', order)}
              />
            )}

            {rdpSessions.length > 0 && window.api.platform === 'darwin' && (
              <DraggableSection
                label="Remote Desktop"
                sessions={applyOrder('rdp', rdpSessions)}
                connectedIds={connectedIds}
                renamingId={renamingId}
                onContextMenu={handleContextMenu}
                onOpen={openSession}
                onRename={handleRename}
                onRenameCancel={() => setRenamingId(null)}
                onReorder={order => setSectionOrder('rdp', order)}
              />
            )}
          </>
        ) : (
          <ProjectView
          sessions={sessions}
          onConnect={openSession}
          onContextMenu={handleContextMenu}
          onMoveToProject={handleMoveToProject}
          groupOrder={projectGroupOrder}
          onGroupOrderChange={setProjectGroupOrder}
        />
        )}
      </nav>

      {/* Settings at bottom */}
      <div className="flex-shrink-0 px-2 pb-2" style={{ borderTop: '1px solid var(--nox-border)', paddingTop: 8 }}>
        <NavItem icon={<Settings className="w-4 h-4" />} label="Settings" active={currentView === 'settings'} onClick={openSettingsTab} />
      </div>

      {/* Context menu */}
      {ctxMenu?.session && (
        <ServerContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          session={ctxMenu.session}
          allGroups={[...new Set(sessions.map(s => s.group).filter(Boolean) as string[])]}
          onEdit={() => { setEditingConnectionId(ctxMenu.session!.id); setShowAddConnection(true); setCtxMenu(null) }}
          onRename={() => { setRenamingId(ctxMenu.session!.id); setCtxMenu(null) }}
          onOpenDocker={(ctxMenu.session.type ?? 'ssh') === 'ssh'
            ? () => { openDockerTab(ctxMenu.session!); setCtxMenu(null) }
            : undefined}
          onOpenRdp={window.api.platform === 'darwin' && (ctxMenu.session?.type ?? 'ssh') === 'rdp'
            ? () => { openRdpTab(ctxMenu.session!); setCtxMenu(null) }
            : undefined}
          onColorChange={c => handleColorChange(ctxMenu.session!, c)}
          onFavorite={() => handleToggleFavorite(ctxMenu.session!)}
          onMoveToProject={g => handleMoveToProject(ctxMenu.session!, g)}
          onDelete={() => handleDelete(ctxMenu.session!)}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {ctxMenu && !ctxMenu.session && (
        <EmptyAreaMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onNewConnection={() => { setShowAddConnection(true); setCtxMenu(null) }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

/* ── Draggable section ───────────────────────────────────────────────────── */
function DraggableSection({ label, sessions, connectedIds, renamingId, onContextMenu, onOpen, onRename, onRenameCancel, onReorder }: Readonly<{
  label: string
  sessions: Session[]
  connectedIds: Set<string | undefined>
  renamingId: string | null
  onContextMenu: (e: React.MouseEvent, s: Session) => void
  onOpen: (s: Session) => void
  onRename: (s: Session, label: string) => void
  onRenameCancel: () => void
  onReorder: (ids: string[]) => void
}>) {
  const dragSrc = useRef<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [order, setOrder] = useState<string[]>([])

  // Sync order: keep custom order, append new, remove deleted
  useEffect(() => {
    const ids = sessions.map(s => s.id)
    setOrder(prev => {
      const kept = prev.filter(id => ids.includes(id))
      const added = ids.filter(id => !kept.includes(id))
      return [...kept, ...added]
    })
  }, [sessions.map(s => s.id).join(',')])

  const ordered = order.map(id => sessions.find(s => s.id === id)).filter(Boolean) as Session[]

  const handleDrop = (targetId: string) => {
    const src = dragSrc.current
    if (!src || src === targetId) return
    setOrder(prev => {
      const next = [...prev]
      const from = next.indexOf(src)
      const to = next.indexOf(targetId)
      if (from === -1 || to === -1) return prev
      next.splice(from, 1)
      next.splice(to, 0, src)
      onReorder(next)
      return next
    })
    dragSrc.current = null
    setDragOver(null)
  }

  return (
    <SectionGroup label={label}>
      {ordered.map(s => (
        <div
          key={s.id}
          draggable
          onDragStart={e => { e.stopPropagation(); dragSrc.current = s.id }}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dragSrc.current !== s.id) setDragOver(s.id) }}
          onDrop={e => { e.stopPropagation(); handleDrop(s.id) }}
          onDragEnd={() => { dragSrc.current = null; setDragOver(null) }}
          style={{ opacity: dragOver === s.id ? 0.5 : 1 }}
        >
          <ConnectionItem
            session={s}
            connected={connectedIds.has(s.id)}
            isRenaming={renamingId === s.id}
            onContextMenu={e => onContextMenu(e, s)}
            onClick={() => onOpen(s)}
            onRename={newLabel => onRename(s, newLabel)}
            onRenameCancel={onRenameCancel}
          />
        </div>
      ))}
    </SectionGroup>
  )
}

/* ── Nav item ────────────────────────────────────────────────────────────── */
function NavItem({ icon, label, active, onClick }: Readonly<{ icon: React.ReactNode; label: string; active: boolean; onClick: () => void }>) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer mb-0.5 transition-colors"
      style={active ? { background: 'var(--nox-active)', color: 'var(--nox-active-t)' } : { color: 'var(--nox-text)' }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = '' }}
    >
      <span style={{ color: active ? 'var(--nox-active-t)' : 'var(--nox-text-2)' }}>{icon}</span>
      <span className="font-['Inter'] text-[12.5px]" style={{ fontWeight: active ? 500 : 400 }}>{label}</span>
    </div>
  )
}

/* ── Section group ───────────────────────────────────────────────────────── */
function SectionGroup({ label, icon, children }: Readonly<{ label: string; icon?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <div className="mt-3 mb-1">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--nox-text-3)' }}>
          {label}
        </span>
        {icon && <span style={{ color: 'var(--nox-text-3)' }}>{icon}</span>}
      </div>
      {children}
    </div>
  )
}

/* ── Connection item ─────────────────────────────────────────────────────── */
function ConnectionItem({ session, connected, isRenaming, onContextMenu, onClick, onRename, onRenameCancel }: Readonly<{
  session: Session
  connected: boolean
  isRenaming: boolean
  onContextMenu: (e: React.MouseEvent) => void
  onClick: () => void
  onRename: (label: string) => void
  onRenameCancel: () => void
}>) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(session.label || session.host)

  useEffect(() => {
    if (isRenaming) {
      setDraft(session.label || session.host)
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [isRenaming])

  if (isRenaming) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 rounded-md" style={{ background: 'var(--nox-active)' }}>
        <ConnectionTypeIcon type={session.type} size={11} />
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onRename(draft)
            if (e.key === 'Escape') onRenameCancel()
          }}
          onBlur={() => onRename(draft)}
          className="flex-1 bg-transparent outline-none font-['Inter'] text-[12px] min-w-0"
          style={{ color: 'var(--nox-text)' }}
        />
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onContextMenu={onContextMenu}
      className="flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer transition-colors"
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
    >
      <ConnectionTypeIcon type={session.type} size={11} />
      <span className="font-['Inter'] text-[12px] truncate flex-1" style={{ color: 'var(--nox-text)' }}>
        {session.label || session.host}
      </span>
      {connected && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[#10B981]" />}
    </div>
  )
}


/* ── Project view ────────────────────────────────────────────────────────── */
function ProjectView({ sessions, onConnect, onContextMenu, onMoveToProject, groupOrder, onGroupOrderChange }: Readonly<{
  sessions: Session[]
  onConnect: (s: Session) => void
  onContextMenu: (e: React.MouseEvent, s: Session) => void
  onMoveToProject: (session: Session, group: string) => void
  groupOrder: string[]
  onGroupOrderChange: (order: string[]) => void
}>) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [groupMenu, setGroupMenu] = useState<{ group: string; x: number; y: number } | null>(null)
  const groupColors = useAppStore(s => s.groupColors)
  const setGroupColor = useAppStore(s => s.setGroupColor)
  const sectionOrder = useAppStore(s => s.sectionOrder)
  const setSectionOrder = useAppStore(s => s.setSectionOrder)
  const setShowAddConnection = useAppStore(s => s.setShowAddConnection)
  const setPendingConnectionGroup = useAppStore(s => s.setPendingConnectionGroup)
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [dragOverItem, setDragOverItem] = useState<string | null>(null)
  const [reorderTarget, setReorderTarget] = useState<string | null>(null)
  const dragGroupSrc = useRef<string | null>(null)
  const dragItemSrc = useRef<Session | null>(null)

  const sessionGroup = (s: Session) => s.group ?? 'Ungrouped'

  const reorderWithinGroup = (group: string, items: Session[], srcId: string, dstId: string) => {
    if (srcId === dstId) return
    const order = items.map(i => i.id)
    const from = order.indexOf(srcId)
    const to = order.indexOf(dstId)
    if (from === -1 || to === -1) return
    order.splice(from, 1)
    order.splice(to, 0, srcId)
    setSectionOrder(`project:${group}`, order)
  }

  const newConnectionInGroup = (group: string) => {
    setPendingConnectionGroup(group === 'Ungrouped' ? null : group)
    setShowAddConnection(true)
    setGroupMenu(null)
  }

  const groups = sessions.reduce<Record<string, Session[]>>((acc, s) => {
    const g = s.group ?? 'Ungrouped'
    if (!acc[g]) acc[g] = []
    acc[g].push(s)
    return acc
  }, {})

  const allGroups = Object.keys(groups)

  useEffect(() => {
    // Sessions load async at startup — syncing against an empty list would
    // overwrite the saved order with nothing
    if (sessions.length === 0) return
    const existing = groupOrder.filter(g => allGroups.includes(g))
    const added = allGroups.filter(g => !groupOrder.includes(g))
    const next = [...existing, ...added]
    if (next.join(',') !== groupOrder.join(',')) onGroupOrderChange(next)
  }, [allGroups.join(',')])

  const orderedGroups = groupOrder.length > 0
    ? groupOrder.filter(g => groups[g]).map(g => [g, groups[g]] as [string, Session[]])
    : Object.entries(groups)

  if (orderedGroups.length === 0) {
    return (
      <div className="px-3 py-6 text-center">
        <p className="font-['Inter'] text-[11.5px]" style={{ color: 'var(--nox-text-3)' }}>No connections</p>
      </div>
    )
  }

  const toggle = (g: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(g)) next.delete(g); else next.add(g)
    return next
  })

  const reorderGroups = (src: string, dst: string) => {
    if (src === dst) return
    const next = [...groupOrder]
    const from = next.indexOf(src)
    const to = next.indexOf(dst)
    if (from === -1 || to === -1) return
    next.splice(from, 1)
    next.splice(to, 0, src)
    onGroupOrderChange(next)
  }

  return (
    <div className="mt-3">
      <div className="px-2 py-1.5">
        <span className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--nox-text-3)' }}>
          Projects
        </span>
      </div>

      {orderedGroups.map(([group, rawItems]) => {
        const isExpanded = expanded.has(group)
        const gColor = groupColor(group, groupColors)
        const isGroupTarget = dragOverGroup === group && dragGroupSrc.current !== group
        const isItemTarget = dragOverItem === group
        const items = applySavedOrder(rawItems, sectionOrder[`project:${group}`])

        return (
          <div
            key={group}
            className="mt-0.5"
            onDragOver={e => {
              e.preventDefault()
              // Group reorder: src is a group
              if (dragGroupSrc.current && dragGroupSrc.current !== group) setDragOverGroup(group)
              // Item drop from another project: src is a session
              if (dragItemSrc.current && sessionGroup(dragItemSrc.current) !== group) setDragOverItem(group)
            }}
            onDrop={e => {
              e.preventDefault()
              if (dragGroupSrc.current) { reorderGroups(dragGroupSrc.current, group); dragGroupSrc.current = null }
              if (dragItemSrc.current && sessionGroup(dragItemSrc.current) !== group) {
                onMoveToProject(dragItemSrc.current, group)
                dragItemSrc.current = null
              }
              setDragOverGroup(null)
              setDragOverItem(null)
            }}
            onDragLeave={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOverGroup(null)
                setDragOverItem(null)
              }
            }}
          >
            {/* Group header */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(group)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(group) } }}
              onContextMenu={e => {
                e.preventDefault()
                e.stopPropagation()
                setGroupMenu({ group, x: e.clientX, y: e.clientY })
              }}
              className="group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors"
              style={{
                background: isGroupTarget || isItemTarget ? 'var(--nox-hover)' : '',
                outline: isItemTarget ? '1px dashed var(--nox-active-t)' : 'none',
                borderRadius: 6,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { if (!isGroupTarget && !isItemTarget) (e.currentTarget as HTMLElement).style.background = '' }}
            >
              {/* Drag handle for group reorder */}
              <span
                draggable
                className="opacity-0 group-hover:opacity-60 flex-shrink-0 cursor-grab active:cursor-grabbing"
                style={{ color: 'var(--nox-text-3)' }}
                onDragStart={e => { e.stopPropagation(); dragGroupSrc.current = group }}
                onDragEnd={() => { dragGroupSrc.current = null; setDragOverGroup(null) }}
                onClick={e => e.stopPropagation()}
                onKeyDown={e => e.stopPropagation()}
              >
                <GripVertical className="w-3 h-3" />
              </span>
              <ChevronRight
                className="w-3 h-3 flex-shrink-0 transition-transform"
                style={{ color: 'var(--nox-text-3)', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
              />
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: gColor }} />
              <span className="font-['Inter'] text-[12px] font-medium flex-1 truncate" style={{ color: 'var(--nox-text)' }}>
                {group}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--nox-text-3)', background: 'var(--nox-border)' }}>
                {items.length}
              </span>
            </div>

            {isExpanded && (
              <div className="ml-5 mt-0.5 space-y-0.5">
                {items.map(s => (
                  <div
                    key={s.id}
                    draggable
                    onDragStart={e => { e.stopPropagation(); dragItemSrc.current = s }}
                    onDragEnd={() => { dragItemSrc.current = null; setDragOverItem(null); setReorderTarget(null) }}
                    onDragOver={e => {
                      // Same-project drag: reorder instead of move
                      if (dragItemSrc.current && sessionGroup(dragItemSrc.current) === group && dragItemSrc.current.id !== s.id) {
                        e.preventDefault()
                        e.stopPropagation()
                        setReorderTarget(s.id)
                      }
                    }}
                    onDrop={e => {
                      if (dragItemSrc.current && sessionGroup(dragItemSrc.current) === group) {
                        e.preventDefault()
                        e.stopPropagation()
                        reorderWithinGroup(group, items, dragItemSrc.current.id, s.id)
                        dragItemSrc.current = null
                      }
                      setReorderTarget(null)
                    }}
                    role="button"
                    tabIndex={0}
                    onClick={() => onConnect(s)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onConnect(s) } }}
                    onContextMenu={e => onContextMenu(e, s)}
                    className="flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer transition-colors"
                    style={{ outline: reorderTarget === s.id ? '1px dashed var(--nox-active-t)' : 'none' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
                  >
                    <ConnectionTypeIcon type={s.type} size={11} />
                    <span className="font-['Inter'] text-[11.5px] flex-1 truncate" style={{ color: 'var(--nox-text)' }}>
                      {s.label || s.host}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {groupMenu && (
        <GroupContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          group={groupMenu.group}
          current={groupColors[groupMenu.group]}
          onNewConnection={() => newConnectionInGroup(groupMenu.group)}
          onPick={color => { setGroupColor(groupMenu.group, color); setGroupMenu(null) }}
          onClose={() => setGroupMenu(null)}
        />
      )}
    </div>
  )
}

/* ── Project context menu ────────────────────────────────────────────────── */
function GroupContextMenu({ x, y, group, current, onNewConnection, onPick, onClose }: Readonly<{
  x: number
  y: number
  group: string
  current?: string
  onNewConnection: () => void
  onPick: (color: string | null) => void
  onClose: () => void
}>) {
  const { menuRef, pos } = useMenuBehavior(x, y, onClose)

  useEffect(() => {
    window.addEventListener('mousedown', onClose)
    return () => window.removeEventListener('mousedown', onClose)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] rounded-lg py-1.5 min-w-[192px]"
      style={{
        left: pos.x,
        top: pos.y,
        background: 'var(--nox-surface)',
        border: '1px solid var(--nox-border)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
      }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="px-3 pb-1.5 mb-1" style={{ borderBottom: '1px solid var(--nox-border)' }}>
        <span className="font-['Plus_Jakarta_Sans'] font-semibold text-[12px] truncate block" style={{ color: 'var(--nox-text)' }}>
          {group}
        </span>
      </div>

      <MenuItem
        icon={<Plus className="w-3.5 h-3.5" />}
        label={group === 'Ungrouped' ? 'New Connection in Ungrouped' : `New Connection in "${group}"`}
        onClick={onNewConnection}
      />

      <div className="px-3 pt-2 pb-1">
        <span className="font-['Plus_Jakarta_Sans'] text-[10px] uppercase tracking-wider font-semibold block mb-2" style={{ color: 'var(--nox-text-3)' }}>
          Project color
        </span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {COLORS.map(c => (
            <button
              key={c}
              onClick={() => onPick(c)}
              title={c}
              className="w-5 h-5 rounded-full transition-transform hover:scale-110"
              style={{
                background: c,
                outline: current === c ? '2px solid var(--nox-text)' : 'none',
                outlineOffset: 1,
              }}
            />
          ))}
        </div>
        <button
          onClick={() => onPick(null)}
          disabled={!current}
          className="mt-2.5 w-full text-left font-['Inter'] text-[11.5px] transition-colors disabled:opacity-40"
          style={{ color: 'var(--nox-text-2)' }}
          onMouseEnter={e => { if (current) e.currentTarget.style.color = 'var(--nox-text)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--nox-text-2)' }}
        >
          Reset to automatic
        </button>
      </div>
    </div>
  )
}

/* ── Connection type icon ────────────────────────────────────────────────── */
function ConnectionTypeIcon({ type, size = 12 }: Readonly<{ type?: string; size?: number }>) {
  const color = 'var(--nox-text-3)'
  switch (type) {
    case 'sftp': return <FolderOpen size={size} style={{ color }} className="flex-shrink-0" />
    case 'database': return <Database size={size} style={{ color }} className="flex-shrink-0" />
    case 'kubernetes': return <K8sIcon size={size} color="var(--nox-text-3)" className="flex-shrink-0" />
    case 'redis': return <Layers size={size} style={{ color }} className="flex-shrink-0" />
    case 'rdp': return <Monitor size={size} style={{ color }} className="flex-shrink-0" />
    default: return <Terminal size={size} style={{ color }} className="flex-shrink-0" />
  }
}

function EmptyAreaMenu({ x, y, onNewConnection, onClose }: Readonly<{
  x: number; y: number; onNewConnection: () => void; onClose: () => void
}>) {
  const { menuRef, pos } = useMenuBehavior(x, y, onClose)

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] rounded-lg py-1.5 min-w-[170px]"
      style={{
        left: pos.x,
        top: pos.y,
        background: 'var(--nox-surface)',
        border: '1px solid var(--nox-border)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
      }}
      onMouseDown={e => e.stopPropagation()}
    >
      <MenuItem icon={<Plus className="w-3.5 h-3.5" />} label="New Connection" onClick={onNewConnection} />
    </div>
  )
}
