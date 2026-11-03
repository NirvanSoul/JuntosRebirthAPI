import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { handleUnhandledError } from "../src/lib/error-handler";
import * as client from "../src/db/client";
import { errorSummary, logFailure } from "../src/lib/log";
import type { AuthVariables } from "../src/middleware/auth";
import type { SpaceAccessVariables } from "../src/middleware/space-access";
import { createSpaceSyncRoute } from "../src/routes/sync";
import { SyncConcurrentUpdateError } from "../src/services/space-sync";
import type { Bindings } from "../src/types/env";

/**
 * Errores ficticios con todo lo que nunca debe aparecer en un log o una
 * respuesta: credenciales, tokens, cookies, correos y datos financieros.
 */
const SECRETS = [
  "s3cr3t-pass",
  "postgresql://owner:s3cr3t-pass@ep-fake.neon.tech/neondb",
  "ana.prueba@example.test",
  "987654321",
  "Bearer tok_live_fake",
  "session_token=abc123",
  "Nómina secreta",
];

function databaseError() {
  // Forma de un `NeonDbError`: mensaje, detalle, pista y contexto de PostgreSQL.
  return Object.assign(
    new Error('duplicate key value violates unique constraint "money_account_balances_account_currency_idx" Key (email)=(ana.prueba@example.test)'),
    {
      name: "NeonDbError",
      code: "23505",
      constraint: "money_account_balances_account_currency_idx",
      table: "money_account_balances",
      detail: "Key (money_account_id, currency, opening_balance_minor)=(x, EUR, 987654321) already exists. title=Nómina secreta",
      hint: "Bearer tok_live_fake",
      where: "SQL statement INSERT ... session_token=abc123",
    },
  );
}

function connectionError() {
  return new Error("Error connecting to database: postgresql://owner:s3cr3t-pass@ep-fake.neon.tech/neondb", {
    cause: new Error("password authentication failed for s3cr3t-pass"),
  });
}

function captureLogs() {
  const lines: string[] = [];
  for (const method of ["error", "warn", "log", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
    });
  }
  return lines;
}

function expectNoSecrets(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

afterEach(() => vi.restoreAllMocks());

describe("logFailure", () => {
  it("keeps SQLSTATE, constraint and correlation but drops messages and row values", () => {
    const lines = captureLogs();
    logFailure("sync.space", databaseError(), { requestId: "req-1" });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      event: "operation_failed",
      operation: "sync.space",
      requestId: "req-1",
      errorName: "NeonDbError",
      databaseCodes: ["23505"],
      databaseIdentifiers: ["money_account_balances", "money_account_balances_account_currency_idx"],
    });
    expect(entry.errorCode).toBeUndefined();
    expectNoSecrets(lines.join("\n"));
  });

  it("never logs a connection string carried by the message or its cause", () => {
    const lines = captureLogs();
    logFailure("health.db", connectionError());
    expect(JSON.parse(lines[0]!)).toMatchObject({ errorName: "Error", causeName: "Error" });
    expectNoSecrets(lines.join("\n"));
  });

  it("keeps domain codes, which are constants and not data", () => {
    expect(errorSummary(new Error("SPACE_NOT_FOUND")).errorCode).toBe("SPACE_NOT_FOUND");
    expect(errorSummary(new SyncConcurrentUpdateError()).errorCode).toBe("SYNC_CONCURRENT_UPDATE");
    expect(errorSummary(new Error("Name Ana")).errorCode).toBeUndefined();
  });
});

