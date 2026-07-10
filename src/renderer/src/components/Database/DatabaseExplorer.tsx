import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useAppStore, Tab } from '../../store'
import { relativeTime } from '../../lib/format'
import {
  Database, Table2, Play, Loader2, AlertTriangle, X, ChevronRight,
  ChevronDown, RefreshCw, Copy, Download, Search, Hash,
  Zap, RotateCcw, ArrowUpDown, Pin, PanelRightOpen, PanelRightClose,
  ExternalLink, Activity, Eye, EyeOff,
} from 'lucide-react'

interface QueryResult { columns: string[]; rows: any[]; rowCount: number; duration: number }
interface TableColumn { name: string; type: string; nullable: boolean }
interface SavedQuery { sql: string; label: string; ts: number }
type ResultSort = { col: string; dir: 'asc' | 'desc' } | null
type ActivePanel = 'results' | 'history' | 'saved' | 'explain'

/* ── Smart cell detection ──────────────────────────────────────────────── */

const URL_RE = /^https?:\/\/[^\s]+$/i
const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function isJsonString(s: string): boolean {
  if (s.length < 2) return false
  return (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))
}

/* ── Explain plan parsing ─────────────────────────────────────────────── */

interface ExplainNode {
  type: string
  relation?: string
  cost: number
  rows: number
  width?: number
  actualTime?: number
  actualRows?: number
  children: ExplainNode[]
}

function parseExplainJson(data: any): ExplainNode | null {
  try {
    const plan = Array.isArray(data) ? data[0]?.Plan ?? data[0] : data?.Plan ?? data
    if (!plan) return null
    return walkPlan(plan)
  } catch { return null }
}

function walkPlan(p: any): ExplainNode {
  return {
    type: p['Node Type'] || p.nodeType || 'Unknown',
    relation: p['Relation Name'] || p.relationName,
    cost: p['Total Cost'] ?? p.totalCost ?? 0,
    rows: p['Plan Rows'] ?? p.planRows ?? 0,
    width: p['Plan Width'] ?? p.planWidth,
    actualTime: p['Actual Total Time'] ?? p.actualTotalTime,
    actualRows: p['Actual Rows'] ?? p.actualRows,
    children: (p.Plans || p.plans || []).map(walkPlan),
  }
}

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
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null)
  const [editValue, setEditValue] = useState('')
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
  const resizingRef = useRef(false)
  const editInputRef = useRef<HTMLInputElement>(null)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

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
    try { const info = await window.api.database.tableInfo(clientId, table); setTableColumns(prev => ({ ...prev, [table]: info.columns })) }
    catch (err: any) { showToast(err?.message) }
  }

  async function runQuery(query?: string, addToHistory = true) {
    const q = (query || sql).trim(); if (!clientId || !q) return
    setRunning(true); setQueryError(null); setResults(null); setSelectedRow(null); setEditingCell(null); setResultSort(null); setActivePanel('results')
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
    const q = `SELECT * FROM "${table}" LIMIT 100`
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

  function startCellEdit(row: number, col: string, val: unknown) {
    if (!browsingTable) return
    setEditingCell({ row, col })
    setEditValue(toEditable(val))
    setTimeout(() => editInputRef.current?.focus(), 0)
  }

  async function commitEdit() {
    if (!clientId || !editingCell || !results || !browsingTable) { setEditingCell(null); return }
    const row = results.rows[editingCell.row]; const col = editingCell.col
    if (String(row[col] ?? '') === editValue) { setEditingCell(null); return }
    const pk = results.columns.includes('id') ? 'id' : results.columns[0]
    const pkVal = row[pk]; if (pkVal == null) { showToast('No primary key to identify row'); setEditingCell(null); return }
    const dbType = session?.dbType || 'postgresql'
    const q = (name: string) => quoteIdent(name, dbType)
    try {
      await window.api.database.query(
        clientId,
        `UPDATE ${q(browsingTable)} SET ${q(col)} = ${bindPlaceholder(dbType, 1)} WHERE ${q(pk)} = ${bindPlaceholder(dbType, 2)}`,
        [editValue === '' ? null : editValue, typeof pkVal === 'number' ? pkVal : String(pkVal)],
      )
      const updated = [...results.rows]; updated[editingCell.row] = { ...row, [col]: editValue === '' ? null : editValue }
      setResults({ ...results, rows: updated }); showToast('Updated')
    } catch (err: any) { showToast(`Update failed: ${err?.message}`) }
    setEditingCell(null)
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

  function startResize(e: React.MouseEvent) {
    e.preventDefault(); resizingRef.current = true; const startY = e.clientY; const startH = editorHeight
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      setEditorHeight(Math.max(40, Math.min(400, startH + (ev.clientY - startY))))
    }
    const onUp = () => { resizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }

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
        <div className="flex-shrink-0" style={{ height: editorHeight }}>
          <textarea ref={editorRef} value={sql} onChange={e => setSql(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runQuery() } }} placeholder="SELECT * FROM …" spellCheck={false} className="w-full h-full resize-none text-[12px] font-mono leading-relaxed px-4 py-3 focus:outline-none" style={{ color: 'var(--nox-text)', background: 'var(--nox-bg)', tabSize: 2 }} />
        </div>
        <div className="h-[3px] flex-shrink-0 cursor-row-resize group" style={{ background: 'var(--nox-border)' }} onMouseDown={startResize}><div className="h-full transition-colors group-hover:bg-[#3B5CCC]" /></div>

        <ResultsTabsBar
          activePanel={activePanel} onSelect={setActivePanel} results={results} hasExplain={!!explainTree}
          historyCount={history.length} savedCount={savedQueries.length} detailOpen={detailOpen}
          onCopy={copyResults} onExport={exportCsv} onToggleDetail={() => setDetailOpen(d => !d)}
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
                  editingCell={editingCell} editValue={editValue} setEditValue={setEditValue} editInputRef={editInputRef}
                  commitEdit={commitEdit} cancelEdit={() => setEditingCell(null)} startCellEdit={startCellEdit}
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

      {toast && <div className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded-lg text-[11px] font-medium" style={{ background: 'var(--nox-surface)', border: '1px solid var(--nox-border)', color: '#3B5CCC', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>{toast}</div>}
    </div>
  )
}

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

