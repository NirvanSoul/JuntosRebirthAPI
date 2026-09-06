import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { databaseErrorResponse, isDatabaseSchemaOutdated } from "../src/lib/database-errors";

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
