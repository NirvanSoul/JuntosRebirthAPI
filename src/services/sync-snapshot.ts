import { activeSpaceScope } from "./active-space-scope";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
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
  activeFinancialContextId: string | null;
  /**
   * Reloj de la base en el momento de leer, en ISO 8601. Es el cursor que el
   * cliente devuelve en `GET /v1/sync/changes?since=`.
   */
  serverTime: string;
  spaces: SnapshotSpace[];
  members: SnapshotMember[];
  categories: SnapshotCategory[];
  moneyAccounts: SnapshotMoneyAccount[];
  recurringSeries: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
};

/** Cambios desde un cursor. Los espacios viajan siempre completos. */
export type Changes = Omit<Snapshot, "members">;

/**
 * Ventana que se resta al cursor al leer cambios. Una fila cuyo
 * `server_updated_at` se fijó dentro de una transacción aún no confirmada
 * cuando otro cliente leyó su cursor quedaría fuera para siempre sin este
 * solape; repetir filas es inocuo porque el cliente las aplica de forma
 * idempotente.
 */
export const CHANGES_OVERLAP_MS = 60_000;

type Memberships = {
  spaces: SnapshotSpace[];
  activeFinancialContextId: string | null;
  serverTime: string;
};

async function readMemberships(db: Database, userId: string): Promise<Memberships> {
  const rows = await db
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
      activeFinancialContextId: userProfiles.activeFinancialContextId,
      // El cursor y `server_updated_at` deben salir del mismo reloj: el de la
      // base, no el del Worker.
      serverTime: sql<string>`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
    .leftJoin(userProfiles, eq(userProfiles.userId, spaceMembers.userId))
    .where(
      and(
        eq(spaceMembers.userId, userId),
        eq(spaceMembers.status, "active"),
        isNull(spaces.archivedAt),
        activeSpaceScope(),
        sql`(
          ${spaces.type} <> 'couple'
          OR ${spaces.activatedAt} IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM space_invitations
            WHERE space_invitations.space_id = ${spaces.id}
              AND space_invitations.status = 'pending'
          )
        )`,
      ),
    );

  return {
    spaces: rows.map(
      ({ activeFinancialContextId: _activeFinancialContextId, serverTime: _serverTime, ...space }) => space,
    ),
    activeFinancialContextId: rows[0]?.activeFinancialContextId ?? null,
    // Sin espacios no hay filas que perder: vale el reloj del Worker.
    serverTime: rows[0]?.serverTime ?? new Date().toISOString(),
  };
}

async function readDeltaCollections(db: Database, spaceIds: string[], since: Date) {
  const [categoryRows, accountRows, seriesRows, transactionRows] = await Promise.all([
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
      .where(and(inArray(categories.spaceId, spaceIds), gt(categories.serverUpdatedAt, since))),
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
      .where(and(inArray(moneyAccounts.spaceId, spaceIds), gt(moneyAccounts.serverUpdatedAt, since))),
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
      .where(and(inArray(recurringTransactionSeries.spaceId, spaceIds), gt(recurringTransactionSeries.serverUpdatedAt, since))),
    db
      .select({
        id: transactions.id,
        spaceId: transactions.spaceId,
        categoryId: transactions.categoryId,
        moneyAccountId: transactions.moneyAccountId,
        type: transactions.type,
        amountMinor: transactions.amountMinor,
        accountingAmountMinorUsd: transactions.accountingAmountMinorUsd,
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
      .where(and(inArray(transactions.spaceId, spaceIds), gt(transactions.serverUpdatedAt, since))),
  ]);

  const categoryIds = categoryRows.map((row) => row.id);
  const accountIds = accountRows.map((row) => row.id);
  const transactionIds = transactionRows.map((row) => row.id);

  const [budgetRows, balanceRows, referenceRateRows] = await Promise.all([
    categoryIds.length > 0
      ? db
          .select({
            categoryId: categoryBudgets.categoryId,
            currency: categoryBudgets.currency,
            budgetAmountMinor: categoryBudgets.budgetAmountMinor,
          })
          .from(categoryBudgets)
          .innerJoin(categories, eq(categoryBudgets.categoryId, categories.id))
          .where(inArray(categoryBudgets.categoryId, categoryIds))
      : [],
    accountIds.length > 0
      ? db
          .select({
            moneyAccountId: moneyAccountBalances.moneyAccountId,
            currency: moneyAccountBalances.currency,
            openingBalanceMinor: moneyAccountBalances.openingBalanceMinor,
            displayOrder: moneyAccountBalances.displayOrder,
          })
          .from(moneyAccountBalances)
          .innerJoin(moneyAccounts, eq(moneyAccountBalances.moneyAccountId, moneyAccounts.id))
          .where(inArray(moneyAccountBalances.moneyAccountId, accountIds))
      : [],
    transactionIds.length > 0
      ? db
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
          .where(inArray(transactionReferenceRates.transactionId, transactionIds))
      : [],
  ]);

  return { categoryRows, budgetRows, accountRows, balanceRows, seriesRows, transactionRows, referenceRateRows };
}

type RawCollections = {
  categoryRows: any[];
  budgetRows: any[];
  accountRows: any[];
  balanceRows: any[];
  seriesRows: any[];
  transactionRows: any[];
  referenceRateRows: any[];
};

function shapeCollections(rows: RawCollections) {
  const { categoryRows, budgetRows, accountRows, balanceRows, seriesRows, transactionRows, referenceRateRows } = rows;

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
      accountingAmountMinorUsd: transaction.accountingAmountMinorUsd == null ? null : serializeMinorAmount(transaction.accountingAmountMinorUsd),
      exchangeSnapshot: exchangeSnapshotFromRows(ratesByTransaction.get(transaction.id), transaction.currency),
    })),
  };
}

const EMPTY_COLLECTIONS = { categories: [], moneyAccounts: [], recurringSeries: [], transactions: [] };

export async function buildSnapshot(db: Database, userId: string): Promise<Snapshot> {
  const memberships = await readMemberships(db, userId);
  const { spaces: memberSpaces, activeFinancialContextId, serverTime } = memberships;

  const spaceIds = memberSpaces.map((space) => space.id);
  if (spaceIds.length === 0) {
    return { activeFinancialContextId: null, serverTime, spaces: [], members: [], ...EMPTY_COLLECTIONS };
  }

  // Orden exacto de lecturas conservado para compatibilidad con mocks y tests unitarios.
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
          accountingAmountMinorUsd: transactions.accountingAmountMinorUsd,
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

  return {
    activeFinancialContextId,
    serverTime,
    spaces: memberSpaces,
    members: memberRows.map((row) => ({ ...row, displayName: row.displayName ?? "Usuario" })),
    ...shapeCollections({
      categoryRows,
      budgetRows,
      accountRows,
      balanceRows,
      seriesRows,
      transactionRows,
      referenceRateRows,
    }),
  };
}

/**
 * Filas cambiadas en el servidor desde `since` (menos el solape). Los
 * espacios van siempre completos: el cliente compara el conjunto y el contexto
 * con su cursor y pide un snapshot entero si difieren.
 */
export async function buildChanges(db: Database, userId: string, since: Date): Promise<Changes> {
  const { spaces: memberSpaces, activeFinancialContextId, serverTime } = await readMemberships(db, userId);

  const spaceIds = memberSpaces.map((space) => space.id);
  if (spaceIds.length === 0) {
    return { activeFinancialContextId: null, serverTime, spaces: [], ...EMPTY_COLLECTIONS };
  }

  const collections = await readDeltaCollections(
    db,
    spaceIds,
    new Date(since.getTime() - CHANGES_OVERLAP_MS),
  );

  return {
    activeFinancialContextId,
    serverTime,
    spaces: memberSpaces,
    ...shapeCollections(collections),
  };
}
