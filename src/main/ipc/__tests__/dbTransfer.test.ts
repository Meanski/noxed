import { describe, it, expect } from 'vitest'
import { csvToRows, parseCsv, quoteIdentifier, toCsv, toJson, toSqlInserts } from '../dbTransfer'

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\n"two\nlines",3\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', '3'],
    ])
  })

  it('keeps empty fields and skips blank lines', () => {
    expect(parseCsv('a,,c\n\n,b,\n')).toEqual([['a', '', 'c'], ['', 'b', '']])
    expect(parseCsv('a,b')).toEqual([['a', 'b']])
    // A quoted empty field is a real (single-column) record; a blank line isn't.
    expect(parseCsv('value\n""\n\nx\n')).toEqual([['value'], [''], ['x']])
    expect(parseCsv('value\r\n""')).toEqual([['value'], ['']])
    // A last line of only separators is a row of empty fields.
    expect(parseCsv('a,b\n,')).toEqual([['a', 'b'], ['', '']])
  })

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,"b\n')).toThrow('CSV ends inside a quoted field')
  })
})

describe('writers', () => {
  const rows = [
    { id: 1, name: 'O\'Neil, Jr', note: 'C:\\temp', meta: { a: 1 }, at: new Date('2026-01-01T00:00:00Z'), ok: true, gone: null, big: 9n },
  ]
  const cols = ['id', 'name', 'note', 'meta', 'at', 'ok', 'gone', 'big']

  it('writes CSV that parses back to the same text', () => {
    const csv = toCsv(cols, rows)
    expect(parseCsv(csv)).toEqual([cols, ['1', "O'Neil, Jr", 'C:\\temp', '{"a":1}', '2026-01-01T00:00:00.000Z', 'true', '', '9']])
  })

  it('writes JSON objects with plain values', () => {
    expect(JSON.parse(toJson(['id', 'meta', 'gone'], rows))).toEqual([{ id: 1, meta: '{"a":1}', gone: null }])
  })

  it('writes INSERTs with dialect-correct quoting and escaping', () => {
    expect(toSqlInserts('t', ['id', 'name', 'note', 'ok', 'gone'], rows, 'postgresql')).toBe(
      `INSERT INTO "t" ("id", "name", "note", "ok", "gone") VALUES (1, 'O''Neil, Jr', 'C:\\temp', TRUE, NULL);\n`,
    )
    expect(toSqlInserts('t', ['note'], rows, 'mysql')).toBe("INSERT INTO `t` (`note`) VALUES ('C:\\\\temp');\n")
    expect(toSqlInserts('t', ['n'], [{ n: Number.NaN }], 'postgresql')).toContain('VALUES (NULL)')
    expect(quoteIdentifier('a"b', 'postgresql')).toBe('"a""b"')
  })
})

describe('csvToRows', () => {
  it('maps headers to table columns case-insensitively and turns empty fields into NULL', () => {
    expect(csvToRows([['NAME', ' id '], ['bob', '7'], ['', '8']], ['id', 'name'])).toEqual({
      columns: ['name', 'id'],
      rows: [['bob', '7'], [null, '8']],
    })
  })

  it('explains bad files', () => {
    expect(() => csvToRows([], ['id'])).toThrow('The CSV file is empty')
    expect(() => csvToRows([['id', 'nope']], ['id'])).toThrow('CSV columns not in the table: nope')
    expect(() => csvToRows([['id', 'ID']], ['id'])).toThrow('repeats a column')
    expect(() => csvToRows([['id', 'name'], ['1']], ['id', 'name'])).toThrow('CSV row 2 has 1 fields; the header has 2')
  })
})

describe('parseCsv edge cases', () => {
  it('handles trailing commas, a final line without newline, and text after a closing quote', () => {
    expect(parseCsv('a,b,\n1,2,')).toEqual([['a', 'b', ''], ['1', '2', '']])
    expect(parseCsv('"ab"c,d')).toEqual([['abc', 'd']])
    expect(parseCsv('x\r\ny\rz')).toEqual([['x'], ['y'], ['z']])
    expect(toCsv(['b'], [{ b: Buffer.from('hi') }])).toBe('b\r\naGk=\r\n')
  })
})

describe('streamed JSON', () => {
  it('matches JSON.stringify exactly, including an empty table', () => {
    const rows = [{ id: 1, tags: { a: [1, 2] } }, { id: 2, tags: null }]
    expect(toJson(['id', 'tags'], rows)).toBe(JSON.stringify([{ id: 1, tags: '{"a":[1,2]}' }, { id: 2, tags: null }], null, 2) + '\n')
    expect(toJson(['id'], [])).toBe('[]\n')
  })
})

describe('SQL export of PostgreSQL arrays and binary data', () => {
  it('writes arrays as array literals, except in JSON columns', () => {
    const sql = toSqlInserts('t', ['ids', 'tags', 'doc'], [{ ids: [1, 2], tags: ['a"b', null, ['x\\y']], doc: [1, 2] }], 'postgresql', ['doc'])
    expect(sql).toBe(`INSERT INTO "t" ("ids", "tags", "doc") VALUES ('{"1","2"}', '{"a\\"b",NULL,{"x\\\\y"}}', '[1,2]');\n`)
  })

  it('writes bytes as bytes in each dialect', () => {
    const bytes = Buffer.from('hi')
    expect(toSqlInserts('t', ['b'], [{ b: bytes }], 'postgresql')).toBe(`INSERT INTO "t" ("b") VALUES ('\\x6869'::bytea);\n`)
    expect(toSqlInserts('t', ['b'], [{ b: bytes }], 'mysql')).toBe("INSERT INTO `t` (`b`) VALUES (X'6869');\n")
    // MySQL keeps arrays (JSON values) as JSON text.
    expect(toSqlInserts('t', ['j'], [{ j: [1] }], 'mysql')).toBe("INSERT INTO `t` (`j`) VALUES ('[1]');\n")
  })
})
