import { afterAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser, updateProfile } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { syncSpaceData, type SpaceSyncPayload } from "../../src/services/space-sync";
import { buildChanges, buildSnapshot } from "../../src/services/sync-snapshot";
import {
  categories,
  categoryBudgets,
  exchangeRateSnapshots,
  moneyAccountBalances,
  moneyAccounts,
  transactionReferenceRates,
  transactions,
} from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

/**
 * Resolución de conflictos de `POST /v1/spaces/:id/sync` con hijos
 * (presupuestos, saldos, tasas congeladas). Todo con datos ficticios.
 *
 * T0 < T1 < T2 < T3: T1 es la versión vieja que llega tarde.
 */
const db = testDb();
const T0 = "2026-09-01T08:00:00.000Z";
const T1 = "2026-09-01T09:00:00.000Z";
const T2 = "2026-09-01T10:00:00.000Z";
const T3 = "2026-09-01T11:00:00.000Z";

const seededRateIds: string[] = [];
afterAll(async () => {
  if (seededRateIds.length) {
    await db.delete(transactionReferenceRates).where(inArray(transactionReferenceRates.rateSnapshotId, seededRateIds));
    await db.delete(exchangeRateSnapshots).where(inArray(exchangeRateSnapshots.id, seededRateIds));
  }
  await cleanupTestUsers();
});

async function sharedSpace(label: string, countryCode?: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  if (countryCode) await updateProfile(db, userId, { countryCode });
  const space = await createSpaceWithOwner(db, userId, {
    name: "Juntos",
    type: "other",
    currency: countryCode === "VE" ? "USD" : "EUR",
    timezone: "Europe/Madrid",
  });
  return { userId, spaceId: space.id };
}

const empty = { categories: [], moneyAccounts: [], recurringSeries: [], transactions: [] };

function push(spaceId: string, userId: string, body: Partial<SpaceSyncPayload>, country: string | null = null) {
  return syncSpaceData(db, spaceId, userId, { installationId: "install-A", ...empty, ...body }, country);
}

function account(id: string, updatedAt: string, balances: { currency: string; openingBalanceMinor: number }[], extra: Record<string, unknown> = {}) {
  return {
    id,
    remoteId: id,
    name: "Cuenta de prueba",
    kind: "bank",
    icon: null,
    colorToken: null,
    currency: balances[0]!.currency,
    isArchived: false,
    createdAt: T0,
    updatedAt,
    balances: balances.map((balance, position) => ({ ...balance, position })),
    ...extra,
  };
}

function category(id: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    remoteId: id,
    name: "Categoría de prueba",
    icon: null,
    colorToken: null,
    budgetMinor: null,
    isDefault: false,
    templateKey: null,
    isArchived: false,
    createdAt: T0,
    updatedAt,
    ...extra,
  };
}

function transaction(id: string, categoryId: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    remoteId: id,
    categoryId,
    moneyAccountId: null,
    type: "expense",
    amountMinor: 1000,
    currency: "USD",
    title: "Compra de prueba",
    occurredOn: "2026-09-01",
    note: null,
    recurrence: "once",
    recurrenceGroupId: null,
    recurrenceSeriesId: null,
    sourceTransactionId: null,
    isArchived: false,
    createdAt: T0,
    updatedAt,
    ...extra,
  };
}

async function storedAccount(id: string) {
  const [parent] = await db.select({ updatedAt: moneyAccounts.updatedAt, name: moneyAccounts.name }).from(moneyAccounts).where(eq(moneyAccounts.id, id));
  const balances = await db
    .select({ currency: moneyAccountBalances.currency, openingBalanceMinor: moneyAccountBalances.openingBalanceMinor })
    .from(moneyAccountBalances)
    .where(eq(moneyAccountBalances.moneyAccountId, id))
    .orderBy(asc(moneyAccountBalances.displayOrder));
  return { updatedAt: parent?.updatedAt.toISOString(), name: parent?.name, balances: balances.map((b) => `${b.currency}:${b.openingBalanceMinor}`) };
}

