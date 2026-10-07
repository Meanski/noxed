import { ValidationError } from './errors'

// Pure helpers for moving table data in and out of files: CSV parsing and
// writing, JSON, and SQL INSERT scripts. No I/O here.

export type Dialect = 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | 'mssql'
export type CellValue = string | number | boolean | null

const isMysqlFamily = (d: Dialect) => d === 'mysql' || d === 'mariadb'

export function quoteIdentifier(name: string, dialect: Dialect): string {
  if (isMysqlFamily(dialect)) return '`' + name.replaceAll('`', '``') + '`'
  if (dialect === 'mssql') return '[' + name.replaceAll(']', ']]') + ']'
  return '"' + name.replaceAll('"', '""') + '"'
}

/** Every row of a table (all columns, or the given select list), capped: SQL Server spells LIMIT as TOP. */
export function selectAll(table: string, dialect: Dialect, limit: number, columns = '*'): string {
  const n = Math.max(1, Math.floor(limit))
  return dialect === 'mssql'
    ? `SELECT TOP ${n} ${columns} FROM ${quoteIdentifier(table, dialect)}`
    : `SELECT ${columns} FROM ${quoteIdentifier(table, dialect)} LIMIT ${n}`
}

interface Field {
  value: string
  /** Index of the character after the field (a separator, newline, or the end). */
  next: number
}

function readPlainField(src: string, start: number): Field {
  let i = start
  while (i < src.length && src[i] !== ',' && src[i] !== '\n' && src[i] !== '\r') i++
  return { value: src.slice(start, i), next: i }
}

// `start` is just past the opening quote. Anything after the closing quote up
// to the separator is kept, as lenient parsers do.
function readQuotedField(src: string, start: number): Field {
  let value = ''
  for (let i = start; i < src.length; i++) {
    if (src[i] !== '"') {
      value += src[i]
    } else if (src[i + 1] === '"') {
      value += '"'
      i++
    } else {
      const rest = readPlainField(src, i + 1)
      return { value: value + rest.value, next: rest.next }
    }
  }
  throw new ValidationError('CSV ends inside a quoted field')
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith('\uFEFF') ? text.slice(1) : text // drop a UTF-8 BOM
  const rows: string[][] = []
  let row: string[] = []
  // A record that was physically nothing (a blank line), as opposed to one
  // holding an explicitly quoted empty field.
  let blank = true
  let i = 0
  while (i < src.length) {
    const quoted = src[i] === '"'
    const field = quoted ? readQuotedField(src, i + 1) : readPlainField(src, i)
    if (quoted || field.value !== '' || row.length > 0) blank = false
    row.push(field.value)
    i = field.next
    if (src[i] === ',') {
      // A separator means explicit fields, even if every one is empty.
      blank = false
      i++
      // A trailing comma means one more, empty, field.
      if (i === src.length) row.push('')
      continue
    }
    if (!blank) rows.push(row)
    row = []
    blank = true
    i += src[i] === '\r' && src[i + 1] === '\n' ? 2 : 1
  }
  if (row.length > 0 && !blank) rows.push(row)
  return rows
}

/** Normalises a driver value for writing to a file. */
function plain(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return JSON.stringify(value)
}

function csvField(value: unknown): string {
  const v = plain(value)
  if (v === null) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replaceAll('"', '""')}"` : s
}

function* csvChunks(columns: readonly string[], rows: readonly Record<string, unknown>[]): Generator<string> {
  yield columns.map(csvField).join(',') + '\r\n'
  for (const r of rows) yield columns.map((c) => csvField(r[c])).join(',') + '\r\n'
}

// JSON-column text goes back to a value; unparseable text is kept as a string.
function jsonValue(value: unknown, isJson: boolean): unknown {
  if (!isJson || typeof value !== 'string') return plain(value)
  try {
    return JSON.parse(value)
  } catch {
    return value // not JSON after all (e.g. a MariaDB alias column); export the text
  }
}

// The same text as JSON.stringify(rows, null, 2), one element at a time.
function* jsonChunks(columns: readonly string[], rows: readonly Record<string, unknown>[], jsonColumns: readonly string[] = []): Generator<string> {
  const json = new Set(jsonColumns)
  if (rows.length === 0) {
    yield '[]\n'
    return
  }
  yield '[\n'
  for (const [i, r] of rows.entries()) {
    const element = JSON.stringify(Object.fromEntries(columns.map((c) => [c, jsonValue(r[c], json.has(c))])), null, 2)
    yield element.split('\n').map((line) => `  ${line}`).join('\n') + (i < rows.length - 1 ? ',\n' : '\n')
  }
  yield ']\n'
}

export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  return [...csvChunks(columns, rows)].join('')
}

export function toJson(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  return [...jsonChunks(columns, rows)].join('')
}

