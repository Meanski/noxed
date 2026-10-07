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
import { registerDatabaseHandlers } from '../database'

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
