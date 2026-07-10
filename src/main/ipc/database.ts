import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { Pool as PgPool } from 'pg'
import mysql from 'mysql2/promise'
import { ConnectionError, NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'
import { validateHost, validatePort } from './security'

type DbType = 'postgresql' | 'mysql' | 'mariadb'
type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

interface QueryResult { columns: string[]; rows: unknown[]; rowCount: number; duration: number }

interface DbConnection {
  type: DbType
  query: (sql: string) => Promise<QueryResult>
  close: () => Promise<void>
  getTables: () => Promise<string[]>
  getTableInfo: (table: string) => Promise<{ columns: { name: string; type: string; nullable: boolean }[] }>
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
    async query(sql: string) {
      const start = Date.now()
      const result = await pool.query(sql)
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
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
      )
      return result.rows.map((r: { table_name: string }) => r.table_name)
    },
    async getTableInfo(table: string) {
      const result = await pool.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [table]
      )
      return {
        columns: result.rows.map((r: { column_name: string; data_type: string; is_nullable: string }) => ({
          name: r.column_name,
          type: r.data_type,
          nullable: r.is_nullable === 'YES',
        })),
      }
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
    async query(sql: string) {
      const start = Date.now()
      const [rows, fields] = await pool.query(sql)
      const resultRows = Array.isArray(rows) ? rows as unknown[] : []
      const resultFields = Array.isArray(fields) ? fields : []
      return {
        columns: resultFields.map((f: { name: string }) => f.name),
        rows: resultRows,
        rowCount: resultRows.length,
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
      return {
        columns: (rows as { Field: string; Type: string; Null: string }[]).map(r => ({
          name: r.Field,
          type: r.Type,
          nullable: r.Null === 'YES',
        })),
      }
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

  ipcMain.handle('db:query', async (event, rawId: unknown, sql: unknown) => {
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw new ValidationError('SQL query is required')
    }
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
      throw new ValidationError(`SQL query exceeds ${MAX_SQL_BYTES} bytes`)
    }
    return requireOwnedConn(event, rawId).query(sql)
  })

  ipcMain.handle('db:tables', async (event, rawId: unknown) => {
    return requireOwnedConn(event, rawId).getTables()
  })

  ipcMain.handle('db:tableInfo', async (event, rawId: unknown, table: unknown) => {
    if (typeof table !== 'string' || table.length === 0 || table.length > MAX_IDENTIFIER_LENGTH) {
      throw new ValidationError('Table name is required')
    }
    return requireOwnedConn(event, rawId).getTableInfo(table)
  })
}
