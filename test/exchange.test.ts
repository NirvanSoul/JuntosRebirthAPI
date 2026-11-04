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
        EURO: { amount: "166.67", currency: "USD", rate: "60.0000000000" },
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

  describe("GET /v1/exchange/rates/at", () => {
    const ratesAt = { date: "2026-08-15", time: "14:30", bcv: { effectiveDate: "2026-08-14", usd: "150.0000000000", eur: "170.0000000000" }, usdt: { rate: "210.0000000000", precision: "daily_average", observedAt: null } };

    it("returns the rates for a date and optional time", async () => {
      const getRatesAt = vi.fn().mockResolvedValue(ratesAt);
      const { testApp } = setup({ getRatesAt });
      const response = await testApp.request("/v1/exchange/rates/at?date=2026-08-15&time=14:30", {}, bindings);

      expect(response.status).toBe(200);
      expect(getRatesAt).toHaveBeenCalledWith(expect.anything(), "2026-08-15", "14:30");
      await expect(response.json()).resolves.toEqual({ data: ratesAt });
    });

    it("treats a missing time as null", async () => {
      const getRatesAt = vi.fn().mockResolvedValue(ratesAt);
      const { testApp } = setup({ getRatesAt });
      await testApp.request("/v1/exchange/rates/at?date=2026-08-15", {}, bindings);
      expect(getRatesAt).toHaveBeenCalledWith(expect.anything(), "2026-08-15", null);
    });

    it.each([
      ["no date", ""],
      ["an impossible date", "?date=2026-02-30"],
      ["a malformed time", "?date=2026-08-15&time=2:30"],
      ["seconds in the time", "?date=2026-08-15&time=14:30:00"],
      ["an empty time", "?date=2026-08-15&time="],
      ["a date after tomorrow", "?date=2999-01-01"],
    ])("rejects %s", async (_label, query) => {
      const getRatesAt = vi.fn();
      const { testApp } = setup({ getRatesAt });
      const response = await testApp.request(`/v1/exchange/rates/at${query}`, {}, bindings);
      expect(response.status).toBe(400);
      expect(getRatesAt).not.toHaveBeenCalled();
    });

    it("maps a database failure to VENEZUELA_RATES_UNAVAILABLE", async () => {
      const { testApp } = setup({ getRatesAt: vi.fn().mockRejectedValue(new Error("db down")) });
      const response = await testApp.request("/v1/exchange/rates/at?date=2026-08-15", {}, bindings);
      expect(response.status).toBe(502);
    });
  });

  describe("GET /v1/exchange/rates/history", () => {
    it("returns one row per day in the range", async () => {
      const rows = [{ date: "2026-08-15", bcvUsd: "150.0000000000", bcvEur: "170.0000000000", usdtDailyAverage: "210.0000000000" }];
      const getRateHistory = vi.fn().mockResolvedValue(rows);
      const { testApp } = setup({ getRateHistory });
      const response = await testApp.request("/v1/exchange/rates/history?from=2026-08-01&to=2026-08-31", {}, bindings);

      expect(response.status).toBe(200);
      expect(getRateHistory).toHaveBeenCalledWith(expect.anything(), "2026-08-01", "2026-08-31");
      await expect(response.json()).resolves.toEqual({ data: { from: "2026-08-01", to: "2026-08-31", rates: rows } });
    });

    it("accepts exactly 366 days", async () => {
      const { testApp } = setup({ getRateHistory: vi.fn().mockResolvedValue([]) });
      const response = await testApp.request("/v1/exchange/rates/history?from=2025-01-01&to=2026-01-01", {}, bindings);
      expect(response.status).toBe(200);
    });

    it.each([
      ["a missing bound", "?from=2026-08-01"],
      ["an inverted range", "?from=2026-08-31&to=2026-08-01"],
      ["a range longer than 366 days", "?from=2025-01-01&to=2026-01-02"],
    ])("rejects %s", async (_label, query) => {
      const getRateHistory = vi.fn();
      const { testApp } = setup({ getRateHistory });
      const response = await testApp.request(`/v1/exchange/rates/history${query}`, {}, bindings);
      expect(response.status).toBe(400);
      expect(getRateHistory).not.toHaveBeenCalled();
    });
  });
});
