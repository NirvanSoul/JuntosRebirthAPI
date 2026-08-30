import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import {
  listImportReviews,
  recordMerchantFeedback,
  syncImportBatches,
  syncMerchantRules,
} from "../../src/services/imports";
import {
  categories,
  importBatches,
  importItems,
  merchantFeedbackAggregates,
  merchantFeedbackVotes,
  userMerchantRules,
} from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

const db = testDb();
const NOW = "2026-08-29T10:00:00.000Z";
const LATER = "2026-08-29T12:00:00.000Z";

afterAll(cleanupTestUsers);

async function workspace(label: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  const bootstrap = await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  const space = await createSpaceWithOwner(db, userId, {
    name: "Importación",
    type: "other",
    currency: "EUR",
    timezone: "Europe/Madrid",
  });
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.spaceId, space.id), eq(categories.templateKey, "groceries")));
  return { userId, spaceId: space.id, categoryId: category!.id, personalSpaceId: bootstrap.personalSpace.id };
}

function batchRow(spaceLocalId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "local-batch-1",
    space_local_id: spaceLocalId,
    source_type: "csv",
    status: "needs_review",
    total_items: 1,
    review_items: 1,
    duplicate_items: 0,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    file_hash: "hash-abc",
    ...overrides,
  };
}

function itemRow(categoryLocalId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: "local-item-1",
    batch_id: "local-batch-1",
    category_local_id: categoryLocalId,
    source_row: 1,
    raw_description: "MERCADONA 1234 MADRID",
    normalized_merchant: "mercadona",
    occurred_on: "2026-08-20",
    amount_minor: 4599,
    currency: "EUR",
    movement_type: "expense",
    duplicate_status: "none",
    item_status: "pending",
    is_selected: true,
    issues: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("import sync against PostgreSQL", () => {
  it("is idempotent thanks to the partial unique index on the item source id", async () => {
    const { userId, spaceId, categoryId } = await workspace("imp-idem");
    const payload = {
      installationId: "install-A",
      batches: [batchRow(spaceId)],
      items: [itemRow(categoryId)],
    };

    await syncImportBatches(db, userId, payload);
    // El ON CONFLICT apunta a un índice parcial: sin repetir su predicado
    // PostgreSQL no puede inferirlo y rechaza la sentencia.
    await syncImportBatches(db, userId, payload);

    const reviews = await listImportReviews(db, userId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.items).toHaveLength(1);
    expect(reviews[0]?.items[0]).toMatchObject({
      normalizedMerchant: "mercadona",
      amountMinor: "4599",
      categoryId,
    });
  });

  it("resolves the personal space by its local id", async () => {
    const { userId, personalSpaceId } = await workspace("imp-personal");

    // En el dispositivo el espacio personal se llama literalmente "personal".
    await syncImportBatches(db, userId, {
      installationId: "install-A",
      batches: [batchRow("personal")],
      items: [],
    });

    const reviews = await listImportReviews(db, userId);
    expect(reviews[0]?.spaceId).toBe(personalSpaceId);
  });

  it("keeps the newest version of an item and ignores an older one", async () => {
    const { userId, spaceId, categoryId } = await workspace("imp-lww");
    const base = { installationId: "install-A", batches: [batchRow(spaceId)] };

    await syncImportBatches(db, userId, { ...base, items: [itemRow(categoryId)] });
    await syncImportBatches(db, userId, {
      ...base,
      items: [itemRow(categoryId, { item_status: "ready", updated_at: LATER })],
    });
    await syncImportBatches(db, userId, {
      ...base,
      items: [itemRow(categoryId, { item_status: "error", updated_at: "2026-08-29T08:00:00.000Z" })],
    });

    const [stored] = await db
      .select({ itemStatus: importItems.itemStatus })
      .from(importItems)
      .innerJoin(importBatches, eq(importItems.batchId, importBatches.id))
      .where(and(eq(importBatches.userId, userId), eq(importItems.sourceLocalId, "local-item-1")));
    expect(stored?.itemStatus).toBe("ready");
  });

  it("refuses a batch aimed at a space the user does not belong to", async () => {
    const { userId } = await workspace("imp-foreign");
    const stranger = await workspace("imp-foreign-other");

    await expect(
      syncImportBatches(db, userId, {
        installationId: "install-A",
        batches: [batchRow(stranger.spaceId)],
        items: [],
      }),
    ).rejects.toThrow("SPACE_NOT_FOUND");
  });

  it("upserts a merchant rule on the unique triple", async () => {
    const { userId, spaceId, categoryId } = await workspace("imp-rules");
    const rule = {
      local_id: "local-rule-1",
      space_local_id: spaceId,
      category_local_id: categoryId,
      normalized_merchant: "mercadona",
      confirmations: 2,
      source: "import_correction",
      last_used_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    };

    await syncMerchantRules(db, userId, { installationId: "install-A", rules: [rule] });
    await syncMerchantRules(db, userId, {
      installationId: "install-A",
      rules: [{ ...rule, confirmations: 5, updated_at: LATER }],
    });

    const stored = await db
      .select({ confirmations: userMerchantRules.confirmations })
      .from(userMerchantRules)
      .where(and(eq(userMerchantRules.userId, userId), eq(userMerchantRules.spaceId, spaceId)));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.confirmations).toBe(5);
  });
});

