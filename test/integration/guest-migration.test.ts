import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { migrateGuest, type GuestPayload } from "../../src/services/guest-migration";
import { categories, categoryBudgets, guestEntityLinks, spaces, transactions } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

const db = testDb();
const NOW = "2026-08-29T10:00:00.000Z";

afterAll(cleanupTestUsers);

async function bootstrapped(label: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  const result = await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  return { userId, personalSpaceId: result.personalSpace.id };
}

function payload(overrides: Partial<GuestPayload> = {}): GuestPayload {
  return {
    batchId: `batch-${Math.random().toString(36).slice(2)}`,
    installationId: `install-${Math.random().toString(36).slice(2)}`,
    spaces: [{ id: "personal", name: "Personal", type: "personal", currency: "EUR" }],
    categories: [],
    moneyAccounts: [],
    recurringSeries: [],
    transactions: [],
    ...overrides,
  };
}

const guestCategory = {
  id: "local-groceries",
  spaceId: "personal",
  name: "Supermercado",
  icon: "shopping-cart",
  colorToken: "orange",
  budgetMinor: null,
  isDefault: true,
  // Misma clave que siembra el bootstrap: el índice único la rechazaría si se
  // insertara de nuevo en lugar de reutilizarse.
  templateKey: "groceries",
  sourceCategoryId: null,
  isArchived: false,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

describe("guest migration against PostgreSQL", () => {
  it("reuses the seeded category instead of colliding with its template key", async () => {
    const { userId, personalSpaceId } = await bootstrapped("guest-reuse");

    const result = await migrateGuest(
      db,
      userId,
      payload({
        categories: [guestCategory],
        transactions: [
          {
            id: "local-tx-1",
            spaceId: "personal",
            categoryId: "local-groceries",
            moneyAccountId: null,
            type: "expense",
            amountMinor: 1250,
            currency: "EUR",
            title: "Café",
            occurredOn: "2026-08-20",
            note: "Con Ana",
            recurrence: "custom",
            recurrenceGroupId: "group-9",
            recurrenceSeriesId: null,
            sourceTransactionId: "local-source-3",
            isArchived: false,
            createdAt: NOW,
            updatedAt: NOW,
            archivedAt: null,
          },
        ],
      }),
    );

    expect(result).toMatchObject({ categoryCount: 1, transactionCount: 1, moneyAccountCount: 0 });

    // Sigue habiendo 18 categorías: la del invitado se fusionó con la sembrada.
    const stored = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.spaceId, personalSpaceId));
    expect(stored).toHaveLength(18);

    const [tx] = await db
      .select({
        note: transactions.note,
        recurrence: transactions.recurrence,
        recurrenceGroupId: transactions.recurrenceGroupId,
        sourceLocalTransactionId: transactions.sourceLocalTransactionId,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(eq(transactions.spaceId, personalSpaceId));

    expect(tx).toMatchObject({
      note: "Con Ana",
      recurrence: "custom",
      recurrenceGroupId: "group-9",
      sourceLocalTransactionId: "local-source-3",
    });

    const [seededGroceries] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.spaceId, personalSpaceId), eq(categories.templateKey, "groceries")),
      );
    expect(tx?.categoryId).toBe(seededGroceries?.id);

    const links = await db
      .select({ entityType: guestEntityLinks.entityType, localId: guestEntityLinks.localId })
      .from(guestEntityLinks)
      .where(eq(guestEntityLinks.userId, userId));
    expect(links).toContainEqual({ entityType: "category", localId: "local-groceries" });
  });

  it("returns the same counts when the batch is replayed", async () => {
    const { userId, personalSpaceId } = await bootstrapped("guest-replay");
    const batch = payload({ categories: [guestCategory] });

    const first = await migrateGuest(db, userId, batch);
    const second = await migrateGuest(db, userId, batch);

    expect(second).toEqual(first);
    const stored = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.spaceId, personalSpaceId));
    expect(stored).toHaveLength(18);
  });

  it("stores the budget in the currency of its own space", async () => {
    const { userId } = await bootstrapped("guest-budget");

    await migrateGuest(
      db,
      userId,
      payload({
        spaces: [
          { id: "personal", name: "Personal", type: "personal", currency: "EUR" },
          { id: "trip", name: "Viaje", type: "other", currency: "USD" },
        ],
        categories: [
          {
            ...guestCategory,
            id: "local-usd",
            spaceId: "trip",
            templateKey: null,
            budgetMinor: 50000,
          },
        ],
      }),
    );

    const [budget] = await db
      .select({ currency: categoryBudgets.currency, amount: categoryBudgets.budgetAmountMinor })
      .from(categoryBudgets)
      .innerJoin(categories, eq(categoryBudgets.categoryId, categories.id))
      .innerJoin(spaces, eq(categories.spaceId, spaces.id))
      .where(eq(spaces.createdBy, userId));

    // Antes se leía `category.currency`, un campo que el cliente nunca envía,
    // así que todo acababa guardado como EUR.
    expect(budget).toMatchObject({ currency: "USD", amount: 50000n });
  });

  it("imports a local couple space as `other` so it never takes the shared slot", async () => {
    const { userId } = await bootstrapped("guest-couple");

    await migrateGuest(
      db,
      userId,
      payload({
        spaces: [
          { id: "personal", name: "Personal", type: "personal", currency: "EUR" },
          { id: "duo", name: "Juntos local", type: "couple", currency: "EUR" },
        ],
      }),
    );

    const imported = await db
      .select({ type: spaces.type, sourceLocalId: spaces.sourceLocalId })
      .from(spaces)
      .where(and(eq(spaces.createdBy, userId), eq(spaces.sourceLocalId, "duo")));
    expect(imported[0]?.type).toBe("other");
  });

  it("refuses a payload from an account that never bootstrapped", async () => {
    const userId = await createTestUser(db, "guest-nobootstrap");

    await expect(migrateGuest(db, userId, payload())).rejects.toThrow("BOOTSTRAP_REQUIRED");
  });
});
