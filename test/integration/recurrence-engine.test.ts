import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser, updateProfile } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { createMoneyAccountWithBalances } from "../../src/services/money-accounts";
import { createSeries, listSeries } from "../../src/services/recurring-transactions";
import { updateCategory } from "../../src/services/categories";
import { runRecurrences } from "../../src/services/recurrence-engine";
import {
  categories,
  exchangeRateSnapshots,
  recurringTransactionOccurrences,
  recurringTransactionSeries,
  transactionReferenceRates,
  transactions,
} from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, databaseUrlForEngine, testDb } from "./harness";

const db = testDb();

const seededRateIds: string[] = [];
afterAll(async () => {
  await cleanupTestUsers();
  if (seededRateIds.length) {
    await db.delete(transactionReferenceRates).where(inArray(transactionReferenceRates.rateSnapshotId, seededRateIds));
    await db.delete(exchangeRateSnapshots).where(inArray(exchangeRateSnapshots.id, seededRateIds));
  }
});

async function workspace(label: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  const space = await createSpaceWithOwner(db, userId, {
    name: "Recurrencias",
    type: "other",
    currency: "EUR",
    timezone: "Europe/Madrid",
  });
  const [category] = await db
    .insert(categories)
    .values({
      spaceId: space.id,
      name: "Vivienda",
      icon: "home",
      colorToken: "blue",
      templateKey: "housing",
      createdBy: userId,
    })
    .returning({ id: categories.id });
  return { userId, spaceId: space.id, categoryId: category!.id };
}

function movementsOf(spaceId: string) {
  return db
    .select({ id: transactions.id, occurredOn: transactions.occurredOn, recurrence: transactions.recurrence })
    .from(transactions)
    .where(eq(transactions.spaceId, spaceId));
}

