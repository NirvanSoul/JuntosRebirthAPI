import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import app from "../src/index";
import type { Database } from "../src/db/client";
import { createRatesRoute } from "../src/routes/rates";
import { VenezuelaRateService } from "../src/services/rates/venezuela";
import type { Bindings } from "../src/types/env";

const bcvRates = [
  { source: "BCV" as const, baseCurrency: "USD" as const, quoteCurrency: "VES" as const, rate: "791.6667000000" },
  { source: "BCV" as const, baseCurrency: "EUR" as const, quoteCurrency: "VES" as const, rate: "921.8800388100" },
];

function setupWithUsdt(getCurrentUsdtRate: ReturnType<typeof vi.fn>) {
  const testApp = new Hono<{ Bindings: Bindings }>();
  testApp.route("/v1/rates", createRatesRoute({ createDb: () => ({}) as Database, getCurrentUsdtRate }));
  return (path: string) => testApp.request(path, {}, { DATABASE_URL: "postgresql://test" } as Bindings);
}

describe("Venezuela rates route", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GET /v1/rates/venezuela returns normalized rates", async () => {
    vi.spyOn(VenezuelaRateService.prototype, "getRates").mockResolvedValue([
      {
        source: "BCV",
        baseCurrency: "USD",
        quoteCurrency: "VES",
        rate: "791.6667000000",
      },
      {
        source: "BCV",
        baseCurrency: "EUR",
        quoteCurrency: "VES",
        rate: "921.8800388100",
      },
    ]);

    const response = await app.request("/v1/rates/venezuela");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        rates: [
          {
            source: "BCV",
            baseCurrency: "USD",
            quoteCurrency: "VES",
            rate: "791.6667000000",
          },
          {
            source: "BCV",
            baseCurrency: "EUR",
            quoteCurrency: "VES",
            rate: "921.8800388100",
          },
        ],
      },
    });
  });

  it("returns 502 without exposing upstream failures", async () => {
    vi.spyOn(VenezuelaRateService.prototype, "getRates").mockRejectedValue(
      new Error("upstream failed"),
    );

    const response = await app.request("/v1/rates/venezuela");

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VENEZUELA_RATES_UNAVAILABLE",
        message: "Venezuela rates are unavailable",
      },
    });
  });

  it("appends the USDT rate from the Juntos database when available", async () => {
    vi.spyOn(VenezuelaRateService.prototype, "getRates").mockResolvedValue(bcvRates);
    const request = setupWithUsdt(vi.fn().mockResolvedValue({
      source: "USDT", baseCurrency: "USDT", quoteCurrency: "VES", rate: "1010.0229500000",
      dailyAverage: "1008.8891290000", observedAt: "2026-11-04T15:05:02.510Z", fetchedAt: "2026-11-04T15:30:00.000Z", stale: false,
    }));

    const response = await request("/v1/rates/venezuela");

    await expect(response.json()).resolves.toEqual({
      data: { rates: [...bcvRates, { source: "USDT", baseCurrency: "USDT", quoteCurrency: "VES", rate: "1010.0229500000" }] },
    });
  });

  it("keeps serving BCV when the USDT lookup fails", async () => {
    vi.spyOn(VenezuelaRateService.prototype, "getRates").mockResolvedValue(bcvRates);
    const request = setupWithUsdt(vi.fn().mockRejectedValue(new Error("db down")));

    const response = await request("/v1/rates/venezuela");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { rates: bcvRates } });
  });
});
