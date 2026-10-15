import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  categories,
  categoryAliases,
  categoryBudgets,
  moneyAccountBalances,
  moneyAccounts,
  recurringTransactionSeries,
  spaces,
  transactionReferenceRates,
  transactionAliases,
  transactions,
} from "../db/schema";
import { buildMovementSnapshot, type MovementSnapshot } from "./exchange-rates";
import { exchangeSnapshotFromRows, snapshotReferenceRateValues, type ExchangeSnapshotDTO } from "./transactions";
import { isUniqueViolation } from "../lib/pg";

type Row = Record<string, unknown>;

export type SpaceSyncPayload = {
  installationId: string;
  categories: Row[];
  moneyAccounts: Row[];
  recurringSeries: Row[];
  transactions: Row[];
};

export type SpaceSyncResult = {
  categoryCount: number;
  moneyAccountCount: number;
  recurringSeriesCount: number;
  transactionCount: number;
  transactions?: { localId: string; remoteId: string; updatedAt: string; accountingAmountMinorUsd: string | null; exchangeSnapshot: ExchangeSnapshotDTO | null }[];
};

export type SyncValidationCode =
  | "INVALID_SYNC_PAYLOAD"
  | "INVALID_MONEY_ACCOUNT_CURRENCY"
  | "INVALID_TRANSACTION_CURRENCY"
  | "INVALID_CATEGORY_REFERENCE"
  | "INVALID_MONEY_ACCOUNT_REFERENCE"
  | "INVALID_RECURRING_SERIES_REFERENCE"
  | "ENTITY_BELONGS_TO_ANOTHER_SPACE"
  | "VE_ACCOUNT_MULTI_CURRENCY_NOT_ALLOWED";

