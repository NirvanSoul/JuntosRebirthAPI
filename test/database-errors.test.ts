import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { databaseErrorResponse, isDatabaseSchemaOutdated, logDatabaseFailure } from "../src/lib/database-errors";

describe("database schema errors", () => {
  it.each([
    { code: "42P01" },
    { code: "42703" },
    { message: 'relation "financial_contexts" does not exist' },
  ])("recognizes an unapplied migration: %o", (error) => {
    expect(isDatabaseSchemaOutdated(error)).toBe(true);
  });

  it("does not misclassify an ordinary database failure", () => {
    expect(isDatabaseSchemaOutdated({ code: "08006", message: "connection failed" })).toBe(false);
  });

  it("keeps a missing database identifier in operational logs without exposing SQL", () => {
    const error = new Error("query failed") as Error & { cause: unknown };
    error.cause = { code: "42703", message: 'column "spaces.country_code" does not exist' };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logDatabaseFailure("account.bootstrap", error);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"databaseIdentifiers":["spaces.country_code"]'));
  });

  it("returns a recoverable response without SQL details", async () => {
    const app = new Hono();
    app.get("/", (c) => databaseErrorResponse(c, { code: "42P01", message: 'relation "financial_contexts" does not exist' }));

    const response = await app.request("/");

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "DATABASE_SCHEMA_OUTDATED",
        message: "Service is updating. Try again shortly.",
      },
    });
  });
});
