import { ValidationError } from './errors'

// Pure helpers for moving table data in and out of files: CSV parsing and
// writing, JSON, and SQL INSERT scripts. No I/O here.

export type Dialect = 'postgresql' | 'mysql' | 'mariadb'
export type CellValue = string | number | boolean | null

const isMysqlFamily = (d: Dialect) => d === 'mysql' || d === 'mariadb'

export function quoteIdentifier(name: string, dialect: Dialect): string {
  return isMysqlFamily(dialect) ? '`' + name.replaceAll('`', '``') + '`' : '"' + name.replaceAll('"', '""') + '"'
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

// The same text as JSON.stringify(rows, null, 2), one element at a time.
function* jsonChunks(columns: readonly string[], rows: readonly Record<string, unknown>[]): Generator<string> {
  if (rows.length === 0) {
    yield '[]\n'
    return
  }
  yield '[\n'
  for (const [i, r] of rows.entries()) {
    const element = JSON.stringify(Object.fromEntries(columns.map((c) => [c, plain(r[c])])), null, 2)
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

function sqlLiteral(value: unknown, dialect: Dialect): string {
  const v = plain(value)
  if (v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  // MySQL treats backslash as an escape inside string literals by default.
  const escaped = isMysqlFamily(dialect) ? v.replaceAll('\\', '\\\\') : v
  return `'${escaped.replaceAll("'", "''")}'`
}

function* sqlChunks(table: string, columns: readonly string[], rows: readonly Record<string, unknown>[], dialect: Dialect): Generator<string> {
  const target = `${quoteIdentifier(table, dialect)} (${columns.map((c) => quoteIdentifier(c, dialect)).join(', ')})`
  for (const r of rows) yield `INSERT INTO ${target} VALUES (${columns.map((c) => sqlLiteral(r[c], dialect)).join(', ')});\n`
}

export function toSqlInserts(table: string, columns: readonly string[], rows: readonly Record<string, unknown>[], dialect: Dialect): string {
  return rows.length === 0 ? '\n' : [...sqlChunks(table, columns, rows, dialect)].join('')
}

export type ExportFormat = 'csv' | 'json' | 'sql'

/** An export file's text in row-sized pieces, so it can be written without building it whole. */
export function exportChunks(
  format: ExportFormat, table: string, columns: readonly string[], rows: readonly Record<string, unknown>[], dialect: Dialect,
): Iterable<string> {
  if (format === 'json') return jsonChunks(columns, rows)
  if (format === 'sql') return sqlChunks(table, columns, rows, dialect)
  return csvChunks(columns, rows)
}

/**
 * Lines a CSV header up with a table's columns (case-insensitive) and turns
 * the data rows into bind values; an empty field becomes NULL.
 */
export function csvToRows(records: string[][], tableColumns: readonly string[]): { columns: string[]; rows: CellValue[][] } {
  const [header, ...data] = records
  if (!header || header.length === 0) throw new ValidationError('The CSV file is empty')
  const byLower = new Map(tableColumns.map((c) => [c.toLowerCase(), c]))
  const unknown = header.filter((h) => !byLower.has(h.trim().toLowerCase()))
  if (unknown.length > 0) throw new ValidationError(`CSV columns not in the table: ${unknown.join(', ')}`)
  const columns = header.map((h) => byLower.get(h.trim().toLowerCase()) as string)
  if (new Set(columns).size !== columns.length) throw new ValidationError('The CSV header repeats a column')
  const rows = data.map((record, i) => {
    if (record.length !== columns.length) {
      throw new ValidationError(`CSV row ${i + 2} has ${record.length} fields; the header has ${columns.length}`)
    }
    return record.map((v) => (v === '' ? null : v))
  })
  return { columns, rows }
}
