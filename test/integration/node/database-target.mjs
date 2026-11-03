// Decide contra qué base corren las pruebas de integración y se niega a
// continuar si no puede demostrar que es desechable.
//
// - Sin `DATABASE_URL_TEST`: arranca un PostgreSQL local nuevo en un
//   directorio temporal, aplica todas las migraciones y lo destruye al acabar.
//   Es el modo por defecto y nunca sale de la máquina.
// - Con `DATABASE_URL_TEST`: usa esa base solo si (a) no coincide con la
//   `DATABASE_URL` de la aplicación (`.dev.vars` o entorno) y (b) contiene la
//   marca `juntos_integration_marker` con `disposable = true`, que alguien creó
//   a propósito en esa base. Nunca se recurre a `DATABASE_URL`.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const MARKER_TABLE = "juntos_integration_marker";

/** Lee una clave de `.dev.vars` solo para compararla; nunca para conectarse. */
export function readDevVar(name, file = ".dev.vars") {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const line of raw.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0 && line.slice(0, index).trim() === name) {
      return line.slice(index + 1).trim().replace(/^"|"$/g, "");
    }
  }
  return undefined;
}

/** Identidad de una base sin credenciales: host, puerto y nombre. */
export function databaseIdentity(connectionString) {
  const url = new URL(connectionString);
  const host = url.hostname.toLowerCase().replace(/-pooler(?=\.)/, "");
  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  return `${host}:${port}/${database}`;
}

/**
 * Valida la URL remota antes de abrir ninguna conexión. Devuelve el motivo de
 * rechazo o `null`.
 */
export function remoteTargetProblem(testUrl, appUrls) {
  let identity;
  try {
    identity = databaseIdentity(testUrl);
  } catch {
    return "DATABASE_URL_TEST is not a valid connection string";
  }
  for (const appUrl of appUrls.filter(Boolean)) {
    try {
      if (databaseIdentity(appUrl) === identity) {
        return "DATABASE_URL_TEST points at the application DATABASE_URL; refusing to run";
      }
    } catch {
      // Una URL de la app ilegible no puede coincidir.
    }
  }
  return null;
}

export const MARKER_SQL = `CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
  disposable boolean NOT NULL CHECK (disposable),
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`;

async function assertMarker(neon, connectionString) {
  const sql = neon(connectionString);
  const rows = await sql.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
     ) AS present`,
    [MARKER_TABLE],
  );
  if (!rows[0]?.present) {
    throw new Error(
      `Refusing to run integration tests: ${MARKER_TABLE} is missing in DATABASE_URL_TEST. ` +
        "Create it only in a disposable database (see README, 'Pruebas de integración').",
    );
  }
  const marked = await sql.query(`SELECT count(*)::int AS n FROM ${MARKER_TABLE} WHERE disposable`);
  if (!marked[0]?.n) throw new Error(`Refusing to run integration tests: ${MARKER_TABLE} has no disposable row`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startLocalPostgres() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "juntos-itest-pg-"));
  const port = await freePort();
  const password = crypto.randomBytes(12).toString("hex");
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "juntos_itest",
    password,
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase("juntos_itest");
  const url = `postgresql://juntos_itest:${password}@127.0.0.1:${port}/juntos_itest`;
  return {
    url,
    async stop() {
      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function resolveIntegrationDatabase() {
  const { neon } = await import("@neondatabase/serverless");
  const testUrl = process.env.DATABASE_URL_TEST;

  if (testUrl) {
    const problem = remoteTargetProblem(testUrl, [process.env.DATABASE_URL, readDevVar("DATABASE_URL")]);
    if (problem) throw new Error(problem);
    await assertMarker(neon, testUrl);
    return { url: testUrl, mode: "remote", stop: async () => {} };
  }

  const { installLocalNeonFetch, closeLocalNeonPools } = await import("./neon-local-fetch.mjs");
  installLocalNeonFetch();
  const local = await startLocalPostgres();
  try {
    const { drizzle } = await import("drizzle-orm/neon-http");
    const { migrate } = await import("drizzle-orm/neon-http/migrator");
    // El mismo migrador que `scripts/migrate.mjs`: valida orden y journal.
    await migrate(drizzle(neon(local.url)), { migrationsFolder: "drizzle" });
    await neon(local.url).query(MARKER_SQL);
    await neon(local.url).query(
      `INSERT INTO ${MARKER_TABLE} (disposable, note) VALUES (true, 'ephemeral local cluster')`,
    );
  } catch (error) {
    await closeLocalNeonPools();
    await local.stop();
    throw error;
  }
  return {
    url: local.url,
    mode: "local",
    async stop() {
      await closeLocalNeonPools();
      await local.stop();
    },
  };
}
