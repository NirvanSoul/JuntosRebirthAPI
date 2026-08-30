import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

function build(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql);
}

export type Database = ReturnType<typeof build>;

/**
 * El driver Neon HTTP no mantiene conexión: una instancia es solo un `fetch`
 * configurado, así que reutilizarla dentro del isolate es seguro y evita
 * reconstruirla varias veces por request (algunos handlers la pedían dos
 * veces, y `requireAuth` una más).
 */
const cache = new Map<string, Database>();

export function createDb(databaseUrl: string): Database {
  const cached = cache.get(databaseUrl);
  if (cached) return cached;

  const db = build(databaseUrl);
  // El isolate solo ve una URL en la práctica; el límite evita que una
  // configuración errónea haga crecer el mapa sin control.
  if (cache.size >= 8) cache.clear();
  cache.set(databaseUrl, db);
  return db;
}
