import { describe, it, expect, vi, beforeEach } from 'vitest'

// A small fake of better-sqlite3: SQL text → canned rows / run results.
const fake = vi.hoisted(() => ({
  reads: new Map<string, unknown[] | ((...args: unknown[]) => unknown[])>(),
  runs: [] as Array<{ sql: string; args: unknown[] }>,
  failOpen: null as Error | null,
  failRunAt: -1,
  closed: false,
}))

vi.mock('better-sqlite3', () => {
  class Database {
    constructor() {
      if (fake.failOpen) throw fake.failOpen
    }
    prepare(sql: string) {
      const isRead = /^\s*(SELECT|PRAGMA|WITH)/i.test(sql)
      return {
        reader: isRead,
        all: (...args: unknown[]) => {
          const hit = fake.reads.get(sql.replace(/\s+/g, ' ').trim())
          return typeof hit === 'function' ? hit(...args) : hit ?? []
        },
        columns: () => [{ name: 'id' }, { name: 'name' }],
        run: (...args: unknown[]) => {
          if (fake.runs.length === fake.failRunAt) throw new Error('constraint failed')
          fake.runs.push({ sql, args })
          return { changes: 1 }
        },
      }
    }
    transaction(fn: () => void) {
      return () => {
        const before = fake.runs.length
        try { fn() } catch (err) { fake.runs.length = before; throw err }
      }
    }
    close() { fake.closed = true }
  }
  return { default: Database }
})

import { connectSqlite, fileEscapingStatement } from '../dbSqlite'
import { ConnectionError, ValidationError } from '../errors'

const TABLES = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
const COLS = 'SELECT name, type, "notnull", pk FROM pragma_table_info(?)'
const FKS = 'SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq'

beforeEach(() => {
  fake.reads.clear()
  fake.runs.length = 0
  fake.failOpen = null
  fake.failRunAt = -1
  fake.reads.set(TABLES, [{ name: 'orders' }, { name: 'users' }])
  fake.reads.set(COLS, (table: unknown) =>
    table === 'users'
      ? [{ name: 'id', type: 'INTEGER', notnull: 1, pk: 1 }, { name: 'email', type: '', notnull: 0, pk: 0 }]
      : [{ name: 'id', type: 'INTEGER', notnull: 1, pk: 1 }, { name: 'user_id', type: 'INTEGER', notnull: 0, pk: 0 }])
  fake.reads.set(FKS, (table: unknown) => (table === 'orders' ? [{ id: 0, seq: 0, table: 'users', from: 'user_id', to: null }] : []))
})

describe('connectSqlite', () => {
  it('reports a file that cannot be opened as a connection error', async () => {
    fake.failOpen = new Error('unable to open database file')
    await expect(connectSqlite({ dbType: 'sqlite', filePath: '/h/missing.db' })).rejects.toThrow(ConnectionError)
  })

  it('returns rows for reads and affected counts for writes, binding booleans as 1/0', async () => {
    const db = await connectSqlite({ dbType: 'sqlite', filePath: '/h/app.db' })
    fake.reads.set('SELECT * FROM users', [{ id: 1, name: 'a' }])
    expect(await db.query('SELECT * FROM users')).toMatchObject({ columns: ['id', 'name'], rows: [{ id: 1, name: 'a' }], rowCount: 1 })
    expect(await db.query('UPDATE users SET active = ? WHERE id = ?', [true, 1])).toMatchObject({ rows: [], rowCount: 1 })
    expect(fake.runs[0].args).toEqual([1, 1])
  })

  it('lists tables and reads column metadata and primary keys', async () => {
    const db = await connectSqlite({ dbType: 'sqlite', filePath: '/h/app.db' })
    expect(await db.getTables()).toEqual(['orders', 'users'])
    expect(await db.getTableInfo('users')).toEqual({
      columns: [{ name: 'id', type: 'INTEGER', nullable: false }, { name: 'email', type: 'any', nullable: true }],
      primaryKey: ['id'],
    })
  })

  it('builds the schema, resolving an FK without a target column to the referenced primary key', async () => {
    const db = await connectSqlite({ dbType: 'sqlite', filePath: '/h/app.db' })
    const schema = await db.getSchema()
    expect(schema.tables.map((t) => t.name)).toEqual(['orders', 'users'])
    expect(schema.foreignKeys).toEqual([{ name: 'orders_fk0', table: 'orders', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }])
  })

  it('imports rows in one transaction and rolls everything back on failure', async () => {
    const db = await connectSqlite({ dbType: 'sqlite', filePath: '/h/app.db' })
    expect(await db.insertRows('users', ['id', 'email'], [['1', 'a'], ['2', null]])).toBe(2)
    expect(fake.runs.map((r) => r.sql)).toEqual(['INSERT INTO "users" ("id", "email") VALUES (?, ?)', 'INSERT INTO "users" ("id", "email") VALUES (?, ?)'])
    fake.runs.length = 0
    fake.failRunAt = 1
    await expect(db.insertRows('users', ['id'], [['1'], ['2']])).rejects.toThrow('constraint failed')
    expect(fake.runs).toEqual([])
    await db.close()
    expect(fake.closed).toBe(true)
  })
})

describe('fileEscapingStatement', () => {
  it.each([
    "ATTACH DATABASE '/etc/x' AS a",
    "  attach '/tmp/x.db' as other",
    "VACUUM INTO '/tmp/copy.db'",
    "vacuum main\ninto '/tmp/copy.db'",
  ])('refuses %j', (sql) => {
    expect(fileEscapingStatement(sql)).not.toBeNull()
  })

  it.each([
    "SELECT * FROM notes WHERE body = 'attach the file'",
    'SELECT "attach" FROM t',
    'SELECT 1 -- ATTACH later',
    'SELECT [vacuum into] FROM t',
    'VACUUM',
  ])('allows %j', (sql) => {
    expect(fileEscapingStatement(sql)).toBeNull()
  })

  it('stops the query before it reaches SQLite', async () => {
    const conn = await connectSqlite({ dbType: 'sqlite', filePath: '/home/me/app.sqlite' })
    await expect(conn.query("ATTACH '/etc/x' AS x")).rejects.toThrow(ValidationError)
  })
})
