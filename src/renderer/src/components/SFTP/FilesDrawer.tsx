import { useState, useEffect, useRef, useCallback } from 'react'
import { Tab, useAppStore } from '../../store'
import { formatFileSize, ipcErrorMessage, joinPath } from '../../lib/format'
import { connectSftp } from '../../lib/sftpConnect'
import {
  IconFolder, IconFile, IconX, IconArrowUp, IconRefresh,
  IconDownload, IconAlert, IconEdit, IconChevronRight,
  IconTrash, IconRename,
} from '../Icons'

interface SftpEntry {
  name: string
  size: number
  mtime: number
  isDirectory: boolean
}

interface Props {
  tab: Tab
  onClose: () => void
}

export default function FilesDrawer({ tab, onClose }: Props) {
  const sessions = useAppStore((s) => s.sessions)
  const addNotification = useAppStore((s) => s.addNotification)
  const openEditorTab = useAppStore((s) => s.openEditorTab)
  const session = sessions.find((s) => s.id === tab.sessionId)

  const [clientId, setClientId] = useState<string | null>(null)
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [pathEditing, setPathEditing] = useState(false)
  const [pathDraft, setPathDraft] = useState('/')
  const pathInputRef = useRef<HTMLInputElement>(null)
  const clientRef = useRef<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const connect = useCallback(async () => {
    if (!session) return
    setConnecting(true)
    setError(null)
    try {
      const id = await connectSftp(session, tab.streamId)
      setClientId(id)
      clientRef.current = id
      setConnecting(false)
      listDir(id, '/')
    } catch (err: any) {
      setError(ipcErrorMessage(err, 'SFTP connection failed'))
      setConnecting(false)
    }
  }, [session, tab.streamId])

  useEffect(() => {
    connect()
    return () => {
      if (clientRef.current) {
        window.api.sftp.disconnect(clientRef.current).catch((err: any) => {
          // Best-effort: main may have already cleaned up on window close.
          console.error('[sftp] files drawer disconnect failed:', err?.message ?? err)
        })
      }
    }
  }, [])

  async function listDir(id: string, dir: string) {
    setLoading(true)
    setError(null)
    try {
      const result: SftpEntry[] = await window.api.sftp.list(id, dir)
      setEntries([...result].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      }))
      setPath(dir)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to read directory')
    } finally {
      setLoading(false)
    }
  }

  function openFile(entry: SftpEntry) {
    if (!session || entry.isDirectory) return
    openEditorTab({ path: joinPath(path, entry.name), source: 'remote', session, streamId: tab.streamId })
  }

  async function downloadFile(entry: SftpEntry) {
    if (!clientId || entry.isDirectory) return
    const remotePath = joinPath(path, entry.name)
    showToast(`Downloading ${entry.name}…`)
    try {
      await window.api.sftp.download(clientId, remotePath, `~/Downloads/${entry.name}`)
      showToast(`Saved to ~/Downloads/${entry.name}`)
      notifyTransfer(`Download complete: ${entry.name}`, 'success')
    } catch (err: any) {
      showToast(`Failed: ${ipcErrorMessage(err)}`)
      notifyTransfer(`Download failed: ${entry.name} — ${ipcErrorMessage(err)}`, 'error')
    }
  }

  function notifyTransfer(message: string, type: 'success' | 'error') {
    window.api.settings.get().then((cfg: { transferAlerts?: unknown }) => {
      if (cfg.transferAlerts === true) addNotification({ type, message })
    }).catch((err: any) => {
      console.error('[notify] settings read failed:', err?.message ?? err)
    })
  }

  async function deleteFile(entry: SftpEntry) {
    if (!clientId) return
    const remotePath = joinPath(path, entry.name)
    if (!confirm(`Delete "${entry.name}"? This cannot be undone.`)) return
    try {
      await window.api.sftp.delete(clientId, remotePath)
      showToast(`Deleted ${entry.name}`)
      listDir(clientId, path)
    } catch (err: any) {
      showToast(`Delete failed: ${ipcErrorMessage(err)}`)
    }
  }

  async function renameFile(entry: SftpEntry) {
    if (!clientId) return
    const newName = prompt('Rename to:', entry.name)
    if (!newName || newName === entry.name) return
    const oldPath = joinPath(path, entry.name)
    const newPath = joinPath(path, newName)
    try {
      await window.api.sftp.rename(clientId, oldPath, newPath)
      showToast(`Renamed to ${newName}`)
      listDir(clientId, path)
    } catch (err: any) {
      showToast(`Rename failed: ${ipcErrorMessage(err)}`)
    }
  }

  function navigateUp() {
    if (!clientId || path === '/') return
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    listDir(clientId, parts.length === 0 ? '/' : `/${parts.join('/')}`)
  }

  function navigateToSegment(idx: number) {
    if (!clientId) return
    const parts = path.split('/').filter(Boolean)
    const target = idx < 0 ? '/' : `/${parts.slice(0, idx + 1).join('/')}`
    listDir(clientId, target)
  }

  function startPathEdit() {
    setPathDraft(path)
    setPathEditing(true)
    setTimeout(() => pathInputRef.current?.select(), 0)
  }

  function commitPathEdit() {
    if (!clientId) return
    setPathEditing(false)
    const trimmed = pathDraft.trim() || '/'
    listDir(clientId, trimmed)
  }

  const segments = path === '/' ? [] : path.split('/').filter(Boolean)

  return (
    <div
      className="flex-shrink-0 flex flex-col h-full animate-slide-in-right"
      style={{
        width: 300,
        background: 'var(--nox-sidebar)',
        borderLeft: '1px solid var(--nox-border)',
      }}
    >
      {/* Panel header */}
      <div
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{
          height: 38,
          borderBottom: '1px solid var(--nox-border)',
          background: 'var(--nox-shell)',
        }}
      >
        <IconFolder size={12} style={{ color: 'var(--nox-text-3)', flexShrink: 0 }} />

        {/* Breadcrumb / path editor */}
        <div className="flex-1 min-w-0">
          {pathEditing ? (
            <input
              ref={pathInputRef}
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onBlur={commitPathEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPathEdit()
                if (e.key === 'Escape') setPathEditing(false)
              }}
              className="w-full text-xs font-mono focus:outline-none rounded px-1.5 py-0.5"
              style={{
                background: 'var(--nox-active)',
                border: '1px solid var(--nox-active-t)',
                color: 'var(--nox-text)',
              }}
              autoFocus
            />
          ) : (
            <button
              onClick={startPathEdit}
              className="flex items-center gap-0 max-w-full"
              title="Click to type a path"
            >
              <Breadcrumb segments={segments} onNavigate={navigateToSegment} />
            </button>
          )}
        </div>

        {/* Header actions */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {clientId && (
            <HeaderButton
              title="Refresh"
              onClick={() => clientId && listDir(clientId, path)}
            >
              <IconRefresh size={11} className={loading ? 'animate-spin' : ''} />
            </HeaderButton>
          )}
          <HeaderButton title="Close files panel" onClick={onClose}>
            <IconX size={11} />
          </HeaderButton>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {connecting && <ConnectingState host={session?.host} />}
        {!connecting && error && <ErrorState message={error} onRetry={connect} />}

        {!connecting && !error && (
          <div
            className="flex-1 overflow-y-auto"
            style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--nox-border) transparent' }}
          >
            {/* Column header */}
            {entries.length > 0 && (
              <div
                className="flex items-center gap-2 px-4 py-1.5 flex-shrink-0 sticky top-0"
                style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-sidebar)' }}
              >
                <span
                  className="flex-1 text-2xs font-semibold uppercase tracking-widest"
                  style={{ color: 'var(--nox-text-3)', letterSpacing: '0.08em' }}
                >
                  Name
                </span>
                <span
                  className="w-16 text-right text-2xs font-semibold uppercase tracking-widest"
                  style={{ color: 'var(--nox-text-3)', letterSpacing: '0.08em' }}
                >
                  Size
                </span>
              </div>
            )}

            {/* Go up row */}
            {path !== '/' && !pathEditing && (
              <button
                onClick={navigateUp}
                className="w-full flex items-center gap-2.5 px-4 py-2 transition-colors text-left"
                style={{ borderBottom: '1px solid var(--nox-border)', color: 'var(--nox-text-3)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}
              >
                <IconArrowUp size={10} style={{ flexShrink: 0 }} />
                <span className="text-2xs font-mono">..</span>
              </button>
            )}

            {entries.length === 0 && !loading && <EmptyDir />}

            {entries.map((entry) => (
              <FileRow
                key={entry.name}
                entry={entry}
                onNavigate={() => clientId && listDir(clientId, joinPath(path, entry.name))}
                onOpen={() => openFile(entry)}
                onDownload={() => downloadFile(entry)}
                onDelete={() => deleteFile(entry)}
                onRename={() => renameFile(entry)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        className="flex items-center px-3 py-2 flex-shrink-0"
        style={{ borderTop: '1px solid var(--nox-border)', minHeight: 32, background: 'var(--nox-shell)' }}
      >
        {toast && <p className="text-2xs break-words line-clamp-2" style={{ color: '#3B5CCC' }}>{toast}</p>}
        {!toast && !connecting && !error && (
          <span className="text-2xs font-mono truncate" style={{ color: 'var(--nox-text-3)' }}>
            {entries.length} item{entries.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  )
}

/* ── Breadcrumb ───────────────────────────────────────────────────────────── */
function Breadcrumb({ segments, onNavigate }: Readonly<{
  segments: string[]
  onNavigate: (idx: number) => void
}>) {
  if (segments.length === 0) {
    return (
      <span className="text-2xs font-mono" style={{ color: 'var(--nox-text-3)' }}>/</span>
    )
  }

  return (
    <span className="flex items-center gap-0 text-2xs font-mono min-w-0">
      <button
        onClick={(e) => { e.stopPropagation(); onNavigate(-1) }}
        className="transition-colors flex-shrink-0"
        style={{ color: 'var(--nox-text-3)' }}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#3B5CCC' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--nox-text-3)' }}
      >
        /
      </button>
      {segments.map((seg, i) => (
        <span key={i} className="flex items-center gap-0 min-w-0">
          {i < segments.length - 1 ? (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onNavigate(i) }}
                className="truncate max-w-[60px] transition-colors"
                style={{ color: 'var(--nox-text-2)' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#3B5CCC' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--nox-text-2)' }}
              >
                {seg}
              </button>
              <IconChevronRight size={8} style={{ color: 'var(--nox-text-3)', flexShrink: 0 }} />
            </>
          ) : (
            <span className="truncate font-medium" style={{ color: 'var(--nox-text)', maxWidth: 100 }}>
              {seg}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}

/* ── Header button ────────────────────────────────────────────────────────── */
function HeaderButton({ title, onClick, children }: Readonly<{
  title: string
  onClick: () => void
  children: React.ReactNode
}>) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-6 h-6 flex items-center justify-center rounded transition-colors"
      style={{ color: 'var(--nox-text-3)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--nox-text)'
        e.currentTarget.style.background = 'var(--nox-hover)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'var(--nox-text-3)'
        e.currentTarget.style.background = ''
      }}
    >
      {children}
    </button>
  )
}

/* ── File row ─────────────────────────────────────────────────────────────── */
function FileRow({ entry, onNavigate, onOpen, onDownload, onDelete, onRename }: Readonly<{
  entry: SftpEntry
  onNavigate: () => void
  onOpen: () => void
  onDownload: () => void
  onDelete: () => void
  onRename: () => void
}>) {
  const isDir = entry.isDirectory

  return (
    <div
      onDoubleClick={isDir ? onNavigate : onOpen}
      className="group flex items-center gap-2.5 px-4 py-[5px] cursor-default transition-colors"
      style={{ borderBottom: '1px solid var(--nox-border)' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}
    >
      {/* Icon */}
      <span className="flex-shrink-0" style={{ color: isDir ? '#8B5CF6' : 'var(--nox-text-3)' }}>
        {isDir ? <IconFolder size={12} /> : <IconFile size={12} />}
      </span>

      {/* Name */}
      <span
        className="flex-1 min-w-0 text-2xs font-mono truncate"
        style={{ color: isDir ? 'var(--nox-text)' : 'var(--nox-text-2)' }}
      >
        {entry.name}
        {isDir && <span style={{ color: 'var(--nox-text-3)' }}>/</span>}
      </span>

      {/* Size */}
      <span
        className="w-16 text-right text-2xs font-mono flex-shrink-0"
        style={{ color: 'var(--nox-text-3)' }}
      >
        {isDir ? '' : formatFileSize(entry.size)}
      </span>

      {/* Hover actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        {isDir ? (
          <>
            <RowButton onClick={onNavigate} title="Open">
              <IconChevronRight size={10} />
            </RowButton>
            <RowButton onClick={onRename} title="Rename">
              <IconRename size={10} />
            </RowButton>
          </>
        ) : (
          <>
            <RowButton onClick={onOpen} title="Edit file">
              <IconEdit size={10} />
            </RowButton>
            <RowButton onClick={onDownload} title="Download">
              <IconDownload size={10} />
            </RowButton>
            <RowButton onClick={onRename} title="Rename">
              <IconRename size={10} />
            </RowButton>
            <RowButton onClick={onDelete} title="Delete">
              <IconTrash size={10} />
            </RowButton>
          </>
        )}
      </div>
    </div>
  )
}

function RowButton({ onClick, title, children }: Readonly<{
  onClick: () => void; title: string; children: React.ReactNode
}>) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className="w-5 h-5 flex items-center justify-center rounded transition-colors"
      style={{ color: 'var(--nox-text-3)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = '#3B5CCC'
        e.currentTarget.style.background = 'var(--nox-active)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'var(--nox-text-3)'
        e.currentTarget.style.background = ''
      }}
    >
      {children}
    </button>
  )
}

/* ── State components ─────────────────────────────────────────────────────── */
function ConnectingState({ host }: Readonly<{ host?: string }>) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6">
      <div className="relative w-6 h-6">
        <span className="absolute inset-0 rounded-full" style={{ border: '1px solid var(--nox-border)' }} />
        <span
          className="absolute inset-0 rounded-full border-t-transparent animate-spin"
          style={{ border: '1px solid #3B5CCC', borderTopColor: 'transparent' }}
        />
      </div>
      <div className="text-center">
        <p className="text-xs" style={{ color: 'var(--nox-text-2)' }}>Connecting</p>
        {host && <p className="text-2xs font-mono mt-0.5" style={{ color: 'var(--nox-text-3)' }}>{host}</p>}
      </div>
    </div>
  )
}

function ErrorState({ message, onRetry }: Readonly<{ message: string; onRetry: () => void }>) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-3 px-5 text-center">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center"
        style={{ border: '1px solid #EF444440', background: '#EF444415', color: '#EF4444' }}
      >
        <IconAlert size={14} />
      </div>
      <p className="text-2xs leading-relaxed" style={{ color: 'var(--nox-text-2)' }}>{message}</p>
      <p className="text-2xs leading-relaxed" style={{ color: 'var(--nox-text-3)' }}>
        The SSH terminal can stay connected even if this separate SFTP channel fails.
      </p>
      <button
        onClick={onRetry}
        className="flex items-center gap-1.5 px-3 py-1.5 text-2xs font-medium rounded-lg transition-colors"
        style={{
          color: 'var(--nox-text-2)',
          background: 'var(--nox-hover)',
          border: '1px solid var(--nox-border)',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-active)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--nox-hover)' }}
      >
        <IconRefresh size={10} />
        Retry
      </button>
    </div>
  )
}

function EmptyDir() {
  return (
    <div className="flex items-center justify-center py-12">
      <p className="text-2xs" style={{ color: 'var(--nox-text-3)' }}>Empty directory</p>
    </div>
  )
}
