import { Hono } from "hono";
import { createDb } from "../db/client";
import { errorResponse, type ErrorCode } from "../lib/http";
import { parseBody } from "../lib/validation";
import type { AuthVariables } from "../middleware/auth";
import * as service from "../services/guest-migration";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings; Variables: AuthVariables };

const COLLECTIONS = [
  "spaces",
  "categories",
  "moneyAccounts",
  "recurringSeries",
  "transactions",
] as const;

/** Errores del servicio que sí son culpa del cliente. Todo lo demás es un 500. */
const CLIENT_ERRORS: Record<string, ErrorCode> = {
  MIGRATION_IN_PROGRESS: "MIGRATION_IN_PROGRESS",
  BOOTSTRAP_REQUIRED: "BOOTSTRAP_REQUIRED",
  INVALID_PAYLOAD: "INVALID_REQUEST",
  INVALID_GRAPH: "INVALID_REQUEST",
};

export const guestMigrationRoute = new Hono<Env>();

guestMigrationRoute.post("/guest-migration", async (c) => {
  const body = await parseBody(c.req.raw, ["batchId", "installationId", ...COLLECTIONS]);
  if (
    !body ||
    typeof body.batchId !== "string" ||
    typeof body.installationId !== "string" ||
    COLLECTIONS.some((key) => !Array.isArray(body[key]))
  ) {
    return errorResponse(c, "INVALID_REQUEST");
  }

  try {
    const result = await service.migrateGuest(
      createDb(c.env.DATABASE_URL),
      c.get("currentUserId"),
      body as unknown as service.GuestPayload,
    );
    return c.json({ data: result }, 201);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    const code = CLIENT_ERRORS[reason];
    if (!code) {
      // Un fallo de base de datos no es una petición inválida: antes todo
      // acababa como 400 y el cliente no podía distinguirlo de un payload malo.
      console.error("Guest migration failed:", reason);
      return errorResponse(c, "INTERNAL_ERROR");
    }
    return errorResponse(c, code, "Guest migration could not be completed.");
  }
});
