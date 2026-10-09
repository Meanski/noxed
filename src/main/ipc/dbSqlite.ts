import Database from 'better-sqlite3'
import { ConnectionError, ValidationError, toMessage } from './errors'
import { quoteIdentifier, type CellValue } from './dbTransfer'
import { assembleSchema, type DbConnection, type ForeignKey, type QueryParam, type SqliteConfig } from './dbTypes'

// better-sqlite3 binds numbers, strings, bigints, buffers and null; SQLite has
// no boolean type, so booleans travel as 1/0.
function bindable(v: QueryParam): string | number | null {
  return typeof v === 'boolean' ? Number(v) : v
}

// Strings, quoted identifiers and comments, which may mention ATTACH harmlessly.
const SQL_LITERALS_AND_COMMENTS = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g

/**
 * Why a statement must not run, or null. The connection was opened only after
 * checking the file is inside the home folder; ATTACH and VACUUM INTO would
 * read or write any other file the app can reach.
 */
export function fileEscapingStatement(sql: string): string | null {
  const code = sql.replaceAll(SQL_LITERALS_AND_COMMENTS, ' ')
  if (/\bATTACH\b/i.test(code)) return 'ATTACH is not allowed: open the other database as its own connection'
  if (/\bVACUUM\b[\s\S]*\bINTO\b/i.test(code)) return 'VACUUM INTO is not allowed: use Export to save a copy'
  return null
}

type PragmaColumn = { name: string; type: string; notnull: number; pk: number }
type PragmaForeignKey = { id: number; seq: number; table: string; from: string; to: string | null }

/**
 * SQLite through better-sqlite3. Its API is synchronous, so each call runs on
 * the main process; that's fine for local files, which answer in microseconds.
 */
export async function connectSqlite(config: SqliteConfig): Promise<DbConnection> {
  let db: Database.Database
  try {
    db = new Database(config.filePath, { fileMustExist: true })
  } catch (err) {
    throw new ConnectionError(toMessage(err))
  }

  const tableNames = (): string[] =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name)

  const tableInfo = (table: string) => {
    const columns = db.prepare('SELECT name, type, "notnull", pk FROM pragma_table_info(?)').all(table) as PragmaColumn[]
    return {
      columns: columns.map((c) => ({ name: c.name, type: c.type || 'any', nullable: c.notnull === 0 })),
      // pk is the column's 1-based position within the primary key, 0 if not part of it.
      primaryKey: columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
    }
  }

  return {
    type: 'sqlite',
    async query(sql: string, params?: QueryParam[]) {
      const start = Date.now()
      const refused = fileEscapingStatement(sql)
      if (refused) throw new ValidationError(refused)
      const stmt = db.prepare(sql)
      const values = (params ?? []).map(bindable)
      if (stmt.reader) {
        const rows = stmt.all(...values) as Record<string, unknown>[]
        return { columns: stmt.columns().map((c) => c.name), rows, rowCount: rows.length, duration: Date.now() - start }
      }
      const info = stmt.run(...values)
      return { columns: [], rows: [], rowCount: info.changes, duration: Date.now() - start }
    },
    async close() {
      db.close()
    },
    async getTables() {
      return tableNames()
    },
    async getTableInfo(table: string) {
      return tableInfo(table)
    },
    async getSchema() {
      const names = tableNames()
      const columnRows = names.flatMap((t) =>
        tableInfo(t).columns.map((c) => ({ table_name: t, column_name: c.name, data_type: c.type, is_nullable: c.nullable ? 'YES' : 'NO' })))
      const pkRows = names.flatMap((t) => tableInfo(t).primaryKey.map((c) => ({ table_name: t, column_name: c })))
      const foreignKeys: ForeignKey[] = names.flatMap((t) => {
        const byId = new Map<number, ForeignKey>()
        for (const r of db.prepare('SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(t) as PragmaForeignKey[]) {
          let fk = byId.get(r.id)
          if (!fk) {
            fk = { name: `${t}_fk${r.id}`, table: t, columns: [], refTable: r.table, refColumns: [] }
            byId.set(r.id, fk)
          }
          fk.columns.push(r.from)
          // A NULL target column means "the referenced table's primary key".
          fk.refColumns.push(r.to ?? tableInfo(r.table).primaryKey[r.seq] ?? 'rowid')
        }
        return [...byId.values()]
      })
      return assembleSchema(columnRows, pkRows, foreignKeys)
    },
    async insertRows(table: string, columns: string[], rows: CellValue[][]) {
      const stmt = db.prepare(
        `INSERT INTO ${quoteIdentifier(table, 'sqlite')} (${columns.map((c) => quoteIdentifier(c, 'sqlite')).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      )
      // db.transaction rolls back automatically if any insert throws.
      db.transaction(() => {
        for (const row of rows) stmt.run(...row.map(bindable))
      })()
      return rows.length
    },
  }
}
