import { describe, it, expect, vi, type Mock } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))
vi.mock('pg', () => {
  const query = vi.fn().mockResolvedValue({ fields: [{ name: 'x' }], rows: [{ x: 1 }], rowCount: 1 })
  const connect = vi.fn().mockResolvedValue({ release: vi.fn() })
  // Regular function so `new Pool(...)` works (arrows are not constructible)
  const PoolCtor = vi.fn(function Pool() {
    return { query, connect, end: vi.fn(), on: vi.fn() }
  })
  return { Pool: PoolCtor, __query: query }
})
vi.mock('mysql2/promise', () => ({
  default: { createPool: vi.fn() },
}))

import { ipcMain } from 'electron'
import * as pg from 'pg'
import { assembleSchema, registerDatabaseHandlers } from '../database'

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
