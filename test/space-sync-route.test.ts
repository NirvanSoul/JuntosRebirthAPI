import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../src/middleware/auth";
import type { SpaceAccessVariables } from "../src/middleware/space-access";
import { createSpaceSyncRoute } from "../src/routes/sync";
import { SyncValidationError } from "../src/services/space-sync";
import type { Bindings } from "../src/types/env";

const bindings = { DATABASE_URL: "unused" } as Bindings;

function syncRequest() {
  return {
    method: "POST",
    body: JSON.stringify({
      installationId: "installation-1",
      categories: [],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    }),
  };
}

function testRoute(error: unknown) {
  const route = createSpaceSyncRoute({
    createDb: vi.fn(() => ({})),
    syncSpaceData: vi.fn().mockRejectedValue(error),
    findUserCountryCode: vi.fn(),
  } as never, async (_c, next) => next());
  const app = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables & SpaceAccessVariables;
  }>();
  app.use("*", async (c, next) => {
    c.set("currentUserId", "user-1");
    await next();
  });
  app.route("/v1/spaces/:spaceId/sync", route);
  return app;
}

describe("space sync route failures", () => {
  it("returns a stable code and safe field path for a sync validation failure", async () => {
    const error = new SyncValidationError("INVALID_TRANSACTION_CURRENCY", {
      path: ["transactions", 0, "currency"],
      reason: "VE_ALLOWS_USD_OR_VES",
      entityType: "transaction",
      localEntityId: "local-transaction-1",
      countryCode: "VE",
      canonicalCurrency: "USD",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await testRoute(error).request(
      "/v1/spaces/space-1/sync",
      { ...syncRequest(), headers: { "x-request-id": "request-1" } },
      bindings,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_TRANSACTION_CURRENCY",
        message: "The transaction currency is invalid.",
        details: {
          path: ["transactions", 0, "currency"],
          reason: "VE_ALLOWS_USD_OR_VES",
        },
      },
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      requestId: "request-1",
      userId: "user-1",
      spaceId: "space-1",
      validationIssuePath: ["transactions", 0, "currency"],
      validationIssueCode: "INVALID_TRANSACTION_CURRENCY",
      validationIssueReason: "VE_ALLOWS_USD_OR_VES",
      entityType: "transaction",
      localEntityId: "local-transaction-1",
      countryCode: "VE",
      canonicalCurrency: "USD",
    });
    log.mockRestore();
  });

  it("reports malformed top-level bodies as INVALID_SYNC_PAYLOAD", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = testRoute(new Error("should not run"));
    const response = await app.request("/v1/spaces/space-1/sync", {
      method: "POST",
      body: JSON.stringify({ installationId: "installation-1" }),
    }, bindings);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_SYNC_PAYLOAD",
        details: { path: [], reason: "MALFORMED_SYNC_BODY" },
      },
    });
    log.mockRestore();
  });

  it.each(["22001", "22003", "22P02", "23502", "23503", "23514"])(
    "returns INVALID_REQUEST for an invalid PostgreSQL payload (%s)",
    async (code) => {
      const app = testRoute({ cause: { code } });
      const response = await app.request("/v1/spaces/space-1/sync", syncRequest(), bindings);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });
    },
  );

  it.each(["42P01", "42703"])(
    "keeps a schema mismatch retryable (%s)",
    async (code) => {
      const app = testRoute({ cause: { code } });
      const response = await app.request("/v1/spaces/space-1/sync", syncRequest(), bindings);

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("60");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "DATABASE_SCHEMA_OUTDATED" },
      });
    },
  );
});
