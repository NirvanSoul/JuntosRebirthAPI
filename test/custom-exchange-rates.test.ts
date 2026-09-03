import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import type { AuthVariables } from "../src/middleware/auth";
import { createCustomExchangeRatesRoute } from "../src/routes/custom-exchange-rates";
import type { Bindings } from "../src/types/env";

const bindings: Bindings = { DATABASE_URL: "postgresql://test", BETTER_AUTH_SECRET: "test-secret", BETTER_AUTH_URL: "https://test", GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "test" };
const rate = { id: "rate-1", name: "Mi tasa", baseCurrency: "USD", quoteCurrency: "VES", rate: "54.50", isDefault: false, createdAt: new Date("2026-09-01T00:00:00Z") };

function setup(overrides: Record<string, unknown> = {}) {
  const deps = {
    createDb: () => ({} as Database),
    listCustomExchangeRates: vi.fn().mockResolvedValue([rate]),
    findCustomExchangeRate: vi.fn().mockResolvedValue(rate),
    createCustomExchangeRate: vi.fn().mockResolvedValue(rate),
    updateCustomExchangeRate: vi.fn().mockResolvedValue(rate),
    deleteCustomExchangeRate: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  const testApp = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  testApp.use("*", async (c, next) => { c.set("currentUserId", "user-1"); await next(); });
  testApp.route("/v1/exchange/custom-rates", createCustomExchangeRatesRoute(deps));
  return { testApp, deps };
}

describe("custom exchange rates routes", () => {
  it("lists the current user's rates", async () => {
    const { testApp, deps } = setup();
    const response = await testApp.request("/v1/exchange/custom-rates", {}, bindings);
    expect(response.status).toBe(200);
    expect(deps.listCustomExchangeRates).toHaveBeenCalledWith(expect.anything(), "user-1");
    await expect(response.json()).resolves.toMatchObject({ data: { rates: [{ ...rate, createdAt: rate.createdAt.toISOString() }] } });
  });

  it("creates a rate fixed to USD/VES regardless of payload currency fields", async () => {
    const { testApp, deps } = setup();
    const response = await testApp.request("/v1/exchange/custom-rates", { method: "POST", body: JSON.stringify({ name: "Mi tasa", rate: "54.50" }) }, bindings);
    expect(response.status).toBe(201);
    expect(deps.createCustomExchangeRate).toHaveBeenCalledWith(expect.anything(), { userId: "user-1", countryCode: "VE", name: "Mi tasa", rate: "54.50", isDefault: false });
  });

  it.each(["0", "-1", "abc", ""])("rejects a non-positive rate %j", async (value) => {
    const { testApp } = setup();
    const response = await testApp.request("/v1/exchange/custom-rates", { method: "POST", body: JSON.stringify({ name: "Mi tasa", rate: value }) }, bindings);
    expect(response.status).toBe(400);
  });

  it("rejects an empty name", async () => {
    const { testApp } = setup();
    const response = await testApp.request("/v1/exchange/custom-rates", { method: "POST", body: JSON.stringify({ name: "  ", rate: "54.50" }) }, bindings);
    expect(response.status).toBe(400);
  });

  it("404s a patch for a rate that isn't the caller's", async () => {
    const { testApp } = setup({ findCustomExchangeRate: vi.fn().mockResolvedValue(null) });
    const response = await testApp.request("/v1/exchange/custom-rates/other-user-rate", { method: "PATCH", body: JSON.stringify({ rate: "60.00" }) }, bindings);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "CUSTOM_RATE_NOT_FOUND" } });
  });

  it("404s deleting a rate that isn't the caller's", async () => {
    const { testApp } = setup({ deleteCustomExchangeRate: vi.fn().mockResolvedValue(false) });
    const response = await testApp.request("/v1/exchange/custom-rates/other-user-rate", { method: "DELETE" }, bindings);
    expect(response.status).toBe(404);
  });

  it("deletes a rate that belongs to the caller", async () => {
    const { testApp, deps } = setup();
    const response = await testApp.request("/v1/exchange/custom-rates/rate-1", { method: "DELETE" }, bindings);
    expect(response.status).toBe(204);
    expect(deps.deleteCustomExchangeRate).toHaveBeenCalledWith(expect.anything(), "user-1", "rate-1");
  });
});
