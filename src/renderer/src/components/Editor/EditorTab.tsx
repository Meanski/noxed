import { useState, useEffect, useRef, useCallback } from 'react'
import { File, Save, RefreshCw, AlertTriangle, Loader2, Server, HardDrive } from 'lucide-react'
import { useAppStore, Tab } from '../../store'
import { ipcErrorMessage } from '../../lib/format'
import { connectSftp } from '../../lib/sftpConnect'
import CodeEditor from './CodeEditor'

export default function EditorTab({ tab }: { tab: Tab }) {
  const sessions = useAppStore(s => s.sessions)
  const updateTab = useAppStore(s => s.updateTab)
  const addNotification = useAppStore(s => s.addNotification)
  const session = sessions.find(s => s.id === tab.sessionId)
  const file = tab.editorFile

  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<string | null>(null)
  const contentRef = useRef<string>('')
  // Latest save() lives in a ref so the global Cmd+S listener never goes stale
  const saveRef = useRef<() => void>(() => {})

  const isRemote = file?.source === 'remote'

  const load = useCallback(async () => {
    if (!file) return
    setLoading(true)
    setError(null)
    try {
      if (file.source === 'local') {
        const text = await window.api.localfs.readTextFile(file.path)
        setContent(text)
        contentRef.current = text
      } else {
        if (!session) throw new Error('Session for this file no longer exists')
        if (!clientRef.current) {
          // Prefer riding the live terminal connection; if that stream has since
          // closed, fall back to a standalone SFTP connection.
          clientRef.current = tab.streamId
            ? await connectSftp(session, tab.streamId).catch(() => connectSftp(session))
            : await connectSftp(session)
        }
        const text = await window.api.sftp.readFile(clientRef.current, file.path)
        setContent(text)
        contentRef.current = text
      }
      updateTab(tab.id, { status: 'connected', isDirty: false })
    } catch (err: any) {
      clientRef.current = null
      setError(ipcErrorMessage(err, 'Failed to open file'))
      updateTab(tab.id, { status: 'error' })
    } finally {
      setLoading(false)
    }
  }, [file?.path, file?.source, session?.id, tab.streamId])

  useEffect(() => {
    load()
    return () => {
      if (clientRef.current) {
        window.api.sftp.disconnect(clientRef.current).catch((err: any) => {
          // Best-effort: main may have already cleaned up on window close.
          console.error('[editor] disconnect on unmount failed:', err?.message ?? err)
        })
        clientRef.current = null
      }
    }
  }, [load])

  async function save() {
    if (!file || saving) return
    setSaving(true)
    try {
      if (file.source === 'local') {
        await window.api.localfs.writeTextFile(file.path, contentRef.current)
      } else {
        if (!clientRef.current) throw new Error('Not connected')
        await window.api.sftp.writeFile(clientRef.current, file.path, contentRef.current)
      }
      updateTab(tab.id, { isDirty: false })
    } catch (err: any) {
      addNotification({ type: 'error', message: `Save failed: ${ipcErrorMessage(err)}` })
    } finally {
      setSaving(false)
    }
  }

  saveRef.current = save

  // Cmd/Ctrl+S saves from anywhere in this tab, not only while the editor
  // itself has keyboard focus. Only the active tab responds.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (useAppStore.getState().activeTabId !== tab.id) return
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [tab.id])

  function handleChange(next: string) {
    contentRef.current = next
    if (!tab.isDirty) updateTab(tab.id, { isDirty: true })
  }

  if (!file) {
    return <CenteredMessage icon={<AlertTriangle className="w-5 h-5" style={{ color: '#EF4444' }} />} text="This editor tab has no file associated with it" />
  }

  return (
    <div className="flex flex-col h-full w-full" style={{ background: 'var(--nox-bg)' }}>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{ height: 34, borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}
      >
        <File className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />
        <span className="text-[12px] font-medium flex-shrink-0" style={{ color: 'var(--nox-text)' }}>
          {tab.label}
        </span>
        <span className="text-[10.5px] font-mono truncate" title={file.path} style={{ color: 'var(--nox-text-3)' }}>
          {file.path}
        </span>
        <span className="flex-1" />
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider flex-shrink-0"
          style={isRemote
            ? { color: '#8B5CF6', background: 'rgba(139,92,246,0.1)' }
            : { color: '#10B981', background: 'rgba(16,185,129,0.1)' }}
        >
          {isRemote ? <Server className="w-2.5 h-2.5" /> : <HardDrive className="w-2.5 h-2.5" />}
          {isRemote ? (session?.host ?? 'remote') : 'local'}
        </span>
        {tab.isDirty && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#fbbf24' }} title="Unsaved changes" />}
        <button
          onClick={load}
          disabled={loading}
          title="Reload from disk"
          className="w-6 h-6 flex items-center justify-center rounded transition-colors disabled:opacity-30 flex-shrink-0"
          style={{ color: 'var(--nox-text-3)' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--nox-hover)' }}
          onMouseLeave={e => { e.currentTarget.style.background = '' }}
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={save}
          disabled={!tab.isDirty || saving || loading || !!error}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors disabled:opacity-40 flex-shrink-0"
          style={tab.isDirty
            ? { color: '#3B5CCC', background: 'rgba(59,92,204,0.08)', border: '1px solid rgba(59,92,204,0.25)' }
            : { color: 'var(--nox-text-3)', border: '1px solid transparent' }}
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          {saving ? 'Saving' : tab.isDirty ? 'Save' : 'Saved'}
        </button>
      </div>

      {/* Body */}
      {loading && content === null ? (
        <CenteredMessage icon={<Loader2 className="w-5 h-5 animate-spin" style={{ color: '#3B5CCC' }} />} />
      ) : error ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-sm px-6">
            <AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: '#EF4444' }} />
            <p className="text-[12px] mb-3" style={{ color: 'var(--nox-text-2)' }}>{error}</p>
            <button
              onClick={load}
              className="px-3 py-1.5 rounded-md text-[12px] text-white"
              style={{ background: '#3B5CCC' }}
            >
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <CodeEditor
            value={content ?? ''}
            filename={file.path}
            onChange={handleChange}
            onSave={save}
          />
        </div>
      )}
    </div>
  )
}

function CenteredMessage({ icon, text }: { icon: React.ReactNode; text?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 h-full">
      {icon}
      {text && <p className="text-[12px]" style={{ color: 'var(--nox-text-2)' }}>{text}</p>}
    </div>
  )
}
