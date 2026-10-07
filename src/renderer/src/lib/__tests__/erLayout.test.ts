import { describe, it, expect } from 'vitest'
import { computeErLayout, edgePath, fitTransform } from '../erLayout'

const table = (name: string, cols: string[], pk = ['id']) => ({
  name,
  columns: cols.map((c) => ({ name: c, type: 'integer', nullable: false })),
  primaryKey: pk,
})

describe('computeErLayout', () => {
  const tables = [table('users', ['id', 'email']), table('orders', ['id', 'user_id', 'approver_id'])]
  const fks = [
    { name: 'orders_user', table: 'orders', columns: ['user_id'], refTable: 'users', refColumns: ['id'] },
    { name: 'orders_approver', table: 'orders', columns: ['approver_id'], refTable: 'users', refColumns: ['id'] },
  ]

  it('places referencing tables before the tables they reference, left to right', () => {
    const layout = computeErLayout(tables, fks)
    const users = layout.nodes.find((n) => n.name === 'users')!
    const orders = layout.nodes.find((n) => n.name === 'orders')!
    expect(orders.x + orders.width).toBeLessThan(users.x)
    expect(layout.width).toBeGreaterThan(users.x)
  })

  it('keeps every constraint as its own edge and marks FK columns', () => {
    const layout = computeErLayout(tables, fks)
    expect(layout.edges.map((e) => e.id)).toEqual(['orders.orders_user', 'orders.orders_approver'])
    expect(layout.edges[0].label).toBe('user_id → users.id')
    expect(layout.edges[0].points.length).toBeGreaterThan(1)
    expect([...layout.nodes.find((n) => n.name === 'orders')!.foreignKeyColumns]).toEqual(['user_id', 'approver_id'])
  })

  it('caps the columns drawn in a box and sizes it for the "+N more" row', () => {
    const wide = table('wide', Array.from({ length: 25 }, (_, i) => `c${i}`))
    const [node] = computeErLayout([wide], []).nodes
    expect(node.shownColumns).toHaveLength(20)
    expect(node.height).toBe(30 + 21 * 20 + 6)
    expect(node.width).toBeGreaterThanOrEqual(170)
  })
})

describe('edgePath / fitTransform', () => {
  it('draws a polyline through the points', () => {
    expect(edgePath([{ x: 1.4, y: 2.6 }, { x: 10, y: 20 }])).toBe('M1,3 L10,20')
  })

  it('fits large diagrams and never enlarges small ones', () => {
    expect(fitTransform({ width: 2000, height: 1000 }, 1000, 1000)).toEqual({ x: 0, y: 250, scale: 0.5 })
    expect(fitTransform({ width: 100, height: 100 }, 1000, 500)).toEqual({ x: 450, y: 200, scale: 1 })
    expect(fitTransform({ width: 0, height: 0 }, 1000, 500)).toEqual({ x: 0, y: 0, scale: 1 })
  })
})