describe("routes log and answer without sensitive values", () => {
  it("POST /v1/spaces/:id/sync", async () => {
    const route = createSpaceSyncRoute({
      createDb: vi.fn(() => ({})),
      syncSpaceData: vi.fn().mockRejectedValue(databaseError()),
      findUserCountryCode: vi.fn(),
    } as never, async (_c, next) => next());
    const syncApp = new Hono<{ Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables }>();
    syncApp.use("*", async (c, next) => {
      c.set("currentUserId", "user-1");
      await next();
    });
    syncApp.route("/v1/spaces/:spaceId/sync", route);
    const lines = captureLogs();

    const response = await syncApp.request(
      "/v1/spaces/space-1/sync",
      {
        method: "POST",
        headers: { "x-request-id": "req-sync-1" },
        body: JSON.stringify({ installationId: "i-1", categories: [], moneyAccounts: [], recurringSeries: [], transactions: [] }),
      },
      { DATABASE_URL: "unused" } as Bindings,
    );

    const body = await response.text();
    expect(response.status).toBe(500);
    expectNoSecrets(body);
    expectNoSecrets(lines.join("\n"));
    expect(lines.join("\n")).toContain("req-sync-1");
    expect(lines.join("\n")).toContain("23505");
  });

  it("POST /v1/spaces/:id/sync maps a concurrent update to a retryable 409", async () => {
    const route = createSpaceSyncRoute({
      createDb: vi.fn(() => ({})),
      syncSpaceData: vi.fn().mockRejectedValue(new SyncConcurrentUpdateError()),
      findUserCountryCode: vi.fn(),
    } as never, async (_c, next) => next());
    const syncApp = new Hono<{ Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables }>();
    syncApp.use("*", async (c, next) => {
      c.set("currentUserId", "user-1");
      await next();
    });
    syncApp.route("/v1/spaces/:spaceId/sync", route);
    captureLogs();
    const response = await syncApp.request(
      "/v1/spaces/space-1/sync",
      { method: "POST", body: JSON.stringify({ installationId: "i-1", categories: [], moneyAccounts: [], recurringSeries: [], transactions: [] }) },
      { DATABASE_URL: "unused" } as Bindings,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "SYNC_CONCURRENT_UPDATE" } });
  });

  it("POST /v1/spaces/:id/sync maps a deadlock that escaped the service to a retryable 409", async () => {
    const route = createSpaceSyncRoute({
      createDb: vi.fn(() => ({})),
      syncSpaceData: vi.fn().mockRejectedValue(Object.assign(databaseError(), { code: "40P01" })),
      findUserCountryCode: vi.fn(),
    } as never, async (_c, next) => next());
    const syncApp = new Hono<{ Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables }>();
    syncApp.use("*", async (c, next) => {
      c.set("currentUserId", "user-1");
      await next();
    });
    syncApp.route("/v1/spaces/:spaceId/sync", route);
    const lines = captureLogs();
    const response = await syncApp.request(
      "/v1/spaces/space-1/sync",
      { method: "POST", body: JSON.stringify({ installationId: "i-1", categories: [], moneyAccounts: [], recurringSeries: [], transactions: [] }) },
      { DATABASE_URL: "unused" } as Bindings,
    );
    const body = await response.text();
    expect(response.status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({ error: { code: "SYNC_CONCURRENT_UPDATE" } });
    expectNoSecrets(body);
    expectNoSecrets(lines.join("\n"));
  });

  it("GET /health/db", async () => {
    vi.spyOn(client, "createDb").mockImplementation(() => {
      throw connectionError();
    });
    const lines = captureLogs();
    const response = await app.request("/health/db", {}, { DATABASE_URL: "postgresql://owner:s3cr3t-pass@ep-fake.neon.tech/neondb" });
    const body = await response.text();
    expect(response.status).toBe(500);
    expectNoSecrets(body);
    expectNoSecrets(lines.join("\n"));
    expect(lines.join("\n")).toContain("health.db");
  });

  it("unhandled errors", async () => {
    // El manejador global de la app, montado sobre una ruta que lanza.
    const probe = new Hono();
    probe.onError(handleUnhandledError);
    probe.get("/boom", () => {
      throw databaseError();
    });
    const lines = captureLogs();
    const response = await probe.request("/boom");
    const body = await response.text();
    expect(response.status).toBe(500);
    expectNoSecrets(body);
    expectNoSecrets(lines.join("\n"));
  });
});
