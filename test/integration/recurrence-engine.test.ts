import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { createMoneyAccountWithBalances } from "../../src/services/money-accounts";
import { createSeries, listSeries } from "../../src/services/recurring-transactions";
import { updateCategory } from "../../src/services/categories";
import { runRecurrences } from "../../src/services/recurrence-engine";
import { categories, recurringTransactionOccurrences, transactions } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, databaseUrlForEngine, testDb } from "./harness";

const db = testDb();

afterAll(cleanupTestUsers);

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
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.spaceId, space.id), eq(categories.templateKey, "housing")));
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
