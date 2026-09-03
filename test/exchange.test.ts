import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { createExchangeRoute } from "../src/routes/exchange";
import { ExchangeRatesUnavailableError } from "../src/services/exchange-rates";
import type { Bindings } from "../src/types/env";

const bindings: Bindings = { DATABASE_URL: "postgresql://test", BETTER_AUTH_SECRET: "test-secret", BETTER_AUTH_URL: "https://test", GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "test" };

const currentRates = {
  rates: {
    BCV: { source: "BCV" as const, baseCurrency: "USD" as const, quoteCurrency: "VES" as const, rate: "50.0000000000", observedAt: "2026-09-01T00:00:00.000Z", fetchedAt: "2026-09-01T00:00:00.000Z" },
    EURO: { source: "EURO" as const, baseCurrency: "EUR" as const, quoteCurrency: "VES" as const, rate: "60.0000000000", observedAt: "2026-09-01T00:00:00.000Z", fetchedAt: "2026-09-01T00:00:00.000Z" },
  },
  ratesUpdatedAt: "2026-09-01T00:00:00.000Z",
  stale: false,
};

function setup(overrides: Record<string, unknown> = {}) {
  const deps = {
    createDb: () => ({} as Database),
    getCurrentRates: vi.fn().mockResolvedValue(currentRates),
    previewConversion: vi.fn(),
    ...overrides,
  };
  const testApp = new Hono<{ Bindings: Bindings }>();
  testApp.route("/v1/exchange", createExchangeRoute(deps));
  return { testApp, deps };
}

describe("Exchange routes", () => {
  it("GET /v1/exchange/rates does not require authentication and returns the current rates", async () => {
    const { testApp } = setup();
    const response = await testApp.request("/v1/exchange/rates", {}, bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: currentRates });
  });

  it("GET /v1/exchange/rates maps a provider outage to VENEZUELA_RATES_UNAVAILABLE", async () => {
    const { testApp } = setup({ getCurrentRates: vi.fn().mockRejectedValue(new ExchangeRatesUnavailableError("down")) });
    const response = await testApp.request("/v1/exchange/rates", {}, bindings);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VENEZUELA_RATES_UNAVAILABLE" } });
  });

  it("POST /v1/exchange/preview validates the payload before calling the service", async () => {
    const { testApp, deps } = setup();
    const response = await testApp.request("/v1/exchange/preview", {
      method: "POST",
      body: JSON.stringify({ countryCode: "VE", amount: "-5", currency: "VES" }),
    }, bindings);
    expect(response.status).toBe(400);
    expect(deps.previewConversion).not.toHaveBeenCalled();
  });

  it("POST /v1/exchange/preview returns the converted amounts", async () => {
    const preview = {
      input: { amount: "10000", currency: "VES" },
      conversions: {
        BCV: { amount: "200.00", currency: "USD", rate: "50.0000000000" },
        EURO: { amount: "166.67", currency: "EUR", rate: "60.0000000000" },
      },
      ratesUpdatedAt: "2026-09-01T00:00:00.000Z",
    };
    const { testApp, deps } = setup({ previewConversion: vi.fn().mockResolvedValue(preview) });
    const response = await testApp.request("/v1/exchange/preview", {
      method: "POST",
      body: JSON.stringify({ countryCode: "VE", amount: "10000", currency: "VES" }),
    }, bindings);
    expect(response.status).toBe(200);
    expect(deps.previewConversion).toHaveBeenCalledWith(expect.anything(), { amount: "10000", currency: "VES" });
    await expect(response.json()).resolves.toEqual({ data: preview });
  });
});