describe("merchant feedback against PostgreSQL", () => {
  it("records the vote and keeps the aggregate in the same statement", async () => {
    const { userId, spaceId, categoryId } = await workspace("imp-feedback");
    await syncImportBatches(db, userId, {
      installationId: "install-A",
      batches: [batchRow(spaceId)],
      items: [itemRow(categoryId)],
    });
    const [item] = await db
      .select({ id: importItems.id })
      .from(importItems)
      .innerJoin(importBatches, eq(importItems.batchId, importBatches.id))
      .where(and(eq(importBatches.userId, userId), eq(importItems.sourceLocalId, "local-item-1")));

    await recordMerchantFeedback(db, userId, {
      importItemId: item!.id,
      canonicalCategoryKey: "groceries",
    });
    // Confirmar dos veces suma confirmaciones pero sigue siendo una persona.
    await recordMerchantFeedback(db, userId, {
      importItemId: item!.id,
      canonicalCategoryKey: "groceries",
    });

    const [vote] = await db
      .select({ confirmations: merchantFeedbackVotes.confirmations, country: merchantFeedbackVotes.countryCode })
      .from(merchantFeedbackVotes)
      .where(eq(merchantFeedbackVotes.userId, userId));
    expect(vote?.confirmations).toBe(2);
    // El cliente no envía país; se deriva del locale del perfil, que es "es".
    expect(vote?.country).toBe("XX");

    const [aggregate] = await db
      .select({
        uniqueUsers: merchantFeedbackAggregates.uniqueUsers,
        totalConfirmations: merchantFeedbackAggregates.totalConfirmations,
      })
      .from(merchantFeedbackAggregates)
      .where(
        and(
          eq(merchantFeedbackAggregates.normalizedMerchant, "mercadona"),
          eq(merchantFeedbackAggregates.canonicalCategoryKey, "groceries"),
        ),
      );
    expect(aggregate?.uniqueUsers).toBeGreaterThanOrEqual(1);
    expect(aggregate?.totalConfirmations).toBeGreaterThanOrEqual(2);
  });

  it("refuses to vote on an import item belonging to someone else", async () => {
    const owner = await workspace("imp-fb-owner");
    const stranger = await createTestUser(db, "imp-fb-stranger");
    await syncImportBatches(db, owner.userId, {
      installationId: "install-A",
      batches: [batchRow(owner.spaceId)],
      items: [itemRow(owner.categoryId)],
    });
    const [item] = await db
      .select({ id: importItems.id })
      .from(importItems)
      .innerJoin(importBatches, eq(importItems.batchId, importBatches.id))
      .where(and(eq(importBatches.userId, owner.userId), eq(importItems.sourceLocalId, "local-item-1")));

    await expect(
      recordMerchantFeedback(db, stranger, {
        importItemId: item!.id,
        canonicalCategoryKey: "groceries",
      }),
    ).rejects.toThrow("IMPORT_ITEM_NOT_FOUND");
  });
});
