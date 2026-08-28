import { and, eq, isNull, isNotNull, notExists, sql } from "drizzle-orm";
import { type Database } from "../db/client";
import { moneyAccountBalances, moneyAccounts, transactions, recurringTransactionSeries } from "../db/schema";
import { serializeMinorAmount } from "../lib/money";

export type BalanceResponse = { currency: string; openingBalanceMinor: string; currentBalanceMinor: string; displayOrder: number };
export type MoneyAccountResponse = { id: string; name: string; kind: "cash" | "bank" | "card"; icon: string | null; colorToken: string | null; primaryCurrency: string; createdAt: Date; balances: BalanceResponse[] };

export async function listMoneyAccounts(db: Database, spaceId: string): Promise<MoneyAccountResponse[]> {
  const rows = await db.select({
    id: moneyAccounts.id, name: moneyAccounts.name, kind: moneyAccounts.kind, icon: moneyAccounts.icon, colorToken: moneyAccounts.colorToken, primaryCurrency: moneyAccounts.primaryCurrency, createdAt: moneyAccounts.createdAt,
    balanceId: moneyAccountBalances.id, balanceCurrency: moneyAccountBalances.currency, opening: moneyAccountBalances.openingBalanceMinor, displayOrder: moneyAccountBalances.displayOrder,
    transactionType: transactions.type, transactionAmount: transactions.amountMinor,
  }).from(moneyAccounts)
    .leftJoin(moneyAccountBalances, eq(moneyAccountBalances.moneyAccountId, moneyAccounts.id))
    .leftJoin(transactions, and(eq(transactions.moneyAccountId, moneyAccounts.id), eq(transactions.currency, moneyAccountBalances.currency), eq(transactions.isArchived, false), isNull(transactions.archivedAt)))
    .where(and(eq(moneyAccounts.spaceId, spaceId), eq(moneyAccounts.isArchived, false), isNull(moneyAccounts.archivedAt)));

  const accounts = new Map<string, MoneyAccountResponse>();
  const balances = new Map<string, BalanceResponse & { current: bigint }>();
  for (const row of rows) {
    let account = accounts.get(row.id);
    if (!account) { account = { id: row.id, name: row.name, kind: row.kind, icon: row.icon, colorToken: row.colorToken, primaryCurrency: row.primaryCurrency, createdAt: row.createdAt, balances: [] }; accounts.set(row.id, account); }
    if (!row.balanceId || !row.balanceCurrency || row.opening === null || row.displayOrder === null) continue;
    let balance = balances.get(row.balanceId);
    if (!balance) { balance = { currency: row.balanceCurrency, openingBalanceMinor: serializeMinorAmount(row.opening), currentBalanceMinor: "", displayOrder: row.displayOrder, current: row.opening }; balances.set(row.balanceId, balance); account.balances.push(balance); }
    if (row.transactionAmount !== null) balance.current += row.transactionType === "income" ? row.transactionAmount : -row.transactionAmount;
  }
  for (const balance of balances.values()) { balance.currentBalanceMinor = serializeMinorAmount(balance.current); delete (balance as Partial<typeof balance>).current; }
  return [...accounts.values()];
}

export async function findMoneyAccountInSpace(db: Database, spaceId: string, accountId: string) {
  const [account] = await db.select({ id: moneyAccounts.id, primaryCurrency: moneyAccounts.primaryCurrency }).from(moneyAccounts).where(and(eq(moneyAccounts.id, accountId), eq(moneyAccounts.spaceId, spaceId)));
  return account ?? null;
}

export async function createMoneyAccountWithBalances(db: Database, input: { spaceId:string; userId:string; name:string; kind:"cash"|"bank"|"card"; icon:string|null; colorToken:string|null; primaryCurrency:string; balances:Array<{currency:string;openingBalanceMinor:bigint;displayOrder:number}> }): Promise<MoneyAccountResponse> {
  const id = crypto.randomUUID(); const now = new Date();
  await db.batch([
    db.insert(moneyAccounts).values({ id, spaceId: input.spaceId, name: input.name, kind: input.kind, icon: input.icon, colorToken: input.colorToken, primaryCurrency: input.primaryCurrency, createdBy: input.userId, createdAt: now, updatedAt: now }),
    ...input.balances.map((balance) => db.insert(moneyAccountBalances).values({ moneyAccountId: id, currency: balance.currency, openingBalanceMinor: balance.openingBalanceMinor, displayOrder: balance.displayOrder, createdAt: now, updatedAt: now })),
  ]);
  return { id, name: input.name, kind: input.kind, icon: input.icon, colorToken: input.colorToken, primaryCurrency: input.primaryCurrency, createdAt: now, balances: input.balances.map((b) => ({ currency:b.currency, openingBalanceMinor:serializeMinorAmount(b.openingBalanceMinor), currentBalanceMinor:serializeMinorAmount(b.openingBalanceMinor), displayOrder:b.displayOrder })) };
}

