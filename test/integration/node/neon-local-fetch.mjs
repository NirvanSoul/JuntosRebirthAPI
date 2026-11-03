// Puente de pruebas: el driver Neon HTTP de producción habla con un
// PostgreSQL local y desechable.
//
// `drizzle-orm/neon-http` no abre conexiones: cada consulta es un POST con
// `{ query, params }` y cada `db.batch` un POST con `{ queries }` que Neon
// ejecuta como UNA transacción. Sustituir `fetch` por esta función permite
// ejecutar exactamente el mismo código de la API (incluida la atomicidad del
// batch y los códigos de error de PostgreSQL) contra un servidor real local,
// sin Docker ni una base remota.
//
// Solo se acepta un host de bucle local: el puente nunca puede apuntar a una
// base remota aunque una prueba se configure mal.
import pg from "pg";
import { neonConfig } from "@neondatabase/serverless";

const pools = new Map();

/** Las filas viajan como texto; el driver Neon las interpreta por `dataTypeID`. */
const rawText = { getTypeParser: () => (value) => value };

const ERROR_FIELDS = [
  "severity", "code", "detail", "hint", "position", "internalPosition", "internalQuery",
  "where", "schema", "table", "column", "dataType", "constraint", "file", "line", "routine",
];

const ISOLATION = {
  ReadUncommitted: "READ UNCOMMITTED",
  ReadCommitted: "READ COMMITTED",
  RepeatableRead: "REPEATABLE READ",
  Serializable: "SERIALIZABLE",
};

export function isLoopbackConnectionString(connectionString) {
  try {
    const { hostname } = new URL(connectionString);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function poolFor(connectionString) {
  if (!isLoopbackConnectionString(connectionString)) {
    throw new Error("neon-local-fetch only talks to a loopback PostgreSQL");
  }
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({ connectionString, max: 10 });
    pools.set(connectionString, pool);
  }
  return pool;
}

async function run(client, { query, params }) {
  const result = await client.query({ text: query, values: params, rowMode: "array", types: rawText });
  return {
    fields: result.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })),
    rows: result.rows,
    command: result.command,
    rowCount: result.rowCount,
  };
}

function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  return headers[name];
}

function errorResponse(error) {
  const body = { message: error?.message ?? String(error) };
  for (const field of ERROR_FIELDS) if (error?.[field] !== undefined) body[field] = error[field];
  return new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
}

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

export async function localNeonFetch(_url, init) {
  const connectionString = header(init?.headers, "Neon-Connection-String");
  const pool = poolFor(connectionString);
  const body = JSON.parse(init.body);

  if (!Array.isArray(body.queries)) {
    try {
      return json(await run(pool, body));
    } catch (error) {
      return errorResponse(error);
    }
  }

  // Igual que Neon: el lote entero es una transacción.
  const isolation = ISOLATION[header(init.headers, "Neon-Batch-Isolation-Level")] ?? "READ COMMITTED";
  const readOnly = header(init.headers, "Neon-Batch-Read-Only") === "true";
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}${readOnly ? " READ ONLY" : ""}`);
    const results = [];
    for (const query of body.queries) results.push(await run(client, query));
    await client.query("COMMIT");
    return json({ results });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return errorResponse(error);
  } finally {
    client.release();
  }
}

export function installLocalNeonFetch() {
  neonConfig.fetchFunction = localNeonFetch;
}

export async function closeLocalNeonPools() {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}
