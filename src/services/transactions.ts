import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  categories,
  moneyAccountBalances,
  moneyAccounts,
  transactionReferenceRates,
  transactions,
} from "../db/schema";
import { serializeMinorAmount } from "../lib/money";
import { buildMovementSnapshot, type MovementSnapshot } from "./exchange-rates";

export type ExchangeSnapshotRateDTO = {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  convertedAmountMinor: string;
  observedAt: string | null;
};
export type ExchangeSnapshotDTO = {
  countryCode: "VE";
  createdWithCurrency: string;
  rates: { BCV?: ExchangeSnapshotRateDTO; EURO?: ExchangeSnapshotRateDTO; CUSTOM?: ExchangeSnapshotRateDTO };
};

export type TransactionResponse = {
  id: string; type: "expense" | "income"; amountMinor: string; currency: string;
  title: string; occurredOn: string; categoryId: string; moneyAccountId: string | null;
  note: string | null;
  /** Quién lo creó. `null` en movimientos migrados antes de que el sync mandara autoría. */
  createdBy: string | null;
  /** Solo lo escriben el motor de recurrencias y la sincronización por lotes. */
  recurrence: "once" | "weekly" | "biweekly" | "monthly" | "custom";
  recurrenceGroupId: string | null;
  recurrenceSeriesId: string | null; createdAt: Date; updatedAt: Date;
  /** `null` para movimientos sin modo Venezuela aplicable o sin tasa disponible al crearlos. */
  exchangeSnapshot: ExchangeSnapshotDTO | null;
};
export type TransactionCursor = { occurredOn: string; createdAt: string; id: string };

function selectFields() {
  return { id: transactions.id, type: transactions.type, amountMinor: transactions.amountMinor,
    currency: transactions.currency, title: transactions.title, occurredOn: transactions.occurredOn,
    categoryId: transactions.categoryId, moneyAccountId: transactions.moneyAccountId,
    note: transactions.note, createdBy: transactions.createdBy, recurrence: transactions.recurrence,
    recurrenceGroupId: transactions.recurrenceGroupId,
    recurrenceSeriesId: transactions.recurrenceSeriesId, createdAt: transactions.createdAt, updatedAt: transactions.updatedAt };
}
function serialize(row: Omit<TransactionResponse, "amountMinor" | "exchangeSnapshot"> & { amountMinor: bigint }): Omit<TransactionResponse, "exchangeSnapshot"> {
  return { ...row, amountMinor: serializeMinorAmount(row.amountMinor) };
}

/**
 * Reconstruye `exchangeSnapshot` desde las filas ya persistidas en
 * `transaction_reference_rates` — usado al leer movimientos (list/find), a
 * diferencia de `create`/`update`, que lo construyen en memoria a partir del
 * snapshot recién calculado, sin volver a consultar.
 */
async function attachExchangeSnapshots<T extends { id: string }>(
  db: Database,
  rows: T[],
): Promise<Array<T & { exchangeSnapshot: ExchangeSnapshotDTO | null }>> {
  if (!rows.length) return rows.map((row) => ({ ...row, exchangeSnapshot: null }));

  const rateRows = await db
    .select()
    .from(transactionReferenceRates)
    .where(inArray(transactionReferenceRates.transactionId, rows.map((row) => row.id)));

  const byTransaction = new Map<string, typeof rateRows>();
  for (const rateRow of rateRows) {
    const list = byTransaction.get(rateRow.transactionId);
    if (list) list.push(rateRow);
    else byTransaction.set(rateRow.transactionId, [rateRow]);
  }

  return rows.map((row) => ({
    ...row,
    exchangeSnapshot: exchangeSnapshotFromRows(byTransaction.get(row.id), (row as { currency?: string }).currency ?? ""),
  }));
}

type SnapshotSourceRow = {
  rateSource: string;
  displayCurrency: string;
  referenceAsset: string;
  rate: string;
  convertedAmountMinor: bigint;
  observedAt: Date | null;
};

export function exchangeSnapshotFromRows(
  rateRows: SnapshotSourceRow[] | undefined,
  createdWithCurrency: string,
): ExchangeSnapshotDTO | null {
  if (!rateRows || !rateRows.length) return null;

  const rates: ExchangeSnapshotDTO["rates"] = {};
  for (const row of rateRows) {
    const entry: ExchangeSnapshotRateDTO = {
      baseCurrency: row.referenceAsset,
      // La tasa siempre está expresada contra bolívares. `displayCurrency`
      // describe el resultado de esta conversión puntual (USD al partir de
      // VES, por ejemplo) y no debe confundirse con la divisa cotizada.
      quoteCurrency: "VES",
      rate: row.rate,
      convertedAmountMinor: serializeMinorAmount(row.convertedAmountMinor),
      observedAt: row.observedAt?.toISOString() ?? null,
    };
    if (row.rateSource === "BCV" || row.rateSource === "EURO" || row.rateSource === "CUSTOM") {
      rates[row.rateSource] = entry;
    }
  }
  return { countryCode: "VE", createdWithCurrency, rates };
}

function snapshotToDTO(snapshot: MovementSnapshot | null): ExchangeSnapshotDTO | null {
  if (!snapshot) return null;
  return exchangeSnapshotFromRows(snapshot.rows, snapshot.createdWithCurrency);
}

