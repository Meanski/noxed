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
  let i = 0
  while (i < src.length) {
    const field = src[i] === '"' ? readQuotedField(src, i + 1) : readPlainField(src, i)
    row.push(field.value)
    i = field.next
    if (src[i] === ',') {
      i++
      // A trailing comma means one more, empty, field.
      if (i === src.length) row.push('')
      continue
    }
    rows.push(row)
    row = []
    i += src[i] === '\r' && src[i + 1] === '\n' ? 2 : 1
  }
  if (row.length > 0) rows.push(row)
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
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

export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.map(csvField).join(','), ...rows.map((r) => columns.map((c) => csvField(r[c])).join(','))]
  return lines.join('\r\n') + '\r\n'
}

export function toJson(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c) => [c, plain(r[c])]))), null, 2) + '\n'
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

export function toSqlInserts(table: string, columns: readonly string[], rows: readonly Record<string, unknown>[], dialect: Dialect): string {
  const target = `${quoteIdentifier(table, dialect)} (${columns.map((c) => quoteIdentifier(c, dialect)).join(', ')})`
  return rows.map((r) => `INSERT INTO ${target} VALUES (${columns.map((c) => sqlLiteral(r[c], dialect)).join(', ')});`).join('\n') + '\n'
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
