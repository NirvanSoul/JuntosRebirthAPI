import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../src/db/client";
import { exchangeRateSnapshots } from "../../src/db/schema";
import { addDaysToDateString, veDateString, veMidnightUtc } from "../../src/lib/venezuela-time";
import {
  buildMovementSnapshot,
  captureNextDayRate,
  ExchangeRatesUnavailableError,
  getCurrentRates,
  previewConversion,
} from "../../src/services/exchange-rates";
import { VenezuelaRateService } from "../../src/services/rates/venezuela";

function chain(rows: unknown[]) {
  const obj: {
    orderBy: () => typeof obj;
    limit: () => Promise<unknown[]>;
    then: Promise<unknown[]>["then"];
  } = {
    orderBy: () => obj,
    limit: () => Promise.resolve(rows),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}

function mockDb(options: {
  snapshotRows?: unknown[];
  customRateRows?: unknown[];
  onInsert?: (values: Record<string, unknown>[]) => void;
  onDelete?: () => void;
} = {}) {
  const snapshotRows = options.snapshotRows ?? [];
  const customRateRows = options.customRateRows ?? [];

  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => chain(table === exchangeRateSnapshots ? snapshotRows : customRateRows),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>[]) => {
        options.onInsert?.(values);
        return {
          returning: () =>
            Promise.resolve(values.map((row, index) => ({ id: `snap-${index}`, ...row }))),
        };
      },
    }),
    delete: () => ({
      where: () => {
        options.onDelete?.();
        return Promise.resolve();
      },
    }),
  } as unknown as Database;
}

const now = new Date();
const todayVE = veDateString(now);
const tomorrowVE = addDaysToDateString(todayVE, 1);
const yesterdayVE = addDaysToDateString(todayVE, -1);

function snapshotRow(asset: "USD" | "EUR", rate: string, dateVE: string) {
  return {
    id: `existing-${asset}-${dateVE}`,
    countryCode: "VE",
    rateSource: asset === "EUR" ? "EURO" : "BCV",
    referenceAsset: asset,
    quoteCurrency: "VES",
    rate,
    observedAt: veMidnightUtc(dateVE),
    fetchedAt: veMidnightUtc(dateVE),
    expiresAt: veMidnightUtc(addDaysToDateString(dateVE, 1)),
    createdAt: veMidnightUtc(dateVE),
  };
}

const TODAY_ROWS = [snapshotRow("USD", "50.0000000000", todayVE), snapshotRow("EUR", "60.0000000000", todayVE)];
const YESTERDAY_ROWS = [snapshotRow("USD", "50.0000000000", yesterdayVE), snapshotRow("EUR", "60.0000000000", yesterdayVE)];

function fakeVenezuelaRateService(rates: Awaited<ReturnType<VenezuelaRateService["getRates"]>> | Error) {
  const service = new VenezuelaRateService();
  vi.spyOn(service, "getRates").mockImplementation(() =>
    rates instanceof Error ? Promise.reject(rates) : Promise.resolve(rates),
  );
  return service;
}

describe("getCurrentRates", () => {
  it("serves today's cached rate without calling the provider", async () => {
    const service = fakeVenezuelaRateService(new Error("should not be called"));
    const result = await getCurrentRates(mockDb({ snapshotRows: TODAY_ROWS }), "VE", service);

    expect(result.stale).toBe(false);
    expect(result.rates.BCV.rate).toBe("50.0000000000");
    expect(result.rates.EURO.rate).toBe("60.0000000000");
  });

  it("self-heals by fetching live and anchoring to today when nothing covers now", async () => {
    const service = fakeVenezuelaRateService([
      { source: "BCV", baseCurrency: "USD", quoteCurrency: "VES", rate: "55.0000000000" },
      { source: "BCV", baseCurrency: "EUR", quoteCurrency: "VES", rate: "65.0000000000" },
    ]);
    const result = await getCurrentRates(mockDb({ snapshotRows: [] }), "VE", service);

    expect(result.stale).toBe(false);
    expect(result.rates.BCV.rate).toBe("55.0000000000");
  });

  it("falls back to yesterday's stale snapshot when nothing covers now and the provider fails", async () => {
    const service = fakeVenezuelaRateService(new Error("upstream down"));
    const result = await getCurrentRates(mockDb({ snapshotRows: YESTERDAY_ROWS }), "VE", service);

    expect(result.stale).toBe(true);
    expect(result.rates.BCV.rate).toBe("50.0000000000");
  });

  it("throws ExchangeRatesUnavailableError when there is nothing cached and the provider fails", async () => {
    const service = fakeVenezuelaRateService(new Error("upstream down"));
    await expect(getCurrentRates(mockDb({ snapshotRows: [] }), "VE", service)).rejects.toBeInstanceOf(
      ExchangeRatesUnavailableError,
    );
  });
});

describe("previewConversion", () => {
  it("converts a VES amount to its USD and EUR equivalents", async () => {
    const service = fakeVenezuelaRateService(new Error("unused"));
    const result = await previewConversion(mockDb({ snapshotRows: TODAY_ROWS }), { amount: "10000", currency: "VES" });

    expect(result.conversions.BCV).toMatchObject({ amount: "200.00", currency: "USD", rate: "50.0000000000" });
    expect(result.conversions.EURO).toMatchObject({ amount: "166.67", currency: "EUR", rate: "60.0000000000" });
  });
});

