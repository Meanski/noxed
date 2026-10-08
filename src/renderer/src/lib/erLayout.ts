import dagre from '@dagrejs/dagre'

export interface SchemaTable {
  name: string
  columns: { name: string; type: string; nullable: boolean }[]
  primaryKey: string[]
}

export interface SchemaForeignKey {
  name: string
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
}

export interface ErNode extends SchemaTable {
  x: number
  y: number
  width: number
  height: number
  /** Columns shown in the box; the rest are summarised as "+N more". */
  shownColumns: SchemaTable['columns']
  foreignKeyColumns: Set<string>
}

export interface ErEdge {
  id: string
  from: string
  to: string
  label: string
  points: { x: number; y: number }[]
}

export interface ErLayout {
  nodes: ErNode[]
  edges: ErEdge[]
  width: number
  height: number
}

export const ER_HEADER_HEIGHT = 30
export const ER_ROW_HEIGHT = 20
const MAX_SHOWN_COLUMNS = 20
const CHAR_WIDTH = 6.6
const MIN_WIDTH = 170
const MAX_WIDTH = 340

function boxWidth(table: SchemaTable): number {
  const longest = Math.max(
    table.name.length + 4,
    ...table.columns.map((c) => c.name.length + c.type.length + 6),
  )
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest * CHAR_WIDTH)))
}

/** Positions tables left-to-right along their foreign keys and routes each relationship. */
export function computeErLayout(tables: readonly SchemaTable[], foreignKeys: readonly SchemaForeignKey[]): ErLayout {
  const g = new dagre.graphlib.Graph({ multigraph: true })
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 90, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))

  const fkColumns = new Map<string, Set<string>>()
  for (const fk of foreignKeys) {
    const set = fkColumns.get(fk.table) ?? new Set<string>()
    fk.columns.forEach((c) => set.add(c))
    fkColumns.set(fk.table, set)
  }

  for (const t of tables) {
    const shown = t.columns.slice(0, MAX_SHOWN_COLUMNS)
    const extraRow = t.columns.length > shown.length ? 1 : 0
    g.setNode(t.name, { width: boxWidth(t), height: ER_HEADER_HEIGHT + (shown.length + extraRow) * ER_ROW_HEIGHT + 6 })
  }
  // Each constraint is its own edge, so two FKs between the same tables both show.
  for (const fk of foreignKeys) g.setEdge(fk.table, fk.refTable, {}, fk.name)

  dagre.layout(g)

  const nodes: ErNode[] = tables.map((t) => {
    const n = g.node(t.name)
    return {
      ...t,
      // dagre reports centres; boxes are positioned by their top-left corner.
      x: n.x - n.width / 2,
      y: n.y - n.height / 2,
      width: n.width,
      height: n.height,
      shownColumns: t.columns.slice(0, MAX_SHOWN_COLUMNS),
      foreignKeyColumns: fkColumns.get(t.name) ?? new Set(),
    }
  })
  const edges: ErEdge[] = foreignKeys.map((fk) => ({
    id: `${fk.table}.${fk.name}`,
    from: fk.table,
    to: fk.refTable,
    label: `${fk.columns.join(', ')} → ${fk.refTable}.${fk.refColumns.join(', ')}`,
    points: g.edge({ v: fk.table, w: fk.refTable, name: fk.name }).points,
  }))
  const graph = g.graph()
  return { nodes, edges, width: graph.width ?? 0, height: graph.height ?? 0 }
}

/** SVG path through dagre's edge points. */
export function edgePath(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${Math.round(p.x)},${Math.round(p.y)}`).join(' ')
}

/** Scale and offset that fit a layout inside a viewport, never zooming past 100%. */
export function fitTransform(layout: Pick<ErLayout, 'width' | 'height'>, viewWidth: number, viewHeight: number) {
  if (!layout.width || !layout.height || !viewWidth || !viewHeight) return { x: 0, y: 0, scale: 1 }
  const scale = Math.min(1, viewWidth / layout.width, viewHeight / layout.height)
  return {
    x: (viewWidth - layout.width * scale) / 2,
    y: (viewHeight - layout.height * scale) / 2,
    scale,
  }
}
