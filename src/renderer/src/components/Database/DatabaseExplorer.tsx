import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useAppStore, Tab } from '../../store'
import SplitHandle from '../SplitHandle'
import ResultsGrid from './ResultsGrid'
import SchemaSidebar from './SchemaSidebar'
import RowDetailPanel from './RowDetailPanel'
import ExplainTreeView, { parseExplainJson, type ExplainNode } from './ExplainTreeView'
import type { QueryResult, ResultSort, TableColumn } from './types'
import { selectRows } from '../../lib/dbSql'
import { useTableEditing } from './useTableEditing'
import InsertRowModal from './InsertRowModal'
import DeleteRowModal from './DeleteRowModal'
import {
  Database, Play, Loader2, AlertTriangle, Copy, Download, RotateCcw, Pin, PanelRightOpen, PanelRightClose, Activity, Eye, EyeOff, Plus, Trash2,
} from 'lucide-react'

interface SavedQuery { sql: string; label: string; ts: number }
type ActivePanel = 'results' | 'history' | 'saved' | 'explain'

/* ── Watch mode diff ──────────────────────────────────────────────────── */

function computeRowDiff(prev: QueryResult | null, next: QueryResult): Set<string> {
  if (!prev) return new Set()
  const changes = new Set<string>()
  const maxRows = Math.max(prev.rows.length, next.rows.length)
  for (let i = 0; i < maxRows; i++) {
    const oldRow = prev.rows[i]
    const newRow = next.rows[i]
    if (!oldRow && newRow) {
      next.columns.forEach(col => changes.add(`${i}-${col}`))
    } else if (oldRow && newRow) {
      for (const col of next.columns) {
        if (String(newRow[col] ?? '') !== String(oldRow[col] ?? '')) changes.add(`${i}-${col}`)
      }
    }
  }
  return changes
}

/* ── Main component ───────────────────────────────────────────────────── */