// PostgreSQL's array literal: {"a","b",NULL,{"nested"}}. Elements are always
// quoted, which every element type accepts.
function pgArrayLiteral(values: readonly unknown[]): string {
  const element = (el: unknown): string => {
    if (el === null || el === undefined) return 'NULL'
    if (Array.isArray(el)) return pgArrayLiteral(el)
    return `"${String(plain(el)).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  }
  return `{${values.map(element).join(',')}}`
}

function quoteString(text: string, dialect: Dialect): string {
  // MySQL treats backslash as an escape inside string literals by default.
  const escaped = isMysqlFamily(dialect) ? text.replaceAll('\\', '\\\\') : text
  // N'' keeps non-ASCII text intact in SQL Server's nvarchar columns.
  return `${dialect === 'mssql' ? 'N' : ''}'${escaped.replaceAll("'", "''")}'`
}

/** A dialect's literal for raw bytes. */
function bytesLiteral(bytes: Uint8Array, dialect: Dialect): string {
  const hex = Buffer.from(bytes).toString('hex')
  if (dialect === 'postgresql') return `'\\x${hex}'::bytea`
  if (dialect === 'mssql') return `0x${hex}`
  return `X'${hex}'`
}

/**
 * The column list for an export query. JSON columns are read as their JSON
 * text, so scalars ("x", 1, null) and SQL NULL stay distinct and round-trip.
 */
export function exportSelectList(columns: readonly { name: string; type: string }[], dialect: Dialect): { sql: string; jsonColumns: string[] } {
  const jsonColumns = columns.filter((c) => /^jsonb?$/i.test(c.type)).map((c) => c.name)
  if (columns.length === 0) return { sql: '*', jsonColumns }
  const sql = columns.map((c) => {
    const id = quoteIdentifier(c.name, dialect)
    if (!jsonColumns.includes(c.name)) return id
    if (dialect === 'postgresql') return `${id}::text AS ${id}`
    // MySQL parses JSON values; SQLite and SQL Server already return JSON as text.
    return isMysqlFamily(dialect) ? `CAST(${id} AS CHAR) AS ${id}` : id
  }).join(', ')
  return { sql, jsonColumns }
}

function sqlLiteral(value: unknown, dialect: Dialect, isJson: boolean): string {
  // JSON columns arrive as JSON text (see exportSelectList): write it as is.
  if (isJson && typeof value === 'string') return quoteString(value, dialect)
  // Bytes go back in as bytes, not as the base64 text used for CSV and JSON.
  if (value instanceof Uint8Array) return bytesLiteral(value, dialect)
  // Only PostgreSQL has array columns; elsewhere an array is JSON.
  if (Array.isArray(value) && !isJson && dialect === 'postgresql') return quoteString(pgArrayLiteral(value), dialect)
  const v = plain(value)
  if (v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  // SQLite and SQL Server have no boolean literals; both store bits as 1/0.
  if (typeof v === 'boolean') {
    if (dialect === 'sqlite' || dialect === 'mssql') return v ? '1' : '0'
    return v ? 'TRUE' : 'FALSE'
  }
  return quoteString(v, dialect)
}

function* sqlChunks(
  table: string, columns: readonly string[], rows: readonly Record<string, unknown>[], dialect: Dialect, jsonColumns: readonly string[],
): Generator<string> {
  const target = `${quoteIdentifier(table, dialect)} (${columns.map((c) => quoteIdentifier(c, dialect)).join(', ')})`
  const json = new Set(jsonColumns)
  for (const r of rows) yield `INSERT INTO ${target} VALUES (${columns.map((c) => sqlLiteral(r[c], dialect, json.has(c))).join(', ')});\n`
}

export function toSqlInserts(
  table: string, columns: readonly string[], rows: readonly Record<string, unknown>[], dialect: Dialect, jsonColumns: readonly string[] = [],
): string {
  return rows.length === 0 ? '\n' : [...sqlChunks(table, columns, rows, dialect, jsonColumns)].join('')
}

export type ExportFormat = 'csv' | 'json' | 'sql'

/** An export file's text in row-sized pieces, so it can be written without building it whole. */
export function exportChunks(
  format: ExportFormat, table: string, columns: readonly string[], rows: readonly Record<string, unknown>[], dialect: Dialect,
  jsonColumns: readonly string[] = [],
): Iterable<string> {
  if (format === 'json') return jsonChunks(columns, rows, jsonColumns)
  if (format === 'sql') return sqlChunks(table, columns, rows, dialect, jsonColumns)
  return csvChunks(columns, rows)
}

/**
 * Lines a CSV header up with a table's columns (case-insensitive) and turns
 * the data rows into bind values; an empty field becomes NULL.
 */
/**
 * A header's table column: an exact match, else the only case-insensitive
 * one. Columns that differ only by case (PostgreSQL "foo" and "FOO") need an
 * exact header, since guessing could fill the wrong one.
 */
function matchColumn(header: string, tableColumns: readonly string[]): string | undefined {
  if (tableColumns.includes(header)) return header
  const lower = header.toLowerCase()
  const candidates = tableColumns.filter((c) => c.toLowerCase() === lower)
  if (candidates.length > 1) {
    throw new ValidationError(`CSV column ${header} could be ${candidates.join(' or ')}; name it exactly`)
  }
  return candidates[0]
}

export function csvToRows(records: string[][], tableColumns: readonly string[]): { columns: string[]; rows: CellValue[][] } {
  const [header, ...data] = records
  if (!header || header.length === 0) throw new ValidationError('The CSV file is empty')
  const columns = header.map((h) => matchColumn(h.trim(), tableColumns))
  const unknown = header.filter((_, i) => columns[i] === undefined)
  if (unknown.length > 0) throw new ValidationError(`CSV columns not in the table: ${unknown.join(', ')}`)
  if (new Set(columns).size !== columns.length) throw new ValidationError('The CSV header repeats a column')
  const rows = data.map((record, i) => {
    if (record.length !== columns.length) {
      throw new ValidationError(`CSV row ${i + 2} has ${record.length} fields; the header has ${columns.length}`)
    }
    return record.map((v) => (v === '' ? null : v))
  })
  return { columns: columns as string[], rows }
}