describe("recurrence engine against PostgreSQL", () => {
  it("catches up a monthly series and stops at today", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-monthly");
    await createSeries(db, {
      spaceId,
      userId,
      categoryId,
      moneyAccountId: null,
      type: "expense",
      amountMinor: 90000n,
      currency: "EUR",
      title: "Alquiler",
      frequency: "monthly",
      startsOn: "2026-05-15",
    });

    const summary = await runRecurrences(
      databaseUrlForEngine(),
      new Date("2026-08-20T10:00:00.000Z"),
      [spaceId],
    );

    // Mayo, junio, julio y agosto: cuatro ocurrencias hasta el 20 de agosto.
    expect(summary.generatedTransactions).toBe(4);
    expect(summary.errors).toBe(0);
    expect(summary.invalidSeries).toBe(0);

    const rows = await movementsOf(spaceId);
    expect(rows.map((row) => row.occurredOn).sort()).toEqual([
      "2026-05-15",
      "2026-06-15",
      "2026-07-15",
      "2026-08-15",
    ]);
    // El movimiento generado hereda la cadencia de su serie.
    expect(rows[0]?.recurrence).toBe("monthly");
  });

  it("is idempotent: a second run on the same day generates nothing", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-idem");
    await createSeries(db, {
      spaceId,
      userId,
      categoryId,
      moneyAccountId: null,
      type: "expense",
      amountMinor: 1000n,
      currency: "EUR",
      title: "Semanal",
      frequency: "weekly",
      startsOn: "2026-08-01",
    });

    const now = new Date("2026-08-20T10:00:00.000Z");
    const first = await runRecurrences(databaseUrlForEngine(), now, [spaceId]);
    const second = await runRecurrences(databaseUrlForEngine(), now, [spaceId]);

    expect(first.generatedTransactions).toBeGreaterThan(0);
    expect(second.generatedTransactions).toBe(0);
    expect(await movementsOf(spaceId)).toHaveLength(first.generatedTransactions);
  });

  it("flags a series whose category was archived instead of retrying it forever", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-invalid");
    await createSeries(db, {
      spaceId,
      userId,
      categoryId,
      moneyAccountId: null,
      type: "expense",
      amountMinor: 1000n,
      currency: "EUR",
      title: "Huérfana",
      frequency: "monthly",
      startsOn: "2026-06-01",
    });
    await updateCategory(db, { spaceId, categoryId, isArchived: true });

    const summary = await runRecurrences(
      databaseUrlForEngine(),
      new Date("2026-08-20T10:00:00.000Z"),
      [spaceId],
    );

    // Antes salía en silencio: la serie se atascaba y se reintentaba cada hora.
    expect(summary.generatedTransactions).toBe(0);
    expect(summary.invalidSeries).toBe(1);
    expect(summary.errors).toBe(0);
    expect(await movementsOf(spaceId)).toHaveLength(0);
  });

  it("walks the custom dates one by one and marks each occurrence generated", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-custom");
    const series = await createSeries(db, {
      spaceId,
      userId,
      categoryId,
      moneyAccountId: null,
      type: "income",
      amountMinor: 5000n,
      currency: "EUR",
      title: "Extras",
      frequency: "custom",
      startsOn: "2026-08-05",
      customDates: ["2026-08-05", "2026-08-12", "2026-09-30"],
    });

    const summary = await runRecurrences(
      databaseUrlForEngine(),
      new Date("2026-08-20T10:00:00.000Z"),
      [spaceId],
    );

    // La fecha de septiembre todavía no ha llegado.
    expect(summary.generatedTransactions).toBe(2);
    const rows = await movementsOf(spaceId);
    expect(rows.map((row) => row.occurredOn).sort()).toEqual(["2026-08-05", "2026-08-12"]);
    expect(rows[0]?.recurrence).toBe("custom");

    const occurrences = await db
      .select({ scheduledOn: recurringTransactionOccurrences.scheduledOn, status: recurringTransactionOccurrences.status })
      .from(recurringTransactionOccurrences)
      .where(eq(recurringTransactionOccurrences.seriesId, series.id));
    const byDate = Object.fromEntries(occurrences.map((o) => [o.scheduledOn, o.status]));
    expect(byDate).toEqual({
      "2026-08-05": "generated",
      "2026-08-12": "generated",
      "2026-09-30": "pending",
    });
  });

  it("refuses to generate when the account has no balance in the series currency", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-currency");
    const account = await createMoneyAccountWithBalances(db, {
      spaceId,
      userId,
      name: "Solo euros",
      kind: "bank",
      icon: null,
      colorToken: null,
      primaryCurrency: "EUR",
      balances: [{ currency: "EUR", openingBalanceMinor: 0n, displayOrder: 0 }],
    });
    await createSeries(db, {
      spaceId,
      userId,
      categoryId,
      moneyAccountId: account.id,
      type: "expense",
      amountMinor: 1000n,
      currency: "USD",
      title: "Suscripción en dólares",
      frequency: "monthly",
      startsOn: "2026-07-01",
    });

    const summary = await runRecurrences(
      databaseUrlForEngine(),
      new Date("2026-08-20T10:00:00.000Z"),
      [spaceId],
    );

    expect(summary.generatedTransactions).toBe(0);
    expect(summary.invalidSeries).toBe(1);
  });
});

describe("recurring series listing", () => {
  it("exposes generatedOccurrences so the client knows how far the series ran", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-listing");
    await createSeries(db, {
      spaceId,
      userId,
      categoryId,
      moneyAccountId: null,
      type: "expense",
      amountMinor: 1000n,
      currency: "EUR",
      title: "Listada",
      frequency: "monthly",
      startsOn: "2026-06-01",
    });
    await runRecurrences(databaseUrlForEngine(), new Date("2026-08-20T10:00:00.000Z"), [spaceId]);

    const [listed] = await listSeries(db, spaceId);

    // El snapshot ya lo devolvía; el listado granular lo omitía.
    expect(listed?.generatedOccurrences).toBe(3);
  });
});

