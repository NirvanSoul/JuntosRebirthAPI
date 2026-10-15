import { Hono, type MiddlewareHandler } from "hono";
import { createDb } from "../db/client";
import { errorResponse, type ErrorCode } from "../lib/http";
import { databaseErrorResponse, isDatabaseSchemaOutdated, logDatabaseFailure } from "../lib/database-errors";
import { isDataViolation } from "../lib/pg";
import { parseBody } from "../lib/validation";
import type { AuthVariables } from "../middleware/auth";
import {
  requireActiveSpaceMember,
  type SpaceAccessVariables,
} from "../middleware/space-access";
import { buildChanges, buildSnapshot } from "../services/sync-snapshot";
import { RecurrenceOccurrenceConflictError, SyncValidationError, syncSpaceData } from "../services/space-sync";
import { findUserCountryCode } from "../services/account";
import type { Bindings } from "../types/env";

type SnapshotEnv = { Bindings: Bindings; Variables: AuthVariables };
type SpaceEnv = { Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables };

const COLLECTIONS = ["categories", "moneyAccounts", "recurringSeries", "transactions"] as const;

const CLIENT_ERRORS: Record<string, ErrorCode> = {
  INVALID_PAYLOAD: "INVALID_REQUEST",
  INVALID_GRAPH: "INVALID_REQUEST",
  INVALID_SYNC_PAYLOAD: "INVALID_SYNC_PAYLOAD",
  INVALID_MONEY_ACCOUNT_CURRENCY: "INVALID_MONEY_ACCOUNT_CURRENCY",
  INVALID_TRANSACTION_CURRENCY: "INVALID_TRANSACTION_CURRENCY",
  INVALID_CATEGORY_REFERENCE: "INVALID_CATEGORY_REFERENCE",
  INVALID_MONEY_ACCOUNT_REFERENCE: "INVALID_MONEY_ACCOUNT_REFERENCE",
  INVALID_RECURRING_SERIES_REFERENCE: "INVALID_RECURRING_SERIES_REFERENCE",
  ENTITY_BELONGS_TO_ANOTHER_SPACE: "ENTITY_BELONGS_TO_ANOTHER_SPACE",
  CUSTOM_RATE_NOT_FOUND: "CUSTOM_RATE_NOT_FOUND",
  VENEZUELA_RATES_UNAVAILABLE: "VENEZUELA_RATES_UNAVAILABLE",
  VE_ACCOUNT_MULTI_CURRENCY_NOT_ALLOWED: "VE_ACCOUNT_MULTI_CURRENCY_NOT_ALLOWED",
  RECURRENCE_OCCURRENCE_CONFLICT: "RECURRENCE_OCCURRENCE_CONFLICT",
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
      logDatabaseFailure("sync.snapshot", error);
      return databaseErrorResponse(c, error);
    }
  });

  return route;
}


type ChangesDeps = { createDb: typeof createDb; buildChanges: typeof buildChanges };

/** `GET /v1/sync/changes` — cambios incrementales desde un cursor `since`. */
export function createChangesRoute(
  deps: ChangesDeps = { createDb, buildChanges },
) {
  const route = new Hono<SnapshotEnv>();

  route.get("/changes", async (c) => {
    const sinceParam = c.req.query("since");
    if (!sinceParam) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    const since = new Date(sinceParam);
    if (isNaN(since.getTime())) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      const changes = await deps.buildChanges(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        since,
      );
      return c.json({ data: changes });
    } catch (error) {
      logDatabaseFailure("sync.changes", error);
      return databaseErrorResponse(c, error);
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
    const requestId = safeRequestId(c.req.header("x-request-id") ?? c.req.header("cf-ray"));
    const body = await parseBody(c.req.raw, ["installationId", ...COLLECTIONS]);
    if (
      !body ||
      typeof body.installationId !== "string" ||
      COLLECTIONS.some((key) => !Array.isArray(body[key]))
    ) {
      console.error(JSON.stringify({
        event: "sync_validation_failure",
        requestId,
        userId: c.get("currentUserId"),
        spaceId: c.req.param("spaceId"),
        route: "POST /v1/spaces/:spaceId/sync",
        validationIssuePath: [],
        validationIssueCode: "INVALID_SYNC_PAYLOAD",
        validationIssueReason: "MALFORMED_SYNC_BODY",
      }));
      return errorResponse(c, "INVALID_SYNC_PAYLOAD", undefined, {
        details: { path: [], reason: "MALFORMED_SYNC_BODY" },
      });
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
      if (error instanceof SyncValidationError) {
        console.error(JSON.stringify({
          event: "sync_validation_failure",
          requestId,
          userId: c.get("currentUserId"),
          spaceId: c.req.param("spaceId"),
          route: "POST /v1/spaces/:spaceId/sync",
          validationIssuePath: error.issue.path,
          validationIssueCode: error.apiCode,
          validationIssueReason: error.issue.reason,
          entityType: error.issue.entityType,
          localEntityId: error.issue.localEntityId,
          countryCode: error.issue.countryCode,
          canonicalCurrency: error.issue.canonicalCurrency,
        }));
        return errorResponse(c, error.apiCode, undefined, {
          details: { path: error.issue.path, reason: error.issue.reason },
        });
      }
      logDatabaseFailure("sync.space", error);
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
      if (isDatabaseSchemaOutdated(error)) {
        return databaseErrorResponse(c, error);
      }
      if (isDataViolation(error)) {
        return errorResponse(c, "INVALID_REQUEST");
      }
      if (!code) {
        return errorResponse(c, "INTERNAL_SERVER_ERROR");
      }
      return errorResponse(
        c,
        code,
        undefined,
        error instanceof RecurrenceOccurrenceConflictError ? error.details : undefined,
      );
    }
  });

  return route;
}

function safeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : crypto.randomUUID();
}