function ResultsTabsBar({ activePanel, onSelect, results, hasExplain, historyCount, savedCount, detailOpen, onCopy, onExport, onToggleDetail }: Readonly<{
  activePanel: ActivePanel; onSelect: (p: ActivePanel) => void; results: QueryResult | null; hasExplain: boolean
  historyCount: number; savedCount: number; detailOpen: boolean
  onCopy: () => void; onExport: () => void; onToggleDetail: () => void
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
        <TinyBtn title="Copy" onClick={onCopy}><Copy className="w-3 h-3" /></TinyBtn>
        <TinyBtn title="CSV" onClick={onExport}><Download className="w-3 h-3" /></TinyBtn>
        <TinyBtn title={detailOpen ? 'Close detail' : 'Row detail'} onClick={onToggleDetail} active={detailOpen}>{detailOpen ? <PanelRightClose className="w-3 h-3" /> : <PanelRightOpen className="w-3 h-3" />}</TinyBtn>
        <div className="w-2" />
      </>}
    </div>
  )
}

function ResultsGrid({ results, sortedRows, resultSort, onToggleSort, selectedRow, onSelectRow, editingCell, editValue, setEditValue, editInputRef, commitEdit, cancelEdit, startCellEdit, changedCells, expandedJson, onToggleJson }: Readonly<{
  results: QueryResult; sortedRows: any[]; resultSort: ResultSort; onToggleSort: (col: string) => void
  selectedRow: number | null; onSelectRow: (i: number | null) => void
  editingCell: { row: number; col: string } | null; editValue: string; setEditValue: (v: string) => void
  editInputRef: React.Ref<HTMLInputElement>; commitEdit: () => void; cancelEdit: () => void
  startCellEdit: (row: number, col: string, val: unknown) => void
  changedCells: Set<string>; expandedJson: Set<string>; onToggleJson: (k: string) => void
}>) {
  const tableWidth = 48 + results.columns.length * 160
  const gridColumns = `48px repeat(${results.columns.length}, 160px)`
  // Result rows have no inherent identity; key on the pk-ish column value,
  // disambiguating duplicates with an occurrence counter (not the array index).
  const pkCol = results.columns.includes('id') ? 'id' : results.columns[0]
  const seen = new Map<string, number>()
  const rowKeys = sortedRows.map(row => {
    const base = toEditable(row[pkCol])
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n > 1 ? `${base}#${n}` : base
  })
  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
      <div className="w-full h-full overflow-auto" style={{ scrollbarWidth: 'thin' }}>
        <div className="text-[11px] font-mono" style={{ width: tableWidth, minWidth: '100%' }}>
          <div className="sticky top-0 z-20 grid" style={{ gridTemplateColumns: gridColumns }}>
            <div className="text-right px-2 py-2 text-[10px] font-normal sticky left-0 z-30 whitespace-nowrap" style={{ color: 'var(--nox-text-3)', background: 'var(--nox-shell)', borderBottom: '2px solid var(--nox-border)' }}>#</div>
            {results.columns.map(col => (
              <button key={col} className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap cursor-pointer select-none overflow-hidden text-ellipsis" style={{ color: resultSort?.col === col ? 'var(--nox-text)' : 'var(--nox-text-2)', background: 'var(--nox-shell)', borderBottom: '2px solid var(--nox-border)' }} onClick={() => onToggleSort(col)}>
                {col}{resultSort?.col === col && <ArrowUpDown className="w-2.5 h-2.5 inline-block ml-1" style={{ transform: resultSort.dir === 'desc' ? 'scaleY(-1)' : undefined }} />}
              </button>
            ))}
          </div>
          {/* Rows can contain interactive cells (JsonCell buttons), so the row
              itself stays a div: no button role, but click + keyboard select. */}
          {sortedRows.map((row, i) => (
            <div key={rowKeys[i]}
              onClick={() => onSelectRow(i === selectedRow ? null : i)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectRow(i === selectedRow ? null : i) } }}
              className="grid cursor-default transition-colors" style={{ gridTemplateColumns: gridColumns, background: selectedRow === i ? 'rgba(59,92,204,0.06)' : undefined }}
              onMouseEnter={e => { if (selectedRow !== i) e.currentTarget.style.background = 'var(--nox-hover)' }} onMouseLeave={e => { if (selectedRow !== i) e.currentTarget.style.background = '' }}>
              <div className="text-right px-2 py-[5px] text-[10px] sticky left-0 z-10 whitespace-nowrap" style={{ color: 'var(--nox-text-3)', background: selectedRow === i ? 'rgba(59,92,204,0.06)' : 'var(--nox-bg)', borderBottom: '1px solid var(--nox-border)' }}>{i + 1}</div>
              {results.columns.map(col => (
                <ResultCell key={col} row={row} rowIndex={i} col={col}
                  editing={editingCell?.row === i && editingCell?.col === col}
                  changed={changedCells.has(`${i}-${col}`)}
                  editValue={editValue} setEditValue={setEditValue} editInputRef={editInputRef}
                  commitEdit={commitEdit} cancelEdit={cancelEdit}
                  startCellEdit={startCellEdit}
                  expandedJson={expandedJson} onToggleJson={onToggleJson} />
              ))}
            </div>
          ))}
        </div>
        {sortedRows.length === 0 && <div className="flex items-center justify-center py-12"><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>No rows</p></div>}
      </div>
    </div>
  )
}

