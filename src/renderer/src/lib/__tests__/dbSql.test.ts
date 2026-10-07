import { describe, it, expect } from 'vitest'
import { bindPlaceholder, buildDelete, coerceForColumn, coerceLike, buildInsert, buildUpdate, quoteIdent, selectRows, toEditable, toParam } from '../dbSql'

describe('quoteIdent / bindPlaceholder', () => {
  it('quotes per dialect and escapes embedded quotes', () => {
    expect(quoteIdent('we"ird', 'postgresql')).toBe('"we""ird"')
    expect(quoteIdent('we`ird', 'mysql')).toBe('`we``ird`')
    expect(quoteIdent('t', 'mariadb')).toBe('`t`')
    expect(bindPlaceholder('postgresql', 3)).toBe('$3')
    expect(bindPlaceholder('mysql', 3)).toBe('?')
  })
})

describe('toParam / toEditable', () => {
  it('binds scalars as-is and serialises everything else', () => {
    expect(toParam(undefined)).toBeNull()
    expect(toParam(5)).toBe(5)
    expect(toParam(false)).toBe(false)
    expect(toParam(10n)).toBe('10')
    expect(toParam(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(toParam({ a: 1 })).toBe('{"a":1}')
  })

  it('renders cell values as editable text', () => {
    expect(toEditable(null)).toBe('')
    expect(toEditable('x')).toBe('x')
    expect(toEditable(3)).toBe('3')
    expect(toEditable(true)).toBe('true')
    expect(toEditable(7n)).toBe('7')
    expect(toEditable([1])).toBe('[1]')
  })
})

describe('row statements', () => {
  const row = { org: 7, id: 'a', name: 'x' }

  it('selects a page of a table', () => {
    expect(selectRows('users', 'postgresql', 100)).toBe('SELECT * FROM "users" LIMIT 100')
    expect(selectRows('users', 'mysql', 0)).toBe('SELECT * FROM `users` LIMIT 1')
  })

  it('updates one column, keyed on every primary-key column', () => {
    expect(buildUpdate('t', 'name', 'y', ['org', 'id'], row, 'postgresql')).toEqual({
      sql: 'UPDATE "t" SET "name" = $1 WHERE "org" = $2 AND "id" = $3',
      params: ['y', 7, 'a'],
    })
    expect(buildUpdate('t', 'name', null, ['id'], row, 'mysql')).toEqual({
      sql: 'UPDATE `t` SET `name` = ? WHERE `id` = ?',
      params: [null, 'a'],
    })
  })

  it('refuses to identify rows without a usable key', () => {
    expect(() => buildUpdate('t', 'name', 'y', [], row, 'postgresql')).toThrow('no primary key')
    expect(() => buildDelete('t', ['missing'], row, 'postgresql')).toThrow('Primary key column missing has no value')
  })

  it('deletes by key', () => {
    expect(buildDelete('t', ['org', 'id'], row, 'postgresql')).toEqual({
      sql: 'DELETE FROM "t" WHERE "org" = $1 AND "id" = $2',
      params: [7, 'a'],
    })
  })

  it('inserts the given columns, or a row of defaults', () => {
    expect(buildInsert('t', { a: 1, b: 'x' }, 'postgresql')).toEqual({ sql: 'INSERT INTO "t" ("a", "b") VALUES ($1, $2)', params: [1, 'x'] })
    expect(buildInsert('t', { a: 1 }, 'mysql')).toEqual({ sql: 'INSERT INTO `t` (`a`) VALUES (?)', params: [1] })
    expect(buildInsert('t', {}, 'postgresql').sql).toBe('INSERT INTO "t" DEFAULT VALUES')
    expect(buildInsert('t', {}, 'mysql').sql).toBe('INSERT INTO `t` () VALUES ()')
  })
})

describe('typed values from text', () => {
  it('types booleans and plain numbers by column, leaving the rest as text', () => {
    expect(coerceForColumn('true', 'boolean')).toBe(true)
    expect(coerceForColumn('0', 'tinyint(1)')).toBe(false)
    expect(coerceForColumn('maybe', 'bool')).toBe('maybe')
    // PostgreSQL's bit is a bit string, not a boolean.
    expect(coerceForColumn('1', 'bit')).toBe('1')
    expect(coerceForColumn('42', 'integer')).toBe(42)
    expect(coerceForColumn('3.5', 'double precision')).toBe(3.5)
    expect(coerceForColumn('12abc', 'int')).toBe('12abc')
    // Precision-sensitive types stay text for the database to parse.
    expect(coerceForColumn('9007199254740993', 'bigint')).toBe('9007199254740993')
    expect(coerceForColumn('1.10', 'numeric')).toBe('1.10')
    expect(coerceForColumn('hello', 'text')).toBe('hello')
  })

  it('types an edited cell like the value it replaces', () => {
    expect(coerceLike('false', true)).toBe(false)
    expect(coerceLike('7', 1)).toBe(7)
    expect(coerceLike('7', 'x')).toBe('7')
  })
})

describe('values JSON cannot encode', () => {
  it('fall back to text instead of throwing', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(toEditable(cyclic)).toBe('[object Object]')
    expect(toParam({ big: 1n })).toBe('[object Object]')
  })
})
