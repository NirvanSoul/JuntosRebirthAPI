import { afterEach, describe, expect, it } from "vitest";
import { and, gte, lt, lte } from "drizzle-orm";
import { venezuelaDailyRates, venezuelaUsdtReadings } from "../../src/db/schema";
import type { KuantoDailyRate, KuantoRatesClient } from "../../src/services/rates/kuanto";
import {
  getCurrentUsdtRate,
  getRateHistory,
  getRatesAt,
  syncVenezuelaRateHistory,
} from "../../src/services/venezuela-rate-history";
import { testDb } from "./harness";

/**
 * Las tasas no cuelgan de ningún usuario, así que la limpieza no puede ir por
 * el prefijo de usuarios del harness. Todas las filas de esta prueba viven en
 * 1999 (fechas y lecturas), un rango que ningún dato real puede ocupar, y solo
 * ese rango se borra.
 */
const db = testDb();
const FROM = "1999-01-01";
const TO = "1999-12-31";

afterEach(async () => {
  await db.delete(venezuelaDailyRates).where(and(gte(venezuelaDailyRates.rateDate, FROM), lte(venezuelaDailyRates.rateDate, TO)));
  await db
    .delete(venezuelaUsdtReadings)
    .where(and(gte(venezuelaUsdtReadings.observedAt, new Date("1999-01-01T00:00:00Z")), lt(venezuelaUsdtReadings.observedAt, new Date("2000-01-02T00:00:00Z"))));
});

function row(rateDate: string, overrides: Partial<KuantoDailyRate> = {}): KuantoDailyRate {
  return {
    rateDate,
    bcvUsd: "100.0000000000",
    bcvEur: "110.0000000000",
    usdtLast: "130.0000000000",
    usdtDailyAverage: "128.0000000000",
    usdtSources: { binance: { buy: 130, sell: 129 } },
    bcvPublishedAt: new Date(`${rateDate}T00:35:00Z`),
    usdtObservedAt: new Date(`${rateDate}T23:00:00Z`),
    sourceUpdatedAt: new Date(`${rateDate}T23:00:01Z`),
    ...overrides,
  };
}

/** Doble estructural: el servicio solo usa `fetchUpdatedSince`. */
function fakeClient(...batches: KuantoDailyRate[][]) {
  const calls: Array<Date | null> = [];
  const client = {
    async fetchUpdatedSince(since: Date | null) {
      calls.push(since);
      return batches.shift() ?? [];
    },
  } as unknown as KuantoRatesClient;
  return { client, calls };
}

const stored = (date: string) =>
  db.select().from(venezuelaDailyRates).where(and(gte(venezuelaDailyRates.rateDate, date), lte(venezuelaDailyRates.rateDate, date)));

const readingsOf1999 = () =>
  db.select().from(venezuelaUsdtReadings).where(and(gte(venezuelaUsdtReadings.observedAt, new Date("1999-01-01T00:00:00Z")), lt(venezuelaUsdtReadings.observedAt, new Date("2000-01-02T00:00:00Z"))));

describe("syncVenezuelaRateHistory", () => {
  it("copies the rows and is idempotent", async () => {
    const rows = [row("1999-03-01"), row("1999-03-02")];
    await syncVenezuelaRateHistory(db, fakeClient(rows).client, new Date("1999-06-01T00:00:00Z"));
    await syncVenezuelaRateHistory(db, fakeClient(rows).client, new Date("1999-06-01T00:00:00Z"));

    const [first] = await stored("1999-03-01");
    expect(first).toMatchObject({ bcvUsd: "100.0000000000", usdtLast: "130.0000000000", usdtDailyAverage: "128.0000000000" });
    expect(first!.usdtSources).toEqual({ binance: { buy: 130, sell: 129 } });
    expect(await getRateHistory(db, "1999-03-01", "1999-03-02")).toHaveLength(2);
  });

  it("updates a day when Kuanto republishes it, but never with an older version", async () => {
    await syncVenezuelaRateHistory(db, fakeClient([row("1999-03-01")]).client);
    await syncVenezuelaRateHistory(
      db,
      fakeClient([row("1999-03-01", { usdtLast: "140.0000000000", sourceUpdatedAt: new Date("1999-03-02T01:00:00Z") })]).client,
    );
    await syncVenezuelaRateHistory(
      db,
      fakeClient([row("1999-03-01", { usdtLast: "120.0000000000", sourceUpdatedAt: new Date("1999-03-01T12:00:00Z") })]).client,
    );

    const [day] = await stored("1999-03-01");
    expect(day!.usdtLast).toBe("140.0000000000");
  });

  it("stores an intraday reading only for fresh observations, once per observedAt", async () => {
    const now = new Date("1999-03-01T15:10:00Z");
    const fresh = row("1999-03-01", { usdtObservedAt: new Date("1999-03-01T15:05:00Z") });
    // Copia del historial: lo observado hace días no es una lectura con hora real.
    const old = row("1999-02-20", { usdtObservedAt: new Date("1999-02-21T03:05:00Z") });

    const first = await syncVenezuelaRateHistory(db, fakeClient([fresh, old]).client, now);
    const again = await syncVenezuelaRateHistory(db, fakeClient([fresh]).client, now);

    expect(first.readingsInserted).toBe(1);
    expect(again.readingsInserted).toBe(0);
    const readings = await readingsOf1999();
    expect(readings.map((reading) => reading.observedAt.toISOString())).toEqual(["1999-03-01T15:05:00.000Z"]);
  });
});

