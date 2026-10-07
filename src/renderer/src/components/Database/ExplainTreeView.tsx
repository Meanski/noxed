import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

// Parses Postgres/MySQL JSON EXPLAIN output and renders it as a cost tree.

export interface ExplainNode {
  type: string
  relation?: string
  cost: number
  rows: number
  width?: number
  actualTime?: number
  actualRows?: number
  children: ExplainNode[]
}

export function parseExplainJson(data: any): ExplainNode | null {
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

function explainCostColor(costPct: number): string {
  if (costPct > 70) return '#EF4444'
  if (costPct > 40) return '#F59E0B'
  return '#10B981'
}

export default function ExplainTreeView({ node, maxCost, depth }: Readonly<{ node: ExplainNode; maxCost: number; depth: number }>) {
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
