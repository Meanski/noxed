import { X } from 'lucide-react'

export default function RowDetailPanel({ columns, row, rowNumber, onClose }: Readonly<{
  columns: string[]; row: Record<string, unknown>; rowNumber: number; onClose: () => void
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