function SchemaSidebar({ dbLabel, footer, tables, tableFilter, setTableFilter, activeTable, tableColumns, onSelect, onRefresh }: Readonly<{
  dbLabel: string; footer: string; tables: string[]; tableFilter: string; setTableFilter: (v: string) => void
  activeTable: string | null; tableColumns: Record<string, TableColumn[]>; onSelect: (t: string) => void; onRefresh: () => void
}>) {
  return (
    <div className="flex flex-col flex-shrink-0 overflow-hidden" style={{ width: 240, borderRight: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
      <div className="flex items-center gap-2 px-3 flex-shrink-0" style={{ height: 36, borderBottom: '1px solid var(--nox-border)' }}>
        <Database className="w-3.5 h-3.5" style={{ color: '#3B5CCC' }} />
        <p className="text-[11px] font-semibold truncate flex-1" style={{ color: 'var(--nox-text)' }}>{dbLabel}</p>
        <button onClick={onRefresh} className="w-5 h-5 flex items-center justify-center rounded" style={{ color: 'var(--nox-text-3)' }}><RefreshCw className="w-3 h-3" /></button>
      </div>
      <div className="px-2 py-2 flex-shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded" style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}>
          <Search className="w-3 h-3" style={{ color: 'var(--nox-text-3)' }} />
          <input value={tableFilter} onChange={e => setTableFilter(e.target.value)} placeholder="Filter tables…" className="flex-1 bg-transparent text-[10px] font-mono focus:outline-none" style={{ color: 'var(--nox-text)' }} />
          {tableFilter && <button onClick={() => setTableFilter('')} style={{ color: 'var(--nox-text-3)' }}><X className="w-2.5 h-2.5" /></button>}
        </div>
      </div>
      <div className="px-3 pb-1 flex-shrink-0"><span className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: 'var(--nox-text-3)' }}>Tables ({tables.length})</span></div>
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
        {tables.map(table => (
          <div key={table}>
            <button onClick={() => onSelect(table)}
              className="w-full flex items-center gap-1.5 px-3 py-[5px] text-left transition-colors"
              style={{ color: activeTable === table ? 'var(--nox-text)' : 'var(--nox-text-2)', background: activeTable === table ? 'rgba(59,92,204,0.06)' : undefined }}
              onMouseEnter={e => { if (activeTable !== table) e.currentTarget.style.background = 'var(--nox-hover)' }}
              onMouseLeave={e => { if (activeTable !== table) e.currentTarget.style.background = '' }}>
              {activeTable === table ? <ChevronDown className="w-2.5 h-2.5 flex-shrink-0" style={{ color: '#3B5CCC' }} /> : <ChevronRight className="w-2.5 h-2.5 flex-shrink-0" style={{ color: 'var(--nox-text-3)' }} />}
              <Table2 className="w-3 h-3 flex-shrink-0" style={{ color: activeTable === table ? '#3B5CCC' : '#8B5CF6' }} />
              <span className="text-[11px] font-mono truncate">{table}</span>
            </button>
            {activeTable === table && tableColumns[table] && (
              <div className="pb-1">{tableColumns[table].map(col => (
                <div key={col.name} className="flex items-center gap-1.5 px-3 pl-8 py-[2px]">
                  <Hash className="w-2.5 h-2.5 flex-shrink-0" style={{ color: 'var(--nox-text-3)', opacity: 0.3 }} />
                  <span className="text-[10px] font-mono truncate flex-1" style={{ color: 'var(--nox-text-3)' }}>{col.name}</span>
                  <span className="text-[9px] font-mono px-1 py-[1px] rounded flex-shrink-0" style={{ color: typeColor(col.type), background: `${typeColor(col.type)}11` }}>{col.type}</span>
                </div>
              ))}</div>
            )}
          </div>
        ))}
      </div>
      <div className="px-3 py-2 flex-shrink-0" style={{ borderTop: '1px solid var(--nox-border)' }}>
        <div className="flex items-center gap-1.5"><Zap className="w-2.5 h-2.5" style={{ color: '#10B981' }} /><span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{footer}</span></div>
      </div>
    </div>
  )
}

