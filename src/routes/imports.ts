import { Hono } from "hono";
import { createDb } from "../db/client";
import { errorResponse, type ErrorCode } from "../lib/http";
import { boundedString, parseBody } from "../lib/validation";
import type { AuthVariables } from "../middleware/auth";
import * as service from "../services/imports";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings; Variables: AuthVariables };
type Deps = typeof service & { createDb: typeof createDb };
const defaults: Deps = { createDb, ...service };

const CLIENT_ERRORS: Record<string, ErrorCode> = {
  INVALID_PAYLOAD: "INVALID_REQUEST",
  INVALID_GRAPH: "INVALID_REQUEST",
  SPACE_NOT_FOUND: "SPACE_NOT_FOUND",
  IMPORT_ITEM_NOT_FOUND: "NOT_FOUND",
};

const CANONICAL_KEY = /^[a-z0-9_]{2,64}$/;

function fail(c: Parameters<typeof errorResponse>[0], error: unknown, context: string) {
  const reason = error instanceof Error ? error.message : "";
  const code = CLIENT_ERRORS[reason];
  if (!code) {
    console.error(`${context} failed:`, reason);
    return errorResponse(c, "INTERNAL_SERVER_ERROR");
  }
  return errorResponse(c, code);
}

export function createImportsRoute(deps: Deps = defaults) {
  const route = new Hono<Env>();

  route.post("/sync/import-batches", async (c) => {
    const body = await parseBody(c.req.raw, ["installationId", "batches", "items"]);
    if (
      !body ||
      typeof body.installationId !== "string" ||
      !Array.isArray(body.batches) ||
      !Array.isArray(body.items)
    ) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      const result = await deps.syncImportBatches(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        body as never,
      );
      return c.json({ data: result });
    } catch (error) {
      return fail(c, error, "Import batch sync");
    }
  });

  route.post("/sync/merchant-rules", async (c) => {
    const body = await parseBody(c.req.raw, ["installationId", "rules"]);
    if (!body || typeof body.installationId !== "string" || !Array.isArray(body.rules)) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      const ruleCount = await deps.syncMerchantRules(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        body as never,
      );
      return c.json({ data: { ruleCount } });
    } catch (error) {
      return fail(c, error, "Merchant rule sync");
    }
  });

  route.get("/sync/import-reviews", async (c) => {
    try {
      const batches = await deps.listImportReviews(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
      );
      return c.json({ data: { batches } });
    } catch (error) {
      return fail(c, error, "Import review read");
    }
  });

  route.post("/merchant-feedback", async (c) => {
    const body = await parseBody(c.req.raw, ["importItemId", "canonicalCategoryKey"]);
    const importItemId = body ? boundedString(body.importItemId, 64) : null;
    const canonicalCategoryKey = body ? boundedString(body.canonicalCategoryKey, 64) : null;
    if (!importItemId || !canonicalCategoryKey || !CANONICAL_KEY.test(canonicalCategoryKey)) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      await deps.recordMerchantFeedback(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        { importItemId, canonicalCategoryKey },
      );
      return c.body(null, 204);
    } catch (error) {
      return fail(c, error, "Merchant feedback");
    }
  });

  return route;
}
