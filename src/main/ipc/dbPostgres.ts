import { Pool as PgPool } from 'pg'
import { ConnectionError, toMessage } from './errors'
import { quoteIdentifier, type CellValue } from './dbTransfer'
import { assembleSchema, rowsPerBatch, sslOption, type DbConnectConfig, type DbConnection, type QueryParam } from './dbTypes'

export async function connectPostgres(config: DbConnectConfig): Promise<DbConnection> {
  const pool = new PgPool({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl: sslOption(config.ssl),
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 30_000,
    max: 4,
  })

  // Surface pool-level errors instead of letting Node throw.
  pool.on('error', (err) => console.error(`[db:pg] pool error: ${toMessage(err)}`))

  try {
    const testClient = await pool.connect()
    testClient.release()
  } catch (err) {
    await pool.end().catch(() => undefined) // never connected; nothing left to clean up
    throw new ConnectionError(toMessage(err))
  }

  return {
    type: 'postgresql',
    async query(sql: string, params?: QueryParam[]) {
      const start = Date.now()
      const result = await pool.query(sql, params)
      return {
        columns: result.fields?.map(f => f.name) ?? [],
        rows: result.rows ?? [],
        rowCount: result.rowCount ?? 0,
        duration: Date.now() - start,
      }
    },
    async close() {
      await pool.end()
    },
    async getTables() {
      const result = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`
      )
      return result.rows.map((r: { table_name: string }) => r.table_name)
    },
    async getTableInfo(table: string) {
      const result = await pool.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        [table]
      )
      // The schema the connection works in (search_path's first), as for the
      // table list. quote_ident keeps mixed-case names intact; to_regclass
      // returns NULL (no rows) instead of erroring for a missing table. Only
      // the first indnkeyatts columns are the key: the rest are INCLUDE
      // columns stored alongside it.
      const pk = await pool.query(
        `SELECT a.attname FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE i.indrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident($1))
           AND i.indisprimary AND k.ord <= i.indnkeyatts
         ORDER BY k.ord`,
        [table]
      )
      return {
        columns: result.rows.map((r: { column_name: string; data_type: string; is_nullable: string }) => ({
          name: r.column_name,
          type: r.data_type,
          nullable: r.is_nullable === 'YES',
        })),
        primaryKey: pk.rows.map((r: { attname: string }) => r.attname),
      }
    },
    async getSchema() {
      const columns = await pool.query(
        `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`
      )
      // Key columns only (the first indnkeyatts), in key order, as tableInfo does.
      const pks = await pool.query(
        `SELECT cl.relname AS table_name, a.attname::text AS column_name
         FROM pg_index i
         JOIN pg_class cl ON cl.oid = i.indrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE i.indisprimary AND ns.nspname = current_schema() AND k.ord <= i.indnkeyatts
         ORDER BY cl.relname, k.ord`
      )
      // pg_constraint pairs each local column with its referenced column by
      // position, so composite keys stay aligned (information_schema can't).
      const fks = await pool.query(
        `SELECT con.conname AS name, cl.relname AS table_name, rcl.relname AS ref_table,
                array_agg(att.attname::text ORDER BY k.ord) AS columns,
                array_agg(ratt.attname::text ORDER BY k.ord) AS ref_columns
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_class rcl ON rcl.oid = con.confrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_namespace rns ON rns.oid = rcl.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(col, refcol, ord)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.col
         JOIN pg_attribute ratt ON ratt.attrelid = con.confrelid AND ratt.attnum = k.refcol
         -- Tables are matched by bare name, so both ends must be in this schema.
         WHERE con.contype = 'f' AND ns.nspname = current_schema() AND rns.nspname = current_schema()
         GROUP BY con.conname, cl.relname, rcl.relname`
      )
      return assembleSchema(
        columns.rows,
        pks.rows,
        fks.rows.map((r: { name: string; table_name: string; ref_table: string; columns: string[]; ref_columns: string[] }) => ({
          name: r.name, table: r.table_name, columns: r.columns, refTable: r.ref_table, refColumns: r.ref_columns,
        })),
      )
    },
    async insertRows(table: string, columns: string[], rows: CellValue[][]) {
      const client = await pool.connect()
      const target = `${quoteIdentifier(table, 'postgresql')} (${columns.map((c) => quoteIdentifier(c, 'postgresql')).join(', ')})`
      const perBatch = rowsPerBatch(columns.length)
      try {
        await client.query('BEGIN')
        for (let i = 0; i < rows.length; i += perBatch) {
          const batch = rows.slice(i, i + perBatch)
          const values = batch
            .map((row, r) => `(${row.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`)
            .join(', ')
          await client.query(`INSERT INTO ${target} VALUES ${values}`, batch.flat())
        }
        await client.query('COMMIT')
        return rows.length
      } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
          console.error(`[db:pg] rollback failed: ${toMessage(rollbackErr)}`)
        })
        throw err
      } finally {
        client.release()
      }
    },
  }
}
