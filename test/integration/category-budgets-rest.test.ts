import { afterAll, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { syncSpaceData } from "../../src/services/space-sync";
import { buildChanges } from "../../src/services/sync-snapshot";
import { deleteCategoryBudget, upsertCategoryBudget } from "../../src/services/categories";
import { categories, categoryBudgets } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

/**
 * `PUT/DELETE /v1/spaces/:id/categories/:id/budgets/:currency` cambian la
 * categoría tanto como un push: deben salir por `/v1/sync/changes` y contar
 * como versión nueva frente a un push que llegue después con una versión vieja.
 */
const db = testDb();
const T0 = "2026-09-01T08:00:00.000Z";
const T1 = "2026-09-01T09:00:00.000Z";

afterAll(async () => {
  await cleanupTestUsers();
});

async function seededCategory(label: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  const space = await createSpaceWithOwner(db, userId, {
    name: "Juntos",
    type: "other",
    currency: "EUR",
    timezone: "Europe/Madrid",
  });
  const id = `cat-rest-${label}`;
  const row = (updatedAt: string, budgets: unknown[]) => ({
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
    budgets,
  });
  await syncSpaceData(db, space.id, userId, {
    installationId: "install-A",
    categories: [row(T1, [{ currency: "EUR", budgetAmountMinor: 10000, period: "week", anchorOn: "2026-09-01" }])],
    moneyAccounts: [],
    recurringSeries: [],
    transactions: [],
  });
  const [stored] = await db.select({ id: categories.id }).from(categories).where(eq(categories.spaceId, space.id));
  // Fuera de la ventana de solapamiento del cursor: solo debe volver a salir
  // si algo la cambia después.
  await db.execute(sql`UPDATE categories SET server_updated_at = now() - interval '10 minutes' WHERE id = ${stored!.id}`);
  return { userId, spaceId: space.id, categoryId: stored!.id, row };
}

async function budgetsOf(categoryId: string) {
  return db
    .select({ currency: categoryBudgets.currency, amount: categoryBudgets.budgetAmountMinor, period: categoryBudgets.period })
    .from(categoryBudgets)
    .where(eq(categoryBudgets.categoryId, categoryId))
    .orderBy(asc(categoryBudgets.currency));
}

describe("category budget REST writes", () => {
  it("publishes a PUT through /changes with a newer version and keeps the schedule", async () => {
    const { userId, categoryId } = await seededCategory("put");
    const cursor = new Date();

    await upsertCategoryBudget(db, { categoryId, userId, currency: "EUR", budgetAmountMinor: 25000n });

    const changes = await buildChanges(db, userId, cursor);
    const published = changes.categories.find((category) => category.id === categoryId);
    expect(published).toBeDefined();
    expect(published!.updatedAt.getTime()).toBeGreaterThan(Date.parse(T1));
    expect(await budgetsOf(categoryId)).toEqual([{ currency: "EUR", amount: 25000n, period: "week" }]);
  });

  it("publishes a DELETE through /changes", async () => {
    const { userId, categoryId } = await seededCategory("delete");
    const cursor = new Date();

    await deleteCategoryBudget(db, categoryId, "EUR");

    const changes = await buildChanges(db, userId, cursor);
    expect(changes.categories.some((category) => category.id === categoryId)).toBe(true);
    expect(await budgetsOf(categoryId)).toEqual([]);
  });

  it("does not let a push of the version before the PUT overwrite it", async () => {
    const { userId, spaceId, categoryId, row } = await seededCategory("stale");

    await upsertCategoryBudget(db, { categoryId, userId, currency: "USD", budgetAmountMinor: 5000n });
    const result = await syncSpaceData(db, spaceId, userId, {
      installationId: "install-B",
      categories: [{ ...row(T1, [{ currency: "EUR", budgetAmountMinor: 1 }]), id: "cat-local-B", remoteId: categoryId }],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });

    expect(result.conflicts?.map((conflict) => conflict.reason)).toEqual(["NEWER_VERSION"]);
    expect(await budgetsOf(categoryId)).toEqual([
      { currency: "EUR", amount: 10000n, period: "week" },
      { currency: "USD", amount: 5000n, period: "month" },
    ]);
  });
});
