import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { syncSpaceData, type SpaceSyncPayload } from "../src/services/space-sync";

const SPACE = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-29T10:00:00.000Z";

type Captured = { table: string; op: "insert" | "delete"; values?: Record<string, unknown> };

/**
 * Doble del driver. Las lecturas responden en el orden del servicio: espacio,
 * categorías, cuentas, series, movimientos y alias de categoría ya existentes.
 */
function fakeDatabase(existing: {
  countryCode?: string | null;
  categories?: unknown[];
  moneyAccounts?: unknown[];
  series?: unknown[];
  transactions?: unknown[];
  categoryAliases?: unknown[];
} = {}) {
  const captured: Captured[] = [];
  const batch = vi.fn().mockResolvedValue([]);
  let selectCall = 0;

  const reads: unknown[][] = [
    [{ currency: "EUR", countryCode: existing.countryCode ?? null }],
    existing.categories ?? [],
    existing.moneyAccounts ?? [],
    existing.series ?? [],
    existing.transactions ?? [],
    existing.categoryAliases ?? [],
  ];

  const db = {
    select: () => ({
      from: () => {
        const rows = reads[selectCall++] ?? [];
        const result = Promise.resolve(rows);
        return Object.assign(result, {
          where: () =>
            Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) }),
        });
      },
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => {
      const builder = {
        values: (values: Record<string, unknown>) => {
          captured.push({ table: getTableName(table), op: "insert", values });
          return { ...builder, onConflictDoUpdate: () => builder };
        },
        onConflictDoUpdate: () => builder,
      };
      return builder;
    },
    delete: (table: Parameters<typeof getTableName>[0]) => ({
      where: () => {
        captured.push({ table: getTableName(table), op: "delete" });
        return {};
      },
    }),
    batch,
  } as unknown as Database;

  return { db, captured, batch };
}

function payload(overrides: Partial<SpaceSyncPayload> = {}): SpaceSyncPayload {
  return {
    installationId: "install-1",
    categories: [],
    moneyAccounts: [],
    recurringSeries: [],
    transactions: [],
    ...overrides,
  };
}

