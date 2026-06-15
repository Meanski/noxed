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
  return (s[0] === '{' && s[s.length - 1] === '}') || (s[0] === '[' && s[s.length - 1] === ']')
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

export default function DatabaseExplorer({ tab }: { tab: Tab }) {
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
    const rows = results.rows.map(r => results.columns.map(c => { const v = r[c]; if (v == null) return ''; const s = String(v); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s }).join(',')).join('\n')
    const blob = new Blob([`${h}\n${rows}`], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${browsingTable || 'query'}-results.csv`; a.click(); URL.revokeObjectURL(a.href); showToast('Exported')
  }

  async function commitEdit() {
    if (!clientId || !editingCell || !results || !browsingTable) { setEditingCell(null); return }
    const row = results.rows[editingCell.row]; const col = editingCell.col
    if (String(row[col] ?? '') === editValue) { setEditingCell(null); return }
    const pk = results.columns.includes('id') ? 'id' : results.columns[0]
    const pkVal = row[pk]; if (pkVal == null) { showToast('No primary key to identify row'); setEditingCell(null); return }
    const newVal = editValue === '' ? 'NULL' : `'${editValue.replace(/'/g, "''")}'`
    const pkLit = typeof pkVal === 'number' ? pkVal : `'${String(pkVal).replace(/'/g, "''")}'`
    try {
      await window.api.database.query(clientId, `UPDATE "${browsingTable}" SET "${col}" = ${newVal} WHERE "${pk}" = ${pkLit}`)
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
    const onMove = (ev: MouseEvent) => { if (!resizingRef.current) return; setEditorHeight(Math.max(40, Math.min(400, startH + (ev.clientY - startY)))) }
    const onUp = () => { resizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }

  const sortedRows = useMemo(() => {
    if (!results) return []
    if (!resultSort) return results.rows
    const { col, dir } = resultSort
    return [...results.rows].sort((a, b) => {
      const av = a[col], bv = b[col]
      if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [results, resultSort])

  function toggleResultSort(col: string) { setResultSort(s => s?.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }) }

  function toggleJsonExpand(key: string) { setExpandedJson(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n }) }

  const filteredTables = tableFilter ? tables.filter(t => t.toLowerCase().includes(tableFilter.toLowerCase())) : tables
  const dbType = session?.dbType === 'mysql' ? 'MySQL' : session?.dbType === 'mariadb' ? 'MariaDB' : 'PostgreSQL'
  const detailRow = selectedRow !== null && results ? sortedRows[selectedRow] : null
  const resultsTableWidth = results ? 48 + results.columns.length * 160 : 0
  const resultsGridColumns = results ? `48px repeat(${results.columns.length}, 160px)` : undefined

  if (connecting) return <div className="flex items-center justify-center h-full" style={{ background: 'var(--nox-bg)' }}><div className="text-center"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-3" style={{ color: '#3B5CCC' }} /><p className="text-[11px]" style={{ color: 'var(--nox-text-2)' }}>Connecting to {session?.databaseName || session?.host}</p></div></div>
  if (error && !clientId) return <div className="flex items-center justify-center h-full" style={{ background: 'var(--nox-bg)' }}><div className="text-center max-w-md px-6"><AlertTriangle className="w-6 h-6 mx-auto mb-3" style={{ color: '#EF4444' }} /><p className="text-[10px] mb-4 font-mono" style={{ color: 'var(--nox-text-3)' }}>{error}</p><button onClick={connect} className="px-4 py-1.5 rounded text-[11px] text-white" style={{ background: '#3B5CCC' }}>Retry</button></div></div>

  return (
    <div className="flex h-full w-full min-w-0 min-h-0 overflow-hidden" style={{ background: 'var(--nox-bg)' }}>
      {/* Schema sidebar */}
      <div className="flex flex-col flex-shrink-0 overflow-hidden" style={{ width: 240, borderRight: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
        <div className="flex items-center gap-2 px-3 flex-shrink-0" style={{ height: 36, borderBottom: '1px solid var(--nox-border)' }}>
          <Database className="w-3.5 h-3.5" style={{ color: '#3B5CCC' }} />
          <p className="text-[11px] font-semibold truncate flex-1" style={{ color: 'var(--nox-text)' }}>{session?.databaseName || 'Database'}</p>
          <button onClick={() => refreshTables()} className="w-5 h-5 flex items-center justify-center rounded" style={{ color: 'var(--nox-text-3)' }}><RefreshCw className="w-3 h-3" /></button>
        </div>
        <div className="px-2 py-2 flex-shrink-0">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded" style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)' }}>
            <Search className="w-3 h-3" style={{ color: 'var(--nox-text-3)' }} />
            <input value={tableFilter} onChange={e => setTableFilter(e.target.value)} placeholder="Filter tables…" className="flex-1 bg-transparent text-[10px] font-mono focus:outline-none" style={{ color: 'var(--nox-text)' }} />
            {tableFilter && <button onClick={() => setTableFilter('')} style={{ color: 'var(--nox-text-3)' }}><X className="w-2.5 h-2.5" /></button>}
          </div>
        </div>
        <div className="px-3 pb-1 flex-shrink-0"><span className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: 'var(--nox-text-3)' }}>Tables ({filteredTables.length})</span></div>
        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {filteredTables.map(table => (
            <div key={table}>
              <button onClick={() => selectTable(table)}
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
          <div className="flex items-center gap-1.5"><Zap className="w-2.5 h-2.5" style={{ color: '#10B981' }} /><span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{dbType} · {session?.host}:{session?.port}</span></div>
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 flex-shrink-0" style={{ height: 36, borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <button onClick={() => runQuery()} disabled={running || !sql.trim()} className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium disabled:opacity-30" style={{ background: running ? 'var(--nox-active)' : '#3B5CCC', color: running ? 'var(--nox-text-2)' : '#fff' }}>
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}{running ? 'Running…' : 'Run'}
          </button>
          <button onClick={runExplain} disabled={running || explainRunning || !sql.trim()} className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium disabled:opacity-30" style={{ color: activePanel === 'explain' ? '#F59E0B' : 'var(--nox-text-3)', background: activePanel === 'explain' ? 'rgba(245,158,11,0.08)' : undefined }} title="Visualize query execution plan">
            <Activity className="w-3 h-3" /> Explain
          </button>
          <div className="w-px h-4" style={{ background: 'var(--nox-border)' }} />
          <div className="flex items-center gap-1">
            <button onClick={watchActive ? stopWatch : startWatch} disabled={!watchActive && (running || !sql.trim())} className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium disabled:opacity-30" style={{ color: watchActive ? '#10B981' : 'var(--nox-text-3)', background: watchActive ? 'rgba(16,185,129,0.08)' : undefined }} title={watchActive ? 'Stop watching' : 'Auto-refresh query results'}>
              {watchActive ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />} {watchActive ? 'Stop' : 'Watch'}
            </button>
            {watchActive && <span className="text-[9px] font-mono tabular-nums px-1.5 py-0.5 rounded-full animate-pulse" style={{ color: '#10B981', background: 'rgba(16,185,129,0.08)' }}>{watchCountdown}s</span>}
            {!watchActive && (
              <select value={watchSec} onChange={e => setWatchSec(Number(e.target.value))} className="bg-transparent text-[10px] font-mono focus:outline-none cursor-pointer" style={{ color: 'var(--nox-text-3)' }}>
                <option value={2}>2s</option>
                <option value={5}>5s</option>
                <option value={10}>10s</option>
                <option value={30}>30s</option>
              </select>
            )}
          </div>
          <kbd className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ color: 'var(--nox-text-3)', background: 'var(--nox-active)' }}>{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter</kbd>
          <div className="w-px h-4" style={{ background: 'var(--nox-border)' }} />
          <button onClick={saveCurrentQuery} disabled={!sql.trim()} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] disabled:opacity-30" style={{ color: 'var(--nox-text-3)' }} title="Save query"><Pin className="w-3 h-3" /> Save</button>
          <div className="flex-1" />
          <button onClick={() => { setSql(''); setResults(null); setQueryError(null); setBrowsingTable(null); setActiveTable(null); setExplainTree(null) }} className="flex items-center gap-1 px-2 py-1 rounded text-[10px]" style={{ color: 'var(--nox-text-3)' }}><RotateCcw className="w-3 h-3" /> Clear</button>
        </div>

        {/* SQL editor */}
        <div className="flex-shrink-0" style={{ height: editorHeight }}>
          <textarea ref={editorRef} value={sql} onChange={e => setSql(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runQuery() } }} placeholder="SELECT * FROM …" spellCheck={false} className="w-full h-full resize-none text-[12px] font-mono leading-relaxed px-4 py-3 focus:outline-none" style={{ color: 'var(--nox-text)', background: 'var(--nox-bg)', tabSize: 2 }} />
        </div>
        <div className="h-[3px] flex-shrink-0 cursor-row-resize group" style={{ background: 'var(--nox-border)' }} onMouseDown={startResize}><div className="h-full transition-colors group-hover:bg-[#3B5CCC]" /></div>

        {/* Tabs */}
        <div className="flex items-center gap-0 flex-shrink-0" style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
          <PanelTab active={activePanel === 'results'} onClick={() => setActivePanel('results')} badge={results ? results.rowCount : undefined}>Results</PanelTab>
          <PanelTab active={activePanel === 'explain'} onClick={() => setActivePanel('explain')} badge={explainTree ? 1 : undefined}>Explain</PanelTab>
          <PanelTab active={activePanel === 'history'} onClick={() => setActivePanel('history')} badge={history.length || undefined}>History</PanelTab>
          <PanelTab active={activePanel === 'saved'} onClick={() => setActivePanel('saved')} badge={savedQueries.length || undefined}>Saved</PanelTab>
          <div className="flex-1" />
          {results && activePanel === 'results' && <>
            <span className="text-[10px] font-mono mr-2" style={{ color: 'var(--nox-text-3)' }}>{results.columns.length} cols · {results.duration}ms</span>
            <TinyBtn title="Copy" onClick={copyResults}><Copy className="w-3 h-3" /></TinyBtn>
            <TinyBtn title="CSV" onClick={exportCsv}><Download className="w-3 h-3" /></TinyBtn>
            <TinyBtn title={detailOpen ? 'Close detail' : 'Row detail'} onClick={() => setDetailOpen(d => !d)} active={detailOpen}>{detailOpen ? <PanelRightClose className="w-3 h-3" /> : <PanelRightOpen className="w-3 h-3" />}</TinyBtn>
            <div className="w-2" />
          </>}
        </div>

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
                <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
                  <div className="w-full h-full overflow-auto" style={{ scrollbarWidth: 'thin' }}>
                    <div className="text-[11px] font-mono" style={{ width: resultsTableWidth, minWidth: '100%' }}>
                      <div className="sticky top-0 z-20 grid" style={{ gridTemplateColumns: resultsGridColumns }}>
                        <div className="text-right px-2 py-2 text-[10px] font-normal sticky left-0 z-30 whitespace-nowrap" style={{ color: 'var(--nox-text-3)', background: 'var(--nox-shell)', borderBottom: '2px solid var(--nox-border)' }}>#</div>
                        {results.columns.map(col => (
                          <button key={col} className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap cursor-pointer select-none overflow-hidden text-ellipsis" style={{ color: resultSort?.col === col ? 'var(--nox-text)' : 'var(--nox-text-2)', background: 'var(--nox-shell)', borderBottom: '2px solid var(--nox-border)' }} onClick={() => toggleResultSort(col)}>
                            {col}{resultSort?.col === col && <ArrowUpDown className="w-2.5 h-2.5 inline-block ml-1" style={{ transform: resultSort.dir === 'desc' ? 'scaleY(-1)' : undefined }} />}
                          </button>
                        ))}
                      </div>
                      {sortedRows.map((row, i) => (
                        <div key={i} onClick={() => setSelectedRow(i === selectedRow ? null : i)} className="grid cursor-default transition-colors" style={{ gridTemplateColumns: resultsGridColumns, background: selectedRow === i ? 'rgba(59,92,204,0.06)' : undefined }} onMouseEnter={e => { if (selectedRow !== i) e.currentTarget.style.background = 'var(--nox-hover)' }} onMouseLeave={e => { if (selectedRow !== i) e.currentTarget.style.background = '' }}>
                          <div className="text-right px-2 py-[5px] text-[10px] sticky left-0 z-10 whitespace-nowrap" style={{ color: 'var(--nox-text-3)', background: selectedRow === i ? 'rgba(59,92,204,0.06)' : 'var(--nox-bg)', borderBottom: '1px solid var(--nox-border)' }}>{i + 1}</div>
                          {results.columns.map(col => {
                            const val = row[col]; const isNull = val == null
                            const isEditing = editingCell?.row === i && editingCell?.col === col
                            const cellKey = `${i}-${col}`
                            return (
                              <div key={col} className="px-3 py-[5px] whitespace-nowrap overflow-hidden text-ellipsis" style={{ color: isNull ? 'var(--nox-text-3)' : 'var(--nox-text)', borderBottom: '1px solid var(--nox-border)', background: changedCells.has(`${i}-${col}`) ? 'rgba(245,158,11,0.12)' : undefined, transition: 'background 0.5s' }}
                                onDoubleClick={e => { e.stopPropagation(); if (browsingTable) { setEditingCell({ row: i, col }); setEditValue(isNull ? '' : String(val)); setTimeout(() => editInputRef.current?.focus(), 0) } }}>
                                {isEditing ? (
                                  <input ref={editInputRef} value={editValue} onChange={e => setEditValue(e.target.value)}
                                    onBlur={commitEdit} onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingCell(null) }}
                                    className="bg-transparent text-[11px] font-mono px-0 py-0 focus:outline-none w-full" style={{ color: 'var(--nox-text)', borderBottom: '1px solid #3B5CCC' }} />
                                ) : (
                                  <SmartCell value={val} cellKey={cellKey} expandedJson={expandedJson} onToggleJson={toggleJsonExpand} />
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                    {sortedRows.length === 0 && <div className="flex items-center justify-center py-12"><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>No rows</p></div>}
                  </div>
                </div>
              )}
              {!results && !queryError && !running && (
                <div className="flex items-center justify-center flex-1 min-h-0 w-full"><div className="text-center"><Database className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--nox-text-3)', opacity: 0.12 }} /><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>Click a table to browse, or write a query</p></div></div>
              )}
              {running && <div className="flex items-center justify-center flex-1 min-h-0 w-full gap-2"><Loader2 className="w-4 h-4 animate-spin" style={{ color: '#3B5CCC' }} /><span className="text-[11px]" style={{ color: 'var(--nox-text-2)' }}>Running…</span></div>}
            </div>

            {/* Row detail panel */}
            {detailOpen && detailRow && results && (
              <div className="flex-shrink-0 flex flex-col overflow-hidden" style={{ width: 300, borderLeft: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
                <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--nox-border)' }}>
                  <span className="text-[11px] font-semibold flex-1" style={{ color: 'var(--nox-text)' }}>Row {selectedRow! + 1}</span>
                  <button onClick={() => setDetailOpen(false)} style={{ color: 'var(--nox-text-3)' }}><X className="w-3 h-3" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-3" style={{ scrollbarWidth: 'thin' }}>
                  {results.columns.map(col => {
                    const val = detailRow[col]; const isNull = val == null
                    const str = isNull ? null : typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)
                    return (
                      <div key={col} className="mb-3">
                        <p className="text-[9px] uppercase tracking-wider font-semibold mb-0.5" style={{ color: 'var(--nox-text-3)' }}>{col}</p>
                        {isNull ? <p className="text-[11px] font-mono italic opacity-40" style={{ color: 'var(--nox-text-3)' }}>NULL</p>
                         : <pre className="text-[11px] font-mono break-all leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--nox-text)' }}>{str}</pre>}
                      </div>
                    )
                  })}
                </div>
              </div>
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

          {/* ── History ──────────────────────────────────────────── */}
          {activePanel === 'history' && (
            <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {history.length === 0 ? <div className="flex items-center justify-center h-full"><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>No history</p></div>
              : history.map((h, i) => (
                <button key={i} onClick={() => { setSql(h.sql); setActivePanel('results'); editorRef.current?.focus() }}
                  className="w-full text-left px-4 py-3 transition-colors" style={{ borderBottom: '1px solid var(--nox-border)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--nox-hover)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
                  <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--nox-text-2)' }}>{h.sql.length > 200 ? h.sql.slice(0, 200) + '…' : h.sql}</pre>
                  <div className="flex items-center gap-3 mt-1"><span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{new Date(h.ts).toLocaleTimeString()}</span>{h.duration !== undefined && <span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{h.duration}ms</span>}{h.rows !== undefined && <span className="text-[9px] font-mono" style={{ color: 'var(--nox-text-3)' }}>{h.rows} rows</span>}</div>
                </button>
              ))}
            </div>
          )}

          {/* ── Saved ────────────────────────────────────────────── */}
          {activePanel === 'saved' && (
            <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {savedQueries.length === 0 ? <div className="flex items-center justify-center h-full"><div className="text-center"><Pin className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--nox-text-3)', opacity: 0.2 }} /><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>Save queries with the Pin button</p></div></div>
              : savedQueries.map((q, i) => (
                <button key={i} onClick={() => { setSql(q.sql); setActivePanel('results'); editorRef.current?.focus() }}
                  className="w-full text-left px-4 py-3 transition-colors" style={{ borderBottom: '1px solid var(--nox-border)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--nox-hover)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
                  <p className="text-[11px] font-medium mb-1" style={{ color: 'var(--nox-text)' }}>{q.label}</p>
                  <pre className="text-[10px] font-mono truncate" style={{ color: 'var(--nox-text-3)' }}>{q.sql}</pre>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {toast && <div className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded-lg text-[11px] font-medium" style={{ background: 'var(--nox-surface)', border: '1px solid var(--nox-border)', color: '#3B5CCC', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>{toast}</div>}
    </div>
  )
}

/* ── Smart cell renderer ───────────────────────────────────────────────── */

function SmartCell({ value, cellKey, expandedJson, onToggleJson }: {
  value: any; cellKey: string; expandedJson: Set<string>; onToggleJson: (k: string) => void
}) {
  if (value == null) return <span className="italic opacity-40">NULL</span>

  const str = typeof value === 'object' ? JSON.stringify(value) : String(value)

  // JSON object/array — expandable inline
  if (typeof value === 'object' || isJsonString(str)) {
    const expanded = expandedJson.has(cellKey)
    const parsed = typeof value === 'object' ? value : (() => { try { return JSON.parse(str) } catch { return null } })()
    if (parsed) {
      return (
        <span>
          <button onClick={e => { e.stopPropagation(); onToggleJson(cellKey) }}
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
    if (!isNaN(d.getTime())) {
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

function ExplainTreeView({ node, maxCost, depth }: { node: ExplainNode; maxCost: number; depth: number }) {
  const [expanded, setExpanded] = useState(true)
  const costPct = maxCost > 0 ? Math.max(2, (node.cost / maxCost) * 100) : 0
  const costColor = costPct > 70 ? '#EF4444' : costPct > 40 ? '#F59E0B' : '#10B981'

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
        <ExplainTreeView key={i} node={child} maxCost={maxCost} depth={depth + 1} />
      ))}
    </div>
  )
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function PanelTab({ active, onClick, badge, children }: { active: boolean; onClick: () => void; badge?: number; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 px-4 py-2 text-[11px] font-medium relative" style={{ color: active ? 'var(--nox-text)' : 'var(--nox-text-3)' }}>
      {children}
      {badge !== undefined && badge > 0 && <span className="text-[9px] font-mono px-1.5 py-[1px] rounded-full" style={{ background: active ? 'rgba(59,92,204,0.1)' : 'var(--nox-active)', color: active ? '#3B5CCC' : 'var(--nox-text-3)' }}>{badge}</span>}
      {active && <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full" style={{ background: '#3B5CCC' }} />}
    </button>
  )
}

function TinyBtn({ title, onClick, active, children }: { title: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
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
