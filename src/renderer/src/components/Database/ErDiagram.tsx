import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, KeyRound, Link2, Loader2, Maximize2, Minus, Plus, RefreshCw } from 'lucide-react'
import { computeErLayout, edgePath, ER_HEADER_HEIGHT, ER_ROW_HEIGHT, fitTransform, type ErLayout, type ErNode } from '../../lib/erLayout'
import { ipcErrorMessage } from '../../lib/format'
import { ACCENT } from '../../lib/colors'

interface ErDiagramProps {
  clientId: string
  /** Opens a table in the results grid when its box is clicked. */
  onOpenTable: (table: string) => void
}

type Schema = Awaited<ReturnType<Window['api']['database']['schema']>>
interface View { x: number; y: number; scale: number }

const MIN_SCALE = 0.15
const MAX_SCALE = 2
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

function TableBox({ node, highlighted, onOpen }: Readonly<{ node: ErNode; highlighted: boolean; onOpen: () => void }>) {
  const hidden = node.columns.length - node.shownColumns.length
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Browse ${node.name}`}
      className="absolute text-left rounded-md overflow-hidden shadow-sm"
      style={{
        left: node.x, top: node.y, width: node.width, height: node.height,
        background: 'var(--nox-shell)',
        border: `1px solid ${highlighted ? ACCENT : 'var(--nox-border)'}`,
        boxShadow: highlighted ? `0 0 0 2px ${ACCENT}33` : undefined,
      }}
    >
      <div className="px-2.5 flex items-center font-['Inter'] text-[12px] font-semibold truncate"
        style={{ height: ER_HEADER_HEIGHT, background: 'var(--nox-sidebar)', color: 'var(--nox-text)', borderBottom: '1px solid var(--nox-border)' }}>
        {node.name}
      </div>
      {node.shownColumns.map((c) => (
        <div key={c.name} className="px-2.5 flex items-center gap-1.5 font-['JetBrains_Mono'] text-[10.5px]" style={{ height: ER_ROW_HEIGHT }}>
          <span className="w-3 flex-shrink-0" style={{ color: ACCENT }}>
            {node.primaryKey.includes(c.name) && <KeyRound className="w-3 h-3" aria-label="primary key" />}
            {!node.primaryKey.includes(c.name) && node.foreignKeyColumns.has(c.name) && <Link2 className="w-3 h-3" aria-label="foreign key" />}
          </span>
          <span className="truncate" style={{ color: 'var(--nox-text)' }}>{c.name}</span>
          <span className="ml-auto truncate pl-2" style={{ color: 'var(--nox-text-3)' }}>{c.type}{c.nullable ? '' : ' !'}</span>
        </div>
      ))}
      {hidden > 0 && (
        <div className="px-2.5 font-['Inter'] text-[10.5px]" style={{ height: ER_ROW_HEIGHT, color: 'var(--nox-text-3)' }}>+{hidden} more</div>
      )}
    </button>
  )
}

// Entity-relationship diagram of the connected database: tables laid out
// along their foreign keys, with pan (drag), zoom (wheel/buttons) and fit.
export default function ErDiagram({ clientId, onOpenTable }: Readonly<ErDiagramProps>) {
  const [schema, setSchema] = useState<Schema | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  const load = useCallback(() => {
    setSchema(null)
    setError(null)
    window.api.database.schema(clientId).then(setSchema, (err: unknown) => setError(ipcErrorMessage(err, 'Could not read the schema')))
  }, [clientId])
  useEffect(load, [load])

  const layout: ErLayout | null = useMemo(() => (schema ? computeErLayout(schema.tables, schema.foreignKeys) : null), [schema])

  const fit = useCallback(() => {
    const el = viewportRef.current
    if (layout && el) setView(fitTransform(layout, el.clientWidth, el.clientHeight))
  }, [layout])
  useEffect(fit, [fit])

  const zoomBy = (factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const el = viewportRef.current
      const px = cx ?? (el ? el.clientWidth / 2 : 0)
      const py = cy ?? (el ? el.clientHeight / 2 : 0)
      const scale = clampScale(v.scale * factor)
      // Keep the point under the cursor fixed while zooming.
      return { scale, x: px - ((px - v.x) * scale) / v.scale, y: py - ((py - v.y) * scale) / v.scale }
    })
  }

  const exportSvg = () => {
    if (!layout) return
    const boxes = layout.nodes.map((n) => {
      const rows = n.shownColumns.map((c, i) =>
        `<text x="${n.x + 10}" y="${n.y + ER_HEADER_HEIGHT + ER_ROW_HEIGHT * i + 14}" font-size="10" font-family="monospace">${keyMarker(n, c.name)}${escapeXml(c.name)} ${escapeXml(c.type)}</text>`).join('')
      return `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="4" fill="#fff" stroke="#999"/>` +
        `<text x="${n.x + 10}" y="${n.y + 19}" font-size="12" font-weight="bold" font-family="sans-serif">${escapeXml(n.name)}</text>${rows}`
    }).join('')
    const lines = layout.edges.map((e) => `<path d="${edgePath(e.points)}" fill="none" stroke="#666"/>`).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}">${lines}${boxes}</svg>`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    a.download = 'er-diagram.svg'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-[11px] mb-3" style={{ color: 'var(--nox-danger-text)' }}>{error}</p>
          <button type="button" onClick={load} className="px-3 py-1 rounded text-[11px] text-white" style={{ background: ACCENT }}>Retry</button>
        </div>
      </div>
    )
  }
  if (!layout || !schema) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin" style={{ color: ACCENT }} /></div>
  }

  const q = filter.trim().toLowerCase()
  const matches = (name: string) => q !== '' && name.toLowerCase().includes(q)
  const toolButton = 'w-7 h-7 flex items-center justify-center rounded hover:bg-[var(--nox-hover)]'

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="flex items-center gap-1.5 px-3 py-1.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--nox-border)', background: 'var(--nox-shell)' }}>
        <input
          type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Highlight tables"
          aria-label="Highlight tables"
          className="px-2 py-1 w-44 rounded text-[11px] outline-none"
          style={{ background: 'var(--nox-bg)', border: '1px solid var(--nox-border)', color: 'var(--nox-text)' }}
        />
        <span className="text-[10.5px] ml-1" style={{ color: 'var(--nox-text-3)' }}>
          {schema.tables.length} tables · {schema.foreignKeys.length} relationships{schema.truncated ? ' · showing the first 300 tables' : ''}
        </span>
        <div className="flex-1" />
        <button type="button" className={toolButton} title="Zoom out" onClick={() => zoomBy(1 / 1.2)}><Minus className="w-3.5 h-3.5" /></button>
        <span className="text-[10.5px] w-10 text-center font-mono" style={{ color: 'var(--nox-text-2)' }}>{Math.round(view.scale * 100)}%</span>
        <button type="button" className={toolButton} title="Zoom in" onClick={() => zoomBy(1.2)}><Plus className="w-3.5 h-3.5" /></button>
        <button type="button" className={toolButton} title="Fit to view" onClick={fit}><Maximize2 className="w-3.5 h-3.5" /></button>
        <button type="button" className={toolButton} title="Reload schema" onClick={load}><RefreshCw className="w-3.5 h-3.5" /></button>
        <button type="button" className={toolButton} title="Export SVG" onClick={exportSvg}><Download className="w-3.5 h-3.5" /></button>
      </div>
      {schema.tables.length === 0 ? (
        <p className="flex-1 flex items-center justify-center text-[11px]" style={{ color: 'var(--nox-text-3)' }}>This database has no tables.</p>
      ) : (
        <div
          ref={viewportRef}
          className="relative flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
          style={{ background: 'var(--nox-bg)', touchAction: 'none' }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }
            e.currentTarget.setPointerCapture?.(e.pointerId)
          }}
          onPointerMove={(e) => {
            const start = drag.current
            if (start) setView((v) => ({ ...v, x: e.clientX - start.x, y: e.clientY - start.y }))
          }}
          onPointerUp={() => { drag.current = null }}
          onWheel={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top)
          }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left pointer-events-none"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, width: layout.width, height: layout.height }}
          >
            <svg width={layout.width} height={layout.height} className="absolute inset-0" aria-hidden="true">
              <defs>
                <marker id="er-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--nox-text-3)" />
                </marker>
              </defs>
              {layout.edges.map((e) => (
                <path key={e.id} d={edgePath(e.points)} fill="none" markerEnd="url(#er-arrow)" strokeWidth={matches(e.from) || matches(e.to) ? 2 : 1.2}
                  stroke={matches(e.from) || matches(e.to) ? ACCENT : 'var(--nox-text-3)'}>
                  <title>{e.label}</title>
                </path>
              ))}
            </svg>
            <div className="pointer-events-auto">
              {layout.nodes.map((n) => (
                <TableBox key={n.name} node={n} highlighted={matches(n.name)} onOpen={() => onOpenTable(n.name)} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// The exported diagram's stand-in for the key icons: PK, else FK, else nothing.
function keyMarker(node: ErNode, column: string): string {
  if (node.primaryKey.includes(column)) return 'PK '
  return node.foreignKeyColumns.has(column) ? 'FK ' : ''
}

function escapeXml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