export async function listTransactions(db: Database, spaceId: string, limit: number, cursor: TransactionCursor | null) {
  const base = [eq(transactions.spaceId, spaceId), eq(transactions.isArchived, false), isNull(transactions.archivedAt)];
  if (cursor) base.push(or(
    lt(transactions.occurredOn, cursor.occurredOn),
    and(eq(transactions.occurredOn, cursor.occurredOn), lt(transactions.createdAt, new Date(cursor.createdAt))),
    and(eq(transactions.occurredOn, cursor.occurredOn), eq(transactions.createdAt, new Date(cursor.createdAt)), lt(transactions.id, cursor.id)),
  )!);
  const rows = await db.select(selectFields()).from(transactions).where(and(...base)).orderBy(desc(transactions.occurredOn), desc(transactions.createdAt), desc(transactions.id)).limit(limit + 1);
  const page = await attachExchangeSnapshots(db, rows.slice(0, limit).map(serialize));
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
  if (!row) return null;
  const [enriched] = await attachExchangeSnapshots(db, [serialize(row)]);
  return enriched;
}

export type CreateTransactionResult = { transaction: TransactionResponse | null; error?: "CUSTOM_RATE_NOT_FOUND" };

export async function createTransaction(
  db: Database,
  input: {
    spaceId: string; userId: string; type: "expense" | "income"; amountMinor: bigint; currency: string;
    title: string; occurredOn: string; categoryId: string; moneyAccountId: string | null; note?: string | null;
    creatorCountryCode: string | null; customRateId?: string | null;
  },
): Promise<CreateTransactionResult> {
  const { creatorCountryCode, customRateId, userId, ...transactionInput } = input;
  const snapshotResult = shouldAttemptSnapshot(input.currency, creatorCountryCode)
    ? await buildMovementSnapshot(db, {
        userId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        customRateId,
      })
    : { snapshot: null as MovementSnapshot | null };

  if (snapshotResult.error) return { transaction: null, error: snapshotResult.error };

  // `transactions` no tiene columna `userId`, solo `createdBy`: dejar `userId`
  // suelto en el spread lo descartaba en silencio y el movimiento quedaba sin
  // autor — el bug real detrás de "el movimiento se le atribuye a otro
  // usuario" en un espacio compartido.
  const [row] = await db
    .insert(transactions)
    .values({ ...transactionInput, createdBy: userId, recurrenceSeriesId: null })
    .returning(selectFields());

  if (snapshotResult.snapshot) await insertReferenceRateRows(db, row.id, snapshotResult.snapshot);

  return { transaction: { ...serialize(row), exchangeSnapshot: snapshotToDTO(snapshotResult.snapshot) } };
}

export type UpdateTransactionResult = { transaction: TransactionResponse | null; error?: "CUSTOM_RATE_NOT_FOUND" };

export async function updateTransaction(
  db: Database,
  input: {
    spaceId: string; transactionId: string; userId: string; type?: "expense" | "income"; amountMinor?: bigint;
    currency?: string; title?: string; occurredOn?: string; categoryId?: string; moneyAccountId?: string | null;
    note?: string | null; isArchived?: boolean; creatorCountryCode: string | null; customRateId?: string | null;
  },
): Promise<UpdateTransactionResult> {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ["type", "amountMinor", "currency", "title", "occurredOn", "categoryId", "moneyAccountId", "note"] as const) if (input[key] !== undefined) values[key] = input[key];
  if (input.isArchived !== undefined) { values.isArchived = input.isArchived; values.archivedAt = input.isArchived ? new Date() : null; }

  const refreezeSnapshot = input.amountMinor !== undefined || input.currency !== undefined || input.occurredOn !== undefined || input.customRateId !== undefined;

  const [row] = await db.update(transactions).set(values).where(and(eq(transactions.id, input.transactionId), eq(transactions.spaceId, input.spaceId))).returning(selectFields());
  if (!row) return { transaction: null };

  if (!refreezeSnapshot) {
    const [enriched] = await attachExchangeSnapshots(db, [serialize(row)]);
    return { transaction: enriched };
  }

  const snapshotResult = shouldAttemptSnapshot(row.currency, input.creatorCountryCode)
    ? await buildMovementSnapshot(db, {
        userId: input.userId,
        amountMinor: row.amountMinor,
        currency: row.currency,
        customRateId: input.customRateId,
      })
    : { snapshot: null as MovementSnapshot | null };

  if (snapshotResult.error) return { transaction: null, error: snapshotResult.error };

  await db.delete(transactionReferenceRates).where(eq(transactionReferenceRates.transactionId, row.id));
  if (snapshotResult.snapshot) await insertReferenceRateRows(db, row.id, snapshotResult.snapshot);

  return { transaction: { ...serialize(row), exchangeSnapshot: snapshotToDTO(snapshotResult.snapshot) } };
}

function shouldAttemptSnapshot(currency: string, creatorCountryCode: string | null): boolean {
  return creatorCountryCode === "VE" && (currency === "VES" || currency === "USD");
}

async function insertReferenceRateRows(db: Database, transactionId: string, snapshot: MovementSnapshot) {
  await db.insert(transactionReferenceRates).values(snapshotReferenceRateValues(transactionId, snapshot));
}

/** Valores de persistencia comunes a rutas directas y sincronización offline. */
export function snapshotReferenceRateValues(transactionId: string, snapshot: MovementSnapshot) {
  return snapshot.rows.map((row) => ({
    transactionId,
    displayCurrency: row.displayCurrency,
    rateSource: row.rateSource,
    referenceAsset: row.referenceAsset,
    rate: row.rate,
    convertedAmountMinor: row.convertedAmountMinor,
    rateSnapshotId: row.rateSnapshotId,
    customRateId: row.customRateId,
    observedAt: row.observedAt,
  }));
}
