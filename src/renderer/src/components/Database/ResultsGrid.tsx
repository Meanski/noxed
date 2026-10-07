import { ArrowUpDown, ChevronRight, ExternalLink } from 'lucide-react'
import { relativeTime } from '../../lib/format'
import { toEditable } from '../../lib/dbSql'
import type { QueryResult, ResultSort } from './types'

// Results table with sortable headers, inline cell editing, and smart cell
// rendering (URLs, colours, dates, collapsible JSON).

const URL_RE = /^https?:\/\/[^\s]+$/i

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function isJsonString(s: string): boolean {
  if (s.length < 2) return false
  return (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))
}

export default function ResultsGrid({ results, sortedRows, resultSort, onToggleSort, selectedRow, onSelectRow, editingCell, editValue, setEditValue, editInputRef, commitEdit, cancelEdit, startCellEdit, changedCells, expandedJson, onToggleJson }: Readonly<{
  results: QueryResult; sortedRows: any[]; resultSort: ResultSort; onToggleSort: (col: string) => void
  selectedRow: number | null; onSelectRow: (i: number | null) => void
  editingCell: { row: Record<string, unknown>; col: string } | null; editValue: string; setEditValue: (v: string) => void
  editInputRef: React.Ref<HTMLInputElement>; commitEdit: () => void; cancelEdit: () => void
  startCellEdit: (row: Record<string, unknown>, col: string, val: unknown) => void
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
        {/* Real table semantics with the CSS grid layout kept via display
            overrides: thead is the header grid, each tr is a row grid (grid
            items blockify, so td/th render like the previous divs), and
            display:contents wrappers keep buttons as direct grid items. */}
        <table className="text-[11px] font-mono" style={{ width: tableWidth, minWidth: '100%', display: 'block' }}>
          <thead className="sticky top-0 z-20 grid" style={{ gridTemplateColumns: gridColumns }}>
            <tr style={{ display: 'contents' }}>
              <th className="text-right px-2 py-2 text-[10px] font-normal sticky left-0 z-30 whitespace-nowrap" style={{ color: 'var(--nox-text-3)', background: 'var(--nox-shell)', borderBottom: '2px solid var(--nox-border)' }}>#</th>
              {results.columns.map(col => (
                <th key={col} style={{ display: 'contents' }}>
                  <button className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap cursor-pointer select-none overflow-hidden text-ellipsis" style={{ color: resultSort?.col === col ? 'var(--nox-text)' : 'var(--nox-text-2)', background: 'var(--nox-shell)', borderBottom: '2px solid var(--nox-border)' }} onClick={() => onToggleSort(col)}>
                    {col}{resultSort?.col === col && <ArrowUpDown className="w-2.5 h-2.5 inline-block ml-1" style={{ transform: resultSort.dir === 'desc' ? 'scaleY(-1)' : undefined }} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          {/* Rows contain interactive cells (JsonCell buttons), so the row keydown
              ignores bubbled events from those child buttons so Enter there
              doesn't both activate and select. tabIndex={-1} lets a clicked row
              take focus so Enter/Space toggles selection on the row itself. */}
          <tbody style={{ display: 'contents' }}>
            {sortedRows.map((row, i) => (
              <tr key={rowKeys[i]} tabIndex={-1} aria-selected={selectedRow === i}
                onClick={() => onSelectRow(i === selectedRow ? null : i)}
                onKeyDown={e => { if (e.target !== e.currentTarget) { return } if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectRow(i === selectedRow ? null : i) } }}
                className="grid cursor-default transition-colors" style={{ gridTemplateColumns: gridColumns, background: selectedRow === i ? 'rgba(59,92,204,0.06)' : undefined }}
                onMouseEnter={e => { if (selectedRow !== i) e.currentTarget.style.background = 'var(--nox-hover)' }} onMouseLeave={e => { if (selectedRow !== i) e.currentTarget.style.background = '' }}>
                <td style={{ display: 'contents' }}>
                  <button type="button" aria-pressed={selectedRow === i} title={`Select row ${i + 1}`}
                    onClick={e => { e.stopPropagation(); onSelectRow(i === selectedRow ? null : i) }}
                    className="text-right px-2 py-[5px] text-[10px] sticky left-0 z-10 whitespace-nowrap" style={{ color: 'var(--nox-text-3)', background: selectedRow === i ? 'rgba(59,92,204,0.06)' : 'var(--nox-bg)', borderBottom: '1px solid var(--nox-border)' }}>{i + 1}</button>
                </td>
                {results.columns.map(col => (
                  <ResultCell key={col} row={row} rowIndex={i} col={col}
                    editing={editingCell?.row === row && editingCell?.col === col}
                    changed={changedCells.has(`${i}-${col}`)}
                    editValue={editValue} setEditValue={setEditValue} editInputRef={editInputRef}
                    commitEdit={commitEdit} cancelEdit={cancelEdit}
                    startCellEdit={startCellEdit}
                    expandedJson={expandedJson} onToggleJson={onToggleJson} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {sortedRows.length === 0 && <div className="flex items-center justify-center py-12"><p className="text-[11px]" style={{ color: 'var(--nox-text-3)' }}>No rows</p></div>}
      </div>
    </div>
  )
}

function ResultCell({ row, rowIndex, col, editing, changed, editValue, setEditValue, editInputRef, commitEdit, cancelEdit, startCellEdit, expandedJson, onToggleJson }: Readonly<{
  row: any; rowIndex: number; col: string; editing: boolean; changed: boolean
  editValue: string; setEditValue: (v: string) => void; editInputRef: React.Ref<HTMLInputElement>
  commitEdit: () => void; cancelEdit: () => void; startCellEdit: (row: Record<string, unknown>, col: string, val: unknown) => void
  expandedJson: Set<string>; onToggleJson: (k: string) => void
}>) {
  const val = row[col]
  const isNull = val == null
  return (
    <td className="px-3 py-[5px] whitespace-nowrap overflow-hidden text-ellipsis" style={{ color: isNull ? 'var(--nox-text-3)' : 'var(--nox-text)', borderBottom: '1px solid var(--nox-border)', background: changed ? 'rgba(245,158,11,0.12)' : undefined, transition: 'background 0.5s' }}
      onDoubleClick={e => { e.stopPropagation(); startCellEdit(row, col, val) }}>
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
    </td>
  )
}

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
