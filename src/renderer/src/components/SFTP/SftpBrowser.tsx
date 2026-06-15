import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore, Tab } from '../../store'
import { formatDate, formatFileSize, ipcErrorMessage, joinPath } from '../../lib/format'
import { connectSftp } from '../../lib/sftpConnect'
import {
  FolderOpen, File, ChevronUp, RefreshCw,
  FolderPlus, Trash2, Pencil, Eye, EyeOff,
  ArrowUpDown, ArrowRight, ArrowLeft, X, Check,
  AlertTriangle, Loader2, HardDrive, Server, GitCompare,
} from 'lucide-react'

interface FileEntry { name: string; size: number; mtime: number; permissions: number; isDirectory: boolean; path?: string }
type SortKey = 'name' | 'size' | 'mtime'
type SortDir = 'asc' | 'desc'
type Side = 'local' | 'remote'
interface PaneState { path: string; entries: FileEntry[]; loading: boolean; selected: Set<string>; sortKey: SortKey; sortDir: SortDir; showHidden: boolean; error: string | null }
interface Transfer { id: number; name: string; direction: 'up' | 'down'; status: 'active' | 'done' | 'error'; error?: string }

const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD HH:mm'

const INIT: PaneState = { path: '/', entries: [], loading: false, selected: new Set(), sortKey: 'name', sortDir: 'asc', showHidden: false, error: null }
let xferId = 0