function ResultCell({ row, rowIndex, col, editing, changed, editValue, setEditValue, editInputRef, commitEdit, cancelEdit, startCellEdit, expandedJson, onToggleJson }: Readonly<{
  row: any; rowIndex: number; col: string; editing: boolean; changed: boolean
  editValue: string; setEditValue: (v: string) => void; editInputRef: React.Ref<HTMLInputElement>
  commitEdit: () => void; cancelEdit: () => void; startCellEdit: (row: number, col: string, val: unknown) => void
  expandedJson: Set<string>; onToggleJson: (k: string) => void
}>) {
  const val = row[col]
  const isNull = val == null
  return (
    <div className="px-3 py-[5px] whitespace-nowrap overflow-hidden text-ellipsis" style={{ color: isNull ? 'var(--nox-text-3)' : 'var(--nox-text)', borderBottom: '1px solid var(--nox-border)', background: changed ? 'rgba(245,158,11,0.12)' : undefined, transition: 'background 0.5s' }}
      onDoubleClick={e => { e.stopPropagation(); startCellEdit(rowIndex, col, val) }}>
      {editing ? (
        <input ref={editInputRef} value={editValue} onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit} onKeyDown={e => {
            if (e.key === 'Enter') commitEdit()
            if (e.key === 'Escape') cancelEdit()
          }}
          className="bg-transparent text-[11px] font-mono px-0 py-0 focus:outline-none w-full" style={{ color: 'var(--nox-text)', borderBottom: '1px solid #3B5CCC' }} />
      ) : (
        <SmartCell value={val} cellKey={`${rowIndex}-${col}`} expandedJson={expandedJson} onToggleJson={onToggleJson} />
      )}
    </div>
  )
}

