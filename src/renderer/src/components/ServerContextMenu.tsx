import { useState, useRef, useEffect } from 'react'
import {
  Settings, Pencil, Boxes, Monitor, Heart, FolderInput, Plus, ChevronRight, Palette, Trash2,
} from 'lucide-react'
import { useAppStore, Session, groupColor } from '../store'

export const COLORS = ['#3B5CCC', '#8B5CF6', '#10B981', '#F59E0B', '#EC4899', '#EF4444', '#DC382D', '#06B6D4']

// Positions a fixed context menu inside the viewport and closes it on Escape.
// Shared by every right-click menu (sidebar + dashboard) so behaviour stays consistent.
export function useMenuBehavior(x: number, y: number, onClose: () => void) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      setPos({
        x: x + rect.width > vw ? x - rect.width : x,
        y: y + rect.height > vh ? y - rect.height : y,
      })
    }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return { menuRef, pos }
}

export function MenuItem({ icon, label, onClick, danger, hasSubmenu }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; hasSubmenu?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors"
      style={{ color: danger ? '#EF4444' : 'var(--nox-text)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
    >
      <span style={{ color: danger ? '#EF4444' : 'var(--nox-text-2)' }}>{icon}</span>
      <span className="font-['Inter'] text-[12px] flex-1">{label}</span>
      {hasSubmenu && <ChevronRight className="w-3 h-3 ml-auto" style={{ color: 'var(--nox-text-3)' }} />}
    </button>
  )
}

export function ServerContextMenu({ x, y, session, allGroups, onEdit, onRename, onColorChange, onFavorite, onMoveToProject, onDelete, onClose, onOpenDocker, onOpenRdp }: {
  x: number; y: number; session: Session
  allGroups: string[]
  onEdit: () => void
  onRename: () => void
  onColorChange: (c: string) => void
  onFavorite: () => void
  onMoveToProject: (group: string) => void
  onDelete: () => void
  onClose: () => void
  onOpenDocker?: () => void
  onOpenRdp?: () => void
}) {
  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const groupColors = useAppStore(s => s.groupColors)
  const [newProjectName, setNewProjectName] = useState('')
  const [creatingNew, setCreatingNew] = useState(false)
  const { menuRef, pos } = useMenuBehavior(x, y, onClose)

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] rounded-lg py-1.5 min-w-[180px]"
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
          {session.label || session.host}
        </span>
        <span className="font-['Inter'] text-[10.5px]" style={{ color: 'var(--nox-text-3)' }}>
          {session.host}:{session.port}
        </span>
      </div>

      <MenuItem icon={<Settings className="w-3.5 h-3.5" />} label="Edit Connection" onClick={onEdit} />
      <MenuItem icon={<Pencil className="w-3.5 h-3.5" />} label="Rename" onClick={onRename} />
      {onOpenDocker && (
        <MenuItem icon={<Boxes className="w-3.5 h-3.5" />} label="Docker Dashboard" onClick={onOpenDocker} />
      )}
      {onOpenRdp && (
        <MenuItem icon={<Monitor className="w-3.5 h-3.5" />} label="Open Remote Desktop" onClick={onOpenRdp} />
      )}
      <MenuItem
        icon={<Heart className="w-3.5 h-3.5" />}
        label={session.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
        onClick={onFavorite}
      />

      {/* Move to Project */}
      <div className="relative">
        <MenuItem
          icon={<FolderInput className="w-3.5 h-3.5" />}
          label="Move to Project"
          onClick={() => setShowMoveMenu(m => !m)}
          hasSubmenu
        />
        {showMoveMenu && (
          <div
            className="absolute left-full top-0 ml-1 rounded-lg py-1.5 min-w-[160px] z-10"
            style={{ background: 'var(--nox-surface)', border: '1px solid var(--nox-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}
            onMouseDown={e => e.stopPropagation()}
          >
            {allGroups.filter(g => g !== session.group).map(g => (
              <button
                key={g}
                onClick={() => onMoveToProject(g)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                style={{ color: 'var(--nox-text)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
              >
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: groupColor(g, groupColors) }} />
                <span className="font-['Inter'] text-[12px] truncate">{g}</span>
              </button>
            ))}
            {creatingNew ? (
              <div className="px-3 py-1.5">
                <input
                  autoFocus
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newProjectName.trim()) { onMoveToProject(newProjectName.trim()); setCreatingNew(false) }
                    if (e.key === 'Escape') { setCreatingNew(false); setNewProjectName('') }
                  }}
                  placeholder="Project name…"
                  className="w-full px-2 py-1 rounded text-[12px] font-['Inter'] focus:outline-none"
                  style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-active-t)', color: 'var(--nox-text)' }}
                />
              </div>
            ) : (
              <button
                onClick={() => setCreatingNew(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                style={{ color: 'var(--nox-text-2)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
              >
                <Plus className="w-3 h-3" />
                <span className="font-['Inter'] text-[12px]">New project…</span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="px-3 py-1.5" style={{ borderTop: '1px solid var(--nox-border)', borderBottom: '1px solid var(--nox-border)', marginTop: 4, marginBottom: 4 }}>
        <div className="flex items-center gap-1.5 mb-2">
          <Palette className="w-3 h-3" style={{ color: 'var(--nox-text-3)' }} />
          <span className="font-['Inter'] text-[11px]" style={{ color: 'var(--nox-text-2)' }}>Color</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {COLORS.map(c => (
            <button
              key={c}
              onClick={() => onColorChange(c)}
              className="w-5 h-5 rounded-full transition-transform hover:scale-110"
              style={{
                background: c,
                border: session.color === c ? '2px solid var(--nox-text)' : '2px solid transparent',
              }}
            />
          ))}
        </div>
      </div>

      <MenuItem icon={<Trash2 className="w-3.5 h-3.5" />} label="Delete" onClick={onDelete} danger />
    </div>
  )
}
