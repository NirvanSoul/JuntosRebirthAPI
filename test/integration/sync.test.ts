import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { syncSpaceData } from "../../src/services/space-sync";
import { buildSnapshot } from "../../src/services/sync-snapshot";
import { categories, moneyAccountBalances, transactions } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

const db = testDb();
const NOW = "2026-08-29T10:00:00.000Z";
const LATER = "2026-08-29T12:00:00.000Z";
const EARLIER = "2026-08-29T08:00:00.000Z";

afterAll(cleanupTestUsers);

async function sharedSpace(label: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  const space = await createSpaceWithOwner(db, userId, {
    name: "Juntos",
    type: "other",
    currency: "EUR",
    timezone: "Europe/Madrid",
  });
  return { userId, spaceId: space.id };
}

function categoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-cat-1",
    remoteId: "local-cat-1",
    name: "Ocio",
    icon: "game-controller",
    colorToken: "emerald",
    budgetMinor: null,
    isDefault: false,
    templateKey: null,
    isArchived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-acc-1",
    remoteId: "local-acc-1",
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
    ...overrides,
  };
}

function transactionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-tx-1",
    remoteId: "local-tx-1",
    categoryId: "local-cat-1",
    moneyAccountId: "local-acc-1",
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
    ...overrides,
  };
}

describe("space bulk sync against PostgreSQL", () => {
  it("is idempotent: pushing the same batch twice creates one row each", async () => {
    const { userId, spaceId } = await sharedSpace("sync-idem");
    const batch = {
      installationId: "install-A",
      categories: [categoryRow()],
      moneyAccounts: [accountRow()],
      recurringSeries: [],
      transactions: [transactionRow()],
    };

    await syncSpaceData(db, spaceId, userId, batch);
    await syncSpaceData(db, spaceId, userId, batch);

    // El espacio nace sin categorías sembradas; el push añade una.
    const storedCategories = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.spaceId, spaceId));
    expect(storedCategories).toHaveLength(1);

    const storedTransactions = await db
      .select({ id: transactions.id, note: transactions.note })
      .from(transactions)
      .where(eq(transactions.spaceId, spaceId));
    expect(storedTransactions).toHaveLength(1);
    expect(storedTransactions[0]?.note).toBe("Con Ana");
  });

  it("keeps the newest version and refuses an older one", async () => {
    const { userId, spaceId } = await sharedSpace("sync-lww");
    const base = {
      installationId: "install-A",
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    };

    await syncSpaceData(db, spaceId, userId, {
      ...base,
      categories: [categoryRow({ name: "Ocio", updatedAt: NOW })],
    });
    await syncSpaceData(db, spaceId, userId, {
      ...base,
      categories: [categoryRow({ name: "Ocio y salidas", updatedAt: LATER })],
    });
    // Un dispositivo con datos viejos no puede pisar los del otro.
    await syncSpaceData(db, spaceId, userId, {
      ...base,
      categories: [categoryRow({ name: "Nombre viejo", updatedAt: EARLIER })],
    });

    const [stored] = await db
      .select({ name: categories.name })
      .from(categories)
      .where(and(eq(categories.spaceId, spaceId), eq(categories.sourceLocalId, "local-cat-1")));
    expect(stored?.name).toBe("Ocio y salidas");
  });

  it("rewrites the currencies of an account wholesale", async () => {
    const { userId, spaceId } = await sharedSpace("sync-balances");
    const base = { installationId: "install-A", categories: [], recurringSeries: [], transactions: [] };

    await syncSpaceData(db, spaceId, userId, { ...base, moneyAccounts: [accountRow()] });
    // La persona retira el dólar en su dispositivo.
    await syncSpaceData(db, spaceId, userId, {
      ...base,
      moneyAccounts: [
        accountRow({
          updatedAt: LATER,
          balances: [{ currency: "EUR", openingBalanceMinor: 100000, position: 0 }],
        }),
      ],
    });

    const snapshot = await buildSnapshot(db, userId);
    const account = snapshot.moneyAccounts.find((item) => item.spaceId === spaceId);
    expect(account?.balances.map((balance) => balance.currency)).toEqual(["EUR"]);

    const orphans = await db
      .select({ currency: moneyAccountBalances.currency })
      .from(moneyAccountBalances)
      .where(eq(moneyAccountBalances.moneyAccountId, account!.id));
    expect(orphans).toHaveLength(1);
  });

  it("links a second installation to the rows the first one pushed", async () => {
    const { userId, spaceId } = await sharedSpace("sync-two-devices");

    await syncSpaceData(db, spaceId, userId, {
      installationId: "install-A",
      categories: [categoryRow()],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });

    const [created] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.spaceId, spaceId), eq(categories.sourceLocalId, "local-cat-1")));

    // El segundo dispositivo restauró y conoce el id remoto, pero su id local
    // es otro: se resuelve por `remoteId`, no por `source_local_id`.
    await syncSpaceData(db, spaceId, userId, {
      installationId: "install-B",
      categories: [
        categoryRow({ id: "device-b-local", remoteId: created!.id, name: "Ocio compartido", updatedAt: LATER }),
      ],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });

    const stored = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.spaceId, spaceId));
    expect(stored).toHaveLength(1);
    expect(stored.find((row) => row.id === created!.id)?.name).toBe("Ocio compartido");
  });
});

describe("snapshot against PostgreSQL", () => {
  it("returns everything the client needs to restore a device", async () => {
    const { userId, spaceId } = await sharedSpace("snapshot");
    await syncSpaceData(db, spaceId, userId, {
      installationId: "install-A",
      categories: [categoryRow()],
      moneyAccounts: [accountRow()],
      recurringSeries: [],
      transactions: [transactionRow()],
    });

    const snapshot = await buildSnapshot(db, userId);

    // Espacio personal del bootstrap más el compartido.
    expect(snapshot.spaces.map((space) => space.id)).toContain(spaceId);
    expect(snapshot.moneyAccounts[0]?.balances.map((b) => b.currency)).toEqual(["EUR", "USD"]);
    expect(snapshot.moneyAccounts[0]?.balances[1]?.openingBalanceMinor).toBe("-2500");

    const tx = snapshot.transactions.find((item) => item.spaceId === spaceId);
    // Los importes viajan como string para no perder precisión de 64 bits.
    expect(tx).toMatchObject({
      amountMinor: "1250",
      note: "Con Ana",
      recurrence: "custom",
      recurrenceGroupId: "group-9",
    });
  });

  it("never leaks a space the user does not belong to", async () => {
    const stranger = await createTestUser(db, "snapshot-stranger");
    const snapshot = await buildSnapshot(db, stranger);

    expect(snapshot.spaces).toHaveLength(0);
    expect(snapshot.transactions).toHaveLength(0);
  });
});
