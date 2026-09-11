import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser, updateProfile } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { syncSpaceData } from "../../src/services/space-sync";
import { buildChanges, buildSnapshot } from "../../src/services/sync-snapshot";
import { categories, moneyAccountBalances, spaces, transactions } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

const db = testDb();
const NOW = "2026-08-29T10:00:00.000Z";
const LATER = "2026-08-29T12:00:00.000Z";
const EARLIER = "2026-08-29T08:00:00.000Z";

afterAll(cleanupTestUsers);

async function sharedSpace(label: string, countryCode?: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  if (countryCode) await updateProfile(db, userId, { countryCode });
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
  it("does not let offline sync bypass Venezuela's single-USD-account rule", async () => {
    const { userId, spaceId } = await sharedSpace("sync-ve-account", "VE");

    await expect(syncSpaceData(db, spaceId, userId, {
      installationId: "install-ve",
      categories: [], recurringSeries: [], transactions: [],
      moneyAccounts: [accountRow()],
    })).rejects.toThrow("VE_ACCOUNT_MULTI_CURRENCY_NOT_ALLOWED");

    await expect(syncSpaceData(db, spaceId, userId, {
      installationId: "install-ve",
      categories: [], recurringSeries: [], transactions: [],
      moneyAccounts: [accountRow({
        currency: "USD",
        balances: [{ currency: "USD", openingBalanceMinor: 100000, position: 0 }],
      })],
    })).resolves.toMatchObject({ moneyAccountCount: 1 });
  });

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

describe("changes against PostgreSQL", () => {
  it("returns rows updated after the cursor and excludes rows updated before the overlap window", async () => {
    const { userId, spaceId } = await sharedSpace("changes-cursor");
    await syncSpaceData(db, spaceId, userId, {
      installationId: "install-1",
      categories: [categoryRow({ id: "cat-old-local", remoteId: "cat-old-local", name: "Antiguo" })],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });
    // Forzar server_updated_at a hace 10 minutos para simular que ocurrió antes del cursor
    await db.execute(sql`UPDATE categories SET server_updated_at = now() - interval '10 minutes' WHERE name = 'Antiguo' AND space_id = ${spaceId}`);

    // El cursor se toma hace 5 minutos
    const cursor = new Date(Date.now() - 5 * 60 * 1000);

    // Insertar nueva fila ahora
    await syncSpaceData(db, spaceId, userId, {
      installationId: "install-1",
      categories: [categoryRow({ id: "cat-new-local", remoteId: "cat-new-local", name: "Nuevo" })],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });

    const changes = await buildChanges(db, userId, cursor);
    const categoryNames = changes.categories.map((c) => c.name);
    expect(categoryNames).toContain("Nuevo");
    expect(categoryNames).not.toContain("Antiguo");
  });

  it("returns items pushed with an old client updatedAt when inserted after the cursor (skew)", async () => {
    const { userId, spaceId } = await sharedSpace("changes-skew");
    const cursor = new Date(Date.now() - 5000);

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await syncSpaceData(db, spaceId, userId, {
      installationId: "install-offline",
      categories: [categoryRow({ id: "cat-off-local", remoteId: "cat-off-local", name: "Offline", updatedAt: threeDaysAgo })],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });

    const changes = await buildChanges(db, userId, cursor);
    expect(changes.categories.some((c) => c.name === "Offline")).toBe(true);
  });

  it("includes archived rows in the changes feed", async () => {
    const { userId, spaceId } = await sharedSpace("changes-archived");
    await syncSpaceData(db, spaceId, userId, {
      installationId: "install-1",
      categories: [categoryRow({ id: "cat-arch-local", remoteId: "cat-arch-local", name: "Por archivar" })],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });
    const cursor = new Date(Date.now() - 2000);

    await syncSpaceData(db, spaceId, userId, {
      installationId: "install-1",
      categories: [categoryRow({ id: "cat-arch-local", remoteId: "cat-arch-local", name: "Por archivar", isArchived: true, updatedAt: new Date().toISOString() })],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });

    const changes = await buildChanges(db, userId, cursor);
    const found = changes.categories.find((c) => c.name === "Por archivar");
    expect(found).toBeDefined();
    expect(found?.isArchived).toBe(true);
  });

  it("re-uploading identical rows touches server_updated_at and remains idempotent", async () => {
    const { userId, spaceId } = await sharedSpace("changes-resync");
    const batch = {
      installationId: "install-1",
      categories: [categoryRow({ id: "cat-idem-local", remoteId: "cat-idem-local", name: "Idempotente" })],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    };
    await syncSpaceData(db, spaceId, userId, batch);
    const cursor = new Date(Date.now() - 1000);

    await syncSpaceData(db, spaceId, userId, batch);

    const changes = await buildChanges(db, userId, cursor);
    expect(changes.categories.some((c) => c.name === "Idempotente")).toBe(true);

    const stored = await db.select().from(categories).where(and(eq(categories.spaceId, spaceId), eq(categories.name, "Idempotente")));
    expect(stored).toHaveLength(1);
  });

  it("updates server_updated_at on raw UPDATE spaces SET activated_at", async () => {
    const { spaceId } = await sharedSpace("changes-raw-update");
    const [before] = await db.select({ serverUpdatedAt: spaces.serverUpdatedAt }).from(spaces).where(eq(spaces.id, spaceId));
    expect(before?.serverUpdatedAt).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 50));

    await db.execute(sql`UPDATE spaces SET activated_at = now() WHERE id = ${spaceId}`);

    const [after] = await db.select({ serverUpdatedAt: spaces.serverUpdatedAt }).from(spaces).where(eq(spaces.id, spaceId));
    expect(after!.serverUpdatedAt.getTime()).toBeGreaterThan(before!.serverUpdatedAt.getTime());
  });

  it("returns rows within the safety overlap window even when since is slightly in the future of the row", async () => {
    const { userId, spaceId } = await sharedSpace("changes-overlap");
    await syncSpaceData(db, spaceId, userId, {
      installationId: "install-1",
      categories: [categoryRow({ id: "cat-overlap-local", remoteId: "cat-overlap-local", name: "Solape" })],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });

    const futureSince = new Date(Date.now() + 30_000);
    const changes = await buildChanges(db, userId, futureSince);
    expect(changes.categories.some((c) => c.name === "Solape")).toBe(true);
  });
});