export default function DatabaseExplorer({ tab }: Readonly<{ tab: Tab }>) {
  const sessions = useAppStore(s => s.sessions)
  const updateTab = useAppStore(s => s.updateTab)
  const session = sessions.find(s => s.id === tab.sessionId)

  const [clientId, setClientId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tables, setTables] = useState<string[]>([])
  const [tableFilter, setTableFilter] = useState('')
  const [activeTable, setActiveTable] = useState<string | null>(null)
  const [tableColumns, setTableColumns] = useState<Record<string, TableColumn[]>>({})
  const [primaryKeys, setPrimaryKeys] = useState<Record<string, string[]>>({})
  const [sql, setSql] = useState('')
  const [results, setResults] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState<{ sql: string; ts: number; duration?: number; rows?: number }[]>([])
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [activePanel, setActivePanel] = useState<ActivePanel>('results')
  const [toast, setToast] = useState<string | null>(null)
  const [editorHeight, setEditorHeight] = useState(120)
  const [selectedRow, setSelectedRow] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [resultSort, setResultSort] = useState<ResultSort>(null)
  const [browsingTable, setBrowsingTable] = useState<string | null>(null)
  const [explainTree, setExplainTree] = useState<ExplainNode | null>(null)
  const [explainRunning, setExplainRunning] = useState(false)
  const [expandedJson, setExpandedJson] = useState<Set<string>>(new Set())
  const [watchActive, setWatchActive] = useState(false)
  const [watchSec, setWatchSec] = useState(5)
  const [watchCountdown, setWatchCountdown] = useState(0)
  const [changedCells, setChangedCells] = useState<Set<string>>(new Set())
  const prevResultsRef = useRef<QueryResult | null>(null)
  const watchTimerRef = useRef<NodeJS.Timeout | null>(null)
  const countdownRef = useRef<NodeJS.Timeout | null>(null)

  const clientRef = useRef<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const editorWrapRef = useRef<HTMLDivElement>(null)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }
  const sqlDialect = session?.dbType || 'postgresql'
  const editing = useTableEditing({
    clientId, dbType: sqlDialect, table: browsingTable,
    primaryKey: browsingTable ? primaryKeys[browsingTable] : undefined,
    results, setResults, notify: showToast,
    reload: () => { if (browsingTable) runQuery(selectRows(browsingTable, sqlDialect, BROWSE_LIMIT), false) },
  })

  const connect = useCallback(async () => {
    if (!session) return
    setConnecting(true); setError(null)
    try {
      const creds = tab.sessionId
        ? await window.api.sessions.getCredentials(tab.sessionId).catch((err: any) => {
            const msg = err?.message ?? 'Failed to retrieve credentials'
            throw new Error(msg.includes('locked') ? 'App is locked — unlock noxed to reconnect' : msg)
          })
        : null
      const id = await window.api.database.connect({ dbType: session.dbType || 'postgresql', host: session.host, port: session.port, username: session.username || '', password: creds?.password, database: session.databaseName || session.host, ssl: session.sslMode })
      setClientId(id); clientRef.current = id; updateTab(tab.id, { status: 'connected' }); setConnecting(false)
      refreshTables(id)
    } catch (err: any) { setError(err?.message ?? 'Connection failed'); updateTab(tab.id, { status: 'error', errorMessage: err?.message }); setConnecting(false) }
  }, [session])

  useEffect(() => {
    connect()
    return () => {
      if (watchTimerRef.current) clearInterval(watchTimerRef.current)
      if (countdownRef.current) clearInterval(countdownRef.current)
      if (clientRef.current) {
        window.api.database.disconnect(clientRef.current).catch((err: any) => {
          // Best-effort: connection may already be torn down by main on tab close.
          console.error('[db] disconnect on unmount failed:', err?.message ?? err)
        })
      }
    }
  }, [])

  async function refreshTables(id?: string) {
    const cid = id || clientId; if (!cid) return
    try { setTables(await window.api.database.tables(cid)) } catch (err: any) { showToast(err?.message) }
  }

  async function loadColumns(table: string) {
    if (!clientId || tableColumns[table]) return
    try {
      const info = await window.api.database.tableInfo(clientId, table)
      setTableColumns(prev => ({ ...prev, [table]: info.columns }))
      setPrimaryKeys(prev => ({ ...prev, [table]: info.primaryKey }))
    }
    catch (err: any) { showToast(err?.message) }
  }

  async function runQuery(query?: string, addToHistory = true) {
    const q = (query || sql).trim(); if (!clientId || !q) return
    setRunning(true); setQueryError(null); setResults(null); setSelectedRow(null); editing.cancelEdit(); setResultSort(null); setActivePanel('results')
    try {
      const result = await window.api.database.query(clientId, q); setResults(result)
      if (addToHistory) setHistory(prev => [{ sql: q, ts: Date.now(), duration: result.duration, rows: result.rowCount }, ...prev.slice(0, 99)])
    } catch (err: any) { setQueryError(err?.message ?? 'Query failed') }
    finally { setRunning(false) }
  }

  async function runExplain() {
    const q = sql.trim(); if (!clientId || !q) return
    setExplainRunning(true); setExplainTree(null); setActivePanel('explain')
    try {
      const isPostgres = (session?.dbType || 'postgresql') === 'postgresql'
      const explainSql = isPostgres
        ? `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${q}`
        : `EXPLAIN FORMAT=JSON ${q}`
      const result = await window.api.database.query(clientId, explainSql)
      const raw = isPostgres ? result.rows[0]?.['QUERY PLAN'] : JSON.parse(result.rows[0]?.EXPLAIN || '{}')
      const tree = parseExplainJson(raw)
      setExplainTree(tree)
    } catch (err: any) { showToast(`Explain failed: ${err?.message}`) }
    finally { setExplainRunning(false) }
  }

  function selectTable(table: string) {
    if (activeTable === table) { setActiveTable(null); return }
    setActiveTable(table); loadColumns(table); setBrowsingTable(table)
    const q = selectRows(table, sqlDialect, BROWSE_LIMIT)
    setSql(q); runQuery(q)
  }

  function saveCurrentQuery() {
    if (!sql.trim()) return
    const label = prompt('Name this query:', sql.trim().slice(0, 40))
    if (!label) return
    setSavedQueries(prev => [{ sql: sql.trim(), label, ts: Date.now() }, ...prev]); showToast('Query saved')
  }

  function copyResults() {
    if (!results) return
    const h = results.columns.join('\t')
    const rows = results.rows.map(r => results.columns.map(c => r[c] ?? '').join('\t')).join('\n')
    navigator.clipboard.writeText(`${h}\n${rows}`); showToast('Copied')
  }

  function exportCsv() {
    if (!results) return
    const h = results.columns.join(',')
    const rows = results.rows.map(r => results.columns.map(c => {
      const v = r[c]
      if (v == null) return ''
      const s = String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replaceAll('"', '""')}"` : s
    }).join(',')).join('\n')
    const blob = new Blob([`${h}\n${rows}`], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${browsingTable || 'query'}-results.csv`; a.click(); URL.revokeObjectURL(a.href); showToast('Exported')
  }

  function pickQuery(q: string) {
    setSql(q)
    setActivePanel('results')
    editorRef.current?.focus()
  }

  function startWatch() {
    if (!sql.trim() || !clientRef.current) return
    prevResultsRef.current = results ? { ...results } : null
    setWatchActive(true)
    setWatchCountdown(watchSec)
    countdownRef.current = setInterval(() => setWatchCountdown(c => c <= 1 ? watchSec : c - 1), 1000)
    watchTimerRef.current = setInterval(runWatchTick, watchSec * 1000)
  }

  function stopWatch() {
    setWatchActive(false)
    if (watchTimerRef.current) clearInterval(watchTimerRef.current)
    if (countdownRef.current) clearInterval(countdownRef.current)
    watchTimerRef.current = null
    countdownRef.current = null
    setChangedCells(new Set())
    setWatchCountdown(0)
    prevResultsRef.current = null
  }

  async function runWatchTick() {
    if (!clientRef.current) return
    const q = sql.trim()
    if (!q) { stopWatch(); return }
    try {
      const result = await window.api.database.query(clientRef.current, q)
      const diff = computeRowDiff(prevResultsRef.current, result)
      if (diff.size > 0) {
        setChangedCells(diff)
        setTimeout(() => setChangedCells(new Set()), 3000)
      }
      prevResultsRef.current = { ...result }
      setResults(result)
    } catch { /* silent during watch */ }
  }

  // The editor grows downward from its top edge, so its height is the pointer's
  // distance below that edge.
  const editorHeightFromPointer = (_x: number, clientY: number) =>
    clientY - (editorWrapRef.current?.getBoundingClientRect().top ?? clientY - editorHeight)

  const sortedRows = useMemo(() => {
    if (!results) return []
    if (!resultSort) return results.rows
    const { col, dir } = resultSort
    return [...results.rows].sort((a, b) => {
      const av = a[col], bv = b[col]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [results, resultSort])

  function toggleResultSort(col: string) { setResultSort(s => s?.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }) }

  function toggleJsonExpand(key: string) { setExpandedJson(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n }) }

  const filteredTables = filterTables(tables, tableFilter)
  const dbType = DB_TYPE_LABELS[session?.dbType ?? ''] ?? 'PostgreSQL'
  const detailRow = getDetailRow(sortedRows, selectedRow)

  if (connecting) return <div className="flex items-center justify-center h-full" style={{ background: 'var(--nox-bg)' }}><div className="text-center"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-3" style={{ color: '#3B5CCC' }} /><p className="text-[11px]" style={{ color: 'var(--nox-text-2)' }}>Connecting to {session?.databaseName || session?.host}</p></div></div>
  if (error && !clientId) return <div className="flex items-center justify-center h-full" style={{ background: 'var(--nox-bg)' }}><div className="text-center max-w-md px-6"><AlertTriangle className="w-6 h-6 mx-auto mb-3" style={{ color: '#EF4444' }} /><p className="text-[10px] mb-4 font-mono" style={{ color: 'var(--nox-text-3)' }}>{error}</p><button onClick={connect} className="px-4 py-1.5 rounded text-[11px] text-white" style={{ background: '#3B5CCC' }}>Retry</button></div></div>

  return (
    <div className="flex h-full w-full min-w-0 min-h-0 overflow-hidden" style={{ background: 'var(--nox-bg)' }}>
      <SchemaSidebar
        dbLabel={session?.databaseName || 'Database'}
        footer={`${dbType} · ${session?.host}:${session?.port}`}
        tables={filteredTables}
        tableFilter={tableFilter}
        setTableFilter={setTableFilter}
        activeTable={activeTable}
        tableColumns={tableColumns}
        onSelect={selectTable}
        onRefresh={() => refreshTables()}
      />

      {/* Main area */}
      <div className="flex-1 flex flex-col" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <ExplorerToolbar
          running={running} explainRunning={explainRunning} hasSql={!!sql.trim()} activePanel={activePanel}
          watchActive={watchActive} watchSec={watchSec} watchCountdown={watchCountdown}
          onRun={() => runQuery()} onExplain={runExplain} onStartWatch={startWatch} onStopWatch={stopWatch}
          onWatchSecChange={setWatchSec} onSave={saveCurrentQuery}
          onClear={() => { setSql(''); setResults(null); setQueryError(null); setBrowsingTable(null); setActiveTable(null); setExplainTree(null) }}
        />

        {/* SQL editor */}
        <div ref={editorWrapRef} className="flex-shrink-0" style={{ height: editorHeight }}>
          <textarea ref={editorRef} value={sql} onChange={e => setSql(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runQuery() } }} placeholder="SELECT * FROM …" spellCheck={false} className="w-full h-full resize-none text-[12px] font-mono leading-relaxed px-4 py-3 focus:outline-none" style={{ color: 'var(--nox-text)', background: 'var(--nox-bg)', tabSize: 2 }} />
        </div>
        <SplitHandle
          orientation="horizontal"
          label="Resize query editor"
          value={editorHeight}
          min={40}
          max={400}
          step={10}
          defaultValue={120}
          onChange={setEditorHeight}
          valueFromPointer={editorHeightFromPointer}
        />

        <ResultsTabsBar
          activePanel={activePanel} onSelect={setActivePanel} results={results} hasExplain={!!explainTree}
          historyCount={history.length} savedCount={savedQueries.length} detailOpen={detailOpen}
          onCopy={copyResults} onExport={exportCsv} onToggleDetail={() => setDetailOpen(d => !d)}
          rowActions={editing.editable ? {
            onAdd: editing.openInsert,
            onDelete: detailRow ? () => editing.requestDelete(detailRow) : undefined,
          } : undefined}
        />

        {/* Panel content */}
        <div style={{ flex: '1 1 0', display: 'flex', minHeight: 0, minWidth: 0 }}>

          {/* ── Results ──────────────────────────────────────────────── */}
          {activePanel === 'results' && <>
            <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {queryError && (
                <div className="flex-1 min-h-0 flex items-center justify-center p-6">
                  <div className="max-w-2xl w-full flex items-start gap-2 rounded-md px-4 py-3" style={{ background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.1)' }}>
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#EF4444' }} />
                    <pre className="text-[11px] font-mono whitespace-pre-wrap flex-1 min-w-0 overflow-auto" style={{ color: '#EF4444' }}>{queryError}</pre>
                  </div>
                </div>
              )}
              {results && (
                <ResultsGrid
                  results={results} sortedRows={sortedRows} resultSort={resultSort} onToggleSort={toggleResultSort}
                  selectedRow={selectedRow} onSelectRow={setSelectedRow}
                  editingCell={editing.editingCell} editValue={editing.editValue} setEditValue={editing.setEditValue} editInputRef={editing.editInputRef}
                  commitEdit={editing.commitEdit} cancelEdit={editing.cancelEdit} startCellEdit={editing.startCellEdit}
                  changedCells={changedCells} expandedJson={expandedJson} onToggleJson={toggleJsonExpand}
                />
              )}
              {!results && !queryError && !running && (
                <div className="flex items-center justify-center flex-1 min-h-0 w-full"><div className="text-center"><Database className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--nox-text-3)', opacity: 0.12 }} /><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>Click a table to browse, or write a query</p></div></div>
              )}
              {running && <div className="flex items-center justify-center flex-1 min-h-0 w-full gap-2"><Loader2 className="w-4 h-4 animate-spin" style={{ color: '#3B5CCC' }} /><span className="text-[11px]" style={{ color: 'var(--nox-text-2)' }}>Running…</span></div>}
            </div>

            {/* Row detail panel */}
            {detailOpen && detailRow && results && (
              <RowDetailPanel columns={results.columns} row={detailRow} rowNumber={selectedRow! + 1} onClose={() => setDetailOpen(false)} />
            )}
          </>}

          {/* ── Explain visualizer ────────────────────────────────── */}
          {activePanel === 'explain' && (
            <div className="flex-1 overflow-auto p-4" style={{ scrollbarWidth: 'thin' }}>
              {explainRunning && <div className="flex items-center justify-center h-full gap-2"><Loader2 className="w-4 h-4 animate-spin" style={{ color: '#F59E0B' }} /><span className="text-[11px]" style={{ color: 'var(--nox-text-2)' }}>Analyzing…</span></div>}
              {!explainRunning && !explainTree && (
                <div className="flex items-center justify-center h-full"><div className="text-center"><Activity className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--nox-text-3)', opacity: 0.12 }} /><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>Click <strong>Explain</strong> to visualize the execution plan</p></div></div>
              )}
              {explainTree && <ExplainTreeView node={explainTree} maxCost={explainTree.cost} depth={0} />}
            </div>
          )}

          {activePanel === 'history' && <HistoryPanel history={history} onPick={pickQuery} />}

          {activePanel === 'saved' && <SavedPanel savedQueries={savedQueries} onPick={pickQuery} />}
        </div>
      </div>

      {editing.insertOpen && browsingTable && (
        <InsertRowModal table={browsingTable} columns={tableColumns[browsingTable] ?? []} onInsert={editing.insertRow} onClose={editing.closeInsert} />
      )}
      {editing.pendingDelete && browsingTable && (
        <DeleteRowModal
          table={browsingTable} primaryKey={primaryKeys[browsingTable] ?? []} row={editing.pendingDelete}
          onConfirm={editing.confirmDelete} onCancel={editing.cancelDelete}
        />
      )}
      {toast && <div className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded-lg text-[11px] font-medium" style={{ background: 'var(--nox-surface)', border: '1px solid var(--nox-border)', color: '#3B5CCC', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>{toast}</div>}
    </div>
  )
}

const BROWSE_LIMIT = 100

const DB_TYPE_LABELS: Record<string, string> = { mysql: 'MySQL', mariadb: 'MariaDB', postgresql: 'PostgreSQL' }

function ExplorerToolbar({ running, explainRunning, hasSql, activePanel, watchActive, watchSec, watchCountdown, onRun, onExplain, onStartWatch, onStopWatch, onWatchSecChange, onSave, onClear }: Readonly<{
  running: boolean; explainRunning: boolean; hasSql: boolean; activePanel: ActivePanel
  watchActive: boolean; watchSec: number; watchCountdown: number
  onRun: () => void; onExplain: () => void; onStartWatch: () => void; onStopWatch: () => void
  onWatchSecChange: (sec: number) => void; onSave: () => void; onClear: () => void
}>) {
  return (
    <div className="flex items-center gap-2 px-3 flex-shrink-0" style={{ height: 36, borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
      <button onClick={onRun} disabled={running || !hasSql} className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium disabled:opacity-30" style={{ background: running ? 'var(--nox-active)' : '#3B5CCC', color: running ? 'var(--nox-text-2)' : '#fff' }}>
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}{running ? 'Running…' : 'Run'}
      </button>
      <button onClick={onExplain} disabled={running || explainRunning || !hasSql} className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium disabled:opacity-30" style={{ color: activePanel === 'explain' ? '#F59E0B' : 'var(--nox-text-3)', background: activePanel === 'explain' ? 'rgba(245,158,11,0.08)' : undefined }} title="Visualize query execution plan">
        <Activity className="w-3 h-3" /> Explain
      </button>
      <div className="w-px h-4" style={{ background: 'var(--nox-border)' }} />
      <WatchControls watchActive={watchActive} watchSec={watchSec} watchCountdown={watchCountdown} running={running} hasSql={hasSql} onStart={onStartWatch} onStop={onStopWatch} onSecChange={onWatchSecChange} />
      <kbd className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ color: 'var(--nox-text-3)', background: 'var(--nox-active)' }}>{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter</kbd>
      <div className="w-px h-4" style={{ background: 'var(--nox-border)' }} />
      <button onClick={onSave} disabled={!hasSql} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] disabled:opacity-30" style={{ color: 'var(--nox-text-3)' }} title="Save query"><Pin className="w-3 h-3" /> Save</button>
      <div className="flex-1" />
      <button onClick={onClear} className="flex items-center gap-1 px-2 py-1 rounded text-[10px]" style={{ color: 'var(--nox-text-3)' }}><RotateCcw className="w-3 h-3" /> Clear</button>
    </div>
  )
}

function WatchControls({ watchActive, watchSec, watchCountdown, running, hasSql, onStart, onStop, onSecChange }: Readonly<{
  watchActive: boolean; watchSec: number; watchCountdown: number; running: boolean; hasSql: boolean
  onStart: () => void; onStop: () => void; onSecChange: (sec: number) => void
}>) {
  return (
    <div className="flex items-center gap-1">
      <button onClick={watchActive ? onStop : onStart} disabled={!watchActive && (running || !hasSql)} className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium disabled:opacity-30" style={{ color: watchActive ? '#10B981' : 'var(--nox-text-3)', background: watchActive ? 'rgba(16,185,129,0.08)' : undefined }} title={watchActive ? 'Stop watching' : 'Auto-refresh query results'}>
        {watchActive ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />} {watchActive ? 'Stop' : 'Watch'}
      </button>
      {watchActive && <span className="text-[9px] font-mono tabular-nums px-1.5 py-0.5 rounded-full animate-pulse" style={{ color: '#10B981', background: 'rgba(16,185,129,0.08)' }}>{watchCountdown}s</span>}
      {!watchActive && (
        <select value={watchSec} onChange={e => onSecChange(Number(e.target.value))} className="bg-transparent text-[10px] font-mono focus:outline-none cursor-pointer" style={{ color: 'var(--nox-text-3)' }}>
          <option value={2}>2s</option>
          <option value={5}>5s</option>
          <option value={10}>10s</option>
          <option value={30}>30s</option>
        </select>
      )}
    </div>
  )
}

function ResultsTabsBar({ activePanel, onSelect, results, hasExplain, historyCount, savedCount, detailOpen, onCopy, onExport, onToggleDetail, rowActions }: Readonly<{
  activePanel: ActivePanel; onSelect: (p: ActivePanel) => void; results: QueryResult | null; hasExplain: boolean
  historyCount: number; savedCount: number; detailOpen: boolean
  onCopy: () => void; onExport: () => void; onToggleDetail: () => void
  /** Present when browsing a table with a primary key; delete needs a selected row. */
  rowActions?: { onAdd: () => void; onDelete?: () => void }
}>) {
  return (
    <div className="flex items-center gap-0 flex-shrink-0" style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
      <PanelTab active={activePanel === 'results'} onClick={() => onSelect('results')} badge={results ? results.rowCount : undefined}>Results</PanelTab>
      <PanelTab active={activePanel === 'explain'} onClick={() => onSelect('explain')} badge={hasExplain ? 1 : undefined}>Explain</PanelTab>
      <PanelTab active={activePanel === 'history'} onClick={() => onSelect('history')} badge={historyCount || undefined}>History</PanelTab>
      <PanelTab active={activePanel === 'saved'} onClick={() => onSelect('saved')} badge={savedCount || undefined}>Saved</PanelTab>
      <div className="flex-1" />
      {results && activePanel === 'results' && <>
        <span className="text-[10px] font-mono mr-2" style={{ color: 'var(--nox-text-3)' }}>{results.columns.length} cols · {results.duration}ms</span>
        {rowActions && <>
          <TinyBtn title="Add row" onClick={rowActions.onAdd}><Plus className="w-3 h-3" /></TinyBtn>
          {rowActions.onDelete && <TinyBtn title="Delete selected row" onClick={rowActions.onDelete}><Trash2 className="w-3 h-3" /></TinyBtn>}
        </>}
        <TinyBtn title="Copy" onClick={onCopy}><Copy className="w-3 h-3" /></TinyBtn>
        <TinyBtn title="CSV" onClick={onExport}><Download className="w-3 h-3" /></TinyBtn>
        <TinyBtn title={detailOpen ? 'Close detail' : 'Row detail'} onClick={onToggleDetail} active={detailOpen}>{detailOpen ? <PanelRightClose className="w-3 h-3" /> : <PanelRightOpen className="w-3 h-3" />}</TinyBtn>
        <div className="w-2" />
      </>}
    </div>
  )
}

function HistoryPanel({ history, onPick }: Readonly<{
  history: { sql: string; ts: number; duration?: number; rows?: number }[]; onPick: (sql: string) => void
}>) {
  if (history.length === 0) {
    return <div className="flex-1 flex items-center justify-center"><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>No history</p></div>
  }
  return (
    <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
      {history.map((h, i) => (
        <button key={`${h.ts}-${i}`} onClick={() => onPick(h.sql)}
          className="w-full text-left px-4 py-3 transition-colors" style={{ borderBottom: '1px solid var(--nox-border)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--nox-hover)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
          <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--nox-text-2)' }}>{h.sql.length > 200 ? h.sql.slice(0, 200) + '…' : h.sql}</pre>
          <div className="flex items-center gap-3 mt-1"><span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{new Date(h.ts).toLocaleTimeString()}</span>{h.duration !== undefined && <span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{h.duration}ms</span>}{h.rows !== undefined && <span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{h.rows} rows</span>}</div>
        </button>
      ))}
    </div>
  )
}

function SavedPanel({ savedQueries, onPick }: Readonly<{ savedQueries: SavedQuery[]; onPick: (sql: string) => void }>) {
  if (savedQueries.length === 0) {
    return <div className="flex-1 flex items-center justify-center"><div className="text-center"><Pin className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--nox-text-3)', opacity: 0.2 }} /><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>Save queries with the Pin button</p></div></div>
  }
  return (
    <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
      {savedQueries.map((q) => (
        <button key={q.ts} onClick={() => onPick(q.sql)}
          className="w-full text-left px-4 py-3 transition-colors" style={{ borderBottom: '1px solid var(--nox-border)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--nox-hover)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
          <p className="text-[11px] font-medium mb-1" style={{ color: 'var(--nox-text)' }}>{q.label}</p>
          <pre className="text-[10px] font-mono truncate" style={{ color: 'var(--nox-text-3)' }}>{q.sql}</pre>
        </button>
      ))}
    </div>
  )
}

/* ── Smart cell renderer ───────────────────────────────────────────────── */

// Returns the parsed object for object values / JSON-looking strings, else null.
/* ── Explain tree visualizer ───────────────────────────────────────────── */

/* ── Helpers ────────────────────────────────────────────────────────────── */

function filterTables(tables: string[], filter: string): string[] {
  if (!filter) return tables
  return tables.filter(t => t.toLowerCase().includes(filter.toLowerCase()))
}

function getDetailRow(rows: Array<Record<string, unknown>>, selectedRow: number | null): Record<string, unknown> | null {
  return selectedRow === null ? null : rows[selectedRow] ?? null
}

function PanelTab({ active, onClick, badge, children }: Readonly<{ active: boolean; onClick: () => void; badge?: number; children: React.ReactNode }>) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 px-4 py-2 text-[11px] font-medium relative" style={{ color: active ? 'var(--nox-text)' : 'var(--nox-text-3)' }}>
      {children}
      {badge !== undefined && badge > 0 && <span className="text-[9px] font-mono px-1.5 py-[1px] rounded-full" style={{ background: active ? 'rgba(59,92,204,0.1)' : 'var(--nox-active)', color: active ? '#3B5CCC' : 'var(--nox-text-3)' }}>{badge}</span>}
      {active && <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full" style={{ background: '#3B5CCC' }} />}
    </button>
  )
}

function TinyBtn({ title, onClick, active, children }: Readonly<{ title: string; onClick: () => void; active?: boolean; children: React.ReactNode }>) {
  return <button type="button" onClick={onClick} title={title} aria-label={title} className="w-6 h-6 flex items-center justify-center rounded mr-0.5" style={{ color: active ? '#3B5CCC' : 'var(--nox-text-2)' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--nox-hover)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>{children}</button>
}
