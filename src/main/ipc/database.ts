import { BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { readFile, rename, rm, stat } from 'node:fs/promises'
import { NotFoundError, OwnershipError, ValidationError, toMessage } from './errors'
import { isInsideHome, validateHost, validatePort } from './security'
import { csvToRows, exportChunks, exportSelectList, parseCsv, selectAll, type ExportFormat } from './dbTransfer'
import type { DbConnectConfig, DbConnection, QueryParam, ServerDbType, SqliteConfig, SslMode } from './dbTypes'
import { connectPostgres } from './dbPostgres'
import { connectMysql } from './dbMysql'
import { connectSqlite } from './dbSqlite'
import { connectMssql } from './dbMssql'

const MAX_IMPORT_BYTES = 50 * 1024 * 1024
const MAX_IMPORT_ROWS = 200_000
const MAX_EXPORT_ROWS = 200_000
// Rows are capped above, but a few huge text or BLOB values can still make a
// file no one meant to write; stop there rather than fill the disk.
const MAX_EXPORT_BYTES = 512 * 1024 * 1024

const EXPORT_FORMATS = {
  csv: { name: 'CSV', ext: 'csv' },
  json: { name: 'JSON', ext: 'json' },
  sql: { name: 'SQL', ext: 'sql' },
} satisfies Record<ExportFormat, { name: string; ext: string }>

/**
 * Writes chunks as they're produced (honouring backpressure and a size cap)
 * to a temporary file beside `path`, then renames it into place. A failure
 * leaves any existing file at `path` untouched.
 */
export async function writeChunks(path: string, chunks: Iterable<string>, maxBytes = MAX_EXPORT_BYTES): Promise<void> {
  const temp = `${path}.${randomUUID().slice(0, 8)}.partial`
  const out = createWriteStream(temp, { encoding: 'utf-8' })
  let bytes = 0
  try {
    for (const chunk of chunks) {
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxBytes) throw new ValidationError(`The export would be larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)
      if (!out.write(chunk)) await once(out, 'drain')
    }
    out.end()
    await once(out, 'finish')
    await rename(temp, path)
  } catch (err) {
    // The stream opens its file asynchronously; wait for it to close so the
    // temp file exists (if it ever will) before it's removed.
    out.destroy()
    if (!out.closed) await once(out, 'close')
    await rm(temp, { force: true })
    throw err
  }
}

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

const SERVER_DB_TYPES = new Set(['postgresql', 'mysql', 'mariadb', 'mssql'])
const MAX_PATH_LENGTH = 4096

function validateSqliteConfig(c: Record<string, unknown>): SqliteConfig {
  if (typeof c.filePath !== 'string' || c.filePath.length === 0 || c.filePath.length > MAX_PATH_LENGTH) {
    throw new ValidationError('A SQLite database file is required')
  }
  // Same trust boundary as other local file access: inside the home folder,
  // judged by where the path really resolves.
  const check = isInsideHome(c.filePath)
  if (!check.ok) throw new ValidationError(check.reason)
  return { dbType: 'sqlite', filePath: check.resolved }
}

function validateConnectConfig(raw: unknown): DbConnectConfig {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid database config')
  const c = raw as Record<string, unknown>
  if (c.dbType === 'sqlite') return validateSqliteConfig(c)
  if (typeof c.dbType !== 'string' || !SERVER_DB_TYPES.has(c.dbType)) {
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
    dbType: c.dbType as ServerDbType,
    host,
    port,
    username: c.username,
    password: (c.password as string | undefined) || undefined,
    database: c.database,
    ssl: ssl as SslMode | undefined,
  }
}

function openConnection(config: DbConnectConfig): Promise<DbConnection> {
  switch (config.dbType) {
    case 'sqlite': return connectSqlite(config)
    case 'postgresql': return connectPostgres(config)
    case 'mssql': return connectMssql(config)
    default: return connectMysql(config)
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
    const conn = await openConnection(config)
    connections.set(id, { conn, senderId: event.sender.id })
    return id
  })

  // The connection form's "Browse…" for SQLite files. Only the chosen path
  // comes back; it's validated again (inside home) when connecting.
  ipcMain.handle('db:pickSqliteFile', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window for file dialog')
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a SQLite database',
      filters: [{ name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    })
    return canceled || filePaths.length === 0 ? null : filePaths[0]
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
    if (typeof rawFormat !== 'string' || !Object.hasOwn(EXPORT_FORMATS, rawFormat)) throw new ValidationError('Invalid export format')
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

    const select = exportSelectList((await conn.getTableInfo(table)).columns, conn.type)
    const result = await conn.query(selectAll(table, conn.type, MAX_EXPORT_ROWS + 1, select.sql))
    const truncated = result.rows.length > MAX_EXPORT_ROWS
    const rows = (truncated ? result.rows.slice(0, MAX_EXPORT_ROWS) : result.rows) as Record<string, unknown>[]
    await writeChunks(filePath, exportChunks(format, table, result.columns, rows, conn.type, select.jsonColumns))
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
