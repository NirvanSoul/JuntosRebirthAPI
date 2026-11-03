import { eq, getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "./client";
import { categories, moneyAccounts, recurringTransactionSeries, transactions } from "./schema";

/**
 * Escrituras de entidades sincronizadas (padre con versión `updated_at` e
 * hijos: presupuestos, saldos, tasas congeladas) compartidas por el sync y por
 * las rutas REST. Todas se usan dentro de un `db.batch` (una transacción).
 */
export type VersionedTable =
  | typeof categories
  | typeof moneyAccounts
  | typeof recurringTransactionSeries
  | typeof transactions;

const SPACE_LOCK_PREFIX = "juntos.space-sync:";

/**
 * Bloqueo consultivo de transacción por espacio, como primera sentencia del
 * batch. Dos escrituras del mismo espacio que tocaran las mismas filas en
 * orden distinto se bloqueaban en cruz (`40P01 deadlock detected`); con él se
 * serializan. Se libera al confirmar o abortar y no afecta a otros espacios.
 * La clave se normaliza en SQL (`::uuid::text`) para coincidir con
 * `spaceWriteLockOf`.
 */
export function spaceWriteLock(db: Database, spaceId: string) {
  return db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${SPACE_LOCK_PREFIX} || ${spaceId}::uuid::text, 0))`,
  );
}

/** El mismo bloqueo, resolviendo el espacio desde la fila del padre. */
export function spaceWriteLockOf(db: Database, table: VersionedTable, id: string) {
  return db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${SPACE_LOCK_PREFIX} || ${table.spaceId}::text, 0)) FROM ${table} WHERE ${table.id} = ${id}`,
  );
}

/**
 * Condición SQL: la versión `updatedAt` es la vigente del padre en este
 * espacio. Se evalúa dentro del mismo batch, después de la escritura del
 * padre: un `INSERT ... ON CONFLICT DO UPDATE` o `UPDATE` bloquea la fila
 * (aunque su `WHERE` la descarte), así que nadie puede cambiar el padre entre
 * esta comprobación y el commit. Tras la escritura, el padre conserva
 * `updatedAt` solo si esta versión se aplicó.
 */
export function versionIsCurrent(table: VersionedTable, id: string, spaceId: string, updatedAt: Date): SQL {
  return sql`EXISTS (SELECT 1 FROM ${table} WHERE ${table.id} = ${id} AND ${table.spaceId} = ${spaceId} AND ${table.updatedAt} = ${updatedAt.toISOString()}::timestamptz)`;
}

/**
 * `INSERT ... SELECT ... WHERE <condición>`: Drizzle no admite condicionar un
 * `INSERT ... VALUES`. Las columnas se nombran y convierten con los metadatos
 * de la tabla, así que los valores siguen siendo los tipados del esquema.
 */
export function insertWhen<T extends PgTable>(
  db: Database,
  table: T,
  rows: Partial<T["$inferInsert"]>[],
  condition: SQL,
  onConflict: SQL = sql``,
) {
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const keys = Object.keys(rows[0]!);
  const names = sql.join(keys.map((key) => sql.identifier(columns[key]!.name)), sql`, `);
  const tuples = sql.join(
    rows.map((row) => {
      const values = keys.map((key) => {
        const column = columns[key]!;
        const value = (row as Record<string, unknown>)[key];
        const param = value === null || value === undefined ? sql`NULL` : sql.param(value, column);
        return sql`${param}::${sql.raw(column.getSQLType())}`;
      });
      return sql`(${sql.join(values, sql`, `)})`;
    }),
    sql`, `,
  );
  const query = db.execute(
    sql`INSERT INTO ${table} (${names}) SELECT * FROM (VALUES ${tuples}) AS v WHERE ${condition}${onConflict}`,
  );
  // Solo descriptivo: permite a las pruebas unitarias leer las filas.
  return Object.assign(query, { gatedInsert: { table: getTableName(table), rows } });
}

/**
 * Un cambio de un hijo por REST es una versión nueva del padre: avanza
 * `updated_at` estrictamente (para que un push con la versión anterior pierda
 * aunque el reloj del cliente vaya adelantado) y el trigger mueve
 * `server_updated_at`, así que el cambio sale por `/v1/sync/changes`.
 */
export function bumpVersion(db: Database, table: VersionedTable, id: string) {
  return db
    .update(table)
    .set({ updatedAt: sql`GREATEST(${table.updatedAt} + interval '1 millisecond', now())` })
    .where(eq(table.id, id));
}
