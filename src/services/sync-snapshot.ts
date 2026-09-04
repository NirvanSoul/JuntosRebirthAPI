import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { serializeMinorAmount } from "../lib/money";
import {
  categories,
  categoryBudgets,
  moneyAccountBalances,
  moneyAccounts,
  recurringTransactionSeries,
  spaceMembers,
  spaces,
  transactionReferenceRates,
  transactions,
  user,
  userProfiles,
} from "../db/schema";
import { exchangeSnapshotFromRows } from "./transactions";

/**
 * Estado remoto completo de la cuenta. Sustituye a `fetchRemoteAccountSnapshot`,
 * que hacía cinco lecturas PostgREST desde el cliente.
 *
 * Todo viaja en camelCase y los importes como string, igual que el resto de la
 * API, para no perder precisión en enteros de 64 bits.
 */
export type SnapshotSpace = {
  id: string;
  name: string;
  type: "personal" | "couple" | "other";
  currency: string;
  timezone: string;
  role: "owner" | "admin" | "member";
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SnapshotCategory = {
  id: string;
  spaceId: string;
  name: string;
  icon: string | null;
  colorToken: string | null;
  createdBy: string | null;
  isDefault: boolean;
  templateKey: string | null;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  budgets: { currency: string; budgetAmountMinor: string }[];
};

export type SnapshotMoneyAccount = {
  id: string;
  spaceId: string;
  name: string;
  kind: "cash" | "bank" | "card";
  icon: string | null;
  colorToken: string | null;
  primaryCurrency: string;
  createdBy: string | null;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  balances: { currency: string; openingBalanceMinor: string; displayOrder: number }[];
};

export type SnapshotMember = {
  spaceId: string;
  userId: string;
  displayName: string;
  image: string | null;
  avatarPath: string | null;
  avatarUpdatedAt: Date | null;
};

export type Snapshot = {
  spaces: SnapshotSpace[];
  members: SnapshotMember[];
  categories: SnapshotCategory[];
  moneyAccounts: SnapshotMoneyAccount[];
  recurringSeries: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
};

const EMPTY: Snapshot = {
  spaces: [],
  members: [],
  categories: [],
  moneyAccounts: [],
  recurringSeries: [],
  transactions: [],
};

export async function buildSnapshot(db: Database, userId: string): Promise<Snapshot> {
  const memberships = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      type: spaces.type,
      currency: spaces.currency,
      timezone: spaces.timezone,
      role: spaceMembers.role,
      activatedAt: spaces.activatedAt,
      createdAt: spaces.createdAt,
      updatedAt: spaces.updatedAt,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
    .where(
      and(
        eq(spaceMembers.userId, userId),
        eq(spaceMembers.status, "active"),
        isNull(spaces.archivedAt),
      ),
    );

  const spaceIds = memberships.map((space) => space.id);
  if (spaceIds.length === 0) return { ...EMPTY };

  const [memberRows, categoryRows, budgetRows, accountRows, balanceRows, seriesRows, transactionRows, referenceRateRows] =
    await Promise.all([
      db
        .select({
          spaceId: spaceMembers.spaceId,
          userId: spaceMembers.userId,
          displayName: userProfiles.displayName,
          image: user.image,
          avatarPath: userProfiles.avatarPath,
          avatarUpdatedAt: userProfiles.avatarUpdatedAt,
        })
        .from(spaceMembers)
        .innerJoin(user, eq(spaceMembers.userId, user.id))
        .leftJoin(userProfiles, eq(userProfiles.userId, user.id))
        .where(and(inArray(spaceMembers.spaceId, spaceIds), eq(spaceMembers.status, "active"))),
      db
        .select({
          id: categories.id,
          spaceId: categories.spaceId,
          name: categories.name,
          icon: categories.icon,
          colorToken: categories.colorToken,
          createdBy: categories.createdBy,
          isDefault: categories.isDefault,
          templateKey: categories.templateKey,
          isArchived: categories.isArchived,
          createdAt: categories.createdAt,
          updatedAt: categories.updatedAt,
          archivedAt: categories.archivedAt,
        })
        .from(categories)
        .where(inArray(categories.spaceId, spaceIds)),
      db
        .select({
          categoryId: categoryBudgets.categoryId,
          currency: categoryBudgets.currency,
          budgetAmountMinor: categoryBudgets.budgetAmountMinor,
        })
        .from(categoryBudgets)
        .innerJoin(categories, eq(categoryBudgets.categoryId, categories.id))
        .where(inArray(categories.spaceId, spaceIds)),
      db
        .select({
          id: moneyAccounts.id,
          spaceId: moneyAccounts.spaceId,
          name: moneyAccounts.name,
          kind: moneyAccounts.kind,
          icon: moneyAccounts.icon,
          colorToken: moneyAccounts.colorToken,
          primaryCurrency: moneyAccounts.primaryCurrency,
          createdBy: moneyAccounts.createdBy,
          isArchived: moneyAccounts.isArchived,
          createdAt: moneyAccounts.createdAt,
          updatedAt: moneyAccounts.updatedAt,
          archivedAt: moneyAccounts.archivedAt,
        })
        .from(moneyAccounts)
        .where(inArray(moneyAccounts.spaceId, spaceIds)),
      db
        .select({
          moneyAccountId: moneyAccountBalances.moneyAccountId,
          currency: moneyAccountBalances.currency,
          openingBalanceMinor: moneyAccountBalances.openingBalanceMinor,
          displayOrder: moneyAccountBalances.displayOrder,
        })
        .from(moneyAccountBalances)
        .innerJoin(moneyAccounts, eq(moneyAccountBalances.moneyAccountId, moneyAccounts.id))
        .where(inArray(moneyAccounts.spaceId, spaceIds)),
      db
        .select({
          id: recurringTransactionSeries.id,
          spaceId: recurringTransactionSeries.spaceId,
          categoryId: recurringTransactionSeries.categoryId,
          moneyAccountId: recurringTransactionSeries.moneyAccountId,
          type: recurringTransactionSeries.type,
          amountMinor: recurringTransactionSeries.amountMinor,
          currency: recurringTransactionSeries.currency,
          title: recurringTransactionSeries.title,
          frequency: recurringTransactionSeries.frequency,
          startsOn: recurringTransactionSeries.startsOn,
          nextOccurrenceOn: recurringTransactionSeries.nextOccurrenceOn,
          generatedOccurrences: recurringTransactionSeries.generatedOccurrences,
          createdBy: recurringTransactionSeries.createdBy,
          isArchived: recurringTransactionSeries.isArchived,
          createdAt: recurringTransactionSeries.createdAt,
          updatedAt: recurringTransactionSeries.updatedAt,
          archivedAt: recurringTransactionSeries.archivedAt,
        })
        .from(recurringTransactionSeries)
        .where(inArray(recurringTransactionSeries.spaceId, spaceIds)),
      db
        .select({
          id: transactions.id,
          spaceId: transactions.spaceId,
          categoryId: transactions.categoryId,
          moneyAccountId: transactions.moneyAccountId,
          type: transactions.type,
          amountMinor: transactions.amountMinor,
          currency: transactions.currency,
          title: transactions.title,
          occurredOn: transactions.occurredOn,
          note: transactions.note,
          createdBy: transactions.createdBy,
          recurrence: transactions.recurrence,
          recurrenceGroupId: transactions.recurrenceGroupId,
          recurrenceSeriesId: transactions.recurrenceSeriesId,
          sourceLocalTransactionId: transactions.sourceLocalTransactionId,
          isArchived: transactions.isArchived,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
          archivedAt: transactions.archivedAt,
        })
        .from(transactions)
        .where(inArray(transactions.spaceId, spaceIds)),
      db
        .select({
          transactionId: transactionReferenceRates.transactionId,
          rateSource: transactionReferenceRates.rateSource,
          displayCurrency: transactionReferenceRates.displayCurrency,
          referenceAsset: transactionReferenceRates.referenceAsset,
          rate: transactionReferenceRates.rate,
          convertedAmountMinor: transactionReferenceRates.convertedAmountMinor,
          observedAt: transactionReferenceRates.observedAt,
        })
        .from(transactionReferenceRates)
        .innerJoin(transactions, eq(transactionReferenceRates.transactionId, transactions.id))
        .where(inArray(transactions.spaceId, spaceIds)),
    ]);

  const budgetsByCategory = new Map<string, SnapshotCategory["budgets"]>();
  for (const budget of budgetRows) {
    const list = budgetsByCategory.get(budget.categoryId) ?? [];
    list.push({
      currency: budget.currency,
      budgetAmountMinor: serializeMinorAmount(budget.budgetAmountMinor),
    });
    budgetsByCategory.set(budget.categoryId, list);
  }

  const balancesByAccount = new Map<string, SnapshotMoneyAccount["balances"]>();
  for (const balance of balanceRows) {
    const list = balancesByAccount.get(balance.moneyAccountId) ?? [];
    list.push({
      currency: balance.currency,
      openingBalanceMinor: serializeMinorAmount(balance.openingBalanceMinor),
      displayOrder: balance.displayOrder,
    });
    balancesByAccount.set(balance.moneyAccountId, list);
  }
  for (const list of balancesByAccount.values()) {
    list.sort((left, right) => left.displayOrder - right.displayOrder);
  }

  const ratesByTransaction = new Map<string, typeof referenceRateRows>();
  for (const rate of referenceRateRows) {
    const list = ratesByTransaction.get(rate.transactionId);
    if (list) list.push(rate); else ratesByTransaction.set(rate.transactionId, [rate]);
  }

  return {
    spaces: memberships,
    members: memberRows.map((row) => ({ ...row, displayName: row.displayName ?? "Usuario" })),
    categories: categoryRows.map((category) => ({
      ...category,
      budgets: budgetsByCategory.get(category.id) ?? [],
    })),
    moneyAccounts: accountRows.map((account) => ({
      ...account,
      balances: balancesByAccount.get(account.id) ?? [],
    })),
    recurringSeries: seriesRows.map((series) => ({
      ...series,
      amountMinor: serializeMinorAmount(series.amountMinor),
    })),
    transactions: transactionRows.map((transaction) => ({
      ...transaction,
      amountMinor: serializeMinorAmount(transaction.amountMinor),
      exchangeSnapshot: exchangeSnapshotFromRows(ratesByTransaction.get(transaction.id), transaction.currency),
    })),
  };
}