export async function updateMoneyAccount(db: Database, input: {spaceId:string;accountId:string;name?:string;kind?:"cash"|"bank"|"card";icon?:string|null;colorToken?:string|null;primaryCurrency?:string;isArchived?:boolean}) {
  const values: Record<string, unknown> = { updatedAt: new Date() }; Object.assign(values, input.name !== undefined ? {name:input.name}:{}, input.kind !== undefined ? {kind:input.kind}:{}, input.icon !== undefined ? {icon:input.icon}:{}, input.colorToken !== undefined ? {colorToken:input.colorToken}:{}, input.primaryCurrency !== undefined ? {primaryCurrency:input.primaryCurrency}:{});
  if (input.isArchived !== undefined) Object.assign(values, {isArchived:input.isArchived, archivedAt:input.isArchived ? new Date() : null});
  const [account] = await db.update(moneyAccounts).set(values).where(and(eq(moneyAccounts.id,input.accountId),eq(moneyAccounts.spaceId,input.spaceId))).returning({id:moneyAccounts.id,name:moneyAccounts.name,kind:moneyAccounts.kind,icon:moneyAccounts.icon,colorToken:moneyAccounts.colorToken,primaryCurrency:moneyAccounts.primaryCurrency,createdAt:moneyAccounts.createdAt});
  return account ?? null;
}

export async function hasBalanceCurrency(db: Database, accountId: string, currency: string) { const [row] = await db.select({id:moneyAccountBalances.id}).from(moneyAccountBalances).where(and(eq(moneyAccountBalances.moneyAccountId,accountId),eq(moneyAccountBalances.currency,currency))); return Boolean(row); }
export async function upsertBalance(db: Database, input:{accountId:string;currency:string;openingBalanceMinor:bigint;displayOrder:number}) { const [row] = await db.insert(moneyAccountBalances).values({moneyAccountId:input.accountId,currency:input.currency,openingBalanceMinor:input.openingBalanceMinor,displayOrder:input.displayOrder}).onConflictDoUpdate({target:[moneyAccountBalances.moneyAccountId,moneyAccountBalances.currency],set:{openingBalanceMinor:input.openingBalanceMinor,displayOrder:input.displayOrder,updatedAt:new Date()}}).returning({currency:moneyAccountBalances.currency,openingBalanceMinor:moneyAccountBalances.openingBalanceMinor,displayOrder:moneyAccountBalances.displayOrder}); return {currency:row.currency,openingBalanceMinor:serializeMinorAmount(row.openingBalanceMinor),displayOrder:row.displayOrder}; }
export async function balanceHasTransactions(db: Database, accountId:string,currency:string) { const [row] = await db.select({id:transactions.id}).from(transactions).where(and(eq(transactions.moneyAccountId,accountId),eq(transactions.currency,currency),isNull(transactions.archivedAt))).limit(1); return Boolean(row); }
export async function moneyAccountHasFutureRecurringSeries(db:Database,spaceId:string,accountId:string) { const [row]=await db.select({id:recurringTransactionSeries.id}).from(recurringTransactionSeries).where(and(eq(recurringTransactionSeries.spaceId,spaceId),eq(recurringTransactionSeries.moneyAccountId,accountId),eq(recurringTransactionSeries.isArchived,false),isNull(recurringTransactionSeries.archivedAt),isNotNull(recurringTransactionSeries.nextOccurrenceOn))).limit(1); return Boolean(row); }
export async function balanceHasFutureRecurringSeries(db:Database,accountId:string,currency:string) { const [row]=await db.select({id:recurringTransactionSeries.id}).from(recurringTransactionSeries).where(and(eq(recurringTransactionSeries.moneyAccountId,accountId),eq(recurringTransactionSeries.currency,currency),eq(recurringTransactionSeries.isArchived,false),isNull(recurringTransactionSeries.archivedAt),isNotNull(recurringTransactionSeries.nextOccurrenceOn))).limit(1); return Boolean(row); }
export async function deleteBalance(db:Database,accountId:string,currency:string) { const [row] = await db.delete(moneyAccountBalances).where(and(eq(moneyAccountBalances.moneyAccountId,accountId),eq(moneyAccountBalances.currency,currency),notExists(db.select({one:sql`1`}).from(transactions).where(and(eq(transactions.moneyAccountId,accountId),eq(transactions.currency,currency),eq(transactions.isArchived,false),isNull(transactions.archivedAt)))),notExists(db.select({one:sql`1`}).from(recurringTransactionSeries).where(and(eq(recurringTransactionSeries.moneyAccountId,accountId),eq(recurringTransactionSeries.currency,currency),eq(recurringTransactionSeries.isArchived,false),isNull(recurringTransactionSeries.archivedAt),isNotNull(recurringTransactionSeries.nextOccurrenceOn)))))).returning({id:moneyAccountBalances.id}); return Boolean(row); }
