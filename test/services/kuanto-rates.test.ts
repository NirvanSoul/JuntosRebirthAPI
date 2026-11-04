import { describe, expect, it, vi } from "vitest";
import { KUANTO_PAGE_SIZE, KuantoRatesClient, KuantoRatesError } from "../../src/services/rates/kuanto";

const config = { url: "https://kuanto.supabase.test/", publishableKey: "sb_publishable_test" };

const weekday = {
  rate_date: "2026-11-04",
  bcv_usd: 893.2173,
  bcv_eur: 999.769192,
  p2p_average: 1010.02295,
  p2p_daily_average: 1008.889129,
  p2p_sources: { binance: { buy: 1009.4999, sell: 1011.5213 }, bybit: { buy: 1010.546, sell: 1005.9813 } },
  bcv_published_at: "2026-11-03T20:35:03.461+00:00",
  p2p_observed_at: "2026-11-04T15:05:02.51+00:00",
  updated_at: "2026-11-04T15:05:02.857776+00:00",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("KuantoRatesClient", () => {
  it("normalizes rates to decimal strings and keeps the raw P2P sources", async () => {
    const fetchFn = vi.fn().mockResolvedValue(respond([weekday]));
    const [row] = await new KuantoRatesClient(config, fetchFn).fetchUpdatedSince(null);

    expect(row).toEqual({
      rateDate: "2026-11-04",
      bcvUsd: "893.2173000000",
      bcvEur: "999.7691920000",
      usdtLast: "1010.0229500000",
      usdtDailyAverage: "1008.8891290000",
      usdtSources: weekday.p2p_sources,
      bcvPublishedAt: new Date("2026-11-03T20:35:03.461Z"),
      usdtObservedAt: new Date("2026-11-04T15:05:02.510Z"),
      sourceUpdatedAt: new Date("2026-11-04T15:05:02.857Z"),
    });
  });

  it("treats a weekend row without BCV as missing data instead of failing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(respond([{ ...weekday, rate_date: "2026-11-01", bcv_usd: null, bcv_eur: null }]));
    const [row] = await new KuantoRatesClient(config, fetchFn).fetchUpdatedSince(null);

    expect(row).toMatchObject({ rateDate: "2026-11-01", bcvUsd: null, bcvEur: null, usdtLast: "1010.0229500000" });
  });

  it("sends the publishable key and filters by updated_at when there is a cursor", async () => {
    const fetchFn = vi.fn().mockResolvedValue(respond([]));
    await new KuantoRatesClient(config, fetchFn).fetchUpdatedSince(new Date("2026-11-04T15:00:00.000Z"));

    const [url, init] = fetchFn.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.origin + parsed.pathname).toBe("https://kuanto.supabase.test/rest/v1/daily_rates");
    expect(parsed.searchParams.get("updated_at")).toBe("gte.2026-11-04T15:00:00.000Z");
    expect(parsed.searchParams.get("order")).toBe("updated_at.asc,rate_date.asc");
    expect((init as RequestInit).headers).toMatchObject({ apikey: "sb_publishable_test" });
  });

  it("pages through the full history when there is no cursor", async () => {
    const fullPage = Array.from({ length: KUANTO_PAGE_SIZE }, () => weekday);
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(respond(fullPage))
      .mockResolvedValueOnce(respond([weekday, weekday]));

    const rows = await new KuantoRatesClient(config, fetchFn).fetchUpdatedSince(null);

    expect(rows).toHaveLength(KUANTO_PAGE_SIZE + 2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(new URL(fetchFn.mock.calls[0]![0] as string).searchParams.has("updated_at")).toBe(false);
    expect(new URL(fetchFn.mock.calls[1]![0] as string).searchParams.get("offset")).toBe(String(KUANTO_PAGE_SIZE));
  });

  it.each([
    ["an HTTP error", () => Promise.resolve(respond({ message: "denied" }, 401))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["a non-array payload", () => Promise.resolve(respond({ rows: [] }))],
    ["a row without date", () => Promise.resolve(respond([{ ...weekday, rate_date: null }]))],
  ])("rejects %s with KuantoRatesError", async (_label, impl) => {
    const fetchFn = vi.fn().mockImplementation(impl);
    await expect(new KuantoRatesClient(config, fetchFn).fetchUpdatedSince(null)).rejects.toBeInstanceOf(KuantoRatesError);
  });
});