export class SyncValidationError extends Error {
  constructor(
    readonly apiCode: SyncValidationCode,
    readonly issue: {
      path: (string | number)[];
      reason: string;
      entityType?: string;
      localEntityId?: string;
      countryCode?: string | null;
      canonicalCurrency?: string;
    },
  ) {
    super(apiCode);
    this.name = "SyncValidationError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Existing = { id: string; sourceInstallationId: string | null; sourceLocalId: string | null };
type ExistingCategory = Existing & { templateKey?: string | null };
type ExistingTransaction = Existing & {
  categoryId: string;
  moneyAccountId: string | null;
  type: string;
  amountMinor: bigint;
  currency: string;
  title: string;
  occurredOn: string;
  note: string | null;
  recurrence: string;
  recurrenceGroupId: string | null;
  recurrenceSeriesId: string | null;
  isArchived: boolean;
  accountingAmountMinorUsd: bigint | null;
};

export class RecurrenceOccurrenceConflictError extends Error {
  readonly details?: { recurrenceSeriesId: string; occurredOn: string };

  constructor(recurrenceSeriesId?: string, occurredOn?: string) {
    super("RECURRENCE_OCCURRENCE_CONFLICT");
    if (recurrenceSeriesId && occurredOn) {
      this.details = { recurrenceSeriesId, occurredOn };
    }
  }
}

/**
 * Traduce los identificadores locales del dispositivo a los remotos, en el
 * mismo orden de preferencia que asumía la base anterior:
 *
 *  1. una fila ya enlazada por `(space_id, source_installation_id, source_local_id)`;
 *  2. el `remoteId` que envía el cliente, si es un UUID;
 *  3. un UUID nuevo.
 *
 * El paso 1 va primero para que reenviar un lote sea idempotente aunque el
 * cliente todavía no conozca el id remoto.
 */
function resolveIds(existing: Existing[], rows: Row[], installationId: string) {
  const bySource = new Map<string, string>();
  for (const row of existing) {
    if (row.sourceInstallationId && row.sourceLocalId) {
      bySource.set(`${row.sourceInstallationId}:${row.sourceLocalId}`, row.id);
    }
  }

  const resolved = new Map<string, string>();
  for (const row of rows) {
    const localId = text(row.id);
    if (!localId) throw new Error("INVALID_PAYLOAD");

    const linked = bySource.get(`${installationId}:${localId}`);
    const remoteId = typeof row.remoteId === "string" ? row.remoteId : null;
    resolved.set(
      localId,
      linked ?? (remoteId && UUID.test(remoteId) ? remoteId : crypto.randomUUID()),
    );
  }
  return resolved;
}

function resolveCategoryIds(existing: ExistingCategory[], rows: Row[], installationId: string) {
  const bySource = new Map<string, string>();
  const byTemplateKey = new Map<string, string>();
  for (const row of existing) {
    if (row.sourceInstallationId && row.sourceLocalId) {
      bySource.set(`${row.sourceInstallationId}:${row.sourceLocalId}`, row.id);
    }
    if (row.templateKey) {
      byTemplateKey.set(row.templateKey, row.id);
    }
  }

  const resolved = new Map<string, string>();
  for (const row of rows) {
    const localId = text(row.id);
    if (!localId) throw new Error("INVALID_PAYLOAD");

    const linked = bySource.get(`${installationId}:${localId}`);
    const templateMatch = typeof row.templateKey === "string" && row.templateKey
      ? byTemplateKey.get(row.templateKey)
      : null;
    const remoteId = typeof row.remoteId === "string" ? row.remoteId : null;
    const resolvedId =
      linked ?? templateMatch ?? (remoteId && UUID.test(remoteId) ? remoteId : crypto.randomUUID());

    if (typeof row.templateKey === "string" && row.templateKey && !byTemplateKey.has(row.templateKey)) {
      byTemplateKey.set(row.templateKey, resolvedId);
    }

    resolved.set(localId, resolvedId);
  }
  return resolved;
}

/** Resuelve la identidad compartida de cada ocurrencia recurrente. */
function resolveTransactionIds(
  existing: ExistingTransaction[],
  aliases: { sourceInstallationId: string; sourceLocalId: string; transactionId: string }[],
  rows: Row[],
  installationId: string,
  knownSeries: Map<string, string>,
  fallbackDate: string,
) {
  const bySource = new Map<string, string>();
  for (const row of existing) {
    if (row.sourceInstallationId && row.sourceLocalId) {
      bySource.set(`${row.sourceInstallationId}:${row.sourceLocalId}`, row.id);
    }
  }
  for (const alias of aliases) {
    bySource.set(`${alias.sourceInstallationId}:${alias.sourceLocalId}`, alias.transactionId);
  }

  const byOccurrence = new Map<string, string>();
  for (const row of existing) {
    if (row.recurrenceSeriesId) byOccurrence.set(`${row.recurrenceSeriesId}:${row.occurredOn}`, row.id);
  }

  const resolved = new Map<string, string>();
  const payloadOccurrences = new Map<string, { id: string; signature: string }>();
  for (const row of rows) {
    const localId = text(row.id);
    if (!localId) throw new Error("INVALID_PAYLOAD");
    const seriesId = reference(knownSeries, row.recurrenceSeriesId);
    const occurredOn = dateOnly(row.occurredOn, fallbackDate);

    if (seriesId) {
      const occurrenceKey = `${seriesId}:${occurredOn}`;
      const signature = recurrenceOccurrenceSignature(row);
      const inPayload = payloadOccurrences.get(occurrenceKey);
      if (inPayload) {
        if (inPayload.signature !== signature) {
          throw new RecurrenceOccurrenceConflictError(seriesId, occurredOn);
        }
        resolved.set(localId, inPayload.id);
        continue;
      }

      // La pareja serie-fecha es más fuerte que el id de la instalación: dos
      // dispositivos que creen la misma ocurrencia deben converger aquí.
      const id = byOccurrence.get(occurrenceKey)
        ?? bySource.get(`${installationId}:${localId}`)
        ?? (typeof row.remoteId === "string" && UUID.test(row.remoteId) ? row.remoteId : crypto.randomUUID());
      payloadOccurrences.set(occurrenceKey, { id, signature });
      resolved.set(localId, id);
      continue;
    }

    const linked = bySource.get(`${installationId}:${localId}`);
    const remoteId = typeof row.remoteId === "string" ? row.remoteId : null;
    resolved.set(localId, linked ?? (remoteId && UUID.test(remoteId) ? remoteId : crypto.randomUUID()));
  }
  return resolved;
}

function recurrenceOccurrenceSignature(row: Row) {
  // Excluye identificadores de réplica y relojes: no describen la ocurrencia.
  const fields = [
    "categoryId", "moneyAccountId", "type", "amountMinor", "currency", "title",
    "note", "recurrence", "recurrenceGroupId", "isArchived", "customRateId",
  ];
  return JSON.stringify(fields.map((field) => row[field] ?? null));
}

/**
 * Sube un lote de cambios de un espacio compartido. Sustituye la RPC
 * `sync_couple_space_data`.
 *
 * Resolución en dos fases porque el driver Neon HTTP no ofrece transacciones
 * interactivas: primero se leen los enlaces existentes y se resuelven todos los
 * identificadores en memoria, y después se escribe todo en un único `db.batch`,
 * que sí es atómico.
 *
 * Los conflictos se resuelven por última escritura: una fila solo se sobrescribe
 * si el `updatedAt` entrante es igual o posterior al almacenado, de modo que un
 * dispositivo con datos viejos no pisa los del otro.
 */
export async function syncSpaceData(
  db: Database,
  spaceId: string,
  userId: string,
  payload: SpaceSyncPayload,
  creatorCountryCode: string | null = null,
): Promise<SpaceSyncResult> {
  const installationId = text(payload.installationId);
  if (!installationId) throw syncIssue("INVALID_SYNC_PAYLOAD", ["installationId"], "REQUIRED_STRING");
  validatePayload(payload);

  const [space] = await db
    .select({ currency: spaces.currency, countryCode: spaces.countryCode })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space) throw new Error("SPACE_NOT_FOUND");
  await assertRemoteIdsBelongToSpace(db, spaceId, payload);
  if (space.countryCode === "VE") {
    for (const [index, account] of payload.moneyAccounts.entries()) {
      validateVeSyncedAccount(account, index);
    }
  }
  for (const [index, account] of payload.moneyAccounts.entries()) {
    validatePrimaryAccountBalance(account, index);
  }
  const moneyAccountRows = payload.moneyAccounts;

  const [
    existingCategories,
    existingAccounts,
    existingSeries,
    existingTransactions,
    existingCategoryAliases,
    existingTransactionAliases,
  ] = await Promise.all([
      db
        .select({
          id: categories.id,
          sourceInstallationId: categories.sourceInstallationId,
          sourceLocalId: categories.sourceLocalId,
          templateKey: categories.templateKey,
        })
        .from(categories)
        .where(eq(categories.spaceId, spaceId)),
      db
        .select({
          id: moneyAccounts.id,
          sourceInstallationId: moneyAccounts.sourceInstallationId,
          sourceLocalId: moneyAccounts.sourceLocalId,
        })
        .from(moneyAccounts)
        .where(eq(moneyAccounts.spaceId, spaceId)),
      db
        .select({
          id: recurringTransactionSeries.id,
          sourceInstallationId: recurringTransactionSeries.sourceInstallationId,
          sourceLocalId: recurringTransactionSeries.sourceLocalId,
        })
        .from(recurringTransactionSeries)
        .where(eq(recurringTransactionSeries.spaceId, spaceId)),
      db
        .select({
          id: transactions.id,
          sourceInstallationId: transactions.sourceInstallationId,
          sourceLocalId: transactions.sourceLocalId,
          categoryId: transactions.categoryId,
          moneyAccountId: transactions.moneyAccountId,
          type: transactions.type,
          amountMinor: transactions.amountMinor,
          currency: transactions.currency,
          title: transactions.title,
          occurredOn: transactions.occurredOn,
          note: transactions.note,
          recurrence: transactions.recurrence,
          recurrenceGroupId: transactions.recurrenceGroupId,
          recurrenceSeriesId: transactions.recurrenceSeriesId,
          isArchived: transactions.isArchived,
          accountingAmountMinorUsd: transactions.accountingAmountMinorUsd,
        })
        .from(transactions)
        .where(eq(transactions.spaceId, spaceId)),
      db
        .select({
          sourceInstallationId: categoryAliases.sourceInstallationId,
          sourceLocalId: categoryAliases.sourceLocalId,
          categoryId: categoryAliases.categoryId,
        })
        .from(categoryAliases)
        .where(eq(categoryAliases.spaceId, spaceId)),
      db
        .select({
          sourceInstallationId: transactionAliases.sourceInstallationId,
          sourceLocalId: transactionAliases.sourceLocalId,
          transactionId: transactionAliases.transactionId,
        })
        .from(transactionAliases)
        .where(eq(transactionAliases.spaceId, spaceId)),
    ]);

  const categoryIds = resolveCategoryIds(existingCategories, payload.categories, installationId);
  const accountIds = resolveIds(existingAccounts, moneyAccountRows, installationId);
  const seriesIds = resolveIds(existingSeries, payload.recurringSeries, installationId);

  // La selección de CUSTOM no vive en `transactions`: solo existe en la fila
  // congelada. Se lee exclusivamente para conservarla cuando el cliente no
  // manda `customRateId`; nunca se devuelve a otro miembro del espacio.
  const existingReferenceRates = existingTransactions.length
    ? await db.select().from(transactionReferenceRates).where(inArray(transactionReferenceRates.transactionId, existingTransactions.map((row) => row.id)))
    : [];
  const referenceRatesByTransaction = new Map<string, typeof existingReferenceRates>();
  for (const rate of existingReferenceRates) {
    const list = referenceRatesByTransaction.get(rate.transactionId);
    if (list) list.push(rate); else referenceRatesByTransaction.set(rate.transactionId, [rate]);
  }

  // Una referencia puede apuntar a una fila que ya vive en el servidor y que no
  // viaja en este lote: por eso el mapa se completa con lo ya existente.
  //
  // Las categorías, además, se completan con sus alias: cuando el sync fusiona
  // la categoría local de un dispositivo en la fila que ya tenía otro (por
  // `templateKey`), el id local del dispositivo fusionado deja de vivir en la
  // fila de `categories` (que solo guarda un par instalación/id-local). Sin el
  // alias, un movimiento de ese dispositivo que referencie esa categoría sin
  // volver a incluirla en el mismo lote no se podría resolver.
  const ownAliases = existingCategoryAliases.filter(
    (alias) => alias.sourceInstallationId === installationId,
  );
  const knownCategories = referenceMap(categoryIds, existingCategories, ownAliases);
  const knownAccounts = referenceMap(accountIds, existingAccounts);
  const knownSeries = referenceMap(seriesIds, existingSeries);

  const now = new Date();
  const transactionIds = resolveTransactionIds(
    existingTransactions as ExistingTransaction[],
    existingTransactionAliases,
    payload.transactions,
    installationId,
    knownSeries,
    now.toISOString().slice(0, 10),
  );
  if (space.countryCode === "VE") {
    const existingTransactionById = new Map(
      existingTransactions.map((transaction) => [transaction.id, transaction]),
    );
    for (const [index, transaction] of payload.transactions.entries()) {
      if (transaction.currency === "USD" || transaction.currency === "VES") continue;
      const id = transactionIds.get(text(transaction.id));
      const existing = id ? existingTransactionById.get(id) : undefined;
      // Un cambio de país puede dejar históricos EUR u otra moneda. Permitimos
      // reenviar exactamente esa fila para que el dispositivo la marque como
      // sincronizada, pero nunca crear ni mutar una nueva divisa fuera del
      // libro VE actual.
      if (!existing || !isUnchangedLegacyVeTransaction(
        existing,
        transaction,
        knownCategories,
        knownAccounts,
        knownSeries,
      )) {
        throw syncIssue(
          "INVALID_TRANSACTION_CURRENCY",
          ["transactions", index, "currency"],
          "VE_ALLOWS_USD_OR_VES",
          transaction,
          "transaction",
          "VE",
          "USD",
        );
      }
    }
  }
  const source = (localId: string) => ({
    sourceInstallationId: installationId,
    sourceLocalId: localId,
  });

  const writes: unknown[] = [];
  const syncedTransactions: SpaceSyncResult["transactions"] = [];

  for (const [categoryIndex, row] of payload.categories.entries()) {
    const localId = text(row.id);
    const id = categoryIds.get(localId)!;
    const updatedAt = date(row.updatedAt, now);
    const isArchived = Boolean(row.isArchived);

    writes.push(
      db
        .insert(categories)
        .values({
          id,
          spaceId,
          name: text(row.name),
          icon: stringOrNull(row.icon),
          colorToken: stringOrNull(row.colorToken),
          // `createdBy` es autoría, no una decisión del dispositivo. En una
          // inserción pertenece a la sesión autenticada; en updates el
          // COALESCE de abajo preserva la autoría ya guardada.
          createdBy: userId,
          isDefault: Boolean(row.isDefault),
          templateKey: stringOrNull(row.templateKey),
          ...source(localId),
          isArchived,
          archivedAt: isArchived ? updatedAt : null,
          createdAt: date(row.createdAt, now),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: categories.id,
          set: {
            name: sql`excluded.name`,
            icon: sql`excluded.icon`,
            colorToken: sql`excluded.color_token`,
            createdBy: sql`COALESCE(${categories.createdBy}, excluded.created_by)`,
            isDefault: sql`excluded.is_default`,
            templateKey: sql`excluded.template_key`,
            sourceInstallationId: sql`excluded.source_installation_id`,
            sourceLocalId: sql`excluded.source_local_id`,
            isArchived: sql`excluded.is_archived`,
            archivedAt: sql`excluded.archived_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`${categories.spaceId} = ${spaceId} AND excluded.updated_at >= ${categories.updatedAt}`,
        }),
    );

    const syncedBudgets = Array.isArray(row.budgets) ? row.budgets as Row[] : null;
    if (syncedBudgets) {
      writes.push(db.delete(categoryBudgets).where(eq(categoryBudgets.categoryId, id)));
      for (const [budgetIndex, budget] of syncedBudgets.entries()) {
        const currency = currencyCode(budget.currency, ["categories", categoryIndex, "budgets", budgetIndex, "currency"], row, "category");
        const amount = syncInteger(budget.budgetAmountMinor, ["categories", categoryIndex, "budgets", budgetIndex, "budgetAmountMinor"], row, "category");
        if (amount < 0) throw syncIssue("INVALID_SYNC_PAYLOAD", ["categories", categoryIndex, "budgets", budgetIndex, "budgetAmountMinor"], "MUST_BE_NON_NEGATIVE", row, "category");
        writes.push(db.insert(categoryBudgets).values({
          categoryId: id,
          currency,
          budgetAmountMinor: BigInt(amount),
          createdBy: userId,
        }));
      }
    } else if (row.budgetMinor !== null && row.budgetMinor !== undefined) {
      // Compatibilidad con clientes anteriores: un único presupuesto usa la
      // moneda canónica del espacio.
      const budget = syncInteger(row.budgetMinor, ["categories", categoryIndex, "budgetMinor"], row, "category");
      if (budget < 0) throw syncIssue("INVALID_SYNC_PAYLOAD", ["categories", categoryIndex, "budgetMinor"], "MUST_BE_NON_NEGATIVE", row, "category");
      writes.push(
        db
          .insert(categoryBudgets)
          .values({
            categoryId: id,
            currency: space.currency,
            budgetAmountMinor: BigInt(budget),
            createdBy: userId,
          })
          .onConflictDoUpdate({
            target: [categoryBudgets.categoryId, categoryBudgets.currency],
            set: { budgetAmountMinor: sql`excluded.budget_amount_minor`, updatedAt: now },
          }),
      );
    }

    // Registra de forma duradera que este dispositivo llama `localId` a `id`,
    // aunque la fila de `categories` termine perteneciendo a otro dispositivo
    // (fusión por `templateKey`). Así, un futuro movimiento que solo
    // referencie esta categoría por su id local sigue resolviéndose aunque la
    // categoría no viaje de nuevo en ese lote.
    writes.push(
      db
        .insert(categoryAliases)
        .values({ spaceId, sourceInstallationId: installationId, sourceLocalId: localId, categoryId: id })
        .onConflictDoUpdate({
          target: [
            categoryAliases.spaceId,
            categoryAliases.sourceInstallationId,
            categoryAliases.sourceLocalId,
          ],
          set: { categoryId: sql`excluded.category_id`, updatedAt: sql`excluded.updated_at` },
        }),
    );
  }

  for (const [accountIndex, row] of moneyAccountRows.entries()) {
    const localId = text(row.id);
    const id = accountIds.get(localId)!;
    const updatedAt = date(row.updatedAt, now);
    const isArchived = Boolean(row.isArchived);

    writes.push(
      db
        .insert(moneyAccounts)
        .values({
          id,
          spaceId,
          name: text(row.name),
          kind: accountKind(row.kind),
          icon: stringOrNull(row.icon),
          colorToken: stringOrNull(row.colorToken),
          primaryCurrency: text(row.currency),
          createdBy: userId,
          ...source(localId),
          isArchived,
          archivedAt: isArchived ? updatedAt : null,
          createdAt: date(row.createdAt, now),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: moneyAccounts.id,
          set: {
            name: sql`excluded.name`,
            kind: sql`excluded.kind`,
            icon: sql`excluded.icon`,
            colorToken: sql`excluded.color_token`,
            primaryCurrency: sql`excluded.primary_currency`,
            createdBy: sql`COALESCE(${moneyAccounts.createdBy}, excluded.created_by)`,
            sourceInstallationId: sql`excluded.source_installation_id`,
            sourceLocalId: sql`excluded.source_local_id`,
            isArchived: sql`excluded.is_archived`,
            archivedAt: sql`excluded.archived_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`${moneyAccounts.spaceId} = ${spaceId} AND excluded.updated_at >= ${moneyAccounts.updatedAt}`,
        }),
    );

    // Las monedas de una cuenta se reescriben enteras: retirar una divisa en un
    // dispositivo debe retirarla en todos.
    const balances = Array.isArray(row.balances) ? (row.balances as Row[]) : [];
    writes.push(
      db.delete(moneyAccountBalances).where(eq(moneyAccountBalances.moneyAccountId, id)),
    );
    for (const [balanceIndex, balance] of balances.entries()) {
      writes.push(
        db.insert(moneyAccountBalances).values({
          moneyAccountId: id,
          currency: currencyCode(balance.currency, ["moneyAccounts", accountIndex, "balances", balanceIndex, "currency"], row, "moneyAccount"),
          openingBalanceMinor: BigInt(syncInteger(balance.openingBalanceMinor, ["moneyAccounts", accountIndex, "balances", balanceIndex, "openingBalanceMinor"], row, "moneyAccount")),
          displayOrder: syncInteger(balance.position ?? balance.displayOrder, ["moneyAccounts", accountIndex, "balances", balanceIndex, "position"], row, "moneyAccount"),
        }),
      );
    }
  }

  for (const [seriesIndex, row] of payload.recurringSeries.entries()) {
    const localId = text(row.id);
    const id = seriesIds.get(localId)!;
    const updatedAt = date(row.updatedAt, now);
    const isArchived = Boolean(row.isArchived);
    const categoryId = reference(knownCategories, row.categoryId);
    if (!categoryId) throw syncIssue("INVALID_CATEGORY_REFERENCE", ["recurringSeries", seriesIndex, "categoryId"], "REFERENCE_NOT_FOUND", row, "recurringSeries");
    const moneyAccountId = nullableReference(knownAccounts, row.moneyAccountId);
    if (moneyAccountId === undefined) throw syncIssue("INVALID_MONEY_ACCOUNT_REFERENCE", ["recurringSeries", seriesIndex, "moneyAccountId"], "REFERENCE_NOT_FOUND", row, "recurringSeries");

    const rawAmount = syncInteger(row.amountMinor, ["recurringSeries", seriesIndex, "amountMinor"], row, "recurringSeries");
    const amountMinor = BigInt(Math.max(1, rawAmount));
    const startsOn = dateOnly(row.startsOn, now.toISOString().slice(0, 10));
    const nextOccurrenceOn = isArchived
      ? null
      : stringOrNull(dateOnly(row.nextOccurrenceOn, startsOn));

    writes.push(
      db
        .insert(recurringTransactionSeries)
        .values({
          id,
          spaceId,
          categoryId,
          moneyAccountId,
          createdBy: userId,
          type: transactionType(row.type),
          amountMinor,
          currency: text(row.currency),
          title: text(row.title),
          frequency: frequency(row.frequency),
          startsOn,
          nextOccurrenceOn,
          generatedOccurrences: syncInteger(row.generatedOccurrences ?? 0, ["recurringSeries", seriesIndex, "generatedOccurrences"], row, "recurringSeries"),
          ...source(localId),
          isArchived,
          archivedAt: isArchived ? updatedAt : null,
          createdAt: date(row.createdAt, now),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: recurringTransactionSeries.id,
          set: {
            categoryId: sql`excluded.category_id`,
            moneyAccountId: sql`excluded.money_account_id`,
            type: sql`excluded.type`,
            amountMinor: sql`excluded.amount_minor`,
            currency: sql`excluded.currency`,
            title: sql`excluded.title`,
            frequency: sql`excluded.frequency`,
            startsOn: sql`excluded.starts_on`,
            nextOccurrenceOn: sql`excluded.next_occurrence_on`,
            generatedOccurrences: sql`excluded.generated_occurrences`,
            createdBy: sql`COALESCE(${recurringTransactionSeries.createdBy}, excluded.created_by)`,
            sourceInstallationId: sql`excluded.source_installation_id`,
            sourceLocalId: sql`excluded.source_local_id`,
            isArchived: sql`excluded.is_archived`,
            archivedAt: sql`excluded.archived_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`${recurringTransactionSeries.spaceId} = ${spaceId} AND excluded.updated_at >= ${recurringTransactionSeries.updatedAt}`,
        }),
    );
  }

  const writtenTransactionIds = new Set<string>();
  const syncedTransactionById = new Map<string, Omit<NonNullable<SpaceSyncResult["transactions"]>[number], "localId">>();
  for (const [transactionIndex, row] of payload.transactions.entries()) {
    const localId = text(row.id);
    const id = transactionIds.get(localId)!;
    // Dos réplicas idénticas de la misma ocurrencia en este lote escriben una
    // sola fila canónica; sus alias se registran después del insert.
    if (writtenTransactionIds.has(id)) continue;
    writtenTransactionIds.add(id);
    const updatedAt = date(row.updatedAt, now);
    const isArchived = Boolean(row.isArchived);
    const categoryId = reference(knownCategories, row.categoryId);
    if (!categoryId) throw syncIssue("INVALID_CATEGORY_REFERENCE", ["transactions", transactionIndex, "categoryId"], "REFERENCE_NOT_FOUND", row, "transaction");
    const moneyAccountId = nullableReference(knownAccounts, row.moneyAccountId);
    if (moneyAccountId === undefined) throw syncIssue("INVALID_MONEY_ACCOUNT_REFERENCE", ["transactions", transactionIndex, "moneyAccountId"], "REFERENCE_NOT_FOUND", row, "transaction");
    const recurrenceSeriesId = nullableReference(knownSeries, row.recurrenceSeriesId);
    if (recurrenceSeriesId === undefined) throw syncIssue("INVALID_RECURRING_SERIES_REFERENCE", ["transactions", transactionIndex, "recurrenceSeriesId"], "REFERENCE_NOT_FOUND", row, "transaction");

    const rawAmount = syncInteger(row.amountMinor, ["transactions", transactionIndex, "amountMinor"], row, "transaction");
    const amountMinor = BigInt(Math.max(1, rawAmount));
    const occurredOn = dateOnly(row.occurredOn, now.toISOString().slice(0, 10));
    const currency = text(row.currency);
    const existing = existingTransactions.find((transaction) => transaction.id === id) as ExistingTransaction | undefined;
    const hasCustomRateId = Object.prototype.hasOwnProperty.call(row, "customRateId");
    const customRateId = hasCustomRateId ? customRateIdValue(row.customRateId) : existingCustomRateId(referenceRatesByTransaction.get(id));
    if (hasCustomRateId && customRateId === undefined) {
      throw syncIssue("INVALID_SYNC_PAYLOAD", ["transactions", transactionIndex, "customRateId"], "INVALID_UUID", row, "transaction");
    }

    // Una creación siempre necesita cálculo. En updates solo cambia la
    // congelación ante campos monetarios o la elección explícita de CUSTOM;
    // título, nota, categoría, cuenta y tipo preservan las filas existentes.
    const regenerate = !existing ||
      existing.amountMinor !== amountMinor || existing.currency !== currency || existing.occurredOn !== occurredOn || hasCustomRateId;
    let snapshot: MovementSnapshot | null = null;
    if (regenerate && creatorCountryCode === "VE" && (currency === "USD" || currency === "VES")) {
      const result = await buildMovementSnapshot(db, { userId, amountMinor, currency, customRateId });
      if (result.error) throw new Error(result.error);
      snapshot = result.snapshot;
    }
    const accountingAmountMinorUsd = currency === "USD" ? amountMinor : snapshot?.rows.find((rate) => rate.rateSource === "BCV" && rate.displayCurrency === "USD")?.convertedAmountMinor ?? (regenerate ? null : existing?.accountingAmountMinorUsd ?? null);

    writes.push(
      db
        .insert(transactions)
        .values({
          id,
          spaceId,
          categoryId,
          moneyAccountId,
          createdBy: userId,
          type: transactionType(row.type),
          amountMinor,
          accountingAmountMinorUsd,
          currency,
          title: text(row.title),
          occurredOn,
          note: stringOrNull(row.note),
          recurrence: recurrenceKind(row.recurrence),
          recurrenceGroupId: stringOrNull(row.recurrenceGroupId),
          recurrenceSeriesId,
          sourceLocalTransactionId: stringOrNull(row.sourceTransactionId),
          ...source(localId),
          isArchived,
          archivedAt: isArchived ? updatedAt : null,
          createdAt: date(row.createdAt, now),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: transactions.id,
          set: {
            categoryId: sql`excluded.category_id`,
            moneyAccountId: sql`excluded.money_account_id`,
            type: sql`excluded.type`,
            amountMinor: sql`excluded.amount_minor`,
            accountingAmountMinorUsd: sql`excluded.accounting_amount_minor_usd`,
            currency: sql`excluded.currency`,
            title: sql`excluded.title`,
            occurredOn: sql`excluded.occurred_on`,
            note: sql`excluded.note`,
            recurrence: sql`excluded.recurrence`,
            recurrenceGroupId: sql`excluded.recurrence_group_id`,
            recurrenceSeriesId: sql`excluded.recurrence_series_id`,
            sourceLocalTransactionId: sql`excluded.source_local_transaction_id`,
            createdBy: sql`COALESCE(${transactions.createdBy}, excluded.created_by)`,
            isArchived: sql`excluded.is_archived`,
            archivedAt: sql`excluded.archived_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`${transactions.spaceId} = ${spaceId} AND excluded.updated_at >= ${transactions.updatedAt}`,
        }),
    );

    if (regenerate) {
      writes.push(db.delete(transactionReferenceRates).where(eq(transactionReferenceRates.transactionId, id)));
      if (snapshot) writes.push(db.insert(transactionReferenceRates).values(snapshotReferenceRateValues(id, snapshot)));
    }

    const priorRates = referenceRatesByTransaction.get(id);
    syncedTransactionById.set(id, {
      remoteId: id,
      updatedAt: updatedAt.toISOString(),
      accountingAmountMinorUsd: accountingAmountMinorUsd === null ? null : accountingAmountMinorUsd.toString(),
      exchangeSnapshot: regenerate
        ? exchangeSnapshotFromRows(snapshot?.rows, currency)
        : exchangeSnapshotFromRows(priorRates, existing?.currency ?? currency),
    });
  }

  // Siempre se conserva el id local que cada instalación usa para la fila
  // canónica. Esto evita que un reintento o un segundo dispositivo vuelva a
  // proponer un UUID distinto para la misma ocurrencia funcional.
  for (const row of payload.transactions) {
    const localId = text(row.id);
    const id = transactionIds.get(localId)!;
    writes.push(
      db
        .insert(transactionAliases)
        .values({ spaceId, sourceInstallationId: installationId, sourceLocalId: localId, transactionId: id })
        .onConflictDoUpdate({
          target: [
            transactionAliases.spaceId,
            transactionAliases.sourceInstallationId,
            transactionAliases.sourceLocalId,
          ],
          set: { transactionId: sql`excluded.transaction_id`, updatedAt: sql`excluded.updated_at` },
        }),
    );
    const synced = syncedTransactionById.get(id)!;
    syncedTransactions.push({ localId, ...synced });
  }

  if (writes.length > 0) {
    try {
      await db.batch(writes as [never, ...never[]]);
    } catch (error) {
      // La resolución previa cubre reintentos y lotes ya existentes. Esta es
      // la última barrera para dos peticiones simultáneas que leyeron el
      // espacio antes de que cualquiera escribiera.
      if (isUniqueViolation(error, "transactions_series_occurred_on_idx")) {
        throw new RecurrenceOccurrenceConflictError();
      }
      throw error;
    }
  }

  return {
    categoryCount: payload.categories.length,
    moneyAccountCount: moneyAccountRows.length,
    recurringSeriesCount: payload.recurringSeries.length,
    transactionCount: payload.transactions.length,
    ...(syncedTransactions.length ? { transactions: syncedTransactions } : {}),
  };
}

function customRateIdValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

async function assertRemoteIdsBelongToSpace(
  db: Database,
  spaceId: string,
  payload: SpaceSyncPayload,
): Promise<void> {
  const categoryIds = remoteUuidIds(payload.categories);
  const accountIds = remoteUuidIds(payload.moneyAccounts);
  const seriesIds = remoteUuidIds(payload.recurringSeries);
  const transactionIds = remoteUuidIds(payload.transactions);
  const [categoryOwners, accountOwners, seriesOwners, transactionOwners] = await Promise.all([
    categoryIds.length
      ? db.select({ id: categories.id, spaceId: categories.spaceId }).from(categories).where(inArray(categories.id, categoryIds))
      : Promise.resolve([]),
    accountIds.length
      ? db.select({ id: moneyAccounts.id, spaceId: moneyAccounts.spaceId }).from(moneyAccounts).where(inArray(moneyAccounts.id, accountIds))
      : Promise.resolve([]),
    seriesIds.length
      ? db.select({ id: recurringTransactionSeries.id, spaceId: recurringTransactionSeries.spaceId }).from(recurringTransactionSeries).where(inArray(recurringTransactionSeries.id, seriesIds))
      : Promise.resolve([]),
    transactionIds.length
      ? db.select({ id: transactions.id, spaceId: transactions.spaceId }).from(transactions).where(inArray(transactions.id, transactionIds))
      : Promise.resolve([]),
  ]);

  assertCollectionOwners("categories", payload.categories, categoryOwners, spaceId);
  assertCollectionOwners("moneyAccounts", payload.moneyAccounts, accountOwners, spaceId);
  assertCollectionOwners("recurringSeries", payload.recurringSeries, seriesOwners, spaceId);
  assertCollectionOwners("transactions", payload.transactions, transactionOwners, spaceId);
}

function remoteUuidIds(rows: Row[]): string[] {
  return [...new Set(rows.flatMap((row) =>
    typeof row.remoteId === "string" && UUID.test(row.remoteId) ? [row.remoteId] : []
  ))];
}

function assertCollectionOwners(
  collection: keyof Pick<SpaceSyncPayload, "categories" | "moneyAccounts" | "recurringSeries" | "transactions">,
  rows: Row[],
  owners: { id: string; spaceId: string }[],
  spaceId: string,
): void {
  const foreignIds = new Set(owners.filter((owner) => owner.spaceId !== spaceId).map((owner) => owner.id));
  const index = rows.findIndex((row) => typeof row.remoteId === "string" && foreignIds.has(row.remoteId));
  if (index < 0) return;
  throw syncIssue(
    "ENTITY_BELONGS_TO_ANOTHER_SPACE",
    [collection, index, "remoteId"],
    "REMOTE_ID_NOT_AVAILABLE_IN_SPACE",
    rows[index],
    collection,
  );
}

function validatePayload(payload: SpaceSyncPayload): void {
  validateUniqueLocalIds(payload);
  for (const [index, row] of payload.categories.entries()) validateSyncedCategory(row, index);
  for (const [index, row] of payload.moneyAccounts.entries()) validateSyncedAccount(row, index);
  for (const [index, row] of payload.recurringSeries.entries()) validateSyncedSeries(row, index);
  for (const [index, row] of payload.transactions.entries()) validateSyncedTransaction(row, index);
}

function validateSyncedCategory(row: Row, index: number): void {
  assertAllowedFields(row, index, "categories", "category", [
    "id", "remoteId", "name", "icon", "colorToken", "budgetMinor", "budgets",
    "isDefault", "templateKey", "isArchived", "createdAt", "updatedAt", "createdBy",
  ]);
  requiredText(row.name, ["categories", index, "name"], row, "category");
  requiredBoolean(row.isDefault, ["categories", index, "isDefault"], row, "category");
  requiredBoolean(row.isArchived, ["categories", index, "isArchived"], row, "category");
  requiredTimestamp(row.createdAt, ["categories", index, "createdAt"], row, "category");
  requiredTimestamp(row.updatedAt, ["categories", index, "updatedAt"], row, "category");
  if (row.budgetMinor !== null && row.budgetMinor !== undefined) {
    nonNegativeInteger(row.budgetMinor, ["categories", index, "budgetMinor"], row, "category");
  }
  if (row.budgets !== undefined) {
    if (!Array.isArray(row.budgets)) throw syncIssue("INVALID_SYNC_PAYLOAD", ["categories", index, "budgets"], "EXPECTED_ARRAY", row, "category");
    const currencies = new Set<string>();
    for (const [budgetIndex, value] of row.budgets.entries()) {
      if (!isRow(value)) throw syncIssue("INVALID_SYNC_PAYLOAD", ["categories", index, "budgets", budgetIndex], "EXPECTED_OBJECT", row, "category");
      const currency = currencyCode(value.currency, ["categories", index, "budgets", budgetIndex, "currency"], row, "category");
      if (currencies.has(currency)) throw syncIssue("INVALID_SYNC_PAYLOAD", ["categories", index, "budgets", budgetIndex, "currency"], "DUPLICATE_CURRENCY", row, "category");
      currencies.add(currency);
      nonNegativeInteger(value.budgetAmountMinor, ["categories", index, "budgets", budgetIndex, "budgetAmountMinor"], row, "category");
    }
  }
}

function validateSyncedAccount(row: Row, index: number): void {
  assertAllowedFields(row, index, "moneyAccounts", "moneyAccount", [
    "id", "remoteId", "name", "kind", "icon", "colorToken", "currency", "balances",
    "isArchived", "createdAt", "updatedAt", "createdBy",
  ]);
  requiredText(row.name, ["moneyAccounts", index, "name"], row, "moneyAccount");
  if (row.kind !== "cash" && row.kind !== "bank" && row.kind !== "card") {
    throw syncIssue("INVALID_SYNC_PAYLOAD", ["moneyAccounts", index, "kind"], "INVALID_ACCOUNT_KIND", row, "moneyAccount");
  }
  currencyCode(row.currency, ["moneyAccounts", index, "currency"], row, "moneyAccount");
  requiredBoolean(row.isArchived, ["moneyAccounts", index, "isArchived"], row, "moneyAccount");
  requiredTimestamp(row.createdAt, ["moneyAccounts", index, "createdAt"], row, "moneyAccount");
  requiredTimestamp(row.updatedAt, ["moneyAccounts", index, "updatedAt"], row, "moneyAccount");
  if (!Array.isArray(row.balances) || row.balances.length === 0) {
    throw syncIssue("INVALID_SYNC_PAYLOAD", ["moneyAccounts", index, "balances"], "REQUIRES_AT_LEAST_ONE_BALANCE", row, "moneyAccount");
  }
  const currencies = new Set<string>();
  for (const [balanceIndex, value] of row.balances.entries()) {
    if (!isRow(value)) throw syncIssue("INVALID_SYNC_PAYLOAD", ["moneyAccounts", index, "balances", balanceIndex], "EXPECTED_OBJECT", row, "moneyAccount");
    const currency = currencyCode(value.currency, ["moneyAccounts", index, "balances", balanceIndex, "currency"], row, "moneyAccount");
    if (currencies.has(currency)) throw syncIssue("INVALID_SYNC_PAYLOAD", ["moneyAccounts", index, "balances", balanceIndex, "currency"], "DUPLICATE_CURRENCY", row, "moneyAccount");
    currencies.add(currency);
    syncInteger(value.openingBalanceMinor, ["moneyAccounts", index, "balances", balanceIndex, "openingBalanceMinor"], row, "moneyAccount");
    nonNegativeInteger(value.position ?? value.displayOrder, ["moneyAccounts", index, "balances", balanceIndex, "position"], row, "moneyAccount");
  }
  // La regla de pertenencia de la moneda primaria se comprueba después de
  // conocer el país, para que VE pueda devolver su código específico.
}

function validateSyncedSeries(row: Row, index: number): void {
  assertAllowedFields(row, index, "recurringSeries", "recurringSeries", [
    "id", "remoteId", "categoryId", "moneyAccountId", "createdBy", "type", "amountMinor",
    "currency", "title", "frequency", "startsOn", "generatedOccurrences", "nextOccurrenceOn",
    "isArchived", "createdAt", "updatedAt",
  ]);
  requiredText(row.categoryId, ["recurringSeries", index, "categoryId"], row, "recurringSeries");
  requiredTransactionType(row.type, ["recurringSeries", index, "type"], row, "recurringSeries");
  positiveInteger(row.amountMinor, ["recurringSeries", index, "amountMinor"], row, "recurringSeries");
  currencyCode(row.currency, ["recurringSeries", index, "currency"], row, "recurringSeries");
  requiredText(row.title, ["recurringSeries", index, "title"], row, "recurringSeries");
  if (!new Set(["weekly", "biweekly", "monthly", "custom"]).has(String(row.frequency))) {
    throw syncIssue("INVALID_SYNC_PAYLOAD", ["recurringSeries", index, "frequency"], "INVALID_FREQUENCY", row, "recurringSeries");
  }
  requiredDateOnly(row.startsOn, ["recurringSeries", index, "startsOn"], row, "recurringSeries");
  if (row.generatedOccurrences !== undefined) {
    nonNegativeInteger(row.generatedOccurrences, ["recurringSeries", index, "generatedOccurrences"], row, "recurringSeries");
  }
  if (row.nextOccurrenceOn !== null && row.nextOccurrenceOn !== undefined) requiredDateOnly(row.nextOccurrenceOn, ["recurringSeries", index, "nextOccurrenceOn"], row, "recurringSeries");
  requiredBoolean(row.isArchived, ["recurringSeries", index, "isArchived"], row, "recurringSeries");
  requiredTimestamp(row.createdAt, ["recurringSeries", index, "createdAt"], row, "recurringSeries");
  requiredTimestamp(row.updatedAt, ["recurringSeries", index, "updatedAt"], row, "recurringSeries");
}

function validateSyncedTransaction(row: Row, index: number) {
  // Las equivalencias congeladas solo se originan en el servidor. Este filtro
  // explícito evita que un cliente offline (o una versión antigua modificada)
  // pueda inyectar una tasa que luego parezca histórica.
  const allowedFields = new Set([
    "id", "remoteId", "categoryId", "moneyAccountId", "createdBy", "type",
    "amountMinor", "currency", "title", "occurredOn", "note", "recurrence",
    "recurrenceGroupId", "recurrenceSeriesId", "sourceTransactionId", "isArchived",
    "createdAt", "updatedAt", "customRateId",
  ]);
  const unexpected = Object.keys(row).find((field) => !allowedFields.has(field));
  if (unexpected) throw syncIssue("INVALID_SYNC_PAYLOAD", ["transactions", index, unexpected], "FIELD_NOT_ALLOWED", row, "transaction");
  if (Object.prototype.hasOwnProperty.call(row, "customRateId") && customRateIdValue(row.customRateId) === undefined) {
    throw syncIssue("INVALID_SYNC_PAYLOAD", ["transactions", index, "customRateId"], "INVALID_UUID", row, "transaction");
  }
  requiredText(row.categoryId, ["transactions", index, "categoryId"], row, "transaction");
  requiredTransactionType(row.type, ["transactions", index, "type"], row, "transaction");
  positiveInteger(row.amountMinor, ["transactions", index, "amountMinor"], row, "transaction");
  currencyCode(row.currency, ["transactions", index, "currency"], row, "transaction");
  requiredText(row.title, ["transactions", index, "title"], row, "transaction");
  requiredDateOnly(row.occurredOn, ["transactions", index, "occurredOn"], row, "transaction");
  requiredBoolean(row.isArchived, ["transactions", index, "isArchived"], row, "transaction");
  requiredTimestamp(row.createdAt, ["transactions", index, "createdAt"], row, "transaction");
  requiredTimestamp(row.updatedAt, ["transactions", index, "updatedAt"], row, "transaction");
}

/** Las cuentas de sync son otra puerta de escritura, no un bypass de VE. */
function validateVeSyncedAccount(row: Row, index: number): void {
  if (Boolean(row.isArchived)) return;
  const balances = Array.isArray(row.balances) ? (row.balances as Row[]) : [];
  if (balances.length !== 1 || balances[0]?.currency !== "USD") {
    throw syncIssue("VE_ACCOUNT_MULTI_CURRENCY_NOT_ALLOWED", ["moneyAccounts", index, "balances"], "VE_REQUIRES_SINGLE_USD_BALANCE", row, "moneyAccount", "VE", "USD");
  }
  if (row.currency !== "USD") {
    throw syncIssue("INVALID_MONEY_ACCOUNT_CURRENCY", ["moneyAccounts", index, "currency"], "VE_REQUIRES_USD_ACCOUNT", row, "moneyAccount", "VE", "USD");
  }
}

function validatePrimaryAccountBalance(row: Row, index: number): void {
  const balances = row.balances as Row[];
  if (!balances.some((balance) => balance.currency === row.currency)) {
    throw syncIssue("INVALID_SYNC_PAYLOAD", ["moneyAccounts", index, "balances"], "PRIMARY_CURRENCY_BALANCE_REQUIRED", row, "moneyAccount");
  }
}

function validateUniqueLocalIds(payload: SpaceSyncPayload): void {
  for (const collection of ["categories", "moneyAccounts", "recurringSeries", "transactions"] as const) {
    const seen = new Set<string>();
    for (const [index, row] of payload[collection].entries()) {
      const id = text(row.id);
      if (!id) throw syncIssue("INVALID_SYNC_PAYLOAD", [collection, index, "id"], "REQUIRED_STRING", row, collection);
      if (seen.has(id)) throw syncIssue("INVALID_SYNC_PAYLOAD", [collection, index, "id"], "DUPLICATE_LOCAL_ID", row, collection);
      seen.add(id);
    }
  }
}

function syncIssue(
  code: SyncValidationCode,
  path: (string | number)[],
  reason: string,
  row?: Row,
  entityType?: string,
  countryCode?: string | null,
  canonicalCurrency?: string,
) {
  return new SyncValidationError(code, {
    path,
    reason,
    entityType,
    localEntityId: row ? text(row.id) || undefined : undefined,
    countryCode,
    canonicalCurrency,
  });
}

function syncInteger(value: unknown, path: (string | number)[], row: Row, entityType: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw syncIssue("INVALID_SYNC_PAYLOAD", path, "EXPECTED_SAFE_INTEGER_NUMBER", row, entityType);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: (string | number)[], row: Row, entityType: string) {
  const parsed = syncInteger(value, path, row, entityType);
  if (parsed < 0) throw syncIssue("INVALID_SYNC_PAYLOAD", path, "MUST_BE_NON_NEGATIVE", row, entityType);
  return parsed;
}

function positiveInteger(value: unknown, path: (string | number)[], row: Row, entityType: string) {
  const parsed = syncInteger(value, path, row, entityType);
  if (parsed <= 0) throw syncIssue("INVALID_SYNC_PAYLOAD", path, "MUST_BE_POSITIVE", row, entityType);
  return parsed;
}

function currencyCode(value: unknown, path: (string | number)[], row: Row, entityType: string) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw syncIssue("INVALID_SYNC_PAYLOAD", path, "EXPECTED_ISO_4217_CODE", row, entityType);
  }
  return value;
}

function requiredText(value: unknown, path: (string | number)[], row: Row, entityType: string): string {
  const parsed = text(value);
  if (!parsed) throw syncIssue("INVALID_SYNC_PAYLOAD", path, "REQUIRED_STRING", row, entityType);
  return parsed;
}

function requiredBoolean(value: unknown, path: (string | number)[], row: Row, entityType: string): void {
  if (typeof value !== "boolean") throw syncIssue("INVALID_SYNC_PAYLOAD", path, "EXPECTED_BOOLEAN", row, entityType);
}

function requiredTimestamp(value: unknown, path: (string | number)[], row: Row, entityType: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw syncIssue("INVALID_SYNC_PAYLOAD", path, "EXPECTED_ISO_TIMESTAMP", row, entityType);
  }
}

