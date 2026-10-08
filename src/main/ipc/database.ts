import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { Pool as PgPool } from 'pg'
import mysql from 'mysql2/promise'
import { ConnectionError, NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'
import { validateHost, validatePort } from './security'

type DbType = 'postgresql' | 'mysql' | 'mariadb'
type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

interface QueryResult { columns: string[]; rows: unknown[]; rowCount: number; duration: number }

type QueryParam = string | number | boolean | null

interface DbConnection {
  type: DbType
  query: (sql: string, params?: QueryParam[]) => Promise<QueryResult>
  close: () => Promise<void>
  getTables: () => Promise<string[]>
  getTableInfo: (table: string) => Promise<TableInfo>
  getSchema: () => Promise<DbSchema>
}

interface ForeignKey {
  name: string
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
}

interface DbSchema {
  tables: Array<TableInfo & { name: string }>
  foreignKeys: ForeignKey[]
  /** True when the table list was cut to MAX_SCHEMA_TABLES. */
  truncated: boolean
}

// ER diagrams beyond this many tables stop being readable (and slow to lay out).
const MAX_SCHEMA_TABLES = 300

type SchemaColumnRow = { table_name: string; column_name: string; data_type: string; is_nullable: string }

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

interface TableInfo {
  columns: { name: string; type: string; nullable: boolean }[]
  /** Primary-key columns in key order; empty when the table has none. */
  primaryKey: string[]
}

interface DbEntry { conn: DbConnection; senderId: number }

interface DbConnectConfig {
  dbType: DbType
  host: string
  port: number
  username: string
  password?: string
  database: string
  ssl?: SslMode
}

const connections = new Map<string, DbEntry>()
const UUID_RE = /^db-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_SQL_BYTES = 1 * 1024 * 1024
const MAX_IDENTIFIER_LENGTH = 128
const MAX_DATABASE_LENGTH = 128

function validateConnId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new ValidationError('Invalid database connection id')
  return id
}

const MAX_QUERY_PARAMS = 256

function validateQueryParams(raw: unknown): QueryParam[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || raw.length > MAX_QUERY_PARAMS) throw new ValidationError('Invalid query parameters')
  for (const v of raw) {
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new ValidationError('Query parameters must be scalar values')
    }
  }
  return raw as QueryParam[]
}

function requireOwnedConn(event: IpcMainInvokeEvent, rawId: unknown): DbConnection {
  const id = validateConnId(rawId)
  const entry = connections.get(id)
  if (!entry) throw new NotFoundError('Database connection')
  if (entry.senderId !== event.sender.id) throw new OwnershipError('Database connection')
  return entry.conn
}

function validateConnectConfig(raw: unknown): DbConnectConfig {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid database config')
  const c = raw as Record<string, unknown>
  if (c.dbType !== 'postgresql' && c.dbType !== 'mysql' && c.dbType !== 'mariadb') {
    throw new ValidationError(`Unsupported database type: ${String(c.dbType)}`)
  }
  const host = validateHost(c.host, 'database host')
  const port = validatePort(c.port, 'database port')
  if (typeof c.username !== 'string' || c.username.length === 0 || c.username.length > MAX_IDENTIFIER_LENGTH) {
    throw new ValidationError('Invalid database username')
  }
  if (c.password !== undefined && c.password !== null && typeof c.password !== 'string') {
    throw new ValidationError('Invalid database password')
  }
  if (typeof c.database !== 'string' || c.database.length === 0 || c.database.length > MAX_DATABASE_LENGTH) {
    throw new ValidationError('Database name is required')
  }
  if (c.ssl !== undefined && typeof c.ssl !== 'string') {
    throw new ValidationError('Invalid SSL mode')
  }
  const ssl = c.ssl as string | undefined
  if (ssl !== undefined && !['disable', 'require', 'verify-ca', 'verify-full'].includes(ssl)) {
    throw new ValidationError(`Invalid SSL mode: ${ssl}`)
  }
  return {
    dbType: c.dbType,
    host,
    port,
    username: c.username,
    password: (c.password as string | undefined) || undefined,
    database: c.database,
    ssl: ssl as SslMode | undefined,
  }
}

// Shared by pg and mysql2 — both accept { rejectUnauthorized } for their ssl option.
function sslOption(mode: SslMode | undefined): { rejectUnauthorized: boolean } | undefined {
  if (mode === 'verify-full' || mode === 'verify-ca') return { rejectUnauthorized: true }
  if (mode === 'require') return { rejectUnauthorized: false }
  return undefined
}

