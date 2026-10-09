import { describe, it, expect, vi, beforeEach } from 'vitest'

const fake = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; inputs: Record<string, unknown>; tx: boolean }>,
  respond: (_text: string): unknown => ({ recordset: undefined, rowsAffected: [0] }),
  connectError: null as Error | null,
  txLog: [] as string[],
  failInsert: false,
  config: null as unknown,
}))

vi.mock('mssql', () => {
  class Request {
    inputs: Record<string, unknown> = {}
    constructor(private readonly inTx = false) {}
    input(name: string, value: unknown) { this.inputs[name] = value; return this }
    async query(text: string) {
      fake.queries.push({ text, inputs: this.inputs, tx: this.inTx })
      if (fake.failInsert && text.startsWith('INSERT')) throw new Error('PRIMARY KEY violation')
      return fake.respond(text)
    }
  }
  class ConnectionPool {
    constructor(config: unknown) { fake.config = config }
    on() { return this }
    async connect() { if (fake.connectError) throw fake.connectError; return this }
    async close() {}
    request() { return new Request(false) }
  }
  class Transaction {
    async begin() { fake.txLog.push('begin') }
    async commit() { fake.txLog.push('commit') }
    async rollback() { fake.txLog.push('rollback') }
  }
  class TxRequest extends Request { constructor() { super(true) } }
  return { default: { ConnectionPool, Transaction, Request: TxRequest } }
})

import { connectMssql } from '../dbMssql'
import { ConnectionError } from '../errors'

const config = { dbType: 'mssql' as const, host: 'sql.example.com', port: 1433, username: 'sa', password: 'pw', database: 'app', ssl: 'require' as const }
const recordset = (rows: Record<string, unknown>[], names: string[]) =>
  Object.assign(rows, { columns: Object.fromEntries(names.map((n, index) => [n, { name: n, index }])) })

beforeEach(() => {
  fake.queries.length = 0
  fake.txLog.length = 0
  fake.connectError = null
  fake.failInsert = false
  fake.respond = () => ({ recordset: undefined, rowsAffected: [0] })
})

describe('connectMssql', () => {
  it('maps SSL modes onto encrypt / certificate checking', async () => {
    await connectMssql(config)
    expect(fake.config).toMatchObject({ server: 'sql.example.com', options: { encrypt: true, trustServerCertificate: true } })
    await connectMssql({ ...config, ssl: 'verify-full' })
    expect(fake.config).toMatchObject({ options: { encrypt: true, trustServerCertificate: false } })
    await connectMssql({ ...config, ssl: 'disable' })
    expect(fake.config).toMatchObject({ options: { encrypt: false } })
  })

  it('surfaces a failed connect as a connection error', async () => {
    fake.connectError = new Error('Login failed for user')
    await expect(connectMssql(config)).rejects.toThrow(ConnectionError)
  })

  it('binds parameters as @p1.. and reports rows or affected counts', async () => {
    const db = await connectMssql(config)
    fake.respond = () => ({ recordset: recordset([{ id: 1, name: 'a' }], ['name', 'id'].reverse()), rowsAffected: [1] })
    expect(await db.query('SELECT * FROM [users] WHERE [id] = @p1', [1])).toMatchObject({ columns: ['id', 'name'], rowCount: 1 })
    expect(fake.queries[0].inputs).toEqual({ p1: 1 })
    fake.respond = () => ({ recordset: undefined, rowsAffected: [2, 1] })
    expect(await db.query('UPDATE [users] SET [a] = @p1', ['x'])).toMatchObject({ rows: [], rowCount: 3 })
  })

  it('reads tables, columns, keys and foreign keys', async () => {
    const db = await connectMssql(config)
    fake.respond = (text) => {
      if (text.includes('INFORMATION_SCHEMA.TABLES') && !text.includes('COLUMNS')) return { recordset: [{ name: 'orders' }, { name: 'users' }] }
      if (text.includes("CONSTRAINT_TYPE = 'PRIMARY KEY'") && text.includes('@p1')) return { recordset: [{ name: 'id' }] }
      if (text.includes('INFORMATION_SCHEMA.COLUMNS') && text.includes('@p1')) return { recordset: [{ name: 'id', type: 'int', nullable: 'NO' }] }
      if (text.includes('INFORMATION_SCHEMA.COLUMNS')) return { recordset: [{ table_name: 'orders', column_name: 'user_id', data_type: 'int', is_nullable: 'YES' }, { table_name: 'users', column_name: 'id', data_type: 'int', is_nullable: 'NO' }] }
      if (text.includes("CONSTRAINT_TYPE = 'PRIMARY KEY'")) return { recordset: [{ table_name: 'users', column_name: 'id' }] }
      if (text.includes('sys.foreign_keys')) return { recordset: [{ name: 'fk_orders_users', table_name: 'orders', column_name: 'user_id', ref_table: 'users', ref_column: 'id' }] }
      return { recordset: [] }
    }
    expect(await db.getTables()).toEqual(['orders', 'users'])
    expect(await db.getTableInfo('users')).toEqual({ columns: [{ name: 'id', type: 'int', nullable: false }], primaryKey: ['id'] })
    expect((await db.getSchema()).foreignKeys).toEqual([{ name: 'fk_orders_users', table: 'orders', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }])
  })

  it('imports inside a transaction with multi-row VALUES, rolling back on error', async () => {
    const db = await connectMssql(config)
    expect(await db.insertRows('users', ['id', 'name'], [['1', 'a'], ['2', null]])).toBe(2)
    const insert = fake.queries.find((q) => q.text.startsWith('INSERT'))!
    expect(insert).toEqual({ text: 'INSERT INTO [users] ([id], [name]) VALUES (@p1, @p2), (@p3, @p4)', inputs: { p1: '1', p2: 'a', p3: '2', p4: null }, tx: true })
    expect(fake.txLog).toEqual(['begin', 'commit'])
    fake.txLog.length = 0
    fake.failInsert = true
    await expect(db.insertRows('users', ['id'], [['1']])).rejects.toThrow('PRIMARY KEY violation')
    expect(fake.txLog).toEqual(['begin', 'rollback'])
    await db.close()
  })
})