function category(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    remoteId: "22222222-2222-4222-8222-222222222222",
    name: "Supermercado",
    icon: "shopping-cart",
    colorToken: "orange",
    budgetMinor: null,
    isDefault: false,
    templateKey: null,
    isArchived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function rowsFor(captured: Captured[], table: string) {
  return captured.filter((entry) => entry.table === table && entry.op === "insert");
}

function recurringTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    categoryId: "22222222-2222-4222-8222-222222222222",
    moneyAccountId: null,
    type: "expense",
    amountMinor: 1250,
    currency: "EUR",
    title: "Suscripción",
    occurredOn: "2026-08-20",
    recurrence: "monthly",
    recurrenceGroupId: null,
    recurrenceSeriesId: "series-local",
    isArchived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("space bulk sync", () => {
  it("reuses the remote id already linked to this installation", async () => {
    const { db, captured } = fakeDatabase({
      categories: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          sourceInstallationId: "install-1",
          sourceLocalId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    });

    await syncSpaceData(db, SPACE, "user-1", payload({ categories: [category()] }));

    // El enlace por (espacio, instalación, id local) manda sobre el `remoteId`
    // que envía el cliente: así reenviar un lote nunca duplica la fila.
    expect(rowsFor(captured, "categories")[0]?.values).toMatchObject({
      id: "99999999-9999-4999-8999-999999999999",
      sourceInstallationId: "install-1",
      sourceLocalId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("keeps the client remote id when nothing is linked yet", async () => {
    const { db, captured } = fakeDatabase();

    await syncSpaceData(db, SPACE, "user-1", payload({ categories: [category()] }));

    expect(rowsFor(captured, "categories")[0]?.values).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      spaceId: SPACE,
    });
  });

  it("reuses the remote id of seeded category matching templateKey", async () => {
    const { db, captured } = fakeDatabase({
      categories: [
        {
          id: "seeded-cat-uuid-1111-2222-3333-4444",
          sourceInstallationId: null,
          sourceLocalId: null,
          templateKey: "groceries",
        },
      ],
    });

    await syncSpaceData(
      db,
      SPACE,
      "user-1",
      payload({
        categories: [
          category({
            id: "local-groceries",
            remoteId: "different-uuid-from-client",
            templateKey: "groceries",
          }),
        ],
      }),
    );

    expect(rowsFor(captured, "categories")[0]?.values).toMatchObject({
      id: "seeded-cat-uuid-1111-2222-3333-4444",
      sourceInstallationId: "install-1",
      sourceLocalId: "local-groceries",
      templateKey: "groceries",
    });
  });

  it("mints a new id when the client id is not a uuid", async () => {
    const { db, captured } = fakeDatabase();

    await syncSpaceData(
      db,
      SPACE,
      "user-1",
      payload({ categories: [category({ id: "local-7", remoteId: "local-7" })] }),
    );

    const values = rowsFor(captured, "categories")[0]?.values;
    expect(values?.id).not.toBe("local-7");
    expect(values?.sourceLocalId).toBe("local-7");
  });

  it("rewrites every currency of an account wholesale", async () => {
    const { db, captured } = fakeDatabase();

    await syncSpaceData(
      db,
      SPACE,
      "user-1",
      payload({
        moneyAccounts: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            remoteId: "33333333-3333-4333-8333-333333333333",
            name: "Revolut",
            kind: "bank",
            icon: null,
            colorToken: null,
            currency: "EUR",
            isArchived: false,
            createdAt: NOW,
            updatedAt: NOW,
            balances: [
              { currency: "EUR", openingBalanceMinor: 100000, position: 0 },
              { currency: "USD", openingBalanceMinor: -2500, position: 1 },
            ],
          },
        ],
      }),
    );

    // El borrado precede a las inserciones: retirar una divisa en un
    // dispositivo debe retirarla en todos.
    const balanceOps = captured.filter((entry) => entry.table === "money_account_balances");
    expect(balanceOps[0]?.op).toBe("delete");
    expect(balanceOps.slice(1).map((entry) => entry.values?.currency)).toEqual(["EUR", "USD"]);
    expect(balanceOps[2]?.values?.openingBalanceMinor).toBe(-2500n);
  });

  it("stores the note and the custom recurrence group of a transaction", async () => {
    const { db, captured } = fakeDatabase();

    await syncSpaceData(
      db,
      SPACE,
      "user-1",
      payload({
        categories: [category()],
        transactions: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            remoteId: "44444444-4444-4444-8444-444444444444",
            categoryId: "22222222-2222-4222-8222-222222222222",
            moneyAccountId: null,
            type: "expense",
            amountMinor: 1250,
            currency: "EUR",
            title: "Café",
            occurredOn: "2026-08-20",
            note: "Con Ana",
            recurrence: "custom",
            recurrenceGroupId: "group-9",
            recurrenceSeriesId: null,
            sourceTransactionId: null,
            isArchived: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );

    expect(rowsFor(captured, "transactions")[0]?.values).toMatchObject({
      note: "Con Ana",
      recurrence: "custom",
      recurrenceGroupId: "group-9",
      categoryId: "22222222-2222-4222-8222-222222222222",
      amountMinor: 1250n,
    });
  });

  it("returns an immediate null snapshot for a non-Venezuela currency", async () => {
    const { db } = fakeDatabase();
    const result = await syncSpaceData(
      db,
      SPACE,
      "user-1",
      payload({
        categories: [category()],
        transactions: [{
          id: "44444444-4444-4444-8444-444444444444",
          categoryId: "22222222-2222-4222-8222-222222222222",
          moneyAccountId: null,
          type: "expense",
          amountMinor: 1250,
          currency: "EUR",
          title: "Café",
          occurredOn: "2026-08-20",
          isArchived: false,
          createdAt: NOW,
          updatedAt: NOW,
        }],
      }),
      "VE",
    );

    expect(result.transactions).toEqual([expect.objectContaining({
      localId: "44444444-4444-4444-8444-444444444444",
      remoteId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      exchangeSnapshot: null,
    })]);
  });

  it("accepts an unchanged legacy currency when a space later becomes VE", async () => {
    const legacyId = "44444444-4444-4444-8444-444444444444";
    const { db } = fakeDatabase({
      countryCode: "VE",
      categories: [{
        id: "22222222-2222-4222-8222-222222222222",
        sourceInstallationId: "install-1",
        sourceLocalId: "category-local",
      }],
      transactions: [{
        id: legacyId,
        sourceInstallationId: "install-1",
        sourceLocalId: "legacy-local",
        amountMinor: 1250n,
        currency: "EUR",
        categoryId: "22222222-2222-4222-8222-222222222222",
        moneyAccountId: null,
        type: "expense",
        title: "Histórico",
        occurredOn: "2026-08-20",
        note: null,
        recurrence: "once",
        recurrenceGroupId: null,
        recurrenceSeriesId: null,
        isArchived: false,
        accountingAmountMinorUsd: null,
      }],
    });

    await expect(syncSpaceData(db, SPACE, "user-1", payload({
      transactions: [{
        id: "legacy-local",
        remoteId: legacyId,
        categoryId: "22222222-2222-4222-8222-222222222222",
        moneyAccountId: null,
        type: "expense",
        amountMinor: 1250,
        currency: "EUR",
        title: "Histórico",
        occurredOn: "2026-08-20",
        isArchived: false,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }))).resolves.toMatchObject({ transactionCount: 1 });
  });

  it("rejects a mutation of a legacy currency in a VE space", async () => {
    const legacyId = "44444444-4444-4444-8444-444444444444";
    const { db, batch } = fakeDatabase({
      countryCode: "VE",
      categories: [{ id: "22222222-2222-4222-8222-222222222222", sourceInstallationId: "install-1", sourceLocalId: "category-local" }],
      transactions: [{
        id: legacyId, sourceInstallationId: "install-1", sourceLocalId: "legacy-local",
        categoryId: "22222222-2222-4222-8222-222222222222", moneyAccountId: null,
        type: "expense", amountMinor: 1250n, currency: "EUR", title: "Histórico",
        occurredOn: "2026-08-20", note: null, recurrence: "once", recurrenceGroupId: null,
        recurrenceSeriesId: null, isArchived: false, accountingAmountMinorUsd: null,
      }],
    });

    await expect(syncSpaceData(db, SPACE, "user-1", payload({
      transactions: [{
        id: "legacy-local", remoteId: legacyId,
        categoryId: "22222222-2222-4222-8222-222222222222", moneyAccountId: null,
        type: "expense", amountMinor: 1300, currency: "EUR", title: "Histórico",
        occurredOn: "2026-08-20", isArchived: false, createdAt: NOW, updatedAt: NOW,
      }],
    }))).rejects.toThrow("INVALID_PAYLOAD");
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects client-supplied snapshot values before writing the batch", async () => {
    const { db, batch } = fakeDatabase();
    await expect(syncSpaceData(db, SPACE, "user-1", payload({
      transactions: [{ id: "local-1", exchangeSnapshot: { rate: "50" } }],
    }))).rejects.toThrow("INVALID_PAYLOAD");
    expect(batch).not.toHaveBeenCalled();
  });


  it("resolves a category that lives on the server and is not in this batch", async () => {
    const { db, captured } = fakeDatabase({
      categories: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          sourceInstallationId: "install-2",
          sourceLocalId: "other-device-local",
        },
      ],
    });

    await syncSpaceData(
      db,
      SPACE,
      "user-1",
      payload({
        transactions: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            remoteId: "44444444-4444-4444-8444-444444444444",
            categoryId: "99999999-9999-4999-8999-999999999999",
            moneyAccountId: null,
            type: "expense",
            amountMinor: 500,
            currency: "EUR",
            title: "Pan",
            occurredOn: "2026-08-20",
            recurrence: "once",
            recurrenceGroupId: null,
            recurrenceSeriesId: null,
            sourceTransactionId: null,
            isArchived: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );

    expect(rowsFor(captured, "transactions")[0]?.values).toMatchObject({
      categoryId: "99999999-9999-4999-8999-999999999999",
    });
  });

  it("rejects a transaction whose category cannot be resolved", async () => {
    const { db } = fakeDatabase();

    await expect(
      syncSpaceData(
        db,
        SPACE,
        "user-1",
        payload({
          transactions: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              categoryId: "ghost",
              moneyAccountId: null,
              type: "expense",
              amountMinor: 500,
              currency: "EUR",
              title: "Pan",
              occurredOn: "2026-08-20",
              isArchived: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      ),
    ).rejects.toThrow("INVALID_GRAPH");
  });

  it("rejects a transaction whose category cannot be resolved even when other categories already exist", async () => {
    // Regresión: un couple space con categorías existentes no debe hacer
    // fallback silencioso a "la primera categoría del espacio" cuando el
    // categoryId del movimiento no se puede resolver — debe rechazar el lote.
    const { db } = fakeDatabase({
      categories: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          sourceInstallationId: "install-1",
          sourceLocalId: "22222222-2222-4222-8222-222222222222",
          templateKey: null,
        },
      ],
    });

    await expect(
      syncSpaceData(
        db,
        SPACE,
        "user-1",
        payload({
          transactions: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              categoryId: "ghost",
              moneyAccountId: null,
              type: "expense",
              amountMinor: 500,
              currency: "EUR",
              title: "Pan",
              occurredOn: "2026-08-20",
              isArchived: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      ),
    ).rejects.toThrow("INVALID_GRAPH");
  });

  it("resolves a transaction's category through a previously recorded alias, without the category traveling in this batch", async () => {
    // Un segundo dispositivo del couple space fusionó su categoría local
    // "Transporte" (id local Z) en la fila ya existente de "Transporte" en un
    // sync anterior; ese sync dejó grabado el alias Z -> id-servidor. Ahora
    // ese mismo dispositivo sube un movimiento que solo referencia Z, sin
    // volver a enviar la categoría: debe seguir resolviéndose a la categoría
    // correcta en vez de caer en cualquier fallback.
    const { db, captured } = fakeDatabase({
      categories: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          sourceInstallationId: "install-1",
          sourceLocalId: "server-local-transporte",
          templateKey: "transport",
        },
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceInstallationId: "install-1",
          sourceLocalId: "server-local-supermercado",
          templateKey: "groceries",
        },
      ],
      categoryAliases: [
        {
          sourceInstallationId: "install-2",
          sourceLocalId: "device-2-local-transporte",
          categoryId: "99999999-9999-4999-8999-999999999999",
        },
      ],
    });

    await syncSpaceData(
      db,
      SPACE,
      "user-1",
      payload({
        installationId: "install-2",
        transactions: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            categoryId: "device-2-local-transporte",
            moneyAccountId: null,
            type: "expense",
            amountMinor: 500,
            currency: "EUR",
            title: "Taxi",
            occurredOn: "2026-08-20",
            isArchived: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );

    expect(rowsFor(captured, "transactions")[0]?.values).toMatchObject({
      categoryId: "99999999-9999-4999-8999-999999999999",
    });
  });

  it("converges a recurring occurrence from another installation on its series and date", async () => {
    const canonicalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const seriesId = "55555555-5555-4555-8555-555555555555";
    const { db, captured } = fakeDatabase({
      categories: [{
        id: "22222222-2222-4222-8222-222222222222",
        sourceInstallationId: "install-1",
        sourceLocalId: "category-local",
      }],
      series: [{ id: seriesId, sourceInstallationId: "install-1", sourceLocalId: "series-local" }],
      transactions: [{
        id: canonicalId,
        sourceInstallationId: "install-1",
        sourceLocalId: "old-local-id",
        amountMinor: 1000n,
        currency: "EUR",
        occurredOn: "2026-08-20",
        recurrenceSeriesId: seriesId,
        accountingAmountMinorUsd: null,
      }],
    });

    const result = await syncSpaceData(db, SPACE, "user-1", payload({
      installationId: "install-2",
      transactions: [recurringTransaction({ id: "device-2-occurrence", remoteId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })],
    }));

    expect(rowsFor(captured, "transactions")[0]?.values?.id).toBe(canonicalId);
    expect(rowsFor(captured, "transaction_aliases")[0]?.values).toMatchObject({
      transactionId: canonicalId,
      sourceInstallationId: "install-2",
      sourceLocalId: "device-2-occurrence",
    });
    expect(result.transactions?.[0]?.remoteId).toBe(canonicalId);
  });

  it("rejects contradictory duplicate recurring occurrences in one payload before writing", async () => {
    const { db, batch } = fakeDatabase({
      categories: [{ id: "22222222-2222-4222-8222-222222222222", sourceInstallationId: "install-1", sourceLocalId: "category-local" }],
      series: [{ id: "55555555-5555-4555-8555-555555555555", sourceInstallationId: "install-1", sourceLocalId: "series-local" }],
    });

    await expect(syncSpaceData(db, SPACE, "user-1", payload({
      transactions: [
        recurringTransaction(),
        recurringTransaction({ id: "another-local-id", amountMinor: 9999 }),
      ],
    }))).rejects.toMatchObject({
      message: "RECURRENCE_OCCURRENCE_CONFLICT",
      details: { recurrenceSeriesId: "55555555-5555-4555-8555-555555555555", occurredOn: "2026-08-20" },
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("turns a concurrent recurrence unique violation into a domain conflict", async () => {
    const { db, batch } = fakeDatabase();
    batch.mockRejectedValueOnce({
      code: "23505",
      constraint: "transactions_series_occurred_on_idx",
    });

    await expect(syncSpaceData(db, SPACE, "user-1", payload({
      categories: [category()],
      recurringSeries: [{
        id: "series-local",
        categoryId: "22222222-2222-4222-8222-222222222222",
        type: "expense",
        amountMinor: 1250,
        currency: "EUR",
        title: "Suscripción",
        frequency: "monthly",
        startsOn: "2026-08-20",
        nextOccurrenceOn: "2026-09-20",
        isArchived: false,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      transactions: [recurringTransaction()],
    }))).rejects.toThrow("RECURRENCE_OCCURRENCE_CONFLICT");
  });

  it("writes everything in a single atomic batch", async () => {
    const { db, batch } = fakeDatabase();

    const result = await syncSpaceData(
      db,
      SPACE,
      "user-1",
      payload({ categories: [category(), category({ id: "b", remoteId: "b" })] }),
    );

    expect(batch).toHaveBeenCalledOnce();
    expect(result).toEqual({
      categoryCount: 2,
      moneyAccountCount: 0,
      recurringSeriesCount: 0,
      transactionCount: 0,
    });
  });

  it("does not touch the database when the batch is empty", async () => {
    const { db, batch } = fakeDatabase();

    await syncSpaceData(db, SPACE, "user-1", payload());

    expect(batch).not.toHaveBeenCalled();
  });

  it("records the archive timestamp when the client archives a row", async () => {
    const { db, captured } = fakeDatabase();

    await syncSpaceData(
      db,
      SPACE,
      "user-1",
      payload({ categories: [category({ isArchived: true })] }),
    );

    expect(rowsFor(captured, "categories")[0]?.values).toMatchObject({
      isArchived: true,
      archivedAt: new Date(NOW),
    });
  });

  it("uses the authenticated user as author instead of trusting client-supplied createdBy", async () => {
    const { db, captured } = fakeDatabase();

    await syncSpaceData(
      db,
      SPACE,
      "syncing-user",
      payload({
        categories: [category({ createdBy: "author-user-cat" })],
        moneyAccounts: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            remoteId: "33333333-3333-4333-8333-333333333333",
            name: "Efectivo",
            kind: "cash",
            icon: "cash",
            colorToken: "green",
            currency: "EUR",
            createdBy: "author-user-acc",
            isArchived: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        recurringSeries: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            remoteId: "55555555-5555-4555-8555-555555555555",
            categoryId: "22222222-2222-4222-8222-222222222222",
            moneyAccountId: null,
            type: "expense",
            amountMinor: 5000,
            currency: "EUR",
            title: "Gimnasio",
            frequency: "monthly",
            startsOn: "2026-09-01",
            createdBy: "author-user-ser",
            isArchived: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        transactions: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            remoteId: "44444444-4444-4444-8444-444444444444",
            categoryId: "22222222-2222-4222-8222-222222222222",
            moneyAccountId: null,
            type: "expense",
            amountMinor: 1250,
            currency: "EUR",
            title: "Café",
            occurredOn: "2026-08-20",
            createdBy: "author-user-tx",
            isArchived: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );

    expect(rowsFor(captured, "categories")[0]?.values?.createdBy).toBe("syncing-user");
    expect(rowsFor(captured, "money_accounts")[0]?.values?.createdBy).toBe("syncing-user");
    expect(rowsFor(captured, "recurring_transaction_series")[0]?.values?.createdBy).toBe("syncing-user");
    expect(rowsFor(captured, "transactions")[0]?.values?.createdBy).toBe("syncing-user");
  });

  it("falls back to the syncing userId when row.createdBy is absent", async () => {
    const { db, captured } = fakeDatabase();

    await syncSpaceData(
      db,
      SPACE,
      "syncing-user",
      payload({
        categories: [category()],
        transactions: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            remoteId: "44444444-4444-4444-8444-444444444444",
            categoryId: "22222222-2222-4222-8222-222222222222",
            moneyAccountId: null,
            type: "expense",
            amountMinor: 1250,
            currency: "EUR",
            title: "Café",
            occurredOn: "2026-08-20",
            isArchived: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );

    expect(rowsFor(captured, "categories")[0]?.values?.createdBy).toBe("syncing-user");
    expect(rowsFor(captured, "transactions")[0]?.values?.createdBy).toBe("syncing-user");
  });
});
