import { Hono, type MiddlewareHandler } from "hono";
import { createDb } from "../db/client";
import { errorResponse, type ErrorCode } from "../lib/http";
import { parseBody } from "../lib/validation";
import type { AuthVariables } from "../middleware/auth";
import {
  requireActiveSpaceMember,
  type SpaceAccessVariables,
} from "../middleware/space-access";
import { buildSnapshot } from "../services/sync-snapshot";
import { syncSpaceData } from "../services/space-sync";
import { findUserCountryCode } from "../services/account";
import type { Bindings } from "../types/env";

type SnapshotEnv = { Bindings: Bindings; Variables: AuthVariables };
type SpaceEnv = { Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables };

const COLLECTIONS = ["categories", "moneyAccounts", "recurringSeries", "transactions"] as const;

const CLIENT_ERRORS: Record<string, ErrorCode> = {
  INVALID_PAYLOAD: "INVALID_REQUEST",
  INVALID_GRAPH: "INVALID_REQUEST",
  CUSTOM_RATE_NOT_FOUND: "CUSTOM_RATE_NOT_FOUND",
  SPACE_NOT_FOUND: "SPACE_NOT_FOUND",
};

type SnapshotDeps = { createDb: typeof createDb; buildSnapshot: typeof buildSnapshot };
type SpaceSyncDeps = { createDb: typeof createDb; syncSpaceData: typeof syncSpaceData; findUserCountryCode: typeof findUserCountryCode };

/** `GET /v1/sync/snapshot` — estado remoto completo para restaurar el dispositivo. */
export function createSnapshotRoute(
  deps: SnapshotDeps = { createDb, buildSnapshot },
) {
  const route = new Hono<SnapshotEnv>();

  route.get("/snapshot", async (c) => {
    try {
      const snapshot = await deps.buildSnapshot(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
      );
      return c.json({ data: snapshot });
    } catch (error) {
      console.error("Snapshot failed:", error);
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  return route;
}

/** `POST /v1/spaces/:spaceId/sync` — lote de cambios del espacio compartido. */
export function createSpaceSyncRoute(
  deps: SpaceSyncDeps = { createDb, syncSpaceData, findUserCountryCode },
  access: MiddlewareHandler<SpaceEnv> = requireActiveSpaceMember,
) {
  const route = new Hono<SpaceEnv>();
  route.use("*", access);

  route.post("/", async (c) => {
    const body = await parseBody(c.req.raw, ["installationId", ...COLLECTIONS]);
    if (
      !body ||
      typeof body.installationId !== "string" ||
      COLLECTIONS.some((key) => !Array.isArray(body[key]))
    ) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      const db = deps.createDb(c.env.DATABASE_URL);
      const userId = c.get("currentUserId");
      const result = await deps.syncSpaceData(
        db,
        c.req.param("spaceId")!,
        userId,
        body as never,
        await deps.findUserCountryCode(db, userId),
      );
      return c.json({ data: result });
    } catch (error: any) {
      console.error(
        "Space sync failed:",
        error?.message,
        JSON.stringify({
          detail: error?.detail,
          constraint: error?.constraint,
          code: error?.code,
          hint: error?.hint,
          where: error?.where,
        }),
      );
      const reason = error instanceof Error ? error.message : "";
      const code = CLIENT_ERRORS[reason];
      if (!code) {
        return errorResponse(c, "INTERNAL_SERVER_ERROR");
      }
      return errorResponse(c, code);
    }
  });

  return route;
}
