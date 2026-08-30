import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { countryFromLocale } from "../src/services/local-ids";
import { syncImportBatches, syncMerchantRules } from "../src/services/imports";

const SPACE = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-29T10:00:00.000Z";

type Captured = { table: string; values: Record<string, unknown> };

/**
 * Las lecturas responden en el orden del servicio: membresías (por cada espacio
 * local distinto), categorías del espacio y lotes ya enlazados.
 */
function fakeDatabase(reads: unknown[][]) {
  let call = 0;
  const captured: Captured[] = [];
  const batch = vi.fn().mockResolvedValue([]);

  const rowsNow = () => reads[call++] ?? [];
  const db = {
    select: () => ({
      from: () => {
        const rows = rowsNow();
        const chain: Record<string, unknown> = {
          innerJoin: () => chain,
          where: () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) }),
        };
        return chain;
      },
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => {
      const builder = {
        values: (values: Record<string, unknown>) => {
          captured.push({ table: getTableName(table), values });
          return { ...builder, onConflictDoUpdate: () => builder };
        },
        onConflictDoUpdate: () => builder,
      };
      return builder;
    },
    batch,
  } as unknown as Database;

  return { db, captured, batch };
}

const membership = [{ id: SPACE, sourceInstallationId: "install-1", sourceLocalId: "duo" }];
const categoryRows = [
  { id: CATEGORY, sourceInstallationId: "install-1", sourceLocalId: "local-cat" },
];

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    space_local_id: "duo",
    source_type: "csv",
    status: "needs_review",
    total_items: 2,
    review_items: 1,
    duplicate_items: 0,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    file_hash: "abc",
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    batch_id: "33333333-3333-4333-8333-333333333333",
    category_local_id: "local-cat",
    source_row: 1,
    raw_description: "MERCADONA 1234",
    normalized_merchant: "mercadona",
    occurred_on: "2026-08-20",
    amount_minor: 1250,
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

function rowsFor(captured: Captured[], table: string) {
  return captured.filter((entry) => entry.table === table).map((entry) => entry.values);
}

describe("import batch sync", () => {
  it("does nothing when there are no batches", async () => {
    const { db, batch } = fakeDatabase([]);

    await expect(
      syncImportBatches(db, "user-1", { installationId: "install-1", batches: [], items: [] }),
    ).resolves.toEqual({ batchCount: 0, itemCount: 0 });
    expect(batch).not.toHaveBeenCalled();
  });

  it("resolves the local space and category to their remote ids", async () => {
    const { db, captured } = fakeDatabase([membership, categoryRows, []]);

    const result = await syncImportBatches(db, "user-1", {
      installationId: "install-1",
      batches: [batchRow()],
      items: [itemRow()],
    });

    expect(result).toEqual({ batchCount: 1, itemCount: 1 });
    expect(rowsFor(captured, "import_batches")[0]).toMatchObject({
      spaceId: SPACE,
      userId: "user-1",
      sourceLocalId: "33333333-3333-4333-8333-333333333333",
    });
    expect(rowsFor(captured, "import_items")[0]).toMatchObject({
      finalCategoryId: CATEGORY,
      amountMinor: 1250n,
    });
  });

  it("refuses a batch for a space the user does not belong to", async () => {
    const { db } = fakeDatabase([[], []]);

    await expect(
      syncImportBatches(db, "user-1", {
        installationId: "install-1",
        batches: [batchRow({ space_local_id: "someone-elses" })],
        items: [],
      }),
    ).rejects.toThrow("SPACE_NOT_FOUND");
  });

  it("refuses an item whose batch is nowhere to be found", async () => {
    const { db } = fakeDatabase([membership, categoryRows, []]);

    await expect(
      syncImportBatches(db, "user-1", {
        installationId: "install-1",
        batches: [batchRow()],
        items: [itemRow({ batch_id: "ghost-batch" })],
      }),
    ).rejects.toThrow("INVALID_GRAPH");
  });

  it("leaves the category empty when the item has none", async () => {
    const { db, captured } = fakeDatabase([membership, categoryRows, []]);

    await syncImportBatches(db, "user-1", {
      installationId: "install-1",
      batches: [batchRow()],
      items: [itemRow({ category_local_id: null })],
    });

    expect(rowsFor(captured, "import_items")[0]?.finalCategoryId).toBeNull();
  });
});

describe("merchant rules sync", () => {
  it("rejects a rule pointing at an unknown category", async () => {
    const { db } = fakeDatabase([membership, categoryRows]);

    await expect(
      syncMerchantRules(db, "user-1", {
        installationId: "install-1",
        rules: [
          {
            local_id: "rule-1",
            space_local_id: "duo",
            category_local_id: "ghost",
            normalized_merchant: "mercadona",
            confirmations: 2,
            source: "manual",
            last_used_at: null,
            created_at: NOW,
            updated_at: NOW,
          },
        ],
      }),
    ).rejects.toThrow("INVALID_GRAPH");
  });

  it("stores the rule against the resolved space and category", async () => {
    const { db, captured } = fakeDatabase([membership, categoryRows]);

    const count = await syncMerchantRules(db, "user-1", {
      installationId: "install-1",
      rules: [
        {
          local_id: "rule-1",
          space_local_id: "duo",
          category_local_id: "local-cat",
          normalized_merchant: "mercadona",
          confirmations: 3,
          source: "import_correction",
          last_used_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });

    expect(count).toBe(1);
    expect(rowsFor(captured, "user_merchant_rules")[0]).toMatchObject({
      userId: "user-1",
      spaceId: SPACE,
      categoryId: CATEGORY,
      confirmations: 3,
      source: "import_correction",
    });
  });
});

describe("merchant feedback country", () => {
  it("derives the region from the profile locale", () => {
    expect(countryFromLocale("es-ES")).toBe("ES");
    expect(countryFromLocale("en-us")).toBe("US");
  });

  it("falls back when the locale carries no region", () => {
    // El cliente no envía país; sin región no se puede atribuir el voto.
    expect(countryFromLocale("es")).toBe("XX");
    expect(countryFromLocale(null)).toBe("XX");
  });
});
