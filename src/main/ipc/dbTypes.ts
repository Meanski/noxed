import type { CellValue } from './dbTransfer'

// Shared shapes for the database drivers (dbPostgres, dbMysql) and the IPC
// layer in database.ts.

export type ServerDbType = 'postgresql' | 'mysql' | 'mariadb' | 'mssql'
export type DbType = ServerDbType | 'sqlite'

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

export interface QueryResult {
  columns: string[]
  rows: unknown[]
  rowCount: number
  duration: number
}

export type QueryParam = string | number | boolean | null

export interface DbConnection {
  type: DbType
  query: (sql: string, params?: QueryParam[]) => Promise<QueryResult>
  close: () => Promise<void>
  getTables: () => Promise<string[]>
  getTableInfo: (table: string) => Promise<TableInfo>
  getSchema: () => Promise<DbSchema>
  /** Inserts all rows in one transaction; any failure rolls the whole import back. */
  insertRows: (table: string, columns: string[], rows: CellValue[][]) => Promise<number>
}

export interface ForeignKey {
  name: string
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
}

export interface DbSchema {
  tables: Array<TableInfo & { name: string }>
  foreignKeys: ForeignKey[]
  /** True when the table list was cut to MAX_SCHEMA_TABLES. */
  truncated: boolean
}

// ER diagrams beyond this many tables stop being readable (and slow to lay out).
export const MAX_SCHEMA_TABLES = 300

export type SchemaColumnRow = { table_name: string; column_name: string; data_type: string; is_nullable: string }

/** Groups flat catalog rows into per-table metadata, capped to MAX_SCHEMA_TABLES. */

export function assembleSchema(
  columnRows: SchemaColumnRow[],
  pkRows: { table_name: string; column_name: string }[],
  foreignKeys: ForeignKey[],
): DbSchema {
  const tables = new Map<string, TableInfo & { name: string }>()
  for (const r of columnRows) {
    let t = tables.get(r.table_name)
    if (!t) {
      if (tables.size >= MAX_SCHEMA_TABLES) continue
      t = { name: r.table_name, columns: [], primaryKey: [] }
      tables.set(r.table_name, t)
    }
    t.columns.push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES' })
  }
  for (const r of pkRows) tables.get(r.table_name)?.primaryKey.push(r.column_name)
  const truncated = new Set(columnRows.map((r) => r.table_name)).size > tables.size
  return {
    tables: [...tables.values()],
    foreignKeys: foreignKeys.filter((fk) => tables.has(fk.table) && tables.has(fk.refTable)),
    truncated,
  }
}

export interface TableInfo {
  columns: { name: string; type: string; nullable: boolean }[]
  /** Primary-key columns in key order; empty when the table has none. */
  primaryKey: string[]
}

export type DbConnectConfig = ServerDbConfig | SqliteConfig

export interface SqliteConfig {
  dbType: 'sqlite'
  /** Absolute path to the database file, already checked to be inside home. */
  filePath: string
}

export interface ServerDbConfig {
  dbType: ServerDbType
  host: string
  port: number
  username: string
  password?: string
  database: string
  ssl?: SslMode
}

// Postgres allows 65535 bind parameters per statement; stay well under it.
export const MAX_BIND_PARAMS = 60_000

export function rowsPerBatch(columnCount: number): number {
  return Math.max(1, Math.floor(MAX_BIND_PARAMS / Math.max(1, columnCount)))
}

// Shared by pg and mysql2 — both accept { rejectUnauthorized } for their ssl option.
export function sslOption(mode: SslMode | undefined): { rejectUnauthorized: boolean } | undefined {
  if (mode === 'verify-full' || mode === 'verify-ca') return { rejectUnauthorized: true }
  if (mode === 'require') return { rejectUnauthorized: false }
  return undefined
}