async function storedBudgets(categoryId: string) {
  const rows = await db.select().from(categoryBudgets).where(eq(categoryBudgets.categoryId, categoryId)).orderBy(asc(categoryBudgets.currency));
  return rows.map((row) => ({
    currency: row.currency,
    budgetAmountMinor: row.budgetAmountMinor.toString(),
    period: row.period,
    intervalDays: row.intervalDays,
    anchorOn: row.anchorOn,
    overrides: row.overrides,
    history: row.history,
  }));
}

/** Tasas BCV/EURO vigentes y ficticias para que VE pueda congelar equivalencias. */
async function seedVenezuelaRates(usd: string, eur: string) {
  const observedAt = new Date(Date.now() - 60_000);
  const expiresAt = new Date(Date.now() + 24 * 3600_000);
  const rows = await db.insert(exchangeRateSnapshots).values([
    { countryCode: "VE", rateSource: "BCV", referenceAsset: "USD", quoteCurrency: "VES", rate: usd, observedAt, fetchedAt: observedAt, expiresAt },
    { countryCode: "VE", rateSource: "EURO", referenceAsset: "EUR", quoteCurrency: "VES", rate: eur, observedAt, fetchedAt: observedAt, expiresAt },
  ]).returning({ id: exchangeRateSnapshots.id });
  seededRateIds.push(...rows.map((row) => row.id));
}

