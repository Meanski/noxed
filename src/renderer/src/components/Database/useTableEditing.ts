import { useRef, useState } from 'react'
import { buildDelete, buildInsert, buildUpdate, coerceLike, toEditable, type QueryParam } from '../../lib/dbSql'
import { ipcErrorMessage } from '../../lib/format'
import type { QueryResult } from './types'

type Row = Record<string, unknown>

interface TableEditingOptions {
  clientId: string | null
  dbType: string
  /** The table being browsed; editing is off for free-form query results. */
  table: string | null
  /** Primary-key columns of `table`, or undefined while still loading. */
  primaryKey: string[] | undefined
  results: QueryResult | null
  setResults: (results: QueryResult) => void
  notify: (message: string) => void
  /** Re-runs the browse query after an insert or delete. */
  reload: () => void
}

/**
 * Row edits for a browsed table. Every write is keyed on the table's real
 * primary key (all of its columns) and must touch exactly one row; tables
 * without a primary key are read-only rather than guessed at.
 */
export function useTableEditing({ clientId, dbType, table, primaryKey, results, setResults, notify, reload }: TableEditingOptions) {
  const [editingCell, setEditingCell] = useState<{ row: Row; col: string } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [pendingDelete, setPendingDelete] = useState<Row | null>(null)
  const [insertOpen, setInsertOpen] = useState(false)
  const editInputRef = useRef<HTMLInputElement>(null)

  const editable = Boolean(clientId && table && primaryKey && primaryKey.length > 0)
  let readOnlyReason: string | null = null
  if (table && primaryKey?.length === 0) readOnlyReason = `${table} has no primary key, so its rows are read-only`

  const run = async (sql: string, params: QueryParam[]) => {
    if (!clientId) throw new Error('Not connected')
    return window.api.database.query(clientId, sql, params)
  }

  const startCellEdit = (row: Row, col: string, value: unknown) => {
    if (!editable) {
      if (readOnlyReason) notify(readOnlyReason)
      return
    }
    setEditingCell({ row, col })
    setEditValue(toEditable(value))
    setTimeout(() => editInputRef.current?.focus(), 0)
  }

  const commitEdit = async () => {
    const cell = editingCell
    setEditingCell(null)
    if (!cell || !editable || !table || !primaryKey || !results) return
    if (toEditable(cell.row[cell.col]) === editValue) return
    const value: QueryParam = editValue === '' ? null : coerceLike(editValue, cell.row[cell.col])
    try {
      const { sql, params } = buildUpdate(table, cell.col, value, primaryKey, cell.row, dbType)
      const result = await run(sql, params)
      if (result.rowCount !== 1) {
        notify(`Update matched ${result.rowCount} rows; reload to see the current data`)
        return
      }
      setResults({ ...results, rows: results.rows.map((r) => (r === cell.row ? { ...r, [cell.col]: value } : r)) })
      notify('Updated')
    } catch (err) {
      notify(`Update failed: ${ipcErrorMessage(err)}`)
    }
  }

  const confirmDelete = async () => {
    const row = pendingDelete
    setPendingDelete(null)
    if (!row || !editable || !table || !primaryKey) return
    try {
      const { sql, params } = buildDelete(table, primaryKey, row, dbType)
      const result = await run(sql, params)
      notify(result.rowCount === 1 ? 'Row deleted' : `Delete matched ${result.rowCount} rows`)
      reload()
    } catch (err) {
      notify(`Delete failed: ${ipcErrorMessage(err)}`)
    }
  }

  const insertRow = async (values: Record<string, QueryParam>): Promise<boolean> => {
    if (!clientId || !table) return false
    try {
      const { sql, params } = buildInsert(table, values, dbType)
      await run(sql, params)
      notify('Row added')
      reload()
      return true
    } catch (err) {
      notify(`Insert failed: ${ipcErrorMessage(err)}`)
      return false
    }
  }

  return {
    editable,
    readOnlyReason,
    editingCell,
    editValue,
    setEditValue,
    editInputRef,
    startCellEdit,
    commitEdit,
    cancelEdit: () => setEditingCell(null),
    pendingDelete,
    requestDelete: (row: Row) => setPendingDelete(row),
    cancelDelete: () => setPendingDelete(null),
    confirmDelete,
    insertOpen,
    openInsert: () => setInsertOpen(true),
    closeInsert: () => setInsertOpen(false),
    insertRow,
  }
}