function requiredDateOnly(value: unknown, path: (string | number)[], row: Row, entityType: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw syncIssue("INVALID_SYNC_PAYLOAD", path, "EXPECTED_ISO_DATE", row, entityType);
  }
}

function requiredTransactionType(value: unknown, path: (string | number)[], row: Row, entityType: string): void {
  if (value !== "income" && value !== "expense") {
    throw syncIssue("INVALID_SYNC_PAYLOAD", path, "INVALID_TRANSACTION_TYPE", row, entityType);
  }
}

function assertAllowedFields(
  row: Row,
  index: number,
  collection: string,
  entityType: string,
  fields: string[],
): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(row).find((field) => !allowed.has(field));
  if (unexpected) throw syncIssue("INVALID_SYNC_PAYLOAD", [collection, index, unexpected], "FIELD_NOT_ALLOWED", row, entityType);
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function existingCustomRateId(rows: { rateSource: string; customRateId: string | null }[] | undefined): string | null | undefined {
  const custom = rows?.find((row) => row.rateSource === "CUSTOM");
  return custom?.customRateId;
}

function isUnchangedLegacyVeTransaction(
  existing: ExistingTransaction,
  row: Row,
  knownCategories: Map<string, string>,
  knownAccounts: Map<string, string>,
  knownSeries: Map<string, string>,
) {
  return existing.categoryId === reference(knownCategories, row.categoryId)
    && existing.moneyAccountId === reference(knownAccounts, row.moneyAccountId)
    && existing.type === transactionType(row.type)
    && existing.amountMinor === BigInt(Math.max(1, integer(row.amountMinor)))
    && existing.currency === text(row.currency)
    && existing.title === text(row.title)
    && existing.occurredOn === dateOnly(row.occurredOn, "")
    && existing.note === stringOrNull(row.note)
    && existing.recurrence === recurrenceKind(row.recurrence)
    && existing.recurrenceGroupId === stringOrNull(row.recurrenceGroupId)
    && existing.recurrenceSeriesId === reference(knownSeries, row.recurrenceSeriesId)
    && existing.isArchived === Boolean(row.isArchived);
}