const ACC = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAT = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TX = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("sync conflicts: money account balances", () => {
  it("a stale version neither replaces balances nor reports itself as canonical", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-acc");
    await push(spaceId, userId, { moneyAccounts: [account(ACC(1), T2, [{ currency: "EUR", openingBalanceMinor: 200 }])] });

    const result = await push(spaceId, userId, {
      installationId: "install-B",
      moneyAccounts: [account(ACC(1), T1, [{ currency: "EUR", openingBalanceMinor: 100 }, { currency: "USD", openingBalanceMinor: 5 }], { name: "Nombre viejo" })],
    });

    expect(await storedAccount(ACC(1))).toEqual({ updatedAt: T2, name: "Cuenta de prueba", balances: ["EUR:200"] });
    expect(result.conflicts).toEqual([
      { collection: "moneyAccounts", localId: ACC(1), remoteId: ACC(1), reason: "NEWER_VERSION", serverUpdatedAt: T2 },
    ]);
  });

  it("accepts an equal version (tie) and a newer version with their balances", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-acc-tie");
    await push(spaceId, userId, { moneyAccounts: [account(ACC(2), T2, [{ currency: "EUR", openingBalanceMinor: 200 }])] });

    const tie = await push(spaceId, userId, { installationId: "install-B", moneyAccounts: [account(ACC(2), T2, [{ currency: "EUR", openingBalanceMinor: 250 }])] });
    expect(tie.conflicts).toBeUndefined();
    expect(await storedAccount(ACC(2))).toMatchObject({ updatedAt: T2, balances: ["EUR:250"] });

    const newer = await push(spaceId, userId, { moneyAccounts: [account(ACC(2), T3, [{ currency: "EUR", openingBalanceMinor: 300 }, { currency: "USD", openingBalanceMinor: 7 }])] });
    expect(newer.conflicts).toBeUndefined();
    expect(await storedAccount(ACC(2))).toMatchObject({ updatedAt: T3, balances: ["EUR:300", "USD:7"] });
  });

  it("re-delivers the canonical row through the changes cursor after rejecting a stale version", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-acc-cursor");
    await push(spaceId, userId, { moneyAccounts: [account(ACC(3), T2, [{ currency: "EUR", openingBalanceMinor: 200 }])] });
    // El dispositivo viejo ya había leído hasta después de T2.
    await db.execute(sql`UPDATE money_accounts SET server_updated_at = now() - interval '10 minutes' WHERE id = ${ACC(3)}`);
    const cursor = new Date(Date.now() - 5 * 60_000);
    expect((await buildChanges(db, userId, cursor)).moneyAccounts.map((row) => row.id)).not.toContain(ACC(3));

    await push(spaceId, userId, { installationId: "install-B", moneyAccounts: [account(ACC(3), T1, [{ currency: "EUR", openingBalanceMinor: 100 }])] });

    const changes = await buildChanges(db, userId, cursor);
    const delivered = changes.moneyAccounts.find((row) => row.id === ACC(3));
    expect(delivered?.updatedAt.toISOString()).toBe(T2);
    expect(delivered?.balances.map((b) => `${b.currency}:${b.openingBalanceMinor}`)).toEqual(["EUR:200"]);
  });

  it("is idempotent when a lost response makes the client retry the same batch", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-acc-retry");
    const batch = { moneyAccounts: [account(ACC(4), T2, [{ currency: "EUR", openingBalanceMinor: 200 }, { currency: "USD", openingBalanceMinor: 3 }])] };
    const first = await push(spaceId, userId, batch);
    const retry = await push(spaceId, userId, batch);
    expect(first.conflicts).toBeUndefined();
    expect(retry.conflicts).toBeUndefined();
    expect(await storedAccount(ACC(4))).toMatchObject({ updatedAt: T2, balances: ["EUR:200", "USD:3"] });
  });

  it("keeps parent and balances consistent under concurrent old/new pushes", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-acc-race");
    await push(spaceId, userId, { moneyAccounts: [account(ACC(5), T0, [{ currency: "EUR", openingBalanceMinor: 1 }])] });

    for (let round = 0; round < 12; round += 1) {
      const base = Date.parse(T3) + round * 60_000;
      const older = new Date(base).toISOString();
      const newer = new Date(base + 1_000).toISOString();
      const pushes = [
        push(spaceId, userId, { installationId: "install-old", moneyAccounts: [account(ACC(5), older, [{ currency: "EUR", openingBalanceMinor: 100 + round }, { currency: "USD", openingBalanceMinor: 9 }])] }),
        push(spaceId, userId, { installationId: "install-new", moneyAccounts: [account(ACC(5), newer, [{ currency: "EUR", openingBalanceMinor: 200 + round }])] }),
      ];
      if (round % 2) pushes.reverse();
      await Promise.all(pushes);
      expect(await storedAccount(ACC(5))).toMatchObject({ updatedAt: newer, balances: [`EUR:${200 + round}`] });
    }
  });

  it("converges when two devices insert the same new account concurrently", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-acc-insert-race");
    await Promise.all([
      push(spaceId, userId, { installationId: "install-old", moneyAccounts: [account(ACC(6), T1, [{ currency: "EUR", openingBalanceMinor: 100 }])] }),
      push(spaceId, userId, { installationId: "install-new", moneyAccounts: [account(ACC(6), T2, [{ currency: "EUR", openingBalanceMinor: 200 }])] }),
    ]);
    expect(await storedAccount(ACC(6))).toMatchObject({ updatedAt: T2, balances: ["EUR:200"] });
  });
});

