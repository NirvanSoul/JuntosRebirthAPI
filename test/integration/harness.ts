import { neon } from "@neondatabase/serverless";
import { createDb, type Database } from "../../src/db/client";
import { user } from "../../src/db/schema";

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

// El proyecto se tipa solo contra los tipos de Cloudflare Workers, así que
// `process` se declara aquí en lugar de añadir @types/node a todo el proyecto
// y arriesgar que el código del Worker use APIs de Node por accidente.
declare const process: { env: Record<string, string | undefined> };

function databaseUrl(): string {
  // `vitest.integration.config.ts` la inyecta; ver el comentario de allí.
  const url = process.env.INTEGRATION_DATABASE_URL;
  if (!url) throw new Error("Run through vitest.integration.config.ts");
  return url;
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
  return id;
}

/** Borra únicamente lo creado por las pruebas. */
export async function cleanupTestUsers() {
  const sql = rawSql();
  await sql`DELETE FROM spaces WHERE created_by LIKE ${TEST_USER_PREFIX + "%"}`;
  await sql`DELETE FROM "user" WHERE id LIKE ${TEST_USER_PREFIX + "%"}`;
  // Los agregados de comercios no cuelgan de ningún usuario, así que el
  // ON DELETE CASCADE no los alcanza: se retiran los que se quedan sin votos.
  await sql`
    DELETE FROM merchant_feedback_aggregates a
     WHERE NOT EXISTS (
       SELECT 1 FROM merchant_feedback_votes v
        WHERE v.country_code = a.country_code
          AND v.normalized_merchant = a.normalized_merchant
          AND v.canonical_category_key = a.canonical_category_key)`;
}
