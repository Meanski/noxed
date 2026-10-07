import { ChevronDown, ChevronRight, Database, Hash, RefreshCw, Search, Table2, X, Zap } from 'lucide-react'
import type { TableColumn } from './types'

export default function SchemaSidebar({ dbLabel, footer, tables, tableFilter, setTableFilter, activeTable, tableColumns, onSelect, onRefresh }: Readonly<{
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