async function connectPostgres(config: DbConnectConfig): Promise<DbConnection> {
  const pool = new PgPool({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl: sslOption(config.ssl),
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 30_000,
    max: 4,
  })

  // Surface pool-level errors instead of letting Node throw.
  pool.on('error', (err) => console.error(`[db:pg] pool error: ${toMessage(err)}`))

  try {
    const testClient = await pool.connect()
    testClient.release()
  } catch (err) {
    await pool.end().catch(() => undefined)
    throw new ConnectionError(toMessage(err))
  }

  return {
    type: 'postgresql',
    async query(sql: string, params?: QueryParam[]) {
      const start = Date.now()
      const result = await pool.query(sql, params)
      return {
        columns: result.fields?.map(f => f.name) ?? [],
        rows: result.rows ?? [],
        rowCount: result.rowCount ?? 0,
        duration: Date.now() - start,
      }
    },
    async close() {
      await pool.end()
    },
    async getTables() {
      const result = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`
      )
      return result.rows.map((r: { table_name: string }) => r.table_name)
    },
    async getTableInfo(table: string) {
      const result = await pool.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        [table]
      )
      // The schema the connection works in (search_path's first), as for the
      // table list. quote_ident keeps mixed-case names intact; to_regclass
      // returns NULL (no rows) instead of erroring for a missing table. Only
      // the first indnkeyatts columns are the key: the rest are INCLUDE
      // columns stored alongside it.
      const pk = await pool.query(
        `SELECT a.attname FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE i.indrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident($1))
           AND i.indisprimary AND k.ord <= i.indnkeyatts
         ORDER BY k.ord`,
        [table]
      )
      return {
        columns: result.rows.map((r: { column_name: string; data_type: string; is_nullable: string }) => ({
          name: r.column_name,
          type: r.data_type,
          nullable: r.is_nullable === 'YES',
        })),
        primaryKey: pk.rows.map((r: { attname: string }) => r.attname),
      }
    },
    async getSchema() {
      const columns = await pool.query(
        `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`
      )
      // Key columns only (the first indnkeyatts), in key order, as tableInfo does.
      const pks = await pool.query(
        `SELECT cl.relname AS table_name, a.attname::text AS column_name
         FROM pg_index i
         JOIN pg_class cl ON cl.oid = i.indrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE i.indisprimary AND ns.nspname = current_schema() AND k.ord <= i.indnkeyatts
         ORDER BY cl.relname, k.ord`
      )
      // pg_constraint pairs each local column with its referenced column by
      // position, so composite keys stay aligned (information_schema can't).
      const fks = await pool.query(
        `SELECT con.conname AS name, cl.relname AS table_name, rcl.relname AS ref_table,
                array_agg(att.attname::text ORDER BY k.ord) AS columns,
                array_agg(ratt.attname::text ORDER BY k.ord) AS ref_columns
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_class rcl ON rcl.oid = con.confrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_namespace rns ON rns.oid = rcl.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(col, refcol, ord)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.col
         JOIN pg_attribute ratt ON ratt.attrelid = con.confrelid AND ratt.attnum = k.refcol
         -- Tables are matched by bare name, so both ends must be in this schema.
         WHERE con.contype = 'f' AND ns.nspname = current_schema() AND rns.nspname = current_schema()
         GROUP BY con.conname, cl.relname, rcl.relname`
      )
      return assembleSchema(
        columns.rows,
        pks.rows,
        fks.rows.map((r: { name: string; table_name: string; ref_table: string; columns: string[]; ref_columns: string[] }) => ({
          name: r.name, table: r.table_name, columns: r.columns, refTable: r.ref_table, refColumns: r.ref_columns,
        })),
      )
    },
  }
}

async function connectMysql(config: DbConnectConfig): Promise<DbConnection> {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl: sslOption(config.ssl),
    connectionLimit: 4,
    connectTimeout: 20_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  })

  try {
    const testConn = await pool.getConnection()
    testConn.release()
  } catch (err) {
    await pool.end().catch(() => undefined)
    throw new ConnectionError(toMessage(err))
  }

  return {
    type: config.dbType === 'mariadb' ? 'mariadb' : 'mysql',
    async query(sql: string, params?: QueryParam[]) {
      const start = Date.now()
      const [rows, fields] = await pool.query(sql, params)
      const resultRows = Array.isArray(rows) ? rows as unknown[] : []
      const resultFields = Array.isArray(fields) ? fields : []
      // Writes return a ResultSetHeader instead of rows; report how many rows
      // they touched, as pg does, so callers can verify an edit hit one row.
      const affected = Array.isArray(rows) ? resultRows.length : (rows as { affectedRows?: number }).affectedRows ?? 0
      return {
        columns: resultFields.map((f: { name: string }) => f.name),
        rows: resultRows,
        rowCount: affected,
        duration: Date.now() - start,
      }
    },
    async close() {
      await pool.end()
    },
    async getTables() {
      const [rows] = await pool.query('SHOW TABLES')
      return (rows as Record<string, unknown>[]).map(r => Object.values(r)[0] as string)
    },
    async getTableInfo(table: string) {
      const [rows] = await pool.query('DESCRIBE ??', [table])
      const [keys] = await pool.query("SHOW KEYS FROM ?? WHERE Key_name = 'PRIMARY'", [table])
      return {
        columns: (rows as { Field: string; Type: string; Null: string }[]).map(r => ({
          name: r.Field,
          type: r.Type,
          nullable: r.Null === 'YES',
        })),
        primaryKey: (keys as { Column_name: string; Seq_in_index: number }[])
          .sort((a, b) => a.Seq_in_index - b.Seq_in_index)
          .map(k => k.Column_name),
      }
    },
    async getSchema() {
      const [columns] = await pool.query(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS data_type, IS_NULLABLE AS is_nullable
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
      )
      const [pks] = await pool.query(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION`
      )
      const [fkRows] = await pool.query(
        `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`
      )
      const fks = new Map<string, ForeignKey>()
      for (const r of fkRows as { name: string; table_name: string; column_name: string; ref_table: string; ref_column: string }[]) {
        const id = `${r.table_name}.${r.name}`
        let fk = fks.get(id)
        if (!fk) {
          fk = { name: r.name, table: r.table_name, columns: [], refTable: r.ref_table, refColumns: [] }
          fks.set(id, fk)
        }
        fk.columns.push(r.column_name)
        fk.refColumns.push(r.ref_column)
      }
      return assembleSchema(columns as SchemaColumnRow[], pks as { table_name: string; column_name: string }[], [...fks.values()])
    },
  }
}

