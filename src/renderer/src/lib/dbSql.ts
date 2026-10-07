// SQL for browsing and editing table rows. Identifiers are quoted per dialect;
// values always travel as bind parameters, never inside the SQL string.

export type QueryParam = string | number | boolean | null

export interface Statement {
  sql: string
  params: QueryParam[]
}

const isMysqlFamily = (dbType: string) => dbType === 'mysql' || dbType === 'mariadb'

export function quoteIdent(name: string, dbType: string): string {
  if (isMysqlFamily(dbType)) return '`' + name.replaceAll('`', '``') + '`'
  return '"' + name.replaceAll('"', '""') + '"'
}

/** The n-th (1-based) bind placeholder: `?` for MySQL/MariaDB, `$n` for Postgres. */
export function bindPlaceholder(dbType: string, n: number): string {
  return isMysqlFamily(dbType) ? '?' : `$${n}`
}

/** Converts a cell value (as returned by the driver) into a bindable parameter. */
export function toParam(value: unknown): QueryParam {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

export function selectRows(table: string, dbType: string, limit: number): string {
  return `SELECT * FROM ${quoteIdent(table, dbType)} LIMIT ${Math.max(1, Math.floor(limit))}`
}

// `WHERE pk1 = $n AND pk2 = $n+1` identifying exactly one row by its key.
function rowWhere(primaryKey: readonly string[], row: Record<string, unknown>, dbType: string, firstParam: number): Statement {
  if (primaryKey.length === 0) throw new Error('This table has no primary key, so rows can’t be identified safely')
  const params: QueryParam[] = []
  const clauses = primaryKey.map((col, i) => {
    const value = row[col]
    if (value === null || value === undefined) throw new Error(`Primary key column ${col} has no value`)
    params.push(toParam(value))
    return `${quoteIdent(col, dbType)} = ${bindPlaceholder(dbType, firstParam + i)}`
  })
  return { sql: clauses.join(' AND '), params }
}

export function buildUpdate(
  table: string, column: string, value: QueryParam, primaryKey: readonly string[], row: Record<string, unknown>, dbType: string,
): Statement {
  const where = rowWhere(primaryKey, row, dbType, 2)
  return {
    sql: `UPDATE ${quoteIdent(table, dbType)} SET ${quoteIdent(column, dbType)} = ${bindPlaceholder(dbType, 1)} WHERE ${where.sql}`,
    params: [value, ...where.params],
  }
}

export function buildDelete(table: string, primaryKey: readonly string[], row: Record<string, unknown>, dbType: string): Statement {
  const where = rowWhere(primaryKey, row, dbType, 1)
  return { sql: `DELETE FROM ${quoteIdent(table, dbType)} WHERE ${where.sql}`, params: where.params }
}

/** INSERT of the given columns; omitted columns take their database default. */
export function buildInsert(table: string, values: Readonly<Record<string, QueryParam>>, dbType: string): Statement {
  const columns = Object.keys(values)
  if (columns.length === 0) {
    const sql = isMysqlFamily(dbType)
      ? `INSERT INTO ${quoteIdent(table, dbType)} () VALUES ()`
      : `INSERT INTO ${quoteIdent(table, dbType)} DEFAULT VALUES`
    return { sql, params: [] }
  }
  return {
    sql: `INSERT INTO ${quoteIdent(table, dbType)} (${columns.map((c) => quoteIdent(c, dbType)).join(', ')}) VALUES (${columns
      .map((_, i) => bindPlaceholder(dbType, i + 1))
      .join(', ')})`,
    params: columns.map((c) => values[c]),
  }
}

/** A cell value as editable text: objects become JSON, null becomes empty. */
export function toEditable(v: unknown): string {
  if (v == null) return ''
  switch (typeof v) {
    case 'string':
      return v
    case 'number':
    case 'boolean':
    case 'bigint':
      return v.toString()
    default:
      return JSON.stringify(v) ?? ''
  }
}