describe("sync conflicts: lock ordering", () => {
  it("never deadlocks when two devices push the same rows in opposite order", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-deadlock");
    const ids = [ACC(40), ACC(41), ACC(42), ACC(43)];
    await push(spaceId, userId, { moneyAccounts: ids.map((id) => account(id, T0, [{ currency: "EUR", openingBalanceMinor: 1 }])) });

    const failures: string[] = [];
    for (let round = 0; round < 25; round += 1) {
      const stamp = new Date(Date.parse(T3) + round * 60_000).toISOString();
      const forward = ids.map((id) => account(id, stamp, [{ currency: "EUR", openingBalanceMinor: 100 + round }]));
      const results = await Promise.allSettled([
        push(spaceId, userId, { installationId: "install-A", moneyAccounts: forward }),
        push(spaceId, userId, { installationId: "install-B", moneyAccounts: [...forward].reverse() }),
      ]);
      for (const result of results) {
        if (result.status === "rejected") failures.push(String((result.reason as { code?: string })?.code ?? result.reason));
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("sync conflicts: category budgets", () => {
  const scheduled = {
    currency: "EUR",
    budgetAmountMinor: 20000,
    period: "custom",
    intervalDays: 10,
    anchorOn: "2026-08-01",
    overrides: [{ periodStartOn: "2026-08-11", budgetAmountMinor: 45000 }],
    history: [{ endsOn: "2026-07-31", budgetAmountMinor: 15000, period: "month", intervalDays: null, anchorOn: null }],
  };
  const scheduledStored = {
    currency: "EUR",
    budgetAmountMinor: "20000",
    period: "custom",
    intervalDays: 10,
    anchorOn: "2026-08-01",
    overrides: [{ periodStartOn: "2026-08-11", budgetAmountMinor: "45000" }],
    history: [{ endsOn: "2026-07-31", budgetAmountMinor: "15000", period: "month", intervalDays: null, anchorOn: null }],
  };

  it("a stale version cannot replace multi-currency budgets or their schedule", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-budget");
    await push(spaceId, userId, { categories: [category(CAT(1), T2, { budgets: [scheduled, { currency: "USD", budgetAmountMinor: 5000 }] })] });

    const result = await push(spaceId, userId, {
      installationId: "install-B",
      categories: [category(CAT(1), T1, { name: "Viejo", budgets: [{ currency: "EUR", budgetAmountMinor: 100 }] })],
    });

    expect(await storedBudgets(CAT(1))).toEqual([
      scheduledStored,
      { currency: "USD", budgetAmountMinor: "5000", period: "month", intervalDays: null, anchorOn: null, overrides: [], history: [] },
    ]);
    expect(result.conflicts).toEqual([
      { collection: "categories", localId: CAT(1), remoteId: CAT(1), reason: "NEWER_VERSION", serverUpdatedAt: T2 },
    ]);
  });

  it("a stale legacy client (budgetMinor) cannot change the amount", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-budget-legacy");
    await push(spaceId, userId, { categories: [category(CAT(2), T2, { budgets: [scheduled] })] });
    await push(spaceId, userId, { installationId: "install-old-app", categories: [category(CAT(2), T1, { budgetMinor: 100 })] });
    expect(await storedBudgets(CAT(2))).toEqual([scheduledStored]);
  });

  it("an accepted legacy client update changes the amount and keeps the schedule", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-budget-legacy-ok");
    await push(spaceId, userId, { categories: [category(CAT(3), T2, { budgets: [scheduled] })] });
    await push(spaceId, userId, { installationId: "install-old-app", categories: [category(CAT(3), T3, { budgetMinor: 30000 })] });
    expect(await storedBudgets(CAT(3))).toEqual([{ ...scheduledStored, budgetAmountMinor: "30000" }]);
  });

  it("a client that sends budgets without schedule fields changes amounts but keeps the schedule", async () => {
    const { userId, spaceId } = await sharedSpace("budget-intermediate-client");
    await push(spaceId, userId, { categories: [category(CAT(6), T1, { budgets: [scheduled, { currency: "USD", budgetAmountMinor: 5000, period: "week" }] })] });

    // Versión intermedia de la app: `budgets` con moneda e importe solamente.
    await push(spaceId, userId, { installationId: "install-old-app", categories: [category(CAT(6), T2, { budgets: [{ currency: "EUR", budgetAmountMinor: 25000 }] })] });
    expect(await storedBudgets(CAT(6))).toEqual([{ ...scheduledStored, budgetAmountMinor: "25000" }]);

    // Una moneda nueva sin periodicidad nace mensual.
    await push(spaceId, userId, { installationId: "install-old-app", categories: [category(CAT(6), T3, { budgets: [{ currency: "EUR", budgetAmountMinor: 25000 }, { currency: "MXN", budgetAmountMinor: 900 }] })] });
    expect((await storedBudgets(CAT(6))).map((b) => `${b.currency}:${b.period}`)).toEqual(["EUR:custom", "MXN:month"]);
  });

  it("an empty budgets array removes every currency, only when accepted", async () => {
    const { userId, spaceId } = await sharedSpace("budget-empty");
    await push(spaceId, userId, { categories: [category(CAT(7), T2, { budgets: [scheduled, { currency: "USD", budgetAmountMinor: 5000 }] })] });
    await push(spaceId, userId, { installationId: "install-B", categories: [category(CAT(7), T1, { budgets: [] })] });
    expect(await storedBudgets(CAT(7))).toHaveLength(2);
    await push(spaceId, userId, { categories: [category(CAT(7), T3, { budgets: [] })] });
    expect(await storedBudgets(CAT(7))).toEqual([]);
  });

  it("restores the accepted budget on another device through snapshot and changes", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-budget-restore");
    const cursor = new Date(Date.now() - 60_000);
    await push(spaceId, userId, { categories: [category(CAT(4), T1, { budgets: [{ currency: "EUR", budgetAmountMinor: 100 }] })] });
    await push(spaceId, userId, { categories: [category(CAT(4), T2, { budgets: [scheduled, { currency: "USD", budgetAmountMinor: 5000, period: "week" }] })] });
    await push(spaceId, userId, { installationId: "install-B", categories: [category(CAT(4), T1, { budgets: [{ currency: "EUR", budgetAmountMinor: 1 }] })] });

    const expected = [
      { ...scheduledStored },
      { currency: "USD", budgetAmountMinor: "5000", period: "week", intervalDays: null, anchorOn: null, overrides: [], history: [] },
    ];
    const snapshot = await buildSnapshot(db, userId);
    expect(snapshot.categories.find((row) => row.id === CAT(4))?.budgets).toEqual(expected);
    const changes = await buildChanges(db, userId, cursor);
    expect(changes.categories.find((row) => row.id === CAT(4))?.budgets).toEqual(expected);
  });

  it("keeps budgets consistent under concurrent old/new pushes", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-budget-race");
    await push(spaceId, userId, { categories: [category(CAT(5), T0, { budgets: [{ currency: "EUR", budgetAmountMinor: 1 }] })] });
    for (let round = 0; round < 12; round += 1) {
      const base = Date.parse(T3) + round * 60_000;
      const older = new Date(base).toISOString();
      const newer = new Date(base + 1_000).toISOString();
      const pushes = [
        push(spaceId, userId, { installationId: "install-old", categories: [category(CAT(5), older, { budgets: [{ currency: "EUR", budgetAmountMinor: 100 + round }, { currency: "USD", budgetAmountMinor: 9 }] })] }),
        push(spaceId, userId, { installationId: "install-new", categories: [category(CAT(5), newer, { budgets: [{ currency: "EUR", budgetAmountMinor: 200 + round, period: "week" }] })] }),
      ];
      if (round % 2) pushes.reverse();
      await Promise.all(pushes);
      expect((await storedBudgets(CAT(5))).map((b) => `${b.currency}:${b.budgetAmountMinor}:${b.period}`)).toEqual([`EUR:${200 + round}:week`]);
    }
  });
});