function RowDetailPanel({ columns, row, rowNumber, onClose }: Readonly<{
  columns: string[]; row: any; rowNumber: number; onClose: () => void
}>) {
  return (
    <div className="flex-shrink-0 flex flex-col overflow-hidden" style={{ width: 300, borderLeft: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
      <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--nox-border)' }}>
        <span className="text-[11px] font-semibold flex-1" style={{ color: 'var(--nox-text)' }}>Row {rowNumber}</span>
        <button onClick={onClose} style={{ color: 'var(--nox-text-3)' }}><X className="w-3 h-3" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3" style={{ scrollbarWidth: 'thin' }}>
        {columns.map(col => {
          const val = row[col]
          if (val == null) {
            return (
              <div key={col} className="mb-3">
                <p className="text-[9px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: 'var(--nox-text-3)' }}>{col}</p>
                <p className="text-[11px] font-mono italic opacity-40" style={{ color: 'var(--nox-text-3)' }}>NULL</p>
              </div>
            )
          }
          const str = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)
          return (
            <div key={col} className="mb-3">
              <p className="text-[9px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: 'var(--nox-text-3)' }}>{col}</p>
              <pre className="text-[11px] font-mono break-all leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--nox-text)' }}>{str}</pre>
            </div>
          )
        })}
      </div>
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
function tryParseJsonCell(value: any, str: string): any {
  if (typeof value === 'object') return value
  if (!isJsonString(str)) return null
  try { return JSON.parse(str) } catch { return null }
}

// JSON object/array — expandable inline
function JsonCell({ parsed, expanded, onToggle }: Readonly<{ parsed: any; expanded: boolean; onToggle: () => void }>) {
  return (
    <span>
      <button onClick={e => { e.stopPropagation(); onToggle() }}
        className="inline-flex items-center gap-0.5 px-1 py-[1px] rounded text-[9px] font-mono font-medium"
        style={{ color: '#8B5CF6', background: 'rgba(139,92,246,0.08)' }}>
        {Array.isArray(parsed) ? `[${parsed.length}]` : `{${Object.keys(parsed).length}}`}
        <ChevronRight className="w-2 h-2" style={{ transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s' }} />
      </button>
      {expanded && (
        <pre className="mt-1 text-[10px] font-mono leading-relaxed whitespace-pre-wrap" style={{ color: '#8B5CF6' }}>{JSON.stringify(parsed, null, 2)}</pre>
      )}
    </span>
  )
}

function SmartCell({ value, cellKey, expandedJson, onToggleJson }: Readonly<{
  value: any; cellKey: string; expandedJson: Set<string>; onToggleJson: (k: string) => void
}>) {
  if (value == null) return <span className="italic opacity-40">NULL</span>

  const str = typeof value === 'object' ? JSON.stringify(value) : String(value)

  const parsed = tryParseJsonCell(value, str)
  if (parsed) {
    return <JsonCell parsed={parsed} expanded={expandedJson.has(cellKey)} onToggle={() => onToggleJson(cellKey)} />
  }

  // URL — clickable link
  if (URL_RE.test(str)) {
    return (
      <span className="inline-flex items-center gap-1" style={{ color: '#3B5CCC' }}>
        <a href={str} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-70">{str.length > 60 ? str.slice(0, 57) + '…' : str}</a>
        <ExternalLink className="w-2.5 h-2.5 flex-shrink-0 opacity-40" />
      </span>
    )
  }

  // Hex color — swatch
  if (HEX_COLOR_RE.test(str)) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: str, border: '1px solid var(--nox-border)' }} />
        <span className="font-mono">{str}</span>
      </span>
    )
  }

  // ISO timestamp — show relative time tooltip
  if (ISO_DATE_RE.test(str)) {
    const d = new Date(str)
    if (!Number.isNaN(d.getTime())) {
      return (
        <span title={str} style={{ color: '#3B5CCC' }}>
          {d.toLocaleString()} <span className="text-[9px] opacity-50">({relativeTime(d)})</span>
        </span>
      )
    }
  }

  // Boolean
  if (typeof value === 'boolean') {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="w-2 h-2 rounded-full" style={{ background: value ? '#10B981' : '#EF4444' }} />
        <span>{str}</span>
      </span>
    )
  }

  return <span title={str}>{str}</span>
}

