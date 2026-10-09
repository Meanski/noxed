import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import Modal, { ModalButton } from '../Modal'
import MongoSidebar from './MongoSidebar'
import MongoDocumentModal from './MongoDocumentModal'
import { useAppStore, type Tab } from '../../store'
import { ipcErrorMessage } from '../../lib/format'
import { resolveSshCredentials } from '../../lib/sshCredentials'

interface MongoExplorerProps {
  tab: Tab
}

interface ShownDocument {
  /** Canonical Extended JSON: exact BSON types, used for editing and as the id. */
  doc: Record<string, unknown>
  /** Relaxed Extended JSON, easier to read. */
  display: Record<string, unknown>
}

interface Results {
  documents: ShownDocument[]
  total: number
}

type Editing = { mode: 'insert' } | { mode: 'edit'; doc: Record<string, unknown> }

const PAGE_SIZES = [20, 50, 100, 200]
const idOf = (doc: Record<string, unknown>) => JSON.stringify({ _id: doc._id })
const pretty = (value: unknown) => JSON.stringify(value, null, 2)

const inputStyle = { background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }

// Browse a MongoDB server: pick a collection, filter and sort with JSON, and
// insert, edit or delete documents.
export default function MongoExplorer({ tab }: Readonly<MongoExplorerProps>) {
  const session = useAppStore((s) => s.sessions.find((x) => x.id === tab.sessionId))
  const updateTab = useAppStore((s) => s.updateTab)
  const [clientId, setClientId] = useState<string | null>(null)
  const clientRef = useRef<string | null>(null)
  // Bumped by each unmount (StrictMode mounts twice), so a connect that
  // finishes for a torn-down mount closes its client instead of keeping it.
  const mountGen = useRef(0)
  const runSeq = useRef(0)
  const [databases, setDatabases] = useState<Array<{ name: string; sizeOnDisk: number }>>([])
  const [connectError, setConnectError] = useState('')
  const [selected, setSelected] = useState<{ db: string; collection: string } | null>(null)
  const [filter, setFilter] = useState('{}')
  const [sort, setSort] = useState('{}')
  const [limit, setLimit] = useState(50)
  const [skip, setSkip] = useState(0)
  const [results, setResults] = useState<Results | null>(null)
  const [queryError, setQueryError] = useState('')
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<Record<string, unknown> | null>(null)

  const connect = async () => {
    if (!session) return
    const gen = mountGen.current
    setConnectError('')
    updateTab(tab.id, { status: 'connecting' })
    try {
      const { password } = await resolveSshCredentials(session)
      const id = await window.api.mongo.connect({
        host: session.host,
        port: session.port || 27017,
        username: session.username || undefined,
        password,
        authSource: session.authSource,
        srv: session.mongoSrv ?? false,
        tls: (session.sslMode ?? 'disable') !== 'disable',
      })
      if (gen !== mountGen.current) {
        await window.api.mongo.disconnect(id)
        return
      }
      clientRef.current = id
      setClientId(id)
      setDatabases(await window.api.mongo.databases(id))
      updateTab(tab.id, { status: 'connected' })
    } catch (err) {
      if (gen !== mountGen.current) return
      const message = ipcErrorMessage(err, 'Could not connect to MongoDB')
      setConnectError(message)
      updateTab(tab.id, { status: 'error', errorMessage: message })
    }
  }

  useEffect(() => {
    connect()
    return () => {
      mountGen.current++
      const id = clientRef.current
      if (id) window.api.mongo.disconnect(id).catch((err: unknown) => console.error('[mongo] disconnect failed:', ipcErrorMessage(err)))
    }
  }, [])

  const run = async (target = selected, from = skip) => {
    if (!clientId || !target) return
    // Only the latest query may show its results (switching collections
    // quickly can finish queries out of order).
    const seq = ++runSeq.current
    setLoading(true)
    setQueryError('')
    try {
      const { documents, total } = await window.api.mongo.find(clientId, target.db, target.collection, { filter, sort, limit, skip: from })
      if (seq !== runSeq.current) return
      setResults({ documents: documents.map((d) => ({ doc: JSON.parse(d.json) as Record<string, unknown>, display: JSON.parse(d.display) as Record<string, unknown> })), total })
    } catch (err) {
      if (seq === runSeq.current) setQueryError(ipcErrorMessage(err, 'Query failed'))
    } finally {
      if (seq === runSeq.current) setLoading(false)
    }
  }

  const choose = (db: string, collection: string) => {
    const target = { db, collection }
    setSelected(target)
    setSkip(0)
    setResults(null)
    run(target, 0)
  }

  const page = (delta: number) => {
    const next = Math.max(0, skip + delta * limit)
    setSkip(next)
    run(selected, next)
  }

  const save = async (json: string) => {
    if (!clientId || !selected || !editing) return
    if (editing.mode === 'insert') await window.api.mongo.insert(clientId, selected.db, selected.collection, json)
    else await window.api.mongo.replace(clientId, selected.db, selected.collection, idOf(editing.doc), json)
    await run()
  }

  const confirmDelete = async () => {
    const doc = deleting
    setDeleting(null)
    if (!clientId || !selected || !doc) return
    try {
      await window.api.mongo.delete(clientId, selected.db, selected.collection, idOf(doc))
      await run()
    } catch (err) {
      useAppStore.getState().addNotification({ type: 'error', message: ipcErrorMessage(err, 'Could not delete the document') })
    }
  }

  if (connectError) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: 'var(--nox-bg)' }}>
        <div className="text-center max-w-sm">
          <AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--nox-danger-text)' }} />
          <p className="text-[12px] mb-3" role="alert" style={{ color: 'var(--nox-text-2)' }}>{connectError}</p>
          <ModalButton variant="primary" onClick={connect}>Retry</ModalButton>
        </div>
      </div>
    )
  }
  if (!clientId) {
    return <div className="flex items-center justify-center h-full" style={{ background: 'var(--nox-bg)' }}><Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--nox-text-2)' }} /></div>
  }

  const shownTo = results ? Math.min(skip + results.documents.length, results.total) : 0

  return (
    <div className="flex h-full min-h-0" style={{ background: 'var(--nox-bg)' }}>
      <div className="w-56 flex-shrink-0" style={{ borderRight: '1px solid var(--nox-border)' }}>
        <MongoSidebar clientId={clientId} databases={databases} selected={selected} onSelect={choose} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        {selected ? (
          <>
            <form
              className="flex items-center gap-2 px-3 py-2 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}
              onSubmit={(e) => {
                e.preventDefault()
                setSkip(0)
                run(selected, 0)
              }}
            >
              <span className="text-[12px] font-medium truncate max-w-48" style={{ color: 'var(--nox-text)' }}>{selected.db}.{selected.collection}</span>
              <input aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder='{"status": "active"}' spellCheck={false} className="flex-1 min-w-0 px-2 py-1 rounded font-['JetBrains_Mono'] text-[11.5px] outline-none" style={inputStyle} />
              <input aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} placeholder='{"_id": -1}' spellCheck={false} className="w-36 px-2 py-1 rounded font-['JetBrains_Mono'] text-[11.5px] outline-none" style={inputStyle} />
              <select aria-label="Page size" value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="px-1 py-1 rounded text-[11.5px]" style={inputStyle}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <ModalButton type="submit" variant="primary"><Play className="w-3 h-3 inline" /> Find</ModalButton>
              <ModalButton onClick={() => setEditing({ mode: 'insert' })}><Plus className="w-3 h-3 inline" /> Insert</ModalButton>
            </form>
            {queryError && <p role="alert" className="px-3 py-2 text-[12px]" style={{ color: 'var(--nox-danger-text)' }}>{queryError}</p>}
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
              {loading && <Loader2 className="w-4 h-4 animate-spin mx-auto" style={{ color: 'var(--nox-text-2)' }} />}
              {results?.documents.length === 0 && !loading && (
                <p className="text-center py-10 text-[12px]" style={{ color: 'var(--nox-text-2)' }}>No documents match.</p>
              )}
              {results?.documents.map(({ doc, display }) => (
                <div key={idOf(doc)} className="group relative rounded-md" style={{ background: 'var(--nox-shell)', border: '1px solid var(--nox-border)' }}>
                  <pre className="p-3 text-[11.5px] font-['JetBrains_Mono'] overflow-x-auto max-h-80 select-text" style={{ color: 'var(--nox-text)' }}>{pretty(display)}</pre>
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <button type="button" aria-label="Edit document" onClick={() => setEditing({ mode: 'edit', doc })} className="p-1 rounded hover:bg-[var(--nox-hover)]" style={{ color: 'var(--nox-text-2)' }}><Pencil className="w-3.5 h-3.5" /></button>
                    <button type="button" aria-label="Delete document" onClick={() => setDeleting(doc)} className="p-1 rounded hover:bg-[var(--nox-hover)]" style={{ color: 'var(--nox-danger-text)' }}><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ))}
            </div>
            {results && results.total > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 text-[11.5px] flex-shrink-0" style={{ borderTop: '1px solid var(--nox-border)', color: 'var(--nox-text-2)' }}>
                <span>{skip + 1}–{shownTo} of {results.total}</span>
                <button type="button" aria-label="Previous page" disabled={skip === 0} onClick={() => page(-1)} className="ml-auto p-1 rounded disabled:opacity-30 hover:bg-[var(--nox-hover)]"><ChevronLeft className="w-3.5 h-3.5" /></button>
                <button type="button" aria-label="Next page" disabled={shownTo >= results.total} onClick={() => page(1)} className="p-1 rounded disabled:opacity-30 hover:bg-[var(--nox-hover)]"><ChevronRight className="w-3.5 h-3.5" /></button>
              </div>
            )}
          </>
        ) : (
          <p className="m-auto text-[12px]" style={{ color: 'var(--nox-text-2)' }}>Choose a collection to browse its documents.</p>
        )}
      </div>

      {editing && (
        <MongoDocumentModal
          title={editing.mode === 'insert' ? 'Insert document' : 'Edit document'}
          initial={editing.mode === 'insert' ? '{\n  \n}' : pretty(editing.doc)}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <Modal
          title="Delete this document?"
          tone="danger"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <ModalButton onClick={() => setDeleting(null)} initialFocus>Cancel</ModalButton>
              <ModalButton variant="danger" onClick={confirmDelete}>Delete</ModalButton>
            </>
          }
        >
          <p>This removes the document with <code>_id</code> <code>{JSON.stringify(deleting._id)}</code>. It can&apos;t be undone.</p>
        </Modal>
      )}
    </div>
  )
}