export default function SftpBrowser({ tab }: { tab: Tab }) {
  const sessions = useAppStore(s => s.sessions)
  const updateTab = useAppStore(s => s.updateTab)
  const addNotification = useAppStore(s => s.addNotification)
  const openEditorTab = useAppStore(s => s.openEditorTab)
  const session = sessions.find(s => s.id === tab.sessionId)

  const [clientId, setClientId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(true)
  const [connError, setConnError] = useState<string | null>(null)
  const [local, setLocal] = useState<PaneState>(INIT)
  const [remote, setRemote] = useState<PaneState>(INIT)
  const [focusedPane, setFocusedPane] = useState<Side>('remote')
  const [splitPct, setSplitPct] = useState(50)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [quickLook, setQuickLook] = useState<{ name: string; content: string; size: number } | null>(null)
  const [quickLookLoading, setQuickLookLoading] = useState(false)
  const [diffMode, setDiffMode] = useState(false)
  const [dateFormat, setDateFormat] = useState(DEFAULT_DATE_FORMAT)

  useEffect(() => {
    const load = () => {
      window.api.settings.get().then((cfg: { dateFormat?: unknown }) => {
        setDateFormat(typeof cfg.dateFormat === 'string' ? cfg.dateFormat : DEFAULT_DATE_FORMAT)
      }).catch((err: any) => {
        console.error('[sftp] settings read failed:', err?.message ?? err)
      })
    }
    load()
    window.addEventListener('noxed:settings-changed', load)
    return () => window.removeEventListener('noxed:settings-changed', load)
  }, [])

  const clientRef = useRef<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const uL = (u: Partial<PaneState>) => setLocal(p => ({ ...p, ...u }))
  const uR = (u: Partial<PaneState>) => setRemote(p => ({ ...p, ...u }))
  const uP = (s: Side, u: Partial<PaneState>) => s === 'local' ? uL(u) : uR(u)
  const gP = (s: Side) => s === 'local' ? local : remote

  // Diff: compare local vs remote by name+size
  const diffMap = (() => {
    if (!diffMode) return null
    const localNames = new Map(local.entries.map(e => [e.name, e]))
    const remoteNames = new Map(remote.entries.map(e => [e.name, e]))
    const result = new Map<string, 'local-only' | 'remote-only' | 'different' | 'same'>()
    for (const [name, le] of localNames) {
      const re = remoteNames.get(name)
      if (!re) result.set(name, 'local-only')
      else if (le.size !== re.size) result.set(name, 'different')
      else result.set(name, 'same')
    }
    for (const name of remoteNames.keys()) {
      if (!localNames.has(name)) result.set(name, 'remote-only')
    }
    return result
  })()

  const addTransfer = (name: string, dir: 'up' | 'down'): number => {
    const id = ++xferId
    setTransfers(t => [{ id, name, direction: dir, status: 'active' }, ...t])
    return id
  }
  const finishTransfer = (id: number, name: string, direction: 'up' | 'down', error?: string) => {
    setTransfers(t => t.map(x => x.id === id ? { ...x, status: error ? 'error' : 'done', error } : x))
    setTimeout(() => setTransfers(t => t.filter(x => x.id !== id)), error ? 5000 : 2000)
    window.api.settings.get().then((cfg: { transferAlerts?: unknown }) => {
      if (cfg.transferAlerts !== true) return
      const verb = direction === 'up' ? 'Upload' : 'Download'
      addNotification(error
        ? { type: 'error', message: `${verb} failed: ${name} — ${error}` }
        : { type: 'success', message: `${verb} complete: ${name}` })
    }).catch((err: any) => {
      console.error('[notify] settings read failed:', err?.message ?? err)
    })
  }

  const connect = useCallback(async () => {
    if (!session) return
    setConnecting(true); setConnError(null)
    try {
      const id = await connectSftp(session, tab.streamId)
      setClientId(id); clientRef.current = id
      updateTab(tab.id, { status: 'connected' }); setConnecting(false)
      loadRemote(id, '/'); loadLocal(undefined)
    } catch (err: any) {
      setConnError(ipcErrorMessage(err, 'SFTP connection failed'))
      updateTab(tab.id, { status: 'error', errorMessage: err?.message }); setConnecting(false)
    }
  }, [session])

  useEffect(() => {
    connect()
    return () => {
      if (clientRef.current) {
        window.api.sftp.disconnect(clientRef.current).catch((err: any) => {
          // Best-effort: main may have already cleaned up on window close.
          console.error('[sftp] disconnect on unmount failed:', err?.message ?? err)
        })
      }
    }
  }, [])

  async function loadLocal(dir?: string) {
    const path = dir ?? await window.api.localfs.home()
    uL({ loading: true, error: null, selected: new Set() })
    try { uL({ entries: await window.api.localfs.list(path), path, loading: false }) }
    catch (err: any) { uL({ error: err?.message, loading: false }) }
  }

  async function loadRemote(id: string, dir: string) {
    uR({ loading: true, error: null, selected: new Set() })
    try { uR({ entries: await window.api.sftp.list(id, dir), path: dir, loading: false }) }
    catch (err: any) { uR({ error: err?.message, loading: false }) }
  }

  function sorted(p: PaneState): FileEntry[] {
    return p.entries.filter(e => p.showHidden || !e.name.startsWith('.')).sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      let c = p.sortKey === 'name' ? a.name.localeCompare(b.name) : p.sortKey === 'size' ? a.size - b.size : a.mtime - b.mtime
      return p.sortDir === 'asc' ? c : -c
    })
  }

  function toggleSort(s: Side, k: SortKey) { const p = gP(s); p.sortKey === k ? uP(s, { sortDir: p.sortDir === 'asc' ? 'desc' : 'asc' }) : uP(s, { sortKey: k, sortDir: 'asc' }) }

  function handleSelect(s: Side, name: string, e: React.MouseEvent) {
    const p = gP(s), vis = sorted(p)
    if (e.shiftKey && p.selected.size > 0) {
      const ns = vis.map(x => x.name), last = [...p.selected].pop()!, a = ns.indexOf(last), b = ns.indexOf(name)
      uP(s, { selected: new Set([...p.selected, ...ns.slice(Math.min(a, b), Math.max(a, b) + 1)]) })
    } else if (e.metaKey || e.ctrlKey) { const n = new Set(p.selected); n.has(name) ? n.delete(name) : n.add(name); uP(s, { selected: n }) }
    else uP(s, { selected: new Set([name]) })
  }

  function navUp(s: Side) { const parts = gP(s).path.split('/').filter(Boolean); parts.pop(); const np = parts.length ? `/${parts.join('/')}` : '/'; s === 'local' ? loadLocal(np) : clientId && loadRemote(clientId, np) }
  function navInto(s: Side, e: FileEntry) { if (!e.isDirectory) return; s === 'local' ? loadLocal(e.path || joinPath(local.path, e.name)) : clientId && loadRemote(clientId, joinPath(remote.path, e.name)) }

  async function doUpload(files: FileEntry[]) {
    if (!clientId) return
    for (const f of files) {
      if (f.isDirectory) continue
      const tid = addTransfer(f.name, 'up')
      try { await window.api.sftp.upload(clientId, f.path || joinPath(local.path, f.name), joinPath(remote.path, f.name)); finishTransfer(tid, f.name, 'up') }
      catch (err: any) { finishTransfer(tid, f.name, 'up', err?.message) }
    }
    loadRemote(clientId, remote.path)
  }

  async function doDownload(files: FileEntry[]) {
    if (!clientId) return
    for (const f of files) {
      if (f.isDirectory) continue
      const tid = addTransfer(f.name, 'down')
      try { await window.api.sftp.download(clientId, joinPath(remote.path, f.name), joinPath(local.path, f.name)); finishTransfer(tid, f.name, 'down') }
      catch (err: any) { finishTransfer(tid, f.name, 'down', err?.message) }
    }
    loadLocal(local.path)
  }

  async function handleMkdir(s: Side) {
    const name = prompt('New folder name:')
    if (!name) return
    if (s === 'remote' && clientId) {
      try {
        await window.api.sftp.mkdir(clientId, joinPath(remote.path, name))
        loadRemote(clientId, remote.path)
      } catch (err: any) {
        uR({ error: err?.message ?? 'Failed to create folder' })
      }
    }
  }

  async function handleDelete(entries: FileEntry[]) {
    if (!clientId || !confirm(`Delete ${entries.length} item${entries.length > 1 ? 's' : ''}?`)) return
    const failures: string[] = []
    for (const e of entries) {
      try {
        const p = joinPath(remote.path, e.name)
        if (e.isDirectory) await window.api.sftp.rmdir(clientId, p)
        else await window.api.sftp.delete(clientId, p)
      } catch (err: any) {
        failures.push(`${e.name}: ${err?.message ?? 'failed'}`)
      }
    }
    if (failures.length) uR({ error: `Could not delete ${failures.length} item(s): ${failures[0]}` })
    loadRemote(clientId, remote.path)
  }

  async function handleRename(entry: FileEntry) {
    if (!clientId) return
    const n = prompt('Rename to:', entry.name)
    if (!n || n === entry.name) return
    try {
      await window.api.sftp.rename(clientId, joinPath(remote.path, entry.name), joinPath(remote.path, n))
      loadRemote(clientId, remote.path)
    } catch (err: any) {
      uR({ error: err?.message ?? 'Rename failed' })
    }
  }

  function openFile(entry: FileEntry) {
    if (!session || entry.isDirectory) return
    openEditorTab({ path: joinPath(remote.path, entry.name), source: 'remote', session, streamId: tab.streamId })
  }

  function openLocalFile(entry: FileEntry) {
    if (entry.isDirectory) return
    openEditorTab({ path: entry.path || joinPath(local.path, entry.name), source: 'local' })
  }

  // Quick Look: spacebar on selected file
  async function triggerQuickLook() {
    const pane = gP(focusedPane)
    const selName = [...pane.selected][0]
    if (!selName) return
    const entry = pane.entries.find(e => e.name === selName)
    if (!entry || entry.isDirectory) return
    if (quickLook?.name === entry.name) { setQuickLook(null); return }
    setQuickLookLoading(true)
    try {
      if (focusedPane === 'remote' && clientId) {
        const content = await window.api.sftp.readFile(clientId, joinPath(remote.path, entry.name))
        setQuickLook({ name: entry.name, content, size: entry.size })
      } else if (focusedPane === 'local') {
        const content = await window.api.localfs.readTextFile(entry.path || joinPath(local.path, entry.name))
        setQuickLook({ name: entry.name, content, size: entry.size })
      }
    } catch { setQuickLook({ name: entry.name, content: '(binary or unreadable file)', size: entry.size }) }
    finally { setQuickLookLoading(false) }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === ' ' && e.target === document.body) { e.preventDefault(); triggerQuickLook() }
      if (e.key === 'Escape' && quickLook) setQuickLook(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focusedPane, local.selected, remote.selected, local.path, remote.path, quickLook, clientId])

  function onDragStart(s: Side, entry: FileEntry, e: React.DragEvent) { e.dataTransfer.setData('application/json', JSON.stringify({ side: s, entries: [entry] })); e.dataTransfer.effectAllowed = 'copy' }

  function onPaneDrop(target: Side, e: React.DragEvent) {
    e.preventDefault()
    try { const d = JSON.parse(e.dataTransfer.getData('application/json')); if (d.side === 'local' && target === 'remote') doUpload(d.entries); else if (d.side === 'remote' && target === 'local') doDownload(d.entries) }
    catch { if (target === 'remote' && clientId && e.dataTransfer.files.length) { const files = Array.from(e.dataTransfer.files).map(f => ({ name: f.name, size: f.size, mtime: 0, permissions: 0, isDirectory: false, path: f.path })); doUpload(files) } }
  }

  // Draggable divider
  function startDividerDrag(e: React.MouseEvent) {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const onMove = (ev: MouseEvent) => { const pct = ((ev.clientX - rect.left) / rect.width) * 100; setSplitPct(Math.max(20, Math.min(80, pct))) }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }

  if (connecting) return <div className="flex items-center justify-center h-full" style={{ background: 'var(--nox-bg)' }}><Loader2 className="w-5 h-5 animate-spin" style={{ color: '#3B5CCC' }} /></div>
  if (connError && !clientId) return <div className="flex items-center justify-center h-full" style={{ background: 'var(--nox-bg)' }}><div className="text-center max-w-sm"><AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: '#EF4444' }} /><p className="text-[11px] mb-3" style={{ color: 'var(--nox-text-2)' }}>{connError}</p><button onClick={connect} className="px-3 py-1 rounded text-[11px] text-white" style={{ background: '#3B5CCC' }}>Retry</button></div></div>

  const lv = sorted(local), rv = sorted(remote)
  const lsel = lv.filter(e => local.selected.has(e.name)), rsel = rv.filter(e => remote.selected.has(e.name))

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--nox-bg)' }}>
      {/* Transfer bar */}
      <div className="flex items-center justify-center gap-3 px-3 flex-shrink-0" style={{ height: 34, borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
        <button onClick={() => lsel.length && doUpload(lsel)} disabled={!lsel.some(e => !e.isDirectory)} className="flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-medium disabled:opacity-20" style={{ color: '#3B5CCC' }}>Upload <ArrowRight className="w-3 h-3" /></button>
        <div className="w-px h-4" style={{ background: 'var(--nox-border)' }} />
        <button onClick={() => rsel.length && doDownload(rsel)} disabled={!rsel.some(e => !e.isDirectory)} className="flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-medium disabled:opacity-20" style={{ color: '#3B5CCC' }}><ArrowLeft className="w-3 h-3" /> Download</button>
        <div className="w-px h-4" style={{ background: 'var(--nox-border)' }} />
        <button onClick={() => setDiffMode(d => !d)} className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium" style={{ color: diffMode ? '#F59E0B' : 'var(--nox-text-3)', background: diffMode ? 'rgba(245,158,11,0.08)' : undefined }} title="Compare folders"><GitCompare className="w-3 h-3" /> Diff</button>
      </div>

      <div ref={containerRef} className="flex flex-1 min-h-0 relative">
        {/* LOCAL */}
        <div style={{ width: `${splitPct}%` }} className="flex flex-col overflow-hidden" onClick={() => setFocusedPane('local')}>
          <PaneChrome side="local" label="Local" icon={<HardDrive className="w-3.5 h-3.5" />} pane={local} focused={focusedPane === 'local'} onNavUp={() => navUp('local')} onRefresh={() => loadLocal(local.path)} onMkdir={() => handleMkdir('local')} onToggleHidden={() => uL({ showHidden: !local.showHidden })} />
          <FileTable pane={local} visible={lv} side="local" diffMap={diffMap} dateFormat={dateFormat} onToggleSort={k => toggleSort('local', k)} onSelect={(n, e) => handleSelect('local', n, e)} onClear={() => uL({ selected: new Set() })} onNavUp={() => navUp('local')} onNavInto={e => navInto('local', e)} onDragStart={(e, ev) => onDragStart('local', e, ev)} onDrop={e => onPaneDrop('local', e)} onDoubleClickFile={openLocalFile} />
        </div>

        {/* Draggable divider */}
        <div className="w-[5px] flex-shrink-0 cursor-col-resize group relative z-10" onMouseDown={startDividerDrag}
          style={{ background: 'var(--nox-border)' }}>
          <div className="absolute inset-0 transition-colors group-hover:bg-[#3B5CCC] group-active:bg-[#3B5CCC]" />
        </div>

        {/* REMOTE */}
        <div style={{ width: `${100 - splitPct}%` }} className="flex flex-col overflow-hidden" onClick={() => setFocusedPane('remote')}>
          <PaneChrome side="remote" label={session?.host || 'Remote'} icon={<Server className="w-3.5 h-3.5" />} pane={remote} focused={focusedPane === 'remote'} onNavUp={() => navUp('remote')} onRefresh={() => clientId && loadRemote(clientId, remote.path)} onMkdir={() => handleMkdir('remote')} onToggleHidden={() => uR({ showHidden: !remote.showHidden })} />
          <FileTable pane={remote} visible={rv} side="remote" diffMap={diffMap} dateFormat={dateFormat} onToggleSort={k => toggleSort('remote', k)} onSelect={(n, e) => handleSelect('remote', n, e)} onClear={() => uR({ selected: new Set() })} onNavUp={() => navUp('remote')} onNavInto={e => navInto('remote', e)} onDelete={handleDelete} onRename={handleRename} onDragStart={(e, ev) => onDragStart('remote', e, ev)} onDrop={e => onPaneDrop('remote', e)} onDoubleClickFile={openFile} />
        </div>

      </div>

      {/* Transfer queue + status bar */}
      <div className="flex-shrink-0" style={{ borderTop: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
        {transfers.length > 0 && (
          <div className="px-3 py-1.5 flex flex-col gap-1" style={{ borderBottom: '1px solid var(--nox-border)' }}>
            {transfers.slice(0, 5).map(t => (
              <div key={t.id} className="flex items-center gap-2">
                {t.status === 'active' && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" style={{ color: '#3B5CCC' }} />}
                {t.status === 'done' && <Check className="w-3 h-3 flex-shrink-0" style={{ color: '#10B981' }} />}
                {t.status === 'error' && <AlertTriangle className="w-3 h-3 flex-shrink-0" style={{ color: '#EF4444' }} />}
                <span className="flex items-center gap-1 text-[10px] font-mono truncate" style={{ color: t.status === 'error' ? '#EF4444' : 'var(--nox-text-2)' }}>
                  {t.direction === 'up' ? <ArrowRight className="w-2.5 h-2.5" /> : <ArrowLeft className="w-2.5 h-2.5" />}
                  {t.name}
                </span>
                {t.error && <span className="text-[9px] truncate" style={{ color: '#EF4444' }}>{t.error}</span>}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center px-3" style={{ height: 24 }}>
          <span className="text-[10px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{lv.length} items</span>
          {diffMode && (
            <span className="flex items-center gap-3 mx-4">
              <span className="flex items-center gap-1 text-[9px]"><span className="w-1.5 h-1.5 rounded-full" style={{ background: '#10B981' }} /><span style={{ color: '#10B981' }}>local only</span></span>
              <span className="flex items-center gap-1 text-[9px]"><span className="w-1.5 h-1.5 rounded-full" style={{ background: '#8B5CF6' }} /><span style={{ color: '#8B5CF6' }}>remote only</span></span>
              <span className="flex items-center gap-1 text-[9px]"><span className="w-1.5 h-1.5 rounded-full" style={{ background: '#F59E0B' }} /><span style={{ color: '#F59E0B' }}>different</span></span>
            </span>
          )}
          <span className="flex-1" />
          <span className="text-[10px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{rv.length} items · {remote.path}</span>
        </div>
      </div>

      {/* Quick Look overlay */}
      {(quickLook || quickLookLoading) && (
        <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }} onClick={() => setQuickLook(null)}>
          <div className="rounded-lg overflow-hidden shadow-2xl flex flex-col" style={{ width: 560, maxHeight: '70vh', background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }} onClick={e => e.stopPropagation()}>
            {quickLookLoading ? (
              <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin" style={{ color: '#3B5CCC' }} /></div>
            ) : quickLook && (<>
              <div className="flex items-center gap-2 px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
                <File className="w-3.5 h-3.5" style={{ color: 'var(--nox-text-3)' }} />
                <span className="text-[12px] font-medium flex-1 truncate" style={{ color: 'var(--nox-text)' }}>{quickLook.name}</span>
                <span className="text-[10px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{formatFileSize(quickLook.size)}</span>
                <button onClick={() => setQuickLook(null)} style={{ color: 'var(--nox-text-3)' }}><X className="w-3.5 h-3.5" /></button>
              </div>
              <pre className="flex-1 overflow-auto p-4 text-[11px] font-mono leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--nox-text-2)', scrollbarWidth: 'thin', maxHeight: '60vh' }}>{quickLook.content}</pre>
              <div className="flex items-center px-4 py-2 flex-shrink-0" style={{ borderTop: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
                <span className="text-[9px]" style={{ color: 'var(--nox-text-3)' }}>Press Space to close · Esc to dismiss</span>
              </div>
            </>)}
          </div>
        </div>
      )}
    </div>
  )
}

function PaneChrome({ side, label, icon, pane, focused, onNavUp, onRefresh, onMkdir, onToggleHidden }: {
  side: Side; label: string; icon: React.ReactNode; pane: PaneState; focused: boolean
  onNavUp: () => void; onRefresh: () => void; onMkdir: () => void; onToggleHidden: () => void
}) {
  const segs = pane.path === '/' ? [] : pane.path.split('/').filter(Boolean)
  return (<>
    <div className="flex items-center gap-2 px-3 flex-shrink-0" style={{ height: 32, borderBottom: '1px solid var(--nox-border)', background: focused ? 'var(--nox-shell)' : 'var(--nox-bg)' }}>
      <span style={{ color: focused ? '#3B5CCC' : 'var(--nox-text-3)' }}>{icon}</span>
      <span className="text-[11px] font-semibold truncate flex-1" style={{ color: 'var(--nox-text)' }}>{label}</span>
      {side === 'remote' && <Btn title="New folder" onClick={onMkdir}><FolderPlus className="w-3 h-3" /></Btn>}
      <Btn title="Refresh" onClick={onRefresh}><RefreshCw className={`w-3 h-3 ${pane.loading ? 'animate-spin' : ''}`} /></Btn>
      <Btn title="Hidden files" onClick={onToggleHidden} active={pane.showHidden}>{pane.showHidden ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}</Btn>
    </div>
    <div className="flex items-center gap-1 px-2 flex-shrink-0 min-w-0 overflow-hidden" style={{ height: 26, borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-bg)' }}>
      <Btn title="Up" onClick={onNavUp} disabled={pane.path === '/'}><ChevronUp className="w-3 h-3" /></Btn>
      <span className="text-[10px] font-mono truncate" style={{ color: 'var(--nox-text-3)' }}>/{segs.join('/')}</span>
    </div>
  </>)
}

function FileTable({ pane, visible, side, diffMap, dateFormat, onToggleSort, onSelect, onClear, onNavUp, onNavInto, onDelete, onRename, onDragStart, onDrop, onDoubleClickFile }: {
  pane: PaneState; visible: FileEntry[]; side: Side; diffMap: Map<string, string> | null; dateFormat: string; onToggleSort: (k: SortKey) => void; onSelect: (n: string, e: React.MouseEvent) => void; onClear: () => void; onNavUp: () => void; onNavInto: (e: FileEntry) => void; onDelete?: (e: FileEntry[]) => void; onRename?: (e: FileEntry) => void; onDragStart: (e: FileEntry, ev: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void; onDoubleClickFile: (e: FileEntry) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  return (
    <div className="flex-1 overflow-auto relative" style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--nox-border) transparent' }} onClick={e => { if (e.target === e.currentTarget) onClear() }} onDragOver={e => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={e => { setDragOver(false); onDrop(e) }}>
      {dragOver && <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none" style={{ background: 'rgba(59,92,204,0.05)', border: '2px dashed rgba(59,92,204,0.25)' }}><span className="text-[11px] font-medium" style={{ color: '#3B5CCC' }}>Drop to {side === 'remote' ? 'upload' : 'download'}</span></div>}
      <table className="w-full border-collapse text-[11px] font-mono" style={{ tableLayout: 'fixed' }}>
        <colgroup><col /><col style={{ width: 70 }} /><col style={{ width: 130 }} />{onRename && <col style={{ width: 50 }} />}</colgroup>
        <thead className="sticky top-0 z-10"><tr>
          <Th label="Name" sk="name" pane={pane} onSort={onToggleSort} />
          <Th label="Size" sk="size" pane={pane} onSort={onToggleSort} align="right" />
          <Th label="Modified" sk="mtime" pane={pane} onSort={onToggleSort} />
          {onRename && <th style={{ background: 'var(--nox-shell)', borderBottom: '1px solid var(--nox-border)' }} />}
        </tr></thead>
        <tbody>
          {pane.path !== '/' && <tr className="cursor-default" onClick={onNavUp} onDoubleClick={onNavUp}><td colSpan={onRename ? 4 : 3} className="px-2 py-[4px]" style={{ color: 'var(--nox-text-3)' }}><span className="flex items-center gap-1.5"><ChevronUp className="w-3 h-3" /> ..</span></td></tr>}
          {visible.length === 0 && !pane.loading && !pane.error && <tr><td colSpan={onRename ? 4 : 3} className="text-center py-8" style={{ color: 'var(--nox-text-3)' }}>Empty</td></tr>}
          {pane.error && <tr><td colSpan={onRename ? 4 : 3} className="text-center py-6" style={{ color: '#EF4444' }}>{pane.error}</td></tr>}
          {visible.map(entry => {
            const sel = pane.selected.has(entry.name)
            const diff = diffMap?.get(entry.name)
            const diffBg = diff === 'local-only' ? 'rgba(16,185,129,0.06)' : diff === 'remote-only' ? 'rgba(139,92,246,0.06)' : diff === 'different' ? 'rgba(245,158,11,0.06)' : undefined
            const diffDot = diff === 'local-only' ? '#10B981' : diff === 'remote-only' ? '#8B5CF6' : diff === 'different' ? '#F59E0B' : null
            return (
              <tr key={entry.name} draggable onDragStart={e => onDragStart(entry, e)} onClick={e => { e.stopPropagation(); onSelect(entry.name, e) }} onDoubleClick={() => entry.isDirectory ? onNavInto(entry) : onDoubleClickFile(entry)} className="group cursor-default transition-colors" style={{ background: sel ? 'rgba(59,92,204,0.08)' : diffBg }} onMouseEnter={e => { if (!sel) e.currentTarget.style.background = sel ? 'rgba(59,92,204,0.08)' : 'var(--nox-hover)' }} onMouseLeave={e => { if (!sel) e.currentTarget.style.background = diffBg || '' }}>
                <td className="px-2 py-[4px] truncate"><span className="flex items-center gap-1.5 min-w-0">{diffDot && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: diffDot }} />}{entry.isDirectory ? <FolderOpen className="w-3 h-3 flex-shrink-0" style={{ color: '#8B5CF6' }} /> : <File className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />}<span className="truncate" style={{ color: entry.isDirectory ? 'var(--nox-text)' : 'var(--nox-text-2)' }}>{entry.name}</span></span></td>
                <td className="px-2 py-[4px] text-right" style={{ color: 'var(--nox-text-3)' }}>{entry.isDirectory ? '—' : formatFileSize(entry.size)}</td>
                <td className="px-2 py-[4px]" style={{ color: 'var(--nox-text-3)', fontSize: 10 }}>{formatDate(entry.mtime, dateFormat)}</td>
                {onRename && <td className="px-1 py-[4px]"><span className="flex items-center gap-0 opacity-0 group-hover:opacity-100 transition-opacity"><button title="Rename" onClick={e => { e.stopPropagation(); onRename(entry) }} className="w-4 h-4 flex items-center justify-center rounded" style={{ color: 'var(--nox-text-3)' }}><Pencil className="w-2.5 h-2.5" /></button>{onDelete && <button title="Delete" onClick={e => { e.stopPropagation(); onDelete([entry]) }} className="w-4 h-4 flex items-center justify-center rounded" style={{ color: '#EF4444' }}><Trash2 className="w-2.5 h-2.5" /></button>}</span></td>}
              </tr>)
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({ label, sk, pane, onSort, align }: { label: string; sk: SortKey; pane: PaneState; onSort: (k: SortKey) => void; align?: 'right' }) {
  const active = pane.sortKey === sk
  return <th className="px-2 py-1.5 text-[9px] uppercase tracking-wider font-semibold cursor-pointer select-none whitespace-nowrap" style={{ textAlign: align || 'left', background: 'var(--nox-shell)', borderBottom: '1px solid var(--nox-border)', color: active ? 'var(--nox-text)' : 'var(--nox-text-3)' }} onClick={() => onSort(sk)}>{label}{active && <ArrowUpDown className="w-2 h-2 inline-block ml-0.5" style={{ transform: pane.sortDir === 'desc' ? 'scaleY(-1)' : undefined }} />}</th>
}

function Btn({ title, onClick, disabled, active, children }: { title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return <button onClick={onClick} title={title} disabled={disabled} className="w-5 h-5 flex items-center justify-center rounded transition-colors disabled:opacity-25" style={{ color: active ? '#3B5CCC' : 'var(--nox-text-3)' }} onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--nox-hover)' }} onMouseLeave={e => { e.currentTarget.style.background = '' }}>{children}</button>
}
