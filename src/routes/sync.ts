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
import type { Bindings } from "../types/env";

type SnapshotEnv = { Bindings: Bindings; Variables: AuthVariables };
type SpaceEnv = { Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables };

const COLLECTIONS = ["categories", "moneyAccounts", "recurringSeries", "transactions"] as const;

const CLIENT_ERRORS: Record<string, ErrorCode> = {
  INVALID_PAYLOAD: "INVALID_REQUEST",
  INVALID_GRAPH: "INVALID_REQUEST",
  SPACE_NOT_FOUND: "SPACE_NOT_FOUND",
};

type SnapshotDeps = { createDb: typeof createDb; buildSnapshot: typeof buildSnapshot };
type SpaceSyncDeps = { createDb: typeof createDb; syncSpaceData: typeof syncSpaceData };

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
      return errorResponse(c, "INTERNAL_ERROR");
    }
  });

  return route;
}

/** `POST /v1/spaces/:spaceId/sync` — lote de cambios del espacio compartido. */
export function createSpaceSyncRoute(
  deps: SpaceSyncDeps = { createDb, syncSpaceData },
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
      const result = await deps.syncSpaceData(
        deps.createDb(c.env.DATABASE_URL),
        c.req.param("spaceId")!,
        c.get("currentUserId"),
        body as never,
      );
      return c.json({ data: result });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      const code = CLIENT_ERRORS[reason];
      if (!code) {
        console.error("Space sync failed:", reason);
        return errorResponse(c, "INTERNAL_ERROR");
      }
      return errorResponse(c, code);
    }
  });

  return route;
}
