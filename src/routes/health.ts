import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { inspectConfig } from "../lib/config";
import { verifyEmailConfig } from "../services/email";
import type { Bindings } from "../types/env";

export const healthRoute = new Hono<{ Bindings: Bindings }>();

healthRoute.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "juntoss-api",
  });
});

healthRoute.get("/health/db", async (c) => {
  try {
    const databaseUrl = c.env?.DATABASE_URL;
    if (!databaseUrl) {
      console.error("DATABASE_URL is not defined in environment");
      return c.json(
        {
          status: "error",
          database: "unavailable",
        },
        500
      );
    }

    const db = createDb(databaseUrl);
    await db.execute(sql`SELECT 1`);

    return c.json(
      {
        status: "ok",
        database: "connected",
      },
      200
    );
  } catch (error) {
    console.error("Database connection error:", error);
    return c.json(
      {
        status: "error",
        database: "unavailable",
      },
      500
    );
  }
});

/**
 * Estado de la configuración del despliegue. Solo devuelve presencia, nunca
 * valores, pero aun así va detrás de sesión: saber qué le falta a un
 * despliegue es información útil para quien lo ataque.
 */
healthRoute.get("/health/config", async (c) => {
  const report = inspectConfig(c.env);

  // La comprobación de correo sale de la red, así que solo se hace a petición:
  // /health/config?email=1
  const email =
    c.req.query("email") === "1"
      ? await verifyEmailConfig({
          apiKey: c.env.RESEND_API_KEY,
          from: c.env.RESEND_FROM,
          appUrl: c.env.APP_URL,
        })
      : undefined;
  return c.json(
    {
      status: report.ok ? "ok" : "incomplete",
      present: report.present,
      missingRequired: report.missingRequired,
      missingOptional: report.missingOptional,
      degraded: report.degraded,
      ...(email ? { email } : {}),
    },
    report.ok ? 200 : 503,
  );
});
