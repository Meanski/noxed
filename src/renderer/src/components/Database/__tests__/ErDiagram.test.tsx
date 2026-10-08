// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import ErDiagram from '../ErDiagram'
import { installWindowApi } from '../../../__tests__/harness'

const schema = {
  tables: [
    { name: 'users', columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'email', type: 'text', nullable: true }], primaryKey: ['id'] },
    { name: 'orders', columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'user_id', type: 'int', nullable: false }], primaryKey: ['id'] },
  ],
  foreignKeys: [{ name: 'orders_user', table: 'orders', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
  truncated: false,
}

function setup(schemaImpl = vi.fn().mockResolvedValue(schema)) {
  const api = installWindowApi({ database: { schema: schemaImpl } })
  const onOpenTable = vi.fn()
  render(<ErDiagram clientId="db-1" onOpenTable={onOpenTable} />)
  return { api, onOpenTable }
}

beforeEach(() => cleanup())

describe('ErDiagram', () => {
  it('draws each table with its keys and opens a table when clicked', async () => {
    const { onOpenTable } = setup()
    expect(await screen.findByText('2 tables · 1 relationships')).toBeTruthy()
    expect(screen.getAllByLabelText('primary key')).toHaveLength(2)
    expect(screen.getByLabelText('foreign key')).toBeTruthy()
    expect(document.querySelectorAll('path[marker-end]')).toHaveLength(1)
    fireEvent.click(screen.getByTitle('Browse orders'))
    expect(onOpenTable).toHaveBeenCalledWith('orders')
  })

  it('zooms with the buttons and the wheel, within limits', async () => {
    setup()
    await screen.findByText('100%')
    fireEvent.click(screen.getByTitle('Zoom in'))
    expect(screen.getByText('120%')).toBeTruthy()
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByTitle('Zoom out'))
    expect(screen.getByText('15%')).toBeTruthy()
    const viewport = screen.getByTitle('Browse users').closest('.cursor-grab') as HTMLElement
    fireEvent.wheel(viewport, { deltaY: -100, clientX: 10, clientY: 10 })
    expect(screen.getByText('17%')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Fit to view'))
  })

  it('pans by dragging the background', async () => {
    setup()
    await screen.findByText('100%')
    const viewport = screen.getByTitle('Browse users').closest('.cursor-grab') as HTMLElement
    const canvas = viewport.firstElementChild as HTMLElement
    const before = canvas.style.transform
    fireEvent.pointerDown(viewport, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(viewport, { clientX: 140, clientY: 120 })
    fireEvent.pointerUp(viewport)
    expect(canvas.style.transform).not.toBe(before)
    fireEvent.pointerMove(viewport, { clientX: 400, clientY: 400 })
  })

  it('highlights matching tables', async () => {
    setup()
    await screen.findByText('100%')
    fireEvent.change(screen.getByLabelText('Highlight tables'), { target: { value: 'ord' } })
    expect((screen.getByTitle('Browse orders') as HTMLElement).style.border).toContain('rgb(59, 92, 204)')
  })

  it('exports an SVG and reloads the schema', async () => {
    const { api } = setup()
    await screen.findByText('100%')
    const blobs: Blob[] = []
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:x' })
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByTitle('Export SVG'))
    expect(click).toHaveBeenCalled()
    // Keys survive the export as text markers.
    const svg = await blobs[0].text()
    expect(svg).toContain('PK id int')
    expect(svg).toContain('FK user_id int')
    expect(svg).toContain('>email text<')
    fireEvent.click(screen.getByTitle('Reload schema'))
    await waitFor(() => expect(api.database.schema).toHaveBeenCalledTimes(2))
  })

  it('shows an empty state, a truncation note, and errors with retry', async () => {
    setup(vi.fn().mockResolvedValue({ tables: [], foreignKeys: [], truncated: false }))
    expect(await screen.findByText('This database has no tables.')).toBeTruthy()
    cleanup()
    setup(vi.fn().mockResolvedValue({ ...schema, truncated: true }))
    expect(await screen.findByText(/showing the first 300 tables/)).toBeTruthy()
    cleanup()
    const failing = vi.fn().mockRejectedValueOnce(new Error('permission denied for schema')).mockResolvedValue(schema)
    setup(failing)
    expect(await screen.findByText('permission denied for schema')).toBeTruthy()
    fireEvent.click(screen.getByText('Retry'))
    expect(await screen.findByText('2 tables · 1 relationships')).toBeTruthy()
  })
})
