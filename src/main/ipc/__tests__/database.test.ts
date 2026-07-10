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
