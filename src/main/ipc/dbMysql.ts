import mysql from 'mysql2/promise'
import { ConnectionError, toMessage } from './errors'
import { quoteIdentifier, type CellValue } from './dbTransfer'
import { assembleSchema, rowsPerBatch, sslOption, type DbConnectConfig, type DbConnection, type ForeignKey, type QueryParam, type SchemaColumnRow } from './dbTypes'

export async function connectMysql(config: DbConnectConfig): Promise<DbConnection> {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl: sslOption(config.ssl),
    connectionLimit: 4,
    connectTimeout: 20_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  })

  try {
    const testConn = await pool.getConnection()
    testConn.release()
  } catch (err) {
    await pool.end().catch(() => undefined) // never connected; nothing left to clean up
    throw new ConnectionError(toMessage(err))
  }

  return {
    type: config.dbType === 'mariadb' ? 'mariadb' : 'mysql',
    async query(sql: string, params?: QueryParam[]) {
      const start = Date.now()
      const [rows, fields] = await pool.query(sql, params)
      const resultRows = Array.isArray(rows) ? rows as unknown[] : []
      const resultFields = Array.isArray(fields) ? fields : []
      // Writes return a ResultSetHeader instead of rows; report how many rows
      // they touched, as pg does, so callers can verify an edit hit one row.
      const affected = Array.isArray(rows) ? resultRows.length : (rows as { affectedRows?: number }).affectedRows ?? 0
      return {
        columns: resultFields.map((f: { name: string }) => f.name),
        rows: resultRows,
        rowCount: affected,
        duration: Date.now() - start,
      }
    },
    async close() {
      await pool.end()
    },
    async getTables() {
      const [rows] = await pool.query('SHOW TABLES')
      return (rows as Record<string, unknown>[]).map(r => Object.values(r)[0] as string)
    },
    async getTableInfo(table: string) {
      const [rows] = await pool.query('DESCRIBE ??', [table])
      const [keys] = await pool.query("SHOW KEYS FROM ?? WHERE Key_name = 'PRIMARY'", [table])
      return {
        columns: (rows as { Field: string; Type: string; Null: string }[]).map(r => ({
          name: r.Field,
          type: r.Type,
          nullable: r.Null === 'YES',
        })),
        primaryKey: (keys as { Column_name: string; Seq_in_index: number }[])
          .sort((a, b) => a.Seq_in_index - b.Seq_in_index)
          .map(k => k.Column_name),
      }
    },
    async getSchema() {
      const [columns] = await pool.query(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS data_type, IS_NULLABLE AS is_nullable
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
      )
      const [pks] = await pool.query(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION`
      )
      const [fkRows] = await pool.query(
        `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`
      )
      const fks = new Map<string, ForeignKey>()
      for (const r of fkRows as { name: string; table_name: string; column_name: string; ref_table: string; ref_column: string }[]) {
        const id = `${r.table_name}.${r.name}`
        let fk = fks.get(id)
        if (!fk) {
          fk = { name: r.name, table: r.table_name, columns: [], refTable: r.ref_table, refColumns: [] }
          fks.set(id, fk)
        }
        fk.columns.push(r.column_name)
        fk.refColumns.push(r.ref_column)
      }
      return assembleSchema(columns as SchemaColumnRow[], pks as { table_name: string; column_name: string }[], [...fks.values()])
    },
    async insertRows(table: string, columns: string[], rows: CellValue[][]) {
      const conn = await pool.getConnection()
      const target = `${quoteIdentifier(table, config.dbType)} (${columns.map((c) => quoteIdentifier(c, config.dbType)).join(', ')})`
      const perBatch = rowsPerBatch(columns.length)
      try {
        await conn.beginTransaction()
        // mysql2 expands `VALUES ?` with a nested array into a multi-row insert.
        for (let i = 0; i < rows.length; i += perBatch) {
          await conn.query(`INSERT INTO ${target} VALUES ?`, [rows.slice(i, i + perBatch)])
        }
        await conn.commit()
        return rows.length
      } catch (err) {
        await conn.rollback().catch((rollbackErr: unknown) => {
          console.error(`[db:mysql] rollback failed: ${toMessage(rollbackErr)}`)
        })
        throw err
      } finally {
        conn.release()
      }
    },
  }
}