describe("recurrence engine when the occurrence already exists", () => {
  const monthly = (spaceId: string, userId: string, categoryId: string) =>
    createSeries(db, {
      spaceId, userId, categoryId, moneyAccountId: null, type: "expense", amountMinor: 1000n,
      currency: "EUR", title: "Mensual", frequency: "monthly", startsOn: "2026-05-15",
    });
  const now = new Date("2026-08-20T10:00:00.000Z");

  async function seriesState(id: string) {
    const [row] = await db
      .select({ generated: recurringTransactionSeries.generatedOccurrences, next: recurringTransactionSeries.nextOccurrenceOn })
      .from(recurringTransactionSeries)
      .where(eq(recurringTransactionSeries.id, id));
    return row;
  }

  it("advances past an occurrence a device already uploaded instead of failing every run", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-uploaded");
    const series = await monthly(spaceId, userId, categoryId);
    // La app materializó junio sin conexión y lo subió antes que el motor.
    await db.insert(transactions).values({
      spaceId, categoryId, createdBy: userId, type: "expense", amountMinor: 1000n, currency: "EUR",
      title: "Mensual", occurredOn: "2026-06-15", recurrence: "monthly", recurrenceSeriesId: series.id,
    });

    const first = await runRecurrences(databaseUrlForEngine(), now, [spaceId]);
    const second = await runRecurrences(databaseUrlForEngine(), now, [spaceId]);

    expect(first.errors).toBe(0);
    expect(second.errors).toBe(0);
    expect((await movementsOf(spaceId)).map((row) => row.occurredOn).sort()).toEqual([
      "2026-05-15", "2026-06-15", "2026-07-15", "2026-08-15",
    ]);
    expect(await seriesState(series.id)).toEqual({ generated: 4, next: "2026-09-15" });
  });

  it("recovers when a push rewinds the series counter", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-rewound");
    const series = await monthly(spaceId, userId, categoryId);
    await runRecurrences(databaseUrlForEngine(), now, [spaceId]);
    // Un dispositivo con una copia vieja de la serie la vuelve a subir.
    await db.execute(sql`UPDATE recurring_transaction_series SET generated_occurrences = 1, next_occurrence_on = '2026-06-15' WHERE id = ${series.id}`);

    const summary = await runRecurrences(databaseUrlForEngine(), now, [spaceId]);

    expect(summary.errors).toBe(0);
    expect(await movementsOf(spaceId)).toHaveLength(4);
    expect(await seriesState(series.id)).toEqual({ generated: 4, next: "2026-09-15" });
  });

  it("links a custom occurrence to the movement that already exists", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-custom-uploaded");
    const series = await createSeries(db, {
      spaceId, userId, categoryId, moneyAccountId: null, type: "income", amountMinor: 5000n, currency: "EUR",
      title: "Extras", frequency: "custom", startsOn: "2026-08-05", customDates: ["2026-08-05", "2026-08-12"],
    });
    const [uploaded] = await db.insert(transactions).values({
      spaceId, categoryId, createdBy: userId, type: "income", amountMinor: 5000n, currency: "EUR",
      title: "Extras", occurredOn: "2026-08-12", recurrence: "custom", recurrenceSeriesId: series.id,
    }).returning({ id: transactions.id });

    const summary = await runRecurrences(databaseUrlForEngine(), now, [spaceId]);

    expect(summary.errors).toBe(0);
    expect(await movementsOf(spaceId)).toHaveLength(2);
    const [occurrence] = await db
      .select({ status: recurringTransactionOccurrences.status, generatedTransactionId: recurringTransactionOccurrences.generatedTransactionId })
      .from(recurringTransactionOccurrences)
      .where(and(eq(recurringTransactionOccurrences.seriesId, series.id), eq(recurringTransactionOccurrences.scheduledOn, "2026-08-12")));
    expect(occurrence).toEqual({ status: "generated", generatedTransactionId: uploaded!.id });
    expect((await seriesState(series.id))?.next).toBeNull();
  });
});

