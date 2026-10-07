import { Copy, Download, PanelRightClose, PanelRightOpen, Plus, Trash2 } from 'lucide-react'
import type { ActivePanel, QueryResult } from './types'

export default function ResultsTabsBar({ activePanel, onSelect, results, hasExplain, historyCount, savedCount, detailOpen, onCopy, onExport, onToggleDetail, rowActions }: Readonly<{
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
      <PanelTab active={activePanel === 'diagram'} onClick={() => onSelect('diagram')}>Diagram</PanelTab>
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

function PanelTab({ active, onClick, badge, children }: Readonly<{ active: boolean; onClick: () => void; badge?: number; children: React.ReactNode }>) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 px-4 py-2 text-[11px] font-medium relative" style={{ color: active ? 'var(--nox-text)' : 'var(--nox-text-2)' }}>
      {children}
      {badge !== undefined && badge > 0 && <span className="text-[9px] font-mono px-1.5 py-[1px] rounded-full" style={{ background: active ? 'rgba(59,92,204,0.1)' : 'var(--nox-active)', color: active ? '#3B5CCC' : 'var(--nox-text-2)' }}>{badge}</span>}
      {active && <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full" style={{ background: '#3B5CCC' }} />}
    </button>
  )
}

function TinyBtn({ title, onClick, active, children }: Readonly<{ title: string; onClick: () => void; active?: boolean; children: React.ReactNode }>) {
  return <button type="button" onClick={onClick} title={title} aria-label={title} className="w-6 h-6 flex items-center justify-center rounded mr-0.5" style={{ color: active ? '#3B5CCC' : 'var(--nox-text-2)' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--nox-hover)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>{children}</button>
}