function referenceMap(
  resolved: Map<string, string>,
  existing: ExistingCategory[],
  aliases: { sourceLocalId: string; categoryId: string }[] = [],
) {
  const map = new Map(resolved);
  for (const row of existing) {
    if (row.sourceLocalId && !map.has(row.sourceLocalId)) map.set(row.sourceLocalId, row.id);
    if (row.templateKey && !map.has(row.templateKey)) map.set(row.templateKey, row.id);
    if (!map.has(row.id)) map.set(row.id, row.id);
  }
  for (const alias of aliases) {
    if (!map.has(alias.sourceLocalId)) map.set(alias.sourceLocalId, alias.categoryId);
  }
  return map;
}

function reference(map: Map<string, string>, value: unknown): string | null {
  const localId = text(value);
  if (!localId) return null;
  return map.get(localId) ?? null;
}

/** `undefined` distingue una referencia enviada pero desconocida de `null`. */
function nullableReference(map: Map<string, string>, value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const localId = text(value);
  if (!localId) return undefined;
  return map.get(localId);
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("INVALID_PAYLOAD");
  }
  return value;
}

function date(value: unknown, fallback: Date) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value);
}

function dateOnly(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (match) return match[1];
  }
  return fallback;
}

function accountKind(value: unknown) {
  if (value === "cash" || value === "bank" || value === "card") return value;
  throw new Error("INVALID_PAYLOAD");
}

function transactionType(value: unknown) {
  if (value === "income" || value === "expense") return value;
  throw new Error("INVALID_PAYLOAD");
}

function frequency(value: unknown) {
  if (value === "weekly" || value === "biweekly" || value === "monthly" || value === "custom") {
    return value;
  }
  throw new Error("INVALID_PAYLOAD");
}

function recurrenceKind(value: unknown) {
  if (value === undefined || value === null) return "once" as const;
  if (
    value === "once" ||
    value === "weekly" ||
    value === "biweekly" ||
    value === "monthly" ||
    value === "custom"
  ) {
    return value;
  }
  throw new Error("INVALID_PAYLOAD");
}
