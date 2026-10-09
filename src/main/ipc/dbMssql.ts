import sql from 'mssql'
import { ConnectionError, toMessage } from './errors'
import { quoteIdentifier, type CellValue } from './dbTransfer'
import { assembleSchema, valuesPlaceholders, type DbConnection, type ForeignKey, type QueryParam, type SchemaColumnRow, type ServerDbConfig } from './dbTypes'

// SQL Server allows 2100 parameters per request; leave headroom.
const MAX_REQUEST_PARAMS = 2000

function bindAll(request: sql.Request, params: readonly QueryParam[] | undefined): sql.Request {
  ;(params ?? []).forEach((value, i) => request.input(`p${i + 1}`, value))
  return request
}

function recordsetColumns(recordset: sql.IRecordSet<unknown> | undefined): string[] {
  if (!recordset?.columns) return []
  return Object.values(recordset.columns).sort((a, b) => a.index - b.index).map((c) => c.name)
}

export async function connectMssql(config: ServerDbConfig): Promise<DbConnection> {
  const pool = new sql.ConnectionPool({
    server: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    connectionTimeout: 20_000,
    pool: { max: 4 },
    options: {
      encrypt: config.ssl !== 'disable',
      // Only the verify modes check the certificate chain, matching pg/mysql.
      trustServerCertificate: config.ssl !== 'verify-ca' && config.ssl !== 'verify-full',
    },
  })
  pool.on('error', (err) => console.error(`[db:mssql] pool error: ${toMessage(err)}`))
  try {
    await pool.connect()
  } catch (err) {
    await pool.close().catch(() => undefined)
    throw new ConnectionError(toMessage(err))
  }

  const run = (text: string, params?: readonly QueryParam[]) => bindAll(pool.request(), params).query(text)

  return {
    type: 'mssql',
    async query(text: string, params?: QueryParam[]) {
      const start = Date.now()
      const result = await run(text, params)
      const rows = (result.recordset ?? []) as unknown[]
      const affected = result.rowsAffected.reduce((sum, n) => sum + n, 0)
      return {
        columns: recordsetColumns(result.recordset),
        rows,
        rowCount: result.recordset ? rows.length : affected,
        duration: Date.now() - start,
      }
    },
    async close() {
      await pool.close()
    },
    async getTables() {
      const result = await run(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = SCHEMA_NAME() ORDER BY TABLE_NAME`,
      )
      return result.recordset.map((r: { name: string }) => r.name)
    },
    async getTableInfo(table: string) {
      const cols = await run(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = SCHEMA_NAME() AND TABLE_NAME = @p1 ORDER BY ORDINAL_POSITION`,
        [table],
      )
      const pk = await run(
        `SELECT k.COLUMN_NAME AS name FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k ON k.CONSTRAINT_NAME = t.CONSTRAINT_NAME AND k.TABLE_SCHEMA = t.TABLE_SCHEMA
         WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY' AND t.TABLE_SCHEMA = SCHEMA_NAME() AND t.TABLE_NAME = @p1
         ORDER BY k.ORDINAL_POSITION`,
        [table],
      )
      return {
        columns: cols.recordset.map((r: { name: string; type: string; nullable: string }) => ({ name: r.name, type: r.type, nullable: r.nullable === 'YES' })),
        primaryKey: pk.recordset.map((r: { name: string }) => r.name),
      }
    },
    async getSchema() {
      const columns = await run(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
         FROM INFORMATION_SCHEMA.COLUMNS c
         WHERE TABLE_SCHEMA = SCHEMA_NAME()
           AND TABLE_NAME IN (SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = SCHEMA_NAME())
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      )
      const pks = await run(
        `SELECT t.TABLE_NAME AS table_name, k.COLUMN_NAME AS column_name FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k ON k.CONSTRAINT_NAME = t.CONSTRAINT_NAME AND k.TABLE_SCHEMA = t.TABLE_SCHEMA
         WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY' AND t.TABLE_SCHEMA = SCHEMA_NAME()
         ORDER BY t.TABLE_NAME, k.ORDINAL_POSITION`,
      )
      // sys.foreign_key_columns pairs local and referenced columns by position.
      const fkRows = await run(
        `SELECT fk.name AS name, pt.name AS table_name, pc.name AS column_name, rt.name AS ref_table, rc.name AS ref_column
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         WHERE pt.schema_id = SCHEMA_ID()
         ORDER BY pt.name, fk.name, fkc.constraint_column_id`,
      )
      const fks = new Map<string, ForeignKey>()
      for (const r of fkRows.recordset as { name: string; table_name: string; column_name: string; ref_table: string; ref_column: string }[]) {
        const id = `${r.table_name}.${r.name}`
        let fk = fks.get(id)
        if (!fk) {
          fk = { name: r.name, table: r.table_name, columns: [], refTable: r.ref_table, refColumns: [] }
          fks.set(id, fk)
        }
        fk.columns.push(r.column_name)
        fk.refColumns.push(r.ref_column)
      }
      return assembleSchema(columns.recordset as SchemaColumnRow[], pks.recordset, [...fks.values()])
    },
    async insertRows(table: string, columns: string[], rows: CellValue[][]) {
      const target = `${quoteIdentifier(table, 'mssql')} (${columns.map((c) => quoteIdentifier(c, 'mssql')).join(', ')})`
      const perBatch = Math.max(1, Math.floor(MAX_REQUEST_PARAMS / Math.max(1, columns.length)))
      const tx = new sql.Transaction(pool)
      await tx.begin()
      try {
        for (let i = 0; i < rows.length; i += perBatch) {
          const batch = rows.slice(i, i + perBatch)
          const values = valuesPlaceholders(batch.length, columns.length, (n) => `@p${n}`)
          await bindAll(new sql.Request(tx), batch.flat()).query(`INSERT INTO ${target} VALUES ${values}`)
        }
        await tx.commit()
        return rows.length
      } catch (err) {
        await tx.rollback().catch((rollbackErr: unknown) => {
          console.error(`[db:mssql] rollback failed: ${toMessage(rollbackErr)}`)
        })
        throw err
      }
    },
  }
}