describe("rate lookups", () => {
  it("returns the current USDT rate and flags it stale after two hours", async () => {
    await syncVenezuelaRateHistory(db, fakeClient([row("1999-03-01", { usdtObservedAt: new Date("1999-03-01T15:00:00Z") })]).client);

    const fresh = await getCurrentUsdtRate(db, new Date("1999-03-01T16:00:00Z"));
    const old = await getCurrentUsdtRate(db, new Date("1999-03-01T17:30:00Z"));

    expect(fresh).toMatchObject({ source: "USDT", rate: "130.0000000000", dailyAverage: "128.0000000000", stale: false });
    expect(old?.stale).toBe(true);
  });

  it("ignores tomorrow's row (BCV published, no P2P yet) when picking the current USDT", async () => {
    await syncVenezuelaRateHistory(db, fakeClient([
      row("1999-03-01", { usdtLast: "130.0000000000" }),
      row("1999-03-02", { usdtLast: null, usdtDailyAverage: null, usdtObservedAt: null }),
    ]).client);

    expect((await getCurrentUsdtRate(db, new Date("1999-03-02T15:00:00Z")))?.rate).toBe("130.0000000000");
  });

  it("carries the last BCV publication over weekends", async () => {
    await syncVenezuelaRateHistory(db, fakeClient([
      row("1999-03-05", { bcvUsd: "105.0000000000", bcvEur: "115.0000000000" }),
      row("1999-03-06", { bcvUsd: null, bcvEur: null }),
    ]).client);

    const saturday = await getRatesAt(db, "1999-03-06", null, new Date("1999-06-01T00:00:00Z"));

    expect(saturday.bcv).toEqual({ effectiveDate: "1999-03-05", usd: "105.0000000000", eur: "115.0000000000" });
    expect(saturday.usdt).toEqual({ rate: "128.0000000000", precision: "daily_average", observedAt: null });
  });

  it("uses the last intraday reading at or before the requested Caracas time", async () => {
    const now = new Date("1999-03-01T20:00:00Z");
    // 10:00, 12:00 y 15:00 hora de Caracas (UTC-4). Cada cron corre justo
    // después de la observación, como en producción (si no, no es "fresca").
    for (const [observed, rate] of [["1999-03-01T14:00:00Z", "131"], ["1999-03-01T16:00:00Z", "132"], ["1999-03-01T19:00:00Z", "133"]] as const) {
      await syncVenezuelaRateHistory(
        db,
        fakeClient([row("1999-03-01", { usdtLast: `${rate}.0000000000`, usdtObservedAt: new Date(observed), sourceUpdatedAt: new Date(observed) })]).client,
        new Date(new Date(observed).getTime() + 5 * 60_000),
      );
    }

    const at = (time: string) => getRatesAt(db, "1999-03-01", time, now);

    expect((await at("13:59")).usdt).toEqual({ rate: "132.0000000000", precision: "intraday", observedAt: "1999-03-01T16:00:00.000Z" });
    expect((await at("15:00")).usdt?.rate).toBe("133.0000000000");
    // Antes de la primera lectura del día: la primera disponible.
    expect((await at("06:00")).usdt?.rate).toBe("131.0000000000");
  });

  it("falls back to the daily average when a time has no readings that day", async () => {
    await syncVenezuelaRateHistory(db, fakeClient([row("1999-03-01")]).client, new Date("1999-06-01T00:00:00Z"));

    const rates = await getRatesAt(db, "1999-03-01", "14:30", new Date("1999-06-01T00:00:00Z"));

    expect(rates.usdt).toEqual({ rate: "128.0000000000", precision: "daily_average", observedAt: null });
  });

  it("returns the latest observed value for today without a time", async () => {
    await syncVenezuelaRateHistory(db, fakeClient([row("1999-03-01", { usdtObservedAt: new Date("1999-03-01T15:00:00Z") })]).client);

    const rates = await getRatesAt(db, "1999-03-01", null, new Date("1999-03-01T16:00:00Z"));

    expect(rates.usdt).toEqual({ rate: "130.0000000000", precision: "intraday", observedAt: "1999-03-01T15:00:00.000Z" });
  });

  it("returns null USDT for a day without P2P data instead of borrowing another day", async () => {
    await syncVenezuelaRateHistory(db, fakeClient([
      row("1999-03-01"),
      row("1999-03-02", { usdtLast: null, usdtDailyAverage: null, usdtObservedAt: null }),
    ]).client);

    const rates = await getRatesAt(db, "1999-03-02", null, new Date("1999-06-01T00:00:00Z"));

    expect(rates.bcv?.effectiveDate).toBe("1999-03-02");
    expect(rates.usdt).toBeNull();
  });
});
