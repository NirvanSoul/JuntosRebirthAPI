import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { VenezuelaRateService } from "../src/services/rates/venezuela";

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
});