export function disposeDatabaseConnectionsForSender(senderId: number): void {
  for (const [id, entry] of connections) {
    if (entry.senderId === senderId) {
      connections.delete(id)
      entry.conn.close().catch((err) => console.error(`[db] close ${id}: ${toMessage(err)}`))
    }
  }
}

export function registerDatabaseHandlers(): void {
  ipcMain.handle('db:connect', async (event, rawConfig: unknown) => {
    const config = validateConnectConfig(rawConfig)
    const id = `db-${randomUUID()}`
    const conn = config.dbType === 'postgresql'
      ? await connectPostgres(config)
      : await connectMysql(config)
    connections.set(id, { conn, senderId: event.sender.id })
    return id
  })

  ipcMain.handle('db:disconnect', async (event, rawId: unknown) => {
    const id = validateConnId(rawId)
    const entry = connections.get(id)
    if (!entry) return
    if (entry.senderId !== event.sender.id) throw new OwnershipError('Database connection')
    connections.delete(id)
    try {
      await entry.conn.close()
    } catch (err) {
      console.error(`[db] close ${id}: ${toMessage(err)}`)
    }
  })

  ipcMain.handle('db:query', async (event, rawId: unknown, sql: unknown, rawParams: unknown) => {
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw new ValidationError('SQL query is required')
    }
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
      throw new ValidationError(`SQL query exceeds ${MAX_SQL_BYTES} bytes`)
    }
    return requireOwnedConn(event, rawId).query(sql, validateQueryParams(rawParams))
  })

  ipcMain.handle('db:tables', async (event, rawId: unknown) => {
    return requireOwnedConn(event, rawId).getTables()
  })

  ipcMain.handle('db:schema', async (event, rawId: unknown) => {
    return requireOwnedConn(event, rawId).getSchema()
  })

  ipcMain.handle('db:tableInfo', async (event, rawId: unknown, table: unknown) => {
    if (typeof table !== 'string' || table.length === 0 || table.length > MAX_IDENTIFIER_LENGTH) {
      throw new ValidationError('Table name is required')
    }
    return requireOwnedConn(event, rawId).getTableInfo(table)
  })
}
