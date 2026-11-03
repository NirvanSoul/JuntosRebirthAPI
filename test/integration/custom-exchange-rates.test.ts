import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createCustomExchangeRate,
  updateCustomExchangeRate,
} from "../../src/services/custom-exchange-rates";
import { customExchangeRates } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

/** Como mucho una tasa CUSTOM predeterminada por persona, y nunca se pierde por error. */
const db = testDb();
afterAll(cleanupTestUsers);

async function defaults(userId: string) {
  const rows = await db
    .select({ name: customExchangeRates.name })
    .from(customExchangeRates)
    .where(and(eq(customExchangeRates.userId, userId), eq(customExchangeRates.isDefault, true)));
  return rows.map((row) => row.name).sort();
}

const rate = (userId: string, name: string, isDefault: boolean) =>
  createCustomExchangeRate(db, { userId, countryCode: "VE", name, rate: "41.5", isDefault });

describe("custom exchange rate default", () => {
  it("keeps the current default when the rate to promote does not exist", async () => {
    const userId = await createTestUser(db, "custom-rate-missing");
    await rate(userId, "Paralelo", true);

    const updated = await updateCustomExchangeRate(db, { userId, id: crypto.randomUUID(), isDefault: true });

    expect(updated).toBeNull();
    expect(await defaults(userId)).toEqual(["Paralelo"]);
  });

  it("keeps the current default when the rate to promote belongs to someone else", async () => {
    const userId = await createTestUser(db, "custom-rate-owner");
    const stranger = await createTestUser(db, "custom-rate-stranger");
    await rate(userId, "Paralelo", true);
    const foreign = await rate(stranger, "Ajena", false);

    expect(await updateCustomExchangeRate(db, { userId, id: foreign.id, isDefault: true })).toBeNull();
    expect(await defaults(userId)).toEqual(["Paralelo"]);
  });

  it("ends with exactly one default when several are created at once", async () => {
    const userId = await createTestUser(db, "custom-rate-race");
    for (let round = 0; round < 5; round += 1) {
      await Promise.all(["A", "B", "C"].map((name) => rate(userId, `${name}${round}`, true)));
      expect(await defaults(userId)).toHaveLength(1);
    }
  });

  it("moves the default when promoting an own rate", async () => {
    const userId = await createTestUser(db, "custom-rate-move");
    await rate(userId, "Paralelo", true);
    const other = await rate(userId, "Binance", false);

    await updateCustomExchangeRate(db, { userId, id: other.id, isDefault: true });

    expect(await defaults(userId)).toEqual(["Binance"]);
  });
});
