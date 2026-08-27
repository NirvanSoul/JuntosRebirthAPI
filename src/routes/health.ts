import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createDb } from "../db/client";
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
