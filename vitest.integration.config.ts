import { defineConfig } from "vitest/config";

/**
 * Integración contra PostgreSQL real. La base la decide
 * `test/integration/node/database-target.mjs`:
 *
 * - por defecto, un PostgreSQL local y efímero creado para esta ejecución;
 * - con `DATABASE_URL_TEST`, una base remota que no coincida con la de la
 *   aplicación y que lleve la marca de base desechable.
 *
 * Nunca se usa `DATABASE_URL` de `.dev.vars`: esa URL puede ser producción.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/node/global-setup.mjs"],
    setupFiles: ["test/integration/node/worker-setup.mjs"],
    // Los archivos comparten base: en serie, cada uno limpia solo lo suyo.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