describe("sync conflicts: Venezuela transactions and frozen rates", () => {
  it("a stale version keeps the canonical amount and rates and answers with them", async () => {
    await seedVenezuelaRates("40.0000000000", "44.0000000000");
    const { userId, spaceId } = await sharedSpace("conflict-ve-tx", "VE");
    const cat = category(CAT(10), T0);
    const first = await push(spaceId, userId, { categories: [cat], transactions: [transaction(TX(1), CAT(10), T2, { amountMinor: 1000 })] }, "VE");
    expect(first.transactions?.[0]).toMatchObject({ applied: true, accountingAmountMinorUsd: "1000" });
    const ratesBefore = await db.select().from(transactionReferenceRates).where(eq(transactionReferenceRates.transactionId, TX(1))).orderBy(asc(transactionReferenceRates.rateSource));
    expect(ratesBefore.map((rate) => `${rate.rateSource}:${rate.convertedAmountMinor}`)).toEqual(["BCV:40000", "EURO:909"]);

    const stale = await push(spaceId, userId, {
      installationId: "install-B",
      transactions: [transaction(TX(1), CAT(10), T1, { amountMinor: 5000, currency: "VES" })],
    }, "VE");

    const [stored] = await db.select().from(transactions).where(eq(transactions.id, TX(1)));
    expect(stored).toMatchObject({ amountMinor: 1000n, currency: "USD", accountingAmountMinorUsd: 1000n });
    expect(stored?.updatedAt.toISOString()).toBe(T2);
    const ratesAfter = await db.select().from(transactionReferenceRates).where(eq(transactionReferenceRates.transactionId, TX(1))).orderBy(asc(transactionReferenceRates.rateSource));
    expect(ratesAfter.map((rate) => rate.id)).toEqual(ratesBefore.map((rate) => rate.id));

    // La respuesta no presenta los valores descartados como canónicos.
    expect(stale.transactions).toEqual([
      expect.objectContaining({ localId: TX(1), remoteId: TX(1), applied: false, updatedAt: T2, accountingAmountMinorUsd: "1000" }),
    ]);
    expect(stale.transactions?.[0]?.exchangeSnapshot).toEqual(first.transactions?.[0]?.exchangeSnapshot);
    expect(stale.transactions?.[0]?.exchangeSnapshot?.createdWithCurrency).toBe("USD");
    expect(stale.conflicts).toEqual([
      { collection: "transactions", localId: TX(1), remoteId: TX(1), reason: "NEWER_VERSION", serverUpdatedAt: T2 },
    ]);
  });

  it("a newer version that changes the amount refreezes the rates", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-ve-tx-newer", "VE");
    await push(spaceId, userId, { categories: [category(CAT(11), T0)], transactions: [transaction(TX(2), CAT(11), T1, { amountMinor: 1000 })] }, "VE");
    const result = await push(spaceId, userId, { transactions: [transaction(TX(2), CAT(11), T2, { amountMinor: 2000 })] }, "VE");
    expect(result.transactions?.[0]).toMatchObject({ applied: true, updatedAt: T2, accountingAmountMinorUsd: "2000" });
    const rates = await db.select().from(transactionReferenceRates).where(eq(transactionReferenceRates.transactionId, TX(2))).orderBy(asc(transactionReferenceRates.rateSource));
    expect(rates.map((rate) => `${rate.rateSource}:${rate.convertedAmountMinor}`)).toEqual(["BCV:80000", "EURO:1818"]);
  });

  it("refreezes rates when another device changes the amount between the read and the batch", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-ve-tx-interleave", "VE");
    await push(spaceId, userId, { categories: [category(CAT(13), T0)], transactions: [transaction(TX(4), CAT(13), T0, { amountMinor: 1000 })] }, "VE");

    // La petición A (más nueva) solo cambia el título: no regenera tasas.
    // Justo antes de su batch, la petición B (más vieja) cambia el importe.
    let interleaved = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (writes: never) => {
          if (!interleaved) {
            interleaved = true;
            await push(spaceId, userId, { installationId: "install-B", transactions: [transaction(TX(4), CAT(13), T1, { amountMinor: 5000 })] }, "VE");
          }
          return target.batch(writes);
        };
      },
    });
    const result = await syncSpaceData(racingDb, spaceId, userId, {
      installationId: "install-A",
      ...empty,
      transactions: [transaction(TX(4), CAT(13), T2, { amountMinor: 1000, title: "Título nuevo" })],
    }, "VE");

    expect(interleaved).toBe(true);
    const [stored] = await db.select().from(transactions).where(eq(transactions.id, TX(4)));
    expect(stored).toMatchObject({ amountMinor: 1000n, title: "Título nuevo", accountingAmountMinorUsd: 1000n });
    const rates = await db.select().from(transactionReferenceRates).where(and(eq(transactionReferenceRates.transactionId, TX(4)), eq(transactionReferenceRates.rateSource, "BCV")));
    expect(rates.map((rate) => rate.convertedAmountMinor)).toEqual([40000n]);
    expect(result.transactions).toEqual([expect.objectContaining({ applied: true, updatedAt: T2, accountingAmountMinorUsd: "1000" })]);
    expect(result.conflicts).toBeUndefined();
  });

  it("keeps amount and frozen rates consistent under concurrent old/new pushes", async () => {
    const { userId, spaceId } = await sharedSpace("conflict-ve-tx-race", "VE");
    await push(spaceId, userId, { categories: [category(CAT(12), T0)], transactions: [transaction(TX(3), CAT(12), T0, { amountMinor: 1 })] }, "VE");
    for (let round = 0; round < 8; round += 1) {
      const base = Date.parse(T3) + round * 60_000;
      const older = new Date(base).toISOString();
      const newer = new Date(base + 1_000).toISOString();
      const pushes = [
        push(spaceId, userId, { installationId: "install-old", transactions: [transaction(TX(3), CAT(12), older, { amountMinor: 100 + round })] }, "VE"),
        push(spaceId, userId, { installationId: "install-new", transactions: [transaction(TX(3), CAT(12), newer, { amountMinor: 200 + round })] }, "VE"),
      ];
      if (round % 2) pushes.reverse();
      await Promise.all(pushes);
      const [stored] = await db.select().from(transactions).where(eq(transactions.id, TX(3)));
      expect(stored?.amountMinor).toBe(BigInt(200 + round));
      expect(stored?.accountingAmountMinorUsd).toBe(BigInt(200 + round));
      const rates = await db.select().from(transactionReferenceRates).where(and(eq(transactionReferenceRates.transactionId, TX(3)), eq(transactionReferenceRates.rateSource, "BCV")));
      expect(rates.map((rate) => rate.convertedAmountMinor)).toEqual([BigInt((200 + round) * 40)]);
    }
  });
});

