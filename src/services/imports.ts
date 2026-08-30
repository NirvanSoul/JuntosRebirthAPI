import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  importBatches,
  importItems,
  merchantFeedbackAggregates,
  merchantFeedbackVotes,
  userMerchantRules,
  userProfiles,
} from "../db/schema";
import { categoryIdResolver, countryFromLocale, resolveSpaceId, UUID } from "./local-ids";

type Row = Record<string, unknown>;

/**
 * Las filas llegan con los mismos nombres en snake_case que ya construía el
 * gateway del cliente para las RPC `sync_import_batches` y
 * `sync_import_merchant_rules`, de modo que portarlo es cambiar el transporte
 * y nada más.
 */
export type ImportSyncPayload = {
  installationId: string;
  batches: Row[];
  items: Row[];
};

export type ImportSyncResult = { batchCount: number; itemCount: number };

export async function syncImportBatches(
  db: Database,
  userId: string,
  payload: ImportSyncPayload,
): Promise<ImportSyncResult> {
  const installationId = text(payload.installationId);
  if (!installationId) throw new Error("INVALID_PAYLOAD");
  if (payload.batches.length === 0) return { batchCount: 0, itemCount: 0 };

  // Un lote pertenece a un espacio; se resuelve una vez por espacio local.
  const spaceIdByLocalId = new Map<string, string>();
  for (const batch of payload.batches) {
    const localSpaceId = text(batch.space_local_id);
    if (!localSpaceId) throw new Error("INVALID_PAYLOAD");
    if (spaceIdByLocalId.has(localSpaceId)) continue;

    const spaceId = await resolveSpaceId(db, userId, installationId, localSpaceId);
    if (!spaceId) throw new Error("SPACE_NOT_FOUND");
    spaceIdByLocalId.set(localSpaceId, spaceId);
  }

  const spaceIds = [...new Set(spaceIdByLocalId.values())];
  const resolveCategory = await categoryIdResolver(db, spaceIds, installationId);

  const existingBatches = await db
    .select({ id: importBatches.id, sourceLocalId: importBatches.sourceLocalId })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.userId, userId),
        eq(importBatches.sourceInstallationId, installationId),
      ),
    );
  const batchIdByLocalId = new Map(
    existingBatches
      .filter((batch) => batch.sourceLocalId)
      .map((batch) => [batch.sourceLocalId as string, batch.id]),
  );
  for (const batch of payload.batches) {
    const localId = text(batch.id);
    if (!localId) throw new Error("INVALID_PAYLOAD");
    if (!batchIdByLocalId.has(localId)) {
      batchIdByLocalId.set(localId, UUID.test(localId) ? localId : crypto.randomUUID());
    }
  }

  const writes: unknown[] = [];

  for (const batch of payload.batches) {
    const localId = text(batch.id);
    const id = batchIdByLocalId.get(localId)!;
    const updatedAt = date(batch.updated_at);

    writes.push(
      db
        .insert(importBatches)
        .values({
          id,
          userId,
          spaceId: spaceIdByLocalId.get(text(batch.space_local_id))!,
          sourceType: sourceType(batch.source_type),
          sourceProfile: stringOrNull(batch.source_profile),
          fileHash: stringOrNull(batch.file_hash),
          status: batchStatus(batch.status),
          totalItems: integer(batch.total_items ?? 0),
          reviewItems: integer(batch.review_items ?? 0),
          duplicateItems: integer(batch.duplicate_items ?? 0),
          sourceInstallationId: installationId,
          sourceLocalId: localId,
          createdAt: date(batch.created_at),
          updatedAt,
          completedAt: dateOrNull(batch.completed_at),
        })
        .onConflictDoUpdate({
          target: importBatches.id,
          set: {
            spaceId: sql`excluded.space_id`,
            sourceType: sql`excluded.source_type`,
            sourceProfile: sql`excluded.source_profile`,
            fileHash: sql`excluded.file_hash`,
            status: sql`excluded.status`,
            totalItems: sql`excluded.total_items`,
            reviewItems: sql`excluded.review_items`,
            duplicateItems: sql`excluded.duplicate_items`,
            completedAt: sql`excluded.completed_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`${importBatches.userId} = ${userId} AND excluded.updated_at >= ${importBatches.updatedAt}`,
        }),
    );
  }

  for (const item of payload.items) {
    const batchLocalId = text(item.batch_id);
    const batchId = batchIdByLocalId.get(batchLocalId);
    // Un item cuyo lote no viaja ni existe no tiene dónde colgarse.
    if (!batchId) throw new Error("INVALID_GRAPH");

    const localId = text(item.id);
    if (!localId) throw new Error("INVALID_PAYLOAD");

    writes.push(
      db
        .insert(importItems)
        .values({
          id: UUID.test(localId) ? localId : crypto.randomUUID(),
          batchId,
          sourceRow: integer(item.source_row),
          sheetName: stringOrNull(item.sheet_name),
          rawDescription: text(item.raw_description),
          normalizedMerchant: text(item.normalized_merchant),
          occurredOn: stringOrNull(item.occurred_on),
          amountMinor:
            item.amount_minor === null || item.amount_minor === undefined
              ? null
              : BigInt(integer(item.amount_minor)),
          currency: stringOrNull(item.currency),
          movementType: movementType(item.movement_type),
          finalCategoryId: resolveCategory(item.category_local_id),
          duplicateStatus: duplicateStatus(item.duplicate_status),
          duplicateTransactionId: null,
          itemStatus: itemStatus(item.item_status),
          isSelected: Boolean(item.is_selected),
          issues: Array.isArray(item.issues) ? item.issues : [],
          sourceInstallationId: installationId,
          sourceLocalId: localId,
          createdAt: date(item.created_at),
          updatedAt: date(item.updated_at),
        })
        .onConflictDoUpdate({
          target: [importItems.batchId, importItems.sourceInstallationId, importItems.sourceLocalId],
          // El índice es parcial: sin repetir su predicado, PostgreSQL no puede
          // inferirlo y rechaza el ON CONFLICT.
          targetWhere: sql`${importItems.sourceLocalId} IS NOT NULL`,
          set: {
            sourceRow: sql`excluded.source_row`,
            sheetName: sql`excluded.sheet_name`,
            rawDescription: sql`excluded.raw_description`,
            normalizedMerchant: sql`excluded.normalized_merchant`,
            occurredOn: sql`excluded.occurred_on`,
            amountMinor: sql`excluded.amount_minor`,
            currency: sql`excluded.currency`,
            movementType: sql`excluded.movement_type`,
            finalCategoryId: sql`excluded.final_category_id`,
            duplicateStatus: sql`excluded.duplicate_status`,
            itemStatus: sql`excluded.item_status`,
            isSelected: sql`excluded.is_selected`,
            issues: sql`excluded.issues`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`excluded.updated_at >= ${importItems.updatedAt}`,
        }),
    );
  }

  await db.batch(writes as [never, ...never[]]);
  return { batchCount: payload.batches.length, itemCount: payload.items.length };
}

export type MerchantRulePayload = { installationId: string; rules: Row[] };

export async function syncMerchantRules(
  db: Database,
  userId: string,
  payload: MerchantRulePayload,
): Promise<number> {
  const installationId = text(payload.installationId);
  if (!installationId) throw new Error("INVALID_PAYLOAD");
  if (payload.rules.length === 0) return 0;

  const spaceIdByLocalId = new Map<string, string>();
  for (const rule of payload.rules) {
    const localSpaceId = text(rule.space_local_id);
    if (!localSpaceId) throw new Error("INVALID_PAYLOAD");
    if (spaceIdByLocalId.has(localSpaceId)) continue;

    const spaceId = await resolveSpaceId(db, userId, installationId, localSpaceId);
    if (!spaceId) throw new Error("SPACE_NOT_FOUND");
    spaceIdByLocalId.set(localSpaceId, spaceId);
  }

  const resolveCategory = await categoryIdResolver(
    db,
    [...new Set(spaceIdByLocalId.values())],
    installationId,
  );

  const writes = payload.rules.map((rule) => {
    const categoryId = resolveCategory(rule.category_local_id);
    if (!categoryId) throw new Error("INVALID_GRAPH");

    return db
      .insert(userMerchantRules)
      .values({
        userId,
        spaceId: spaceIdByLocalId.get(text(rule.space_local_id))!,
        normalizedMerchant: text(rule.normalized_merchant),
        categoryId,
        confirmations: Math.max(1, integer(rule.confirmations ?? 1)),
        source: ruleSource(rule.source),
        lastUsedAt: dateOrNull(rule.last_used_at),
        createdAt: date(rule.created_at),
        updatedAt: date(rule.updated_at),
      })
      .onConflictDoUpdate({
        target: [
          userMerchantRules.userId,
          userMerchantRules.spaceId,
          userMerchantRules.normalizedMerchant,
        ],
        set: {
          categoryId: sql`excluded.category_id`,
          confirmations: sql`excluded.confirmations`,
          source: sql`excluded.source`,
          lastUsedAt: sql`excluded.last_used_at`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`excluded.updated_at >= ${userMerchantRules.updatedAt}`,
      });
  });

  await db.batch(writes as [never, ...never[]]);
  return payload.rules.length;
}

/**
 * Un voto por persona y comercio, con el agregado global actualizado en la
 * misma escritura para no depender de un proceso de reconstrucción.
 */
export async function recordMerchantFeedback(
  db: Database,
  userId: string,
  input: { importItemId: string; canonicalCategoryKey: string },
): Promise<void> {
  const [item] = await db
    .select({ normalizedMerchant: importItems.normalizedMerchant })
    .from(importItems)
    .innerJoin(importBatches, eq(importItems.batchId, importBatches.id))
    .where(and(eq(importItems.id, input.importItemId), eq(importBatches.userId, userId)))
    .limit(1);
  if (!item) throw new Error("IMPORT_ITEM_NOT_FOUND");

  const [profile] = await db
    .select({ locale: userProfiles.locale })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const countryCode = countryFromLocale(profile?.locale);

  // Dos sentencias dentro de un `db.batch`, que el driver ejecuta como
  // transacción. En un solo CTE no serviría: los CTE comparten instantánea, así
  // que el recuento habría leído el voto anterior en vez del recién escrito.
  await db.batch([
    db.execute(sql`
      INSERT INTO merchant_feedback_votes
        (user_id, country_code, normalized_merchant, canonical_category_key, confirmations)
      VALUES (${userId}, ${countryCode}, ${item.normalizedMerchant}, ${input.canonicalCategoryKey}, 1)
      ON CONFLICT (user_id, country_code, normalized_merchant) DO UPDATE SET
        canonical_category_key = EXCLUDED.canonical_category_key,
        confirmations = merchant_feedback_votes.confirmations + 1,
        updated_at = now()
    `),
    // Se recalculan todas las claves de ese comercio, no solo la votada: si
    // alguien cambia de opinión, la fila de la clave anterior también se corrige.
    db.execute(sql`
      INSERT INTO merchant_feedback_aggregates
        (country_code, normalized_merchant, canonical_category_key, unique_users, total_confirmations, updated_at)
      SELECT v.country_code, v.normalized_merchant, v.canonical_category_key,
             count(DISTINCT v.user_id)::int, coalesce(sum(v.confirmations), 0)::int, now()
        FROM merchant_feedback_votes v
       WHERE v.country_code = ${countryCode} AND v.normalized_merchant = ${item.normalizedMerchant}
       GROUP BY v.country_code, v.normalized_merchant, v.canonical_category_key
      ON CONFLICT (country_code, normalized_merchant, canonical_category_key) DO UPDATE SET
        unique_users = EXCLUDED.unique_users,
        total_confirmations = EXCLUDED.total_confirmations,
        updated_at = now()
    `),
  ]);
}

const REVIEWABLE = ["needs_review", "ready", "failed"] as const;

/** Sustituye a `fetchRemoteImportReviews`: lotes pendientes de revisar en otro dispositivo. */
export async function listImportReviews(db: Database, userId: string) {
  const batches = await db
    .select({
      id: importBatches.id,
      spaceId: importBatches.spaceId,
      sourceType: importBatches.sourceType,
      status: importBatches.status,
      totalItems: importBatches.totalItems,
      reviewItems: importBatches.reviewItems,
      duplicateItems: importBatches.duplicateItems,
      createdAt: importBatches.createdAt,
      updatedAt: importBatches.updatedAt,
      completedAt: importBatches.completedAt,
    })
    .from(importBatches)
    .where(
      and(eq(importBatches.userId, userId), inArray(importBatches.status, [...REVIEWABLE])),
    );

  if (batches.length === 0) return [];

  const items = await db
    .select({
      id: importItems.id,
      batchId: importItems.batchId,
      categoryId: importItems.finalCategoryId,
      sourceRow: importItems.sourceRow,
      rawDescription: importItems.rawDescription,
      normalizedMerchant: importItems.normalizedMerchant,
      occurredOn: importItems.occurredOn,
      amountMinor: importItems.amountMinor,
      currency: importItems.currency,
      movementType: importItems.movementType,
      duplicateStatus: importItems.duplicateStatus,
      itemStatus: importItems.itemStatus,
      isSelected: importItems.isSelected,
      issues: importItems.issues,
      createdAt: importItems.createdAt,
      updatedAt: importItems.updatedAt,
    })
    .from(importItems)
    .where(
      inArray(
        importItems.batchId,
        batches.map((batch) => batch.id),
      ),
    );

  return batches.map((batch) => ({
    ...batch,
    items: items
      .filter((item) => item.batchId === batch.id)
      .map(({ amountMinor, ...item }) => ({
        ...item,
        amountMinor: amountMinor === null ? null : amountMinor.toString(),
      })),
  }));
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
function date(value: unknown) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("INVALID_PAYLOAD");
  }
  return new Date(value);
}
function dateOrNull(value: unknown) {
  return value === null || value === undefined ? null : date(value);
}
function oneOf<T extends readonly string[]>(allowed: T, value: unknown): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw new Error("INVALID_PAYLOAD");
}
const sourceType = (value: unknown) => oneOf(["xls", "xlsx", "csv", "tsv"] as const, value);
const batchStatus = (value: unknown) =>
  oneOf(
    ["parsing", "mapping_required", "needs_review", "ready", "imported", "failed", "cancelled"] as const,
    value,
  );
const movementType = (value: unknown) => oneOf(["expense", "income", "unknown"] as const, value);
const duplicateStatus = (value: unknown) => oneOf(["none", "exact", "probable"] as const, value);
const itemStatus = (value: unknown) =>
  oneOf(["pending", "ready", "ignored", "duplicate", "imported", "error"] as const, value);
const ruleSource = (value: unknown) =>
  oneOf(["manual", "import_correction", "system"] as const, value);
