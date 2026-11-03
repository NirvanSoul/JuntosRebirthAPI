import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser, updateProfile } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { createCategory } from "../../src/services/categories";
import { createTransaction, updateTransaction } from "../../src/services/transactions";
import { exchangeRateSnapshots, transactionReferenceRates, transactions } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

/**
 * `POST/PATCH /v1/spaces/:id/transactions` en VE: el movimiento, su
 * equivalencia USD y sus tasas congeladas se escriben juntos o no se escriben.
 */
const db = testDb();
const seededRateIds: string[] = [];

afterAll(async () => {
  await cleanupTestUsers();
  if (seededRateIds.length) {
    await db.delete(transactionReferenceRates).where(inArray(transactionReferenceRates.rateSnapshotId, seededRateIds));
    await db.delete(exchangeRateSnapshots).where(inArray(exchangeRateSnapshots.id, seededRateIds));
  }
});

async function venezuelaSpace(label: string) {
  const observedAt = new Date(Date.now() - 60_000);
  const expiresAt = new Date(Date.now() + 24 * 3600_000);
  const rates = await db.insert(exchangeRateSnapshots).values([
    { countryCode: "VE", rateSource: "BCV", referenceAsset: "USD", quoteCurrency: "VES", rate: "40", observedAt, fetchedAt: observedAt, expiresAt },
    { countryCode: "VE", rateSource: "EURO", referenceAsset: "EUR", quoteCurrency: "VES", rate: "44", observedAt, fetchedAt: observedAt, expiresAt },
  ]).returning({ id: exchangeRateSnapshots.id });
  seededRateIds.push(...rates.map((row) => row.id));

  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "America/Caracas");
  await updateProfile(db, userId, { countryCode: "VE" });
  const space = await createSpaceWithOwner(db, userId, { name: "Juntos", type: "other", currency: "USD", timezone: "America/Caracas" });
  const category = await createCategory(db, { spaceId: space.id, userId, name: "Comida", icon: null, colorToken: null });
  return { userId, spaceId: space.id, categoryId: category.id };
}

/**
 * Mientras dura `run`, cualquier INSERT de tasas congeladas falla en la base:
 * simula un fallo a mitad de escritura sin depender de cómo escribe el código.
 */
async function withFailingRateWrites<T>(run: () => Promise<T>): Promise<T> {
  await db.execute(sql`CREATE OR REPLACE FUNCTION itest_fail_rate_writes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'itest: rate write failed'; END; $$`);
  await db.execute(sql`CREATE TRIGGER itest_fail_rate_writes BEFORE INSERT ON transaction_reference_rates FOR EACH ROW EXECUTE FUNCTION itest_fail_rate_writes()`);
  try {
    return await run();
  } finally {
    await db.execute(sql`DROP TRIGGER IF EXISTS itest_fail_rate_writes ON transaction_reference_rates`);
    await db.execute(sql`DROP FUNCTION IF EXISTS itest_fail_rate_writes()`);
  }
}

async function stored(spaceId: string) {
  const rows = await db
    .select({ id: transactions.id, amountMinor: transactions.amountMinor, usd: transactions.accountingAmountMinorUsd })
    .from(transactions)
    .where(eq(transactions.spaceId, spaceId));
  const rates = rows.length
    ? await db.select({ converted: transactionReferenceRates.convertedAmountMinor }).from(transactionReferenceRates).where(inArray(transactionReferenceRates.transactionId, rows.map((row) => row.id)))
    : [];
  return { rows, rates: rates.map((rate) => rate.converted).sort() };
}

const base = { type: "expense" as const, currency: "VES", title: "Mercado de prueba", occurredOn: "2026-09-01", moneyAccountId: null, creatorCountryCode: "VE" };

describe("transactions REST writes in Venezuela", () => {
  it("does not leave a movement without its frozen rates when the rates fail to write", async () => {
    const { userId, spaceId, categoryId } = await venezuelaSpace("tx-rest-create");

    await expect(withFailingRateWrites(() => createTransaction(db, { ...base, spaceId, userId, categoryId, amountMinor: 40_000n }))).rejects.toBeDefined();

    expect((await stored(spaceId)).rows).toEqual([]);
  });

  it("keeps amount, USD equivalent and rates together when a refreeze fails", async () => {
    const { userId, spaceId, categoryId } = await venezuelaSpace("tx-rest-update");
    const created = await createTransaction(db, { ...base, spaceId, userId, categoryId, amountMinor: 40_000n });
    const before = await stored(spaceId);
    expect(before.rows).toEqual([{ id: created.transaction!.id, amountMinor: 40_000n, usd: 1_000n }]);
    expect(before.rates.length).toBeGreaterThan(0);

    await expect(withFailingRateWrites(() => updateTransaction(db, {
      spaceId, transactionId: created.transaction!.id, userId, amountMinor: 80_000n, creatorCountryCode: "VE",
    }))).rejects.toBeDefined();

    expect(await stored(spaceId)).toEqual(before);
  });

  it("refreezes amount, USD equivalent and rates on a successful update", async () => {
    const { userId, spaceId, categoryId } = await venezuelaSpace("tx-rest-ok");
    const created = await createTransaction(db, { ...base, spaceId, userId, categoryId, amountMinor: 40_000n });

    const updated = await updateTransaction(db, { spaceId, transactionId: created.transaction!.id, userId, amountMinor: 80_000n, creatorCountryCode: "VE" });

    expect(updated.transaction?.accountingAmountMinorUsd).toBe("2000");
    const after = await stored(spaceId);
    expect(after.rows).toEqual([{ id: created.transaction!.id, amountMinor: 80_000n, usd: 2_000n }]);
    expect(after.rates.length).toBeGreaterThan(0);
    expect(after.rates).toContain(2_000n);
  });
});
