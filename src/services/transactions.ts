import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { categories, moneyAccountBalances, moneyAccounts, transactions } from "../db/schema";
import { serializeMinorAmount } from "../lib/money";

export type TransactionResponse = {
  id: string; type: "expense" | "income"; amountMinor: string; currency: string;
  title: string; occurredOn: string; categoryId: string; moneyAccountId: string | null;
  recurrenceSeriesId: string | null; createdAt: Date; updatedAt: Date;
};
export type TransactionCursor = { occurredOn: string; createdAt: string; id: string };

function selectFields() {
  return { id: transactions.id, type: transactions.type, amountMinor: transactions.amountMinor,
    currency: transactions.currency, title: transactions.title, occurredOn: transactions.occurredOn,
    categoryId: transactions.categoryId, moneyAccountId: transactions.moneyAccountId,
    recurrenceSeriesId: transactions.recurrenceSeriesId, createdAt: transactions.createdAt, updatedAt: transactions.updatedAt };
}
function serialize(row: Omit<TransactionResponse, "amountMinor"> & { amountMinor: bigint }): TransactionResponse {
  return { ...row, amountMinor: serializeMinorAmount(row.amountMinor) };
}

export async function listTransactions(db: Database, spaceId: string, limit: number, cursor: TransactionCursor | null) {
  const base = [eq(transactions.spaceId, spaceId), eq(transactions.isArchived, false), isNull(transactions.archivedAt)];
  if (cursor) base.push(or(
    lt(transactions.occurredOn, cursor.occurredOn),
    and(eq(transactions.occurredOn, cursor.occurredOn), lt(transactions.createdAt, new Date(cursor.createdAt))),
    and(eq(transactions.occurredOn, cursor.occurredOn), eq(transactions.createdAt, new Date(cursor.createdAt)), lt(transactions.id, cursor.id)),
  )!);
  const rows = await db.select(selectFields()).from(transactions).where(and(...base)).orderBy(desc(transactions.occurredOn), desc(transactions.createdAt), desc(transactions.id)).limit(limit + 1);
  const page = rows.slice(0, limit).map(serialize);
  const last = page.at(-1);
  return { transactions: page, nextCursor: rows.length > limit && last ? { occurredOn: last.occurredOn, createdAt: last.createdAt.toISOString(), id: last.id } : null };
}

export async function findActiveCategory(db: Database, spaceId: string, categoryId: string) {
  const [row] = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, categoryId), eq(categories.spaceId, spaceId), eq(categories.isArchived, false), isNull(categories.archivedAt)));
  return row ?? null;
}
export async function findActiveMoneyAccount(db: Database, spaceId: string, accountId: string) {
  const [row] = await db.select({ id: moneyAccounts.id }).from(moneyAccounts).where(and(eq(moneyAccounts.id, accountId), eq(moneyAccounts.spaceId, spaceId), eq(moneyAccounts.isArchived, false), isNull(moneyAccounts.archivedAt)));
  return row ?? null;
}
export async function accountHasCurrency(db: Database, accountId: string, currency: string) {
  const [row] = await db.select({ id: moneyAccountBalances.id }).from(moneyAccountBalances).where(and(eq(moneyAccountBalances.moneyAccountId, accountId), eq(moneyAccountBalances.currency, currency))).limit(1);
  return Boolean(row);
}
export async function findTransactionInSpace(db: Database, spaceId: string, transactionId: string) {
  const [row] = await db.select(selectFields()).from(transactions).where(and(eq(transactions.id, transactionId), eq(transactions.spaceId, spaceId)));
  return row ? serialize(row) : null;
}
export async function createTransaction(db: Database, input: { spaceId: string; userId: string; type: "expense" | "income"; amountMinor: bigint; currency: string; title: string; occurredOn: string; categoryId: string; moneyAccountId: string | null }) {
  const [row] = await db.insert(transactions).values({ ...input, recurrenceSeriesId: null }).returning(selectFields());
  return serialize(row);
}
export async function updateTransaction(db: Database, input: { spaceId: string; transactionId: string; type?: "expense" | "income"; amountMinor?: bigint; currency?: string; title?: string; occurredOn?: string; categoryId?: string; moneyAccountId?: string | null; isArchived?: boolean }) {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ["type", "amountMinor", "currency", "title", "occurredOn", "categoryId", "moneyAccountId"] as const) if (input[key] !== undefined) values[key] = input[key];
  if (input.isArchived !== undefined) { values.isArchived = input.isArchived; values.archivedAt = input.isArchived ? new Date() : null; }
  const [row] = await db.update(transactions).set(values).where(and(eq(transactions.id, input.transactionId), eq(transactions.spaceId, input.spaceId))).returning(selectFields());
  return row ? serialize(row) : null;
}
