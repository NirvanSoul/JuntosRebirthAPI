import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { createExchangeRatesRoute } from "../src/routes/exchange-rates";
import { ExchangeRatesUnavailableError } from "../src/services/exchange-rates";
import type { Bindings } from "../src/types/env";

const bindings: Bindings = { DATABASE_URL: "postgresql://test", BETTER_AUTH_SECRET: "test-secret", BETTER_AUTH_URL: "https://test", GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "test" };

const currentRates = {
  rates: {
    BCV: { source: "BCV" as const, baseCurrency: "USD" as const, quoteCurrency: "VES" as const, rate: "50.0000000000", observedAt: "2026-09-01T04:00:00.000Z", fetchedAt: "2026-09-01T04:00:00.000Z" },
    EURO: { source: "EURO" as const, baseCurrency: "EUR" as const, quoteCurrency: "VES" as const, rate: "60.0000000000", observedAt: "2026-09-01T04:00:00.000Z", fetchedAt: "2026-09-01T04:00:00.000Z" },
  },
  ratesUpdatedAt: "2026-09-01T04:00:00.000Z",
  stale: false,
};

function setup(overrides: Record<string, unknown> = {}) {
  const deps = {
    createDb: () => ({} as Database),
    getCurrentRates: vi.fn().mockResolvedValue(currentRates),
    ...overrides,
  };
  const testApp = new Hono<{ Bindings: Bindings }>();
  testApp.route("/v1/exchange-rates", createExchangeRatesRoute(deps));
  return { testApp, deps };
}

describe("Fase 2 exchange-rates routes", () => {
  it("GET /current returns the active BCV rate and Venezuela effective date", async () => {
    const { testApp, deps } = setup();
    const response = await testApp.request("/v1/exchange-rates/current?source=BCV", {}, bindings);

    expect(response.status).toBe(200);
    expect(deps.getCurrentRates).toHaveBeenCalledWith(expect.anything(), "VE");
    await expect(response.json()).resolves.toEqual({
      source: "BCV", baseCurrency: "USD", quoteCurrency: "VES", rate: "50.0000000000", effectiveDate: "2026-09-01", stale: false,
    });
  });

  it("rejects a missing or unsupported source", async () => {
    const { testApp, deps } = setup();
    const response = await testApp.request("/v1/exchange-rates/current");
    expect(response.status).toBe(400);
    expect(deps.getCurrentRates).not.toHaveBeenCalled();
  });

  it("POST /preview converts VES to USD using BCV", async () => {
    const { testApp } = setup();
    const response = await testApp.request("/v1/exchange-rates/preview", {
      method: "POST",
      body: JSON.stringify({ amount: "10000", fromCurrency: "VES", toCurrency: "USD", source: "BCV" }),
    }, bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      convertedAmount: "200.00", rate: "50.0000000000", effectiveDate: "2026-09-01", stale: false,
    });
  });

  it("POST /preview converts USD to VES using BCV", async () => {
    const { testApp } = setup();
    const response = await testApp.request("/v1/exchange-rates/preview", {
      method: "POST",
      body: JSON.stringify({ amount: "10", fromCurrency: "USD", toCurrency: "VES", source: "BCV" }),
    }, bindings);

    await expect(response.json()).resolves.toMatchObject({ convertedAmount: "500.00", rate: "50.0000000000" });
  });

  it("validates the exact preview payload before accessing rates", async () => {
    const { testApp, deps } = setup();
    const response = await testApp.request("/v1/exchange-rates/preview", {
      method: "POST",
      body: JSON.stringify({ amount: "0", fromCurrency: "USD", toCurrency: "USD", source: "BCV" }),
    }, bindings);

    expect(response.status).toBe(400);
    expect(deps.getCurrentRates).not.toHaveBeenCalled();
  });

  it("preserves the stale signal for a cached fallback", async () => {
    const { testApp } = setup({ getCurrentRates: vi.fn().mockResolvedValue({ ...currentRates, stale: true }) });
    const response = await testApp.request("/v1/exchange-rates/current?source=BCV", {}, bindings);
    await expect(response.json()).resolves.toMatchObject({ stale: true });
  });

  it("maps unavailable rates to the established 502 error", async () => {
    const { testApp } = setup({ getCurrentRates: vi.fn().mockRejectedValue(new ExchangeRatesUnavailableError("down")) });
    const response = await testApp.request("/v1/exchange-rates/current?source=BCV", {}, bindings);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VENEZUELA_RATES_UNAVAILABLE" } });
  });
});
