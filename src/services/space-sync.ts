import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  categories,
  categoryAliases,
  categoryBudgets,
  moneyAccountBalances,
  moneyAccounts,
  recurringTransactionSeries,
  spaces,
  transactions,
} from "../db/schema";

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
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Existing = { id: string; sourceInstallationId: string | null; sourceLocalId: string | null };
type ExistingCategory = Existing & { templateKey?: string | null };

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
): Promise<SpaceSyncResult> {
  const installationId = text(payload.installationId);
  if (!installationId) throw new Error("INVALID_PAYLOAD");

  const [space] = await db
    .select({ currency: spaces.currency })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space) throw new Error("SPACE_NOT_FOUND");

  const [
    existingCategories,
    existingAccounts,
    existingSeries,
    existingTransactions,
    existingCategoryAliases,
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
    ]);

  const categoryIds = resolveCategoryIds(existingCategories, payload.categories, installationId);
  const accountIds = resolveIds(existingAccounts, payload.moneyAccounts, installationId);
  const seriesIds = resolveIds(existingSeries, payload.recurringSeries, installationId);
  const transactionIds = resolveIds(existingTransactions, payload.transactions, installationId);

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
  const source = (localId: string) => ({
    sourceInstallationId: installationId,
    sourceLocalId: localId,
  });

  const writes: unknown[] = [];

  for (const row of payload.categories) {
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
          createdBy: stringOrNull(row.createdBy) ?? userId,
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

    // El cliente todavía envía el presupuesto local como un único importe sin
    // moneda propia; se registra en la del espacio.
    const budget = row.budgetMinor;
    if (typeof budget === "number" && Number.isSafeInteger(budget) && budget > 0) {
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

  for (const row of payload.moneyAccounts) {
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
          createdBy: stringOrNull(row.createdBy) ?? userId,
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
    for (const balance of balances) {
      writes.push(
        db.insert(moneyAccountBalances).values({
          moneyAccountId: id,
          currency: text(balance.currency),
          openingBalanceMinor: BigInt(integer(balance.openingBalanceMinor ?? 0)),
          displayOrder: integer(balance.position ?? balance.displayOrder ?? 0),
        }),
      );
    }
  }

  for (const row of payload.recurringSeries) {
    const localId = text(row.id);
    const id = seriesIds.get(localId)!;
    const updatedAt = date(row.updatedAt, now);
    const isArchived = Boolean(row.isArchived);
    const categoryId = reference(knownCategories, row.categoryId);
    if (!categoryId) throw new Error("INVALID_GRAPH");

    const rawAmount = integer(row.amountMinor);
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
          moneyAccountId: reference(knownAccounts, row.moneyAccountId),
          createdBy: stringOrNull(row.createdBy) ?? userId,
          type: transactionType(row.type),
          amountMinor,
          currency: text(row.currency),
          title: text(row.title),
          frequency: frequency(row.frequency),
          startsOn,
          nextOccurrenceOn,
          generatedOccurrences: integer(row.generatedOccurrences ?? 0),
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

  for (const row of payload.transactions) {
    const localId = text(row.id);
    const id = transactionIds.get(localId)!;
    const updatedAt = date(row.updatedAt, now);
    const isArchived = Boolean(row.isArchived);
    const categoryId = reference(knownCategories, row.categoryId);
    if (!categoryId) throw new Error("INVALID_GRAPH");

    const rawAmount = integer(row.amountMinor);
    const amountMinor = BigInt(Math.max(1, rawAmount));
    const occurredOn = dateOnly(row.occurredOn, now.toISOString().slice(0, 10));

    writes.push(
      db
        .insert(transactions)
        .values({
          id,
          spaceId,
          categoryId,
          moneyAccountId: reference(knownAccounts, row.moneyAccountId),
          createdBy: stringOrNull(row.createdBy) ?? userId,
          type: transactionType(row.type),
          amountMinor,
          currency: text(row.currency),
          title: text(row.title),
          occurredOn,
          note: stringOrNull(row.note),
          recurrence: recurrenceKind(row.recurrence),
          recurrenceGroupId: stringOrNull(row.recurrenceGroupId),
          recurrenceSeriesId: reference(knownSeries, row.recurrenceSeriesId),
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
            currency: sql`excluded.currency`,
            title: sql`excluded.title`,
            occurredOn: sql`excluded.occurred_on`,
            note: sql`excluded.note`,
            recurrence: sql`excluded.recurrence`,
            recurrenceGroupId: sql`excluded.recurrence_group_id`,
            recurrenceSeriesId: sql`excluded.recurrence_series_id`,
            sourceLocalTransactionId: sql`excluded.source_local_transaction_id`,
            sourceInstallationId: sql`excluded.source_installation_id`,
            sourceLocalId: sql`excluded.source_local_id`,
            createdBy: sql`COALESCE(${transactions.createdBy}, excluded.created_by)`,
            isArchived: sql`excluded.is_archived`,
            archivedAt: sql`excluded.archived_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`${transactions.spaceId} = ${spaceId} AND excluded.updated_at >= ${transactions.updatedAt}`,
        }),
    );
  }

  if (writes.length > 0) {
    await db.batch(writes as [never, ...never[]]);
  }

  return {
    categoryCount: payload.categories.length,
    moneyAccountCount: payload.moneyAccounts.length,
    recurringSeriesCount: payload.recurringSeries.length,
    transactionCount: payload.transactions.length,
  };
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