/* ── Explain tree visualizer ───────────────────────────────────────────── */

function explainCostColor(costPct: number): string {
  if (costPct > 70) return '#EF4444'
  if (costPct > 40) return '#F59E0B'
  return '#10B981'
}

function ExplainTreeView({ node, maxCost, depth }: Readonly<{ node: ExplainNode; maxCost: number; depth: number }>) {
  const [expanded, setExpanded] = useState(true)
  const costPct = maxCost > 0 ? Math.max(2, (node.cost / maxCost) * 100) : 0
  const costColor = explainCostColor(costPct)

  return (
    <div style={{ marginLeft: depth > 0 ? 24 : 0 }}>
      <div className="flex items-start gap-2 mb-1.5 group">
        {node.children.length > 0 ? (
          <button onClick={() => setExpanded(!expanded)} className="w-4 h-4 flex items-center justify-center flex-shrink-0 rounded" style={{ color: 'var(--nox-text-3)', marginTop: 2 }}>
            <ChevronRight className="w-3 h-3" style={{ transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s' }} />
          </button>
        ) : <div className="w-4" />}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-semibold font-mono" style={{ color: 'var(--nox-text)' }}>{node.type}</span>
            {node.relation && <span className="text-[10px] font-mono px-1.5 py-[1px] rounded" style={{ color: '#8B5CF6', background: 'rgba(139,92,246,0.08)' }}>on {node.relation}</span>}
          </div>

          {/* Cost bar */}
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-[6px] rounded-full overflow-hidden" style={{ background: 'var(--nox-active)', maxWidth: 200 }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${costPct}%`, background: costColor }} />
            </div>
            <span className="text-[9px] font-mono whitespace-nowrap" style={{ color: costColor }}>cost {node.cost.toFixed(1)}</span>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>est. {node.rows} rows</span>
            {node.width !== undefined && <span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>width {node.width}</span>}
            {node.actualTime !== undefined && <span className="text-[9px] font-mono" style={{ color: '#3B5CCC' }}>actual {node.actualTime.toFixed(2)}ms</span>}
            {node.actualRows !== undefined && <span className="text-[9px] font-mono" style={{ color: '#3B5CCC' }}>actual {node.actualRows} rows</span>}
          </div>
        </div>
      </div>

      {expanded && node.children.map((child, i) => (
        <ExplainTreeView key={`${child.type}-${child.relation ?? i}`} node={child} maxCost={maxCost} depth={depth + 1} />
      ))}
    </div>
  )
}

// Identifier quoting per dialect — values themselves always travel as bind
// parameters, never interpolated into the SQL string.
function quoteIdent(name: string, dbType: string): string {
  if (dbType === 'mysql' || dbType === 'mariadb') return '`' + name.replaceAll('`', '``') + '`'
  return '"' + name.replaceAll('"', '""') + '"'
}

function bindPlaceholder(dbType: string, n: number): string {
  return dbType === 'mysql' || dbType === 'mariadb' ? '?' : `$${n}`
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function toEditable(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function filterTables(tables: string[], filter: string): string[] {
  if (!filter) return tables
  return tables.filter(t => t.toLowerCase().includes(filter.toLowerCase()))
}

function getDetailRow(rows: any[], selectedRow: number | null): any {
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
  return <button onClick={onClick} title={title} className="w-6 h-6 flex items-center justify-center rounded mr-0.5" style={{ color: active ? '#3B5CCC' : 'var(--nox-text-3)' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--nox-hover)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>{children}</button>
}

function typeColor(type: string): string {
  const t = type.toLowerCase()
  if (t.includes('int') || t.includes('serial') || t.includes('numeric') || t.includes('decimal') || t.includes('float') || t.includes('double')) return '#F59E0B'
  if (t.includes('text') || t.includes('char') || t.includes('varchar') || t.includes('string')) return '#10B981'
  if (t.includes('bool')) return '#EC4899'
  if (t.includes('time') || t.includes('date')) return '#3B5CCC'
  if (t.includes('json')) return '#8B5CF6'
  if (t.includes('uuid')) return '#06B6D4'
  return 'var(--nox-text-3)'
}
