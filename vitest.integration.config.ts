import fs from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * La URL de la base se resuelve aquí, en Node, y se inyecta en el entorno de
 * las pruebas. Así el arnés no necesita `fs` ni `process`, y el proyecto puede
 * seguir tipándose solo contra los tipos de Cloudflare Workers.
 */
function databaseUrl(): string {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;

  const raw = fs.existsSync(".dev.vars") ? fs.readFileSync(".dev.vars", "utf8") : "";
  for (const line of raw.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0 && line.slice(0, index).trim() === "DATABASE_URL") {
      return line.slice(index + 1).trim().replace(/^"|"$/g, "");
    }
  }
  throw new Error("Set DATABASE_URL_TEST, or DATABASE_URL in .dev.vars");
}

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    // Cada prueba habla con Neon por HTTP: en paralelo se pisarían.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { INTEGRATION_DATABASE_URL: databaseUrl() },
  },
});
