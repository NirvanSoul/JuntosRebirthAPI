import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { migrateGuest, type GuestPayload } from "../src/services/guest-migration";

type Inserted = { table: string; values: Record<string, unknown> | Record<string, unknown>[] };

/**
 * Doble del driver. `select()` responde en el orden en que el servicio consulta:
 * lote previo, perfil y categorías ya sembradas en el espacio personal.
 */
function fakeDatabase(options: {
  existingBatch?: { status: string };
  personalSpaceId?: string | null;
  seededCategories?: { id: string; templateKey: string }[];
}) {
  const responses: unknown[][] = [
    options.existingBatch ? [options.existingBatch] : [],
    [{ personalSpaceId: "personalSpaceId" in options ? options.personalSpaceId : "personal-remote" }],
    options.seededCategories ?? [],
  ];
  let call = 0;
  const inserted: Inserted[] = [];
  const batch = vi.fn().mockResolvedValue([]);

  const db = {
    select: () => ({
      from: () => {
        const rows = responses[call++] ?? [];
        const result = Promise.resolve(rows);
        return Object.assign(result, { where: () => Promise.resolve(rows) });
      },
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        inserted.push({ table: getTableName(table), values });
        return values;
      },
    }),
    batch,
  } as unknown as Database;

  return { db, inserted, batch };
}

const NOW = "2026-08-29T10:00:00.000Z";

function payload(overrides: Partial<GuestPayload> = {}): GuestPayload {
  return {
    batchId: "batch-1",
    installationId: "install-1",
    spaces: [{ id: "personal", name: "Personal", type: "personal", currency: "EUR" }],
    categories: [],
    moneyAccounts: [],
    recurringSeries: [],
    transactions: [],
    ...overrides,
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "tx-1",
    spaceId: "personal",
    categoryId: "cat-1",
    moneyAccountId: null,
    type: "expense",
    amountMinor: 1250,
    currency: "EUR",
    title: "Café",
    occurredOn: "2026-08-20",
    recurrence: "once",
    recurrenceGroupId: null,
    recurrenceSeriesId: null,
    sourceTransactionId: null,
    isArchived: false,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function category(overrides: Record<string, unknown> = {}) {
  return {
    id: "cat-1",
    spaceId: "personal",
    name: "Supermercado",
    icon: "shopping-cart",
    colorToken: "orange",
    budgetMinor: null,
    isDefault: true,
    templateKey: "groceries",
    sourceCategoryId: null,
    isArchived: false,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function rowsFor(inserted: Inserted[], table: string) {
  return inserted
    .filter((entry) => entry.table === table)
    .flatMap((entry) => (Array.isArray(entry.values) ? entry.values : [entry.values]));
}

describe("guest migration", () => {
  it("returns the stored counts when the same batch is replayed", async () => {
    const { db, batch } = fakeDatabase({ existingBatch: { status: "completed" } });

    const result = await migrateGuest(db, "user-1", payload({ transactions: [transaction()], categories: [category()] }));

    expect(batch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ batchId: "batch-1", transactionCount: 1, categoryCount: 1 });
  });

  it("rejects a batch that is still in flight", async () => {
    const { db } = fakeDatabase({ existingBatch: { status: "processing" } });

    await expect(migrateGuest(db, "user-1", payload())).rejects.toThrow("MIGRATION_IN_PROGRESS");
  });

  it("requires bootstrap before accepting data", async () => {
    const { db } = fakeDatabase({ personalSpaceId: null });

    await expect(migrateGuest(db, "user-1", payload())).rejects.toThrow("BOOTSTRAP_REQUIRED");
  });

  it("carries note, recurrence and the custom recurrence group", async () => {
    const { db, inserted } = fakeDatabase({});

    await migrateGuest(
      db,
      "user-1",
      payload({
        categories: [category()],
        transactions: [
          transaction({
            note: "Regalo de Ana",
            recurrence: "custom",
            recurrenceGroupId: "group-9",
            sourceTransactionId: "local-source-3",
          }),
        ],
      }),
    );

    const [row] = rowsFor(inserted, "transactions");
    expect(row).toMatchObject({
      note: "Regalo de Ana",
      recurrence: "custom",
      recurrenceGroupId: "group-9",
      sourceLocalTransactionId: "local-source-3",
      sourceInstallationId: "install-1",
      sourceLocalId: "tx-1",
    });
  });

  it("stores the budget in the currency of its space, not always EUR", async () => {
    const { db, inserted } = fakeDatabase({});

    await migrateGuest(
      db,
      "user-1",
      payload({
        spaces: [
          { id: "personal", name: "Personal", type: "personal", currency: "EUR" },
          { id: "trip", name: "Viaje", type: "other", currency: "USD" },
        ],
        categories: [
          category({ id: "cat-usd", spaceId: "trip", templateKey: null, budgetMinor: 50000 }),
        ],
      }),
    );

    expect(rowsFor(inserted, "category_budgets")[0]).toMatchObject({
      currency: "USD",
      budgetAmountMinor: 50000n,
    });
  });

  it("reuses the seeded personal category instead of duplicating its template key", async () => {
    const { db, inserted } = fakeDatabase({
      seededCategories: [{ id: "seeded-groceries", templateKey: "groceries" }],
    });

    await migrateGuest(
      db,
      "user-1",
      payload({
        categories: [category()],
        transactions: [transaction()],
      }),
    );

    // La categoría sembrada por el bootstrap y la del invitado son la misma:
    // insertarla otra vez chocaría con el índice único (space_id, template_key).
    expect(rowsFor(inserted, "categories")).toHaveLength(0);
    expect(rowsFor(inserted, "transactions")[0]).toMatchObject({
      categoryId: "seeded-groceries",
    });
    expect(rowsFor(inserted, "guest_entity_links")).toContainEqual(
      expect.objectContaining({ entityType: "category", localId: "cat-1", remoteId: "seeded-groceries" }),
    );
  });

  it("imports a local couple space as `other` so it never takes the shared-space slot", async () => {
    const { db, inserted } = fakeDatabase({});

    await migrateGuest(
      db,
      "user-1",
      payload({
        spaces: [
          { id: "personal", name: "Personal", type: "personal", currency: "EUR" },
          { id: "duo", name: "Juntos", type: "couple", currency: "EUR" },
        ],
      }),
    );

    const rows = rowsFor(inserted, "spaces");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "other", sourceLocalId: "duo" });
  });

  it("stores a content hash so a different payload cannot reuse a batch id", async () => {
    const first = fakeDatabase({});
    await migrateGuest(first.db, "user-1", payload({ transactions: [transaction()], categories: [category({ templateKey: null })] }));
    const second = fakeDatabase({});
    await migrateGuest(second.db, "user-1", payload({ transactions: [transaction({ amountMinor: 9999 })], categories: [category({ templateKey: null })] }));

    const hashOf = (entries: Inserted[]) =>
      rowsFor(entries, "guest_migration_batches")[0]?.payloadHash as string;

    expect(hashOf(first.inserted)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOf(first.inserted)).not.toBe(hashOf(second.inserted));
  });

  it("rejects a transaction pointing at a category outside the payload", async () => {
    const { db } = fakeDatabase({});

    await expect(
      migrateGuest(db, "user-1", payload({ transactions: [transaction({ categoryId: "ghost" })] })),
    ).rejects.toThrow("INVALID_GRAPH");
  });
});
