import { BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'
import { validateHost, validatePort } from './security'
import { csvToRows, parseCsv, quoteIdentifier, toCsv, toJson, toSqlInserts } from './dbTransfer'
import type { DbConnectConfig, DbConnection, QueryParam, SslMode } from './dbTypes'
import { connectPostgres } from './dbPostgres'
import { connectMysql } from './dbMysql'

const MAX_IMPORT_BYTES = 50 * 1024 * 1024
const MAX_IMPORT_ROWS = 200_000
const MAX_EXPORT_ROWS = 200_000

const EXPORT_FORMATS = {
  csv: { name: 'CSV', ext: 'csv' },
  json: { name: 'JSON', ext: 'json' },
  sql: { name: 'SQL', ext: 'sql' },
} as const
type ExportFormat = keyof typeof EXPORT_FORMATS

function validateTableName(table: unknown): string {
  if (typeof table !== 'string' || table.length === 0 || table.length > MAX_IDENTIFIER_LENGTH) {
    throw new ValidationError('Table name is required')
  }
  return table
}

interface DbEntry { conn: DbConnection; senderId: number }

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
    return requireOwnedConn(event, rawId).getTableInfo(validateTableName(table))
  })

  // Main picks the file and writes it, so table data never round-trips
  // through the renderer and the renderer never gets a filesystem path.
  ipcMain.handle('db:exportTable', async (event, rawId: unknown, rawTable: unknown, rawFormat: unknown) => {
    const conn = requireOwnedConn(event, rawId)
    const table = validateTableName(rawTable)
    if (typeof rawFormat !== 'string' || !(rawFormat in EXPORT_FORMATS)) throw new ValidationError('Invalid export format')
    const format = rawFormat as ExportFormat
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window for export dialog')
    const { name, ext } = EXPORT_FORMATS[format]
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: `Export ${table}`,
      defaultPath: `${table}.${ext}`,
      filters: [{ name, extensions: [ext] }],
    })
    if (canceled || !filePath) return { canceled: true, rows: 0, truncated: false }

    const result = await conn.query(`SELECT * FROM ${quoteIdentifier(table, conn.type)} LIMIT ${MAX_EXPORT_ROWS + 1}`)
    const truncated = result.rows.length > MAX_EXPORT_ROWS
    const rows = (truncated ? result.rows.slice(0, MAX_EXPORT_ROWS) : result.rows) as Record<string, unknown>[]
    let content = toCsv(result.columns, rows)
    if (format === 'json') content = toJson(result.columns, rows)
    if (format === 'sql') content = toSqlInserts(table, result.columns, rows, conn.type)
    await writeFile(filePath, content, 'utf-8')
    return { canceled: false, rows: rows.length, truncated }
  })

  ipcMain.handle('db:importCsv', async (event, rawId: unknown, rawTable: unknown) => {
    const conn = requireOwnedConn(event, rawId)
    const table = validateTableName(rawTable)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window for import dialog')
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: `Import CSV into ${table}`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return { canceled: true, rows: 0 }

    if ((await stat(filePaths[0])).size > MAX_IMPORT_BYTES) throw new ValidationError('CSV file is larger than 50 MB')
    const records = parseCsv(await readFile(filePaths[0], 'utf-8'))
    if (records.length - 1 > MAX_IMPORT_ROWS) throw new ValidationError(`CSV has more than ${MAX_IMPORT_ROWS} rows`)
    const info = await conn.getTableInfo(table)
    const { columns, rows } = csvToRows(records, info.columns.map((c) => c.name))
    if (rows.length === 0) return { canceled: false, rows: 0 }
    return { canceled: false, rows: await conn.insertRows(table, columns, rows) }
  })
}