describe("recurrence engine repairs series left stuck by earlier versions", () => {
  it("moves a custom series off an occurrence that was already generated", async () => {
    const { userId, spaceId, categoryId } = await workspace("rec-stuck-custom");
    const series = await createSeries(db, {
      spaceId, userId, categoryId, moneyAccountId: null, type: "income", amountMinor: 5000n, currency: "EUR",
      title: "Extras", frequency: "custom", startsOn: "2026-08-05", customDates: ["2026-08-05", "2026-08-12", "2026-09-30"],
    });
    await runRecurrences(databaseUrlForEngine(), new Date("2026-08-20T10:00:00.000Z"), [spaceId]);
    // Lo que dejaba la carrera de la ruta de ocurrencias: la serie apunta a
    // una fecha ya generada y el motor no volvía a avanzarla.
    await db.execute(sql`UPDATE recurring_transaction_series SET next_occurrence_on = '2026-08-05' WHERE id = ${series.id}`);

    const summary = await runRecurrences(databaseUrlForEngine(), new Date("2026-10-01T10:00:00.000Z"), [spaceId]);

    expect(summary.errors).toBe(0);
    expect(summary.generatedTransactions).toBe(1);
    expect((await movementsOf(spaceId)).map((row) => row.occurredOn).sort()).toEqual(["2026-08-05", "2026-08-12", "2026-09-30"]);
    const [row] = await db.select({ next: recurringTransactionSeries.nextOccurrenceOn }).from(recurringTransactionSeries).where(eq(recurringTransactionSeries.id, series.id));
    expect(row?.next).toBeNull();
  });
});

describe("recurrence engine in Venezuela", () => {
  async function venezuelaWorkspace(label: string) {
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
    const space = await createSpaceWithOwner(db, userId, { name: "Recurrencias VE", type: "other", currency: "USD", timezone: "America/Caracas" });
    const [category] = await db.insert(categories).values({ spaceId: space.id, name: "Servicios", createdBy: userId }).returning({ id: categories.id });
    return { userId, spaceId: space.id, categoryId: category!.id };
  }

  async function generated(spaceId: string) {
    const rows = await db
      .select({ id: transactions.id, amountMinor: transactions.amountMinor, usd: transactions.accountingAmountMinorUsd })
      .from(transactions)
      .where(eq(transactions.spaceId, spaceId));
    const rates = rows.length
      ? await db.select({ transactionId: transactionReferenceRates.transactionId }).from(transactionReferenceRates).where(inArray(transactionReferenceRates.transactionId, rows.map((row) => row.id)))
      : [];
    return rows.map((row) => ({ amountMinor: row.amountMinor, usd: row.usd, rates: rates.filter((rate) => rate.transactionId === row.id).length }));
  }

  it("freezes the USD equivalent and the rates of each generated VES movement", async () => {
    const { userId, spaceId, categoryId } = await venezuelaWorkspace("rec-ve-ves");
    await createSeries(db, {
      spaceId, userId, categoryId, moneyAccountId: null, type: "expense", amountMinor: 40_000n,
      currency: "VES", title: "Internet", frequency: "monthly", startsOn: "2026-07-01",
    });

    const summary = await runRecurrences(databaseUrlForEngine(), new Date("2026-08-20T15:00:00.000Z"), [spaceId]);

    expect(summary.errors).toBe(0);
    const rows = await generated(spaceId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.usd).toBe(1_000n);
      expect(row.rates).toBeGreaterThan(0);
    }
  });

  it("books a generated USD movement at its own amount", async () => {
    const { userId, spaceId, categoryId } = await venezuelaWorkspace("rec-ve-usd");
    await createSeries(db, {
      spaceId, userId, categoryId, moneyAccountId: null, type: "expense", amountMinor: 2_500n,
      currency: "USD", title: "Streaming", frequency: "monthly", startsOn: "2026-08-01",
    });

    await runRecurrences(databaseUrlForEngine(), new Date("2026-08-20T15:00:00.000Z"), [spaceId]);

    const rows = await generated(spaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usd).toBe(2_500n);
    expect(rows[0]!.rates).toBeGreaterThan(0);
  });
});
