import { describe, expect, it } from "vitest";
import app from "../../src/index";
import { databaseUrlForEngine } from "./harness";

describe("health against PostgreSQL", () => {
  it("reports the schema as current once every migration (including 0033/0034) is applied", async () => {
    const response = await app.request("/health/db", {}, { DATABASE_URL: databaseUrlForEngine() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", database: "connected" });
  });
});
