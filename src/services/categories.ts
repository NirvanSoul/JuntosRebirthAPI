import { and, asc, eq, isNull, isNotNull } from "drizzle-orm";
import { type Database } from "../db/client";
import { categoryBudgets, categories, recurringTransactionSeries } from "../db/schema";
import { serializeMinorAmount } from "../lib/money";

export type CategoryBudgetResponse = {
  currency: string;
  budgetAmountMinor: string;
};

export type CategoryResponse = {
  id: string;
  name: string;
  icon: string | null;
  colorToken: string | null;
  isDefault: boolean;
  templateKey: string | null;
  isArchived: boolean;
  createdAt: Date;
  budgets: CategoryBudgetResponse[];
};

export async function listCategories(
  db: Database,
  spaceId: string,
): Promise<CategoryResponse[]> {
  const rows = await buildCategoryListQuery(db, spaceId);

  const categoryMap = new Map<string, CategoryResponse>();

  for (const row of rows) {
    let category = categoryMap.get(row.id);

    if (!category) {
      category = {
        id: row.id,
        name: row.name,
        icon: row.icon,
        colorToken: row.colorToken,
        isDefault: row.isDefault,
        templateKey: row.templateKey,
        isArchived: row.isArchived,
        createdAt: row.createdAt,
        budgets: [],
      };
      categoryMap.set(row.id, category);
    }

    if (row.budgetCurrency && row.budgetAmountMinor !== null) {
      category.budgets.push({
        currency: row.budgetCurrency,
        budgetAmountMinor: serializeMinorAmount(row.budgetAmountMinor),
      });
    }
  }

  return [...categoryMap.values()];
}

export function buildCategoryListQuery(db: Database, spaceId: string) {
  return db
    .select({
      id: categories.id,
      name: categories.name,
      icon: categories.icon,
      colorToken: categories.colorToken,
      isDefault: categories.isDefault,
      templateKey: categories.templateKey,
      isArchived: categories.isArchived,
      createdAt: categories.createdAt,
      budgetCurrency: categoryBudgets.currency,
      budgetAmountMinor: categoryBudgets.budgetAmountMinor,
    })
    .from(categories)
    .leftJoin(categoryBudgets, eq(categoryBudgets.categoryId, categories.id))
    .where(
      and(
        eq(categories.spaceId, spaceId),
        eq(categories.isArchived, false),
        isNull(categories.archivedAt),
      ),
    )
    .orderBy(asc(categories.name));
}

/**
 * Presupuestos de una categoría, sin filtrar por archivado. El PATCH los
 * necesita para no devolver `budgets: []` y hacer que un cliente que fusione la
 * respuesta se quede sin presupuestos.
 */
export async function findCategoryBudgets(
  db: Database,
  categoryId: string,
): Promise<CategoryBudgetResponse[]> {
  const rows = await db
    .select({
      currency: categoryBudgets.currency,
      budgetAmountMinor: categoryBudgets.budgetAmountMinor,
    })
    .from(categoryBudgets)
    .where(eq(categoryBudgets.categoryId, categoryId));

  return rows.map((row) => ({
    currency: row.currency,
    budgetAmountMinor: serializeMinorAmount(row.budgetAmountMinor),
  }));
}

export async function findCategoryInSpace(
  db: Database,
  spaceId: string,
  categoryId: string,
) {
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.spaceId, spaceId)));

  return category ?? null;
}

export async function createCategory(
  db: Database,
  input: {
    spaceId: string;
    userId: string;
    name: string;
    icon: string | null;
    colorToken: string | null;
  },
): Promise<CategoryResponse> {
  const [category] = await db
    .insert(categories)
    .values({
      spaceId: input.spaceId,
      name: input.name,
      icon: input.icon,
      colorToken: input.colorToken,
      createdBy: input.userId,
    })
    .returning({
      id: categories.id,
      name: categories.name,
      icon: categories.icon,
      colorToken: categories.colorToken,
      isDefault: categories.isDefault,
      templateKey: categories.templateKey,
      isArchived: categories.isArchived,
      createdAt: categories.createdAt,
    });

  return { ...category, budgets: [] };
}

export async function updateCategory(
  db: Database,
  input: {
    spaceId: string;
    categoryId: string;
    name?: string;
    icon?: string | null;
    colorToken?: string | null;
    isArchived?: boolean;
  },
) {
  const values: {
    name?: string;
    icon?: string | null;
    colorToken?: string | null;
    isArchived?: boolean;
    archivedAt?: Date | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (input.name !== undefined) values.name = input.name;
  if (input.icon !== undefined) values.icon = input.icon;
  if (input.colorToken !== undefined) values.colorToken = input.colorToken;
  if (input.isArchived !== undefined) {
    values.isArchived = input.isArchived;
    values.archivedAt = input.isArchived ? new Date() : null;
  }

  const [category] = await db
    .update(categories)
    .set(values)
    .where(and(eq(categories.id, input.categoryId), eq(categories.spaceId, input.spaceId)))
    .returning({
      id: categories.id,
      name: categories.name,
      icon: categories.icon,
      colorToken: categories.colorToken,
      isDefault: categories.isDefault,
      templateKey: categories.templateKey,
      isArchived: categories.isArchived,
      createdAt: categories.createdAt,
    });

  return category ? { ...category, budgets: [] } : null;
}

export async function upsertCategoryBudget(
  db: Database,
  input: {
    categoryId: string;
    userId: string;
    currency: string;
    budgetAmountMinor: bigint;
  },
) {
  const [budget] = await db
    .insert(categoryBudgets)
    .values({
      categoryId: input.categoryId,
      currency: input.currency,
      budgetAmountMinor: input.budgetAmountMinor,
      createdBy: input.userId,
    })
    .onConflictDoUpdate({
      target: [categoryBudgets.categoryId, categoryBudgets.currency],
      set: {
        budgetAmountMinor: input.budgetAmountMinor,
        updatedAt: new Date(),
      },
    })
    .returning({
      currency: categoryBudgets.currency,
      budgetAmountMinor: categoryBudgets.budgetAmountMinor,
    });

  return {
    currency: budget.currency,
    budgetAmountMinor: serializeMinorAmount(budget.budgetAmountMinor),
  };
}

export async function deleteCategoryBudget(
  db: Database,
  categoryId: string,
  currency: string,
) {
  await db
    .delete(categoryBudgets)
    .where(
      and(
        eq(categoryBudgets.categoryId, categoryId),
        eq(categoryBudgets.currency, currency),
      ),
    );
}

export async function categoryHasFutureRecurringSeries(db: Database, spaceId: string, categoryId: string) {
  const [row] = await db.select({ id: recurringTransactionSeries.id }).from(recurringTransactionSeries).where(and(
    eq(recurringTransactionSeries.spaceId, spaceId), eq(recurringTransactionSeries.categoryId, categoryId),
    eq(recurringTransactionSeries.isArchived, false), isNull(recurringTransactionSeries.archivedAt),
    isNotNull(recurringTransactionSeries.nextOccurrenceOn),
  )).limit(1);
  return Boolean(row);
}