describe("sync conflicts: space isolation with two users", () => {
  it("never touches another space's children when a remote id is reused", async () => {
    const owner = await sharedSpace("conflict-space-a");
    const intruder = await sharedSpace("conflict-space-b");
    await push(owner.spaceId, owner.userId, {
      moneyAccounts: [account(ACC(20), T1, [{ currency: "EUR", openingBalanceMinor: 200 }])],
      categories: [category(CAT(20), T1, { budgets: [{ currency: "EUR", budgetAmountMinor: 200 }] })],
    });

    await expect(push(intruder.spaceId, intruder.userId, {
      moneyAccounts: [account(ACC(20), T3, [{ currency: "EUR", openingBalanceMinor: 1 }])],
    })).rejects.toMatchObject({ apiCode: "ENTITY_BELONGS_TO_ANOTHER_SPACE" });
    await expect(push(intruder.spaceId, intruder.userId, {
      categories: [category(CAT(20), T3, { budgets: [{ currency: "EUR", budgetAmountMinor: 1 }] })],
    })).rejects.toMatchObject({ apiCode: "ENTITY_BELONGS_TO_ANOTHER_SPACE" });

    expect(await storedAccount(ACC(20))).toMatchObject({ updatedAt: T1, balances: ["EUR:200"] });
    expect((await storedBudgets(CAT(20))).map((b) => b.budgetAmountMinor)).toEqual(["200"]);
    const [cat] = await db.select({ spaceId: categories.spaceId }).from(categories).where(eq(categories.id, CAT(20)));
    expect(cat?.spaceId).toBe(owner.spaceId);
  });
});
