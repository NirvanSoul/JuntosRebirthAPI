import { describe, expect, it, vi } from "vitest";
import {
  VenezuelaRateService,
  VenezuelaRateServiceError,
} from "../../src/services/rates/venezuela";

describe("VenezuelaRateService", () => {
  it("normalizes BCV USD and EUR rates as decimal strings", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, usd: 791.6667, eur: 921.88003881 }),
        { status: 200 },
      ),
    );

    const rates = await new VenezuelaRateService(fetchFn).getRates();

    expect(fetchFn).toHaveBeenCalledWith("https://bcvscrapper.vercel.app/api/bcv");
    expect(rates).toEqual([
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
  });

  it("rejects invalid provider rates", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, usd: -1, eur: 921.88 }), {
        status: 200,
      }),
    );

    await expect(new VenezuelaRateService(fetchFn).getRates()).rejects.toBeInstanceOf(
      VenezuelaRateServiceError,
    );
  });
});
