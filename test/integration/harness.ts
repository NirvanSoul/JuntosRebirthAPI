import { neon } from "@neondatabase/serverless";
import { inject } from "vitest";
import { createDb, type Database } from "../../src/db/client";
import { inArray } from "drizzle-orm";
import { spaces, user } from "../../src/db/schema";

declare module "vitest" {
  export interface ProvidedContext {
    integrationDatabaseUrl: string;
    integrationDatabaseMode: "local" | "remote";
  }
}

/**
 * Las pruebas de integración corren contra PostgreSQL real, porque todo lo
 * interesante de este backend vive en SQL: los CTE atómicos, los índices
 * parciales y los `ON CONFLICT`. Un doble del driver no comprueba ninguna de
 * esas tres cosas.
 *
 * Cada prueba crea sus propios usuarios con un prefijo reconocible y los borra
 * al terminar; el `ON DELETE CASCADE` arrastra todo lo que cuelga de ellos.
 * Nunca se toca ninguna fila que no haya creado la propia prueba.
 */
export const TEST_USER_PREFIX = "itest-";

function databaseUrl(): string {
  // `test/integration/node/global-setup.mjs` la entrega tras comprobar que la
  // base es desechable; ver `vitest.integration.config.ts`.
  const url = inject("integrationDatabaseUrl");
  if (!url) throw new Error("Run through vitest.integration.config.ts");
  return url;
}

export function integrationDatabaseMode() {
  return inject("integrationDatabaseMode");
}

export function testDb(): Database {
  return createDb(databaseUrl());
}

/** El motor de recurrencias recibe la URL, no un `Database` ya construido. */
export function databaseUrlForEngine(): string {
  return databaseUrl();
}

export function rawSql() {
  return neon(databaseUrl());
}

let counter = 0;
// Cada archivo de Vitest se ejecuta en su propio contexto aislado. Mantener
// sus IDs evita que el `afterAll` de un archivo borre los datos que otro aún
// está usando si el runner decide solapar workers.
const createdTestUserIds = new Set<string>();

/** Crea un usuario de Better Auth aislado y devuelve su id. */
export async function createTestUser(db: Database, label = "user") {
  const id = `${TEST_USER_PREFIX}${label}-${Date.now()}-${counter++}`;
  const now = new Date();
  await db.insert(user).values({
    id,
    name: label,
    email: `${id}@integration.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  createdTestUserIds.add(id);
  return id;
}

/** Registra usuarios que una prueba crea directamente para controlar su email. */
export function registerTestUser(id: string) {
  createdTestUserIds.add(id);
}

/** Borra únicamente lo creado por las pruebas. */
export async function cleanupTestUsers() {
  const ids = [...createdTestUserIds].filter((id) => id.startsWith(TEST_USER_PREFIX));
  createdTestUserIds.clear();
  if (!ids.length) return;
  const sql = rawSql();
  // Los agregados de comercios no cuelgan de ningún usuario, así que el
  // ON DELETE CASCADE no los alcanza. Solo se tocan las claves que votaron
  // usuarios de prueba: se recalculan con los votos que queden (de otras
  // personas) y se borran únicamente si ya no queda ninguno.
  const touched = await sql.query(
    `SELECT DISTINCT country_code, normalized_merchant, canonical_category_key
       FROM merchant_feedback_votes WHERE user_id = ANY($1::text[])`,
    [ids],
  );
  // Primero espacios: `created_by` es SET NULL, así que borrar solo usuarios
  // dejaría espacios huérfanos y ensuciaría el siguiente archivo.
  await testDb().delete(spaces).where(inArray(spaces.createdBy, ids));
  await testDb().delete(user).where(inArray(user.id, ids));
  for (const key of touched as { country_code: string; normalized_merchant: string; canonical_category_key: string }[]) {
    await recomputeMerchantAggregate(key.country_code, key.normalized_merchant, key.canonical_category_key);
  }
}

/** Recalcula un único agregado a partir de los votos que existan. */
export async function recomputeMerchantAggregate(countryCode: string, merchant: string, categoryKey: string) {
  const sql = rawSql();
  await sql.transaction([
    sql`
      UPDATE merchant_feedback_aggregates a
         SET unique_users = s.users, total_confirmations = s.confirmations, updated_at = now()
        FROM (SELECT count(*)::int AS users, coalesce(sum(confirmations), 0)::int AS confirmations
                FROM merchant_feedback_votes
               WHERE country_code = ${countryCode} AND normalized_merchant = ${merchant}
                 AND canonical_category_key = ${categoryKey}) s
       WHERE a.country_code = ${countryCode} AND a.normalized_merchant = ${merchant}
         AND a.canonical_category_key = ${categoryKey} AND s.users > 0`,
    sql`
      DELETE FROM merchant_feedback_aggregates a
       WHERE a.country_code = ${countryCode} AND a.normalized_merchant = ${merchant}
         AND a.canonical_category_key = ${categoryKey}
         AND NOT EXISTS (
           SELECT 1 FROM merchant_feedback_votes v
            WHERE v.country_code = a.country_code AND v.normalized_merchant = a.normalized_merchant
              AND v.canonical_category_key = a.canonical_category_key)`,
  ]);
}
