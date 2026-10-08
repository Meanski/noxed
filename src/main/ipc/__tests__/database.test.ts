import { describe, it, expect, vi, type Mock } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => ({})) },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  rm: (await importOriginal<typeof import('node:fs/promises')>()).rm,
  rename: (await importOriginal<typeof import('node:fs/promises')>()).rename,
}))
vi.mock('pg', () => {
  const query = vi.fn().mockResolvedValue({ fields: [{ name: 'x' }], rows: [{ x: 1 }], rowCount: 1 })
  const clientQuery = vi.fn().mockResolvedValue({ rows: [] })
  const connect = vi.fn().mockResolvedValue({ release: vi.fn(), query: clientQuery })
  // Regular function so `new Pool(...)` works (arrows are not constructible)
  const PoolCtor = vi.fn(function Pool() {
    return { query, connect, end: vi.fn(), on: vi.fn() }
  })
  return { Pool: PoolCtor, __query: query, __clientQuery: clientQuery }
})
vi.mock('mysql2/promise', () => ({
  default: { createPool: vi.fn() },
}))

import { dialog, ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pg from 'pg'
import { registerDatabaseHandlers, writeChunks } from '../database'
import { assembleSchema } from '../dbTypes'

registerDatabaseHandlers()

type Handler = (...args: unknown[]) => unknown

function handler(channel: string): Handler {
  const call = (ipcMain.handle as Mock).mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as Handler
}

const event = { sender: { id: 1 } }

async function connectPg(): Promise<string> {
  return (await handler('db:connect')(event, {
    dbType: 'postgresql', host: 'db.example.com', port: 5432,
    username: 'u', password: 'p', database: 'appdb',
  })) as string
}

describe('db:query parameter validation', () => {
  it('forwards scalar bind parameters to the driver', async () => {
    const id = await connectPg()
    await handler('db:query')(event, id, 'UPDATE "t" SET "a" = $1 WHERE "id" = $2', ['x', 7])
    const pgQuery = (pg as unknown as { __query: Mock }).__query
    expect(pgQuery).toHaveBeenCalledWith('UPDATE "t" SET "a" = $1 WHERE "id" = $2', ['x', 7])
  })

  it('accepts omitted and null params', async () => {
    const id = await connectPg()
    const result = (await handler('db:query')(event, id, 'SELECT 1')) as { rowCount: number }
    expect(result.rowCount).toBe(1)
    await handler('db:query')(event, id, 'SELECT 1', null)
    const pgQuery = (pg as unknown as { __query: Mock }).__query
    expect(pgQuery).toHaveBeenLastCalledWith('SELECT 1', undefined)
  })

  it('accepts null, boolean, and number parameter values', async () => {
    const id = await connectPg()
    await handler('db:query')(event, id, 'SELECT $1, $2, $3', [null, true, 3.5])
    const pgQuery = (pg as unknown as { __query: Mock }).__query
    expect(pgQuery).toHaveBeenLastCalledWith('SELECT $1, $2, $3', [null, true, 3.5])
  })

  it('rejects non-array params', async () => {
    const id = await connectPg()
    await expect(handler('db:query')(event, id, 'SELECT 1', 'nope')).rejects.toThrow('Invalid query parameters')
  })

  it('rejects non-scalar parameter values', async () => {
    const id = await connectPg()
    await expect(handler('db:query')(event, id, 'SELECT $1', [{ evil: true }]))
      .rejects.toThrow('Query parameters must be scalar values')
    await expect(handler('db:query')(event, id, 'SELECT $1', [undefined]))
      .rejects.toThrow('Query parameters must be scalar values')
  })

  it('rejects oversized parameter arrays', async () => {
    const id = await connectPg()
    await expect(handler('db:query')(event, id, 'SELECT 1', Array(300).fill(1)))
      .rejects.toThrow('Invalid query parameters')
  })
})

async function connectMysql(responses: unknown[]) {
  const query = vi.fn()
  for (const r of responses) query.mockResolvedValueOnce(r)
  const mysql = (await import('mysql2/promise')).default
  ;(mysql.createPool as Mock).mockReturnValue({
    query,
    getConnection: vi.fn().mockResolvedValue({ release: vi.fn() }),
    end: vi.fn().mockResolvedValue(undefined),
  })
  const id = (await handler('db:connect')(event, {
    dbType: 'mysql', host: 'db.example.com', port: 3306, username: 'u', database: 'appdb',
  })) as string
  return { id, query }
}

describe('table metadata and write results', () => {
  it('reads postgres columns and its primary key in key order', async () => {
    const id = await connectPg()
    const pgQuery = (pg as unknown as { __query: Mock }).__query
    pgQuery
      .mockResolvedValueOnce({ rows: [{ column_name: 'org', data_type: 'int', is_nullable: 'NO' }, { column_name: 'id', data_type: 'int', is_nullable: 'NO' }] })
      .mockResolvedValueOnce({ rows: [{ attname: 'org' }, { attname: 'id' }] })
    const info = await handler('db:tableInfo')(event, id, 'Members')
    expect(info).toEqual({
      columns: [
        { name: 'org', type: 'int', nullable: false },
        { name: 'id', type: 'int', nullable: false },
      ],
      primaryKey: ['org', 'id'],
    })
    expect(pgQuery.mock.calls.at(-1)?.[1]).toEqual(['Members'])
    // Both lookups follow the connection's schema rather than assuming public.
    expect(pgQuery.mock.calls.slice(-2).every((c) => String(c[0]).includes('current_schema()'))).toBe(true)
    // INCLUDE columns follow the key columns in indkey and aren't part of the key.
    expect(String(pgQuery.mock.calls.at(-1)?.[0])).toContain('k.ord <= i.indnkeyatts')
  })


  it('reports affected rows for mysql writes', async () => {
    const { id } = await connectMysql([[{ affectedRows: 1, insertId: 0 }, undefined]])
    const result = (await handler('db:query')(event, id, 'UPDATE `t` SET `a` = ? WHERE `id` = ?', ['x', 1])) as { rowCount: number; rows: unknown[] }
    expect(result).toMatchObject({ rowCount: 1, rows: [] })
  })

  it('reads the mysql primary key ordered by its position in the index', async () => {
    const { id, query } = await connectMysql([
      [[{ Field: 'id', Type: 'int', Null: 'NO' }, { Field: 'org', Type: 'int', Null: 'NO' }]],
      [[{ Column_name: 'id', Seq_in_index: 2 }, { Column_name: 'org', Seq_in_index: 1 }]],
    ])
    const info = (await handler('db:tableInfo')(event, id, 'members')) as { primaryKey: string[] }
    expect(info.primaryKey).toEqual(['org', 'id'])
    expect(query).toHaveBeenLastCalledWith("SHOW KEYS FROM ?? WHERE Key_name = 'PRIMARY'", ['members'])
  })
})

describe('schema for ER diagrams', () => {
  const col = (table_name: string, column_name: string) => ({ table_name, column_name, data_type: 'int', is_nullable: 'NO' })

  it('groups columns and keys per table, dropping relations to cut tables', () => {
    const schema = assembleSchema(
      [col('users', 'id'), col('orders', 'id'), col('orders', 'user_id')],
      [{ table_name: 'users', column_name: 'id' }, { table_name: 'orders', column_name: 'id' }],
      [
        { name: 'orders_user', table: 'orders', columns: ['user_id'], refTable: 'users', refColumns: ['id'] },
        { name: 'ghost', table: 'orders', columns: ['x'], refTable: 'missing', refColumns: ['id'] },
      ],
    )
    expect(schema.tables).toEqual([
      { name: 'users', columns: [{ name: 'id', type: 'int', nullable: false }], primaryKey: ['id'] },
      { name: 'orders', columns: [{ name: 'id', type: 'int', nullable: false }, { name: 'user_id', type: 'int', nullable: false }], primaryKey: ['id'] },
    ])
    expect(schema.foreignKeys.map((f) => f.name)).toEqual(['orders_user'])
    expect(schema.truncated).toBe(false)
  })

  it('caps very large schemas and says so', () => {
    const rows = Array.from({ length: 305 }, (_, i) => col(`t${i}`, 'id'))
    const schema = assembleSchema(rows, [], [])
    expect(schema.tables).toHaveLength(300)
    expect(schema.truncated).toBe(true)
  })

  it('reads the postgres catalog', async () => {
    const id = await connectPg()
    const pgQuery = (pg as unknown as { __query: Mock }).__query
    pgQuery
      .mockResolvedValueOnce({ rows: [col('users', 'id'), col('orders', 'user_id')] })
      .mockResolvedValueOnce({ rows: [{ table_name: 'users', column_name: 'id' }] })
      .mockResolvedValueOnce({ rows: [{ name: 'fk', table_name: 'orders', ref_table: 'users', columns: ['user_id'], ref_columns: ['id'] }] })
    const schema = (await handler('db:schema')(event, id)) as { foreignKeys: unknown[] }
    expect(schema.foreignKeys).toEqual([{ name: 'fk', table: 'orders', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }])
    const sql = pgQuery.mock.calls.slice(-3).map((c) => String(c[0]))
    // The connection's schema, not 'public'; key columns without INCLUDE ones.
    expect(sql.every((q) => q.includes('current_schema()'))).toBe(true)
    expect(sql[1]).toContain('k.ord <= i.indnkeyatts')
    // Both ends of a foreign key are in this schema, since tables match by name.
    expect(sql[2]).toContain('rns.nspname = current_schema()')
  })

  it('groups mysql composite foreign keys by constraint', async () => {
    const { id, query: mysqlQuery } = await connectMysql([
      [[col('a', 'x'), col('a', 'y'), col('b', 'x'), col('b', 'y')]],
      [[]],
      [[
        { name: 'ab', table_name: 'a', column_name: 'x', ref_table: 'b', ref_column: 'x' },
        { name: 'ab', table_name: 'a', column_name: 'y', ref_table: 'b', ref_column: 'y' },
      ]],
    ])
    const schema = (await handler('db:schema')(event, id)) as { foreignKeys: unknown[] }
    expect(schema.foreignKeys).toEqual([{ name: 'ab', table: 'a', columns: ['x', 'y'], refTable: 'b', refColumns: ['x', 'y'] }])
    expect(String(mysqlQuery.mock.calls.at(-1)?.[0])).toContain('REFERENCED_TABLE_SCHEMA = DATABASE()')
  })
})

describe('import and export', () => {
  const pgQuery = () => (pg as unknown as { __query: Mock }).__query
  const pgClientQuery = () => (pg as unknown as { __clientQuery: Mock }).__clientQuery

  it('exports a whole table as SQL to the chosen file', async () => {
    const id = await connectPg()
    const out = join(tmpdir(), `noxed-export-${Date.now()}.sql`)
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: out })
    pgQuery()
      .mockResolvedValueOnce({ rows: [
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'name', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'doc', data_type: 'jsonb', is_nullable: 'YES' },
      ] })
      .mockResolvedValueOnce({ rows: [{ attname: 'id' }] })
      .mockResolvedValueOnce({
        fields: [{ name: 'id' }, { name: 'name' }, { name: 'doc' }],
        rows: [{ id: 1, name: "o'k", doc: '"x"' }, { id: 2, name: null, doc: null }, { id: 3, name: 'n', doc: 'null' }],
        rowCount: 3,
      })
    const result = await handler('db:exportTable')(event, id, 'users', 'sql')
    expect(result).toEqual({ canceled: false, rows: 3, truncated: false })
    // JSON columns are read as their text, so JSON scalars and SQL NULL stay distinct.
    expect(pgQuery()).toHaveBeenLastCalledWith('SELECT "id", "name", "doc"::text AS "doc" FROM "users" LIMIT 200001', undefined)
    expect(readFileSync(out, 'utf-8')).toBe([
      `INSERT INTO "users" ("id", "name", "doc") VALUES (1, 'o''k', '"x"');`,
      `INSERT INTO "users" ("id", "name", "doc") VALUES (2, NULL, NULL);`,
      `INSERT INTO "users" ("id", "name", "doc") VALUES (3, 'n', 'null');`,
    ].join('\n') + '\n')
  })

  it('streams exports, and a failed one leaves the existing file alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noxed-export-'))
    const out = join(dir, 'table.csv')
    await writeChunks(out, ['a,b\r\n', '1,2\r\n'])
    expect(readFileSync(out, 'utf-8')).toBe('a,b\r\n1,2\r\n')
    await expect(writeChunks(out, ['x'.repeat(10), 'y'.repeat(10)], 15)).rejects.toThrow('larger than')
    expect(readFileSync(out, 'utf-8')).toBe('a,b\r\n1,2\r\n')
    expect(readdirSync(dir)).toEqual(['table.csv'])
  })

  it('validates the export format and honours a cancelled dialog', async () => {
    const id = await connectPg()
    for (const bad of ['xml', 'toString', '__proto__', 42]) {
      await expect(handler('db:exportTable')(event, id, 'users', bad)).rejects.toThrow('Invalid export format')
    }
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: '' })
    expect(await handler('db:exportTable')(event, id, 'users', 'csv')).toEqual({ canceled: true, rows: 0, truncated: false })
  })

  it('imports a CSV in one transaction', async () => {
    const id = await connectPg()
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/u.csv'] })
    vi.mocked(stat).mockResolvedValueOnce({ size: 20 } as never)
    vi.mocked(readFile).mockResolvedValueOnce('name,id\nbob,7\n,8\n' as never)
    pgQuery()
      .mockResolvedValueOnce({ rows: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO' }, { column_name: 'name', data_type: 'text', is_nullable: 'YES' }] })
      .mockResolvedValueOnce({ rows: [{ attname: 'id' }] })
    pgClientQuery().mockClear()
    expect(await handler('db:importCsv')(event, id, 'users')).toEqual({ canceled: false, rows: 2 })
    expect(pgClientQuery().mock.calls.map((c) => c[0])).toEqual([
      'BEGIN',
      'INSERT INTO "users" ("name", "id") VALUES ($1, $2), ($3, $4)',
      'COMMIT',
    ])
    expect(pgClientQuery().mock.calls[1][1]).toEqual(['bob', '7', null, '8'])
  })

  it('rolls the import back when an insert fails', async () => {
    const id = await connectPg()
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/u.csv'] })
    vi.mocked(stat).mockResolvedValueOnce({ size: 20 } as never)
    vi.mocked(readFile).mockResolvedValueOnce('id\n1\n' as never)
    pgQuery()
      .mockResolvedValueOnce({ rows: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO' }] })
      .mockResolvedValueOnce({ rows: [] })
    pgClientQuery().mockClear()
    pgClientQuery().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('duplicate key'))
    await expect(handler('db:importCsv')(event, id, 'users')).rejects.toThrow('duplicate key')
    expect(pgClientQuery().mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'INSERT INTO "users" ("id") VALUES ($1)', 'ROLLBACK'])
  })

  it('refuses oversized files and honours a cancelled dialog', async () => {
    const id = await connectPg()
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await handler('db:importCsv')(event, id, 'users')).toEqual({ canceled: true, rows: 0 })
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/big.csv'] })
    vi.mocked(stat).mockResolvedValueOnce({ size: 60 * 1024 * 1024 } as never)
    await expect(handler('db:importCsv')(event, id, 'users')).rejects.toThrow('larger than 50 MB')
  })

  it('imports into mysql inside a transaction with a multi-row VALUES', async () => {
    const { id } = await connectMysql([
      [[{ Field: 'id', Type: 'int', Null: 'NO' }]],
      [[]],
    ])
    const mysql = (await import('mysql2/promise')).default
    const pool = (mysql.createPool as Mock).mock.results.at(-1)!.value
    const conn = { beginTransaction: vi.fn(), query: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
    pool.getConnection = vi.fn().mockResolvedValue(conn)
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/u.csv'] })
    vi.mocked(stat).mockResolvedValueOnce({ size: 10 } as never)
    vi.mocked(readFile).mockResolvedValueOnce('id\n1\n2\n' as never)
    expect(await handler('db:importCsv')(event, id, 'users')).toEqual({ canceled: false, rows: 2 })
    expect(conn.query).toHaveBeenCalledWith('INSERT INTO `users` (`id`) VALUES ?', [[['1'], ['2']]])
    expect(conn.commit).toHaveBeenCalled()
    expect(conn.release).toHaveBeenCalled()
  })
})