describe("buildMovementSnapshot", () => {
  it("returns null when the currency is not VES or USD", async () => {
    const { snapshot } = await buildMovementSnapshot(
      mockDb({ snapshotRows: TODAY_ROWS }),
      { userId: "user-1", amountMinor: 1000n, currency: "EUR" },
    );
    expect(snapshot).toBeNull();
  });

  it("freezes BCV and EURO rows for a VES movement using today's rate", async () => {
    const { snapshot } = await buildMovementSnapshot(
      mockDb({ snapshotRows: TODAY_ROWS }),
      { userId: "user-1", amountMinor: 1000000n, currency: "VES" },
    );

    expect(snapshot?.createdWithCurrency).toBe("VES");
    expect(snapshot?.rows).toHaveLength(2);
    const bcv = snapshot?.rows.find((row) => row.rateSource === "BCV");
    expect(bcv).toMatchObject({ displayCurrency: "USD", rate: "50.0000000000", convertedAmountMinor: 20000n });
  });

  it("is best-effort: returns null instead of throwing when the provider is unavailable", async () => {
    const service = fakeVenezuelaRateService(new Error("upstream down"));
    const { snapshot, error } = await buildMovementSnapshot(
      mockDb({ snapshotRows: [] }),
      { userId: "user-1", amountMinor: 1000000n, currency: "VES" },
      service,
    );
    expect(snapshot).toBeNull();
    expect(error).toBeUndefined();
  });

  it("reports CUSTOM_RATE_NOT_FOUND when the customRateId does not belong to the user", async () => {
    const { snapshot, error } = await buildMovementSnapshot(
      mockDb({ snapshotRows: TODAY_ROWS, customRateRows: [] }),
      { userId: "user-1", amountMinor: 1000000n, currency: "VES", customRateId: "not-mine" },
    );
    expect(snapshot).toBeNull();
    expect(error).toBe("CUSTOM_RATE_NOT_FOUND");
  });

  it("adds a CUSTOM row when the customRateId belongs to the user", async () => {
    const { snapshot } = await buildMovementSnapshot(
      mockDb({
        snapshotRows: TODAY_ROWS,
        customRateRows: [{
          id: "custom-1", userId: "user-1", countryCode: "VE", name: "Mi tasa",
          baseCurrency: "USD", quoteCurrency: "VES", rate: "54.5000000000", isDefault: false,
          createdAt: new Date(), updatedAt: new Date(),
        }],
      }),
      { userId: "user-1", amountMinor: 1000000n, currency: "VES", customRateId: "custom-1" },
    );

    const custom = snapshot?.rows.find((row) => row.rateSource === "CUSTOM");
    expect(custom).toMatchObject({ customRateId: "custom-1", rate: "54.5000000000", displayCurrency: "USD" });
  });
});

describe("captureNextDayRate", () => {
  afterEach(() => vi.useRealTimers());

  function setVeTime(hourVe: number, minuteVe = 0) {
    // VE = UTC-4, sin horario de verano: hora VE + 4 = hora UTC.
    const iso = `${todayVE}T${String(hourVe + 4).padStart(2, "0")}:${String(minuteVe).padStart(2, "0")}:00.000Z`;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  }

  it("does nothing outside the publish window, without calling the provider", async () => {
    setVeTime(10); // 10:00am VE
    const service = fakeVenezuelaRateService(new Error("should not be called"));
    const result = await captureNextDayRate(mockDb({ snapshotRows: TODAY_ROWS }), "VE", service);
    expect(result.captured).toBe(false);
  });

  it("does nothing inside the window when the rate hasn't changed from today's", async () => {
    setVeTime(16); // 4:00pm VE, inside the window
    const service = fakeVenezuelaRateService([
      { source: "BCV", baseCurrency: "USD", quoteCurrency: "VES", rate: "50.0000000000" },
      { source: "BCV", baseCurrency: "EUR", quoteCurrency: "VES", rate: "60.0000000000" },
    ]);
    const onInsert = vi.fn();
    const result = await captureNextDayRate(mockDb({ snapshotRows: TODAY_ROWS, onInsert }), "VE", service);
    expect(result.captured).toBe(false);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("captures a changed rate inside the window, anchored to tomorrow's VE date", async () => {
    setVeTime(16); // 4:00pm VE, inside the window
    const service = fakeVenezuelaRateService([
      { source: "BCV", baseCurrency: "USD", quoteCurrency: "VES", rate: "55.0000000000" },
      { source: "BCV", baseCurrency: "EUR", quoteCurrency: "VES", rate: "60.0000000000" },
    ]);
    const onInsert = vi.fn();
    const onDelete = vi.fn();
    const result = await captureNextDayRate(mockDb({ snapshotRows: TODAY_ROWS, onInsert, onDelete }), "VE", service);

    expect(result.captured).toBe(true);
    expect(onDelete).toHaveBeenCalled();
    expect(onInsert).toHaveBeenCalledWith([
      expect.objectContaining({ referenceAsset: "USD", rate: "55.0000000000", observedAt: veMidnightUtc(tomorrowVE) }),
    ]);
  });
});
