import { afterAll, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { syncSpaceData } from "../../src/services/space-sync";
import { buildChanges } from "../../src/services/sync-snapshot";
import { deleteBalance, upsertBalance } from "../../src/services/money-accounts";
import { moneyAccountBalances } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

/**
 * `PUT/DELETE /v1/spaces/:id/money-accounts/:id/balances/:currency` cambian la
 * cuenta tanto como un push: deben salir por `/v1/sync/changes` y ganar a un
 * push posterior que traiga la versión anterior.
 */
const db = testDb();
const T0 = "2026-09-01T08:00:00.000Z";
const T1 = "2026-09-01T09:00:00.000Z";
const ACC = (n: number) => `b1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

afterAll(async () => {
  await cleanupTestUsers();
});

function account(id: string, updatedAt: string, balances: { currency: string; openingBalanceMinor: number }[]) {
  return {
    id, remoteId: id, name: "Cuenta de prueba", kind: "bank", icon: null, colorToken: null,
    currency: balances[0]!.currency, isArchived: false, createdAt: T0, updatedAt,
    balances: balances.map((balance, position) => ({ ...balance, position })),
  };
}

async function seededAccount(label: string, id: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  const space = await createSpaceWithOwner(db, userId, { name: "Juntos", type: "other", currency: "EUR", timezone: "Europe/Madrid" });
  await syncSpaceData(db, space.id, userId, {
    installationId: "install-A", categories: [], recurringSeries: [], transactions: [],
    moneyAccounts: [account(id, T1, [{ currency: "EUR", openingBalanceMinor: 100 }, { currency: "USD", openingBalanceMinor: 5 }])],
  });
  await db.execute(sql`UPDATE money_accounts SET server_updated_at = now() - interval '10 minutes' WHERE id = ${id}`);
  return { userId, spaceId: space.id };
}

async function balancesOf(id: string) {
  const rows = await db.select().from(moneyAccountBalances).where(eq(moneyAccountBalances.moneyAccountId, id)).orderBy(asc(moneyAccountBalances.currency));
  return rows.map((row) => `${row.currency}:${row.openingBalanceMinor}`);
}

describe("money account balance REST writes", () => {
  it("publishes a PUT through /changes with a newer version", async () => {
    const { userId } = await seededAccount("bal-put", ACC(1));
    const cursor = new Date();
    await upsertBalance(db, { accountId: ACC(1), currency: "EUR", openingBalanceMinor: 300n, displayOrder: 0 });

    const published = (await buildChanges(db, userId, cursor)).moneyAccounts.find((row) => row.id === ACC(1));
    expect(published?.updatedAt.getTime()).toBeGreaterThan(Date.parse(T1));
    expect(await balancesOf(ACC(1))).toEqual(["EUR:300", "USD:5"]);
  });

  it("publishes a DELETE through /changes", async () => {
    const { userId } = await seededAccount("bal-delete", ACC(2));
    const cursor = new Date();
    expect(await deleteBalance(db, ACC(2), "USD")).toBe(true);
    expect((await buildChanges(db, userId, cursor)).moneyAccounts.some((row) => row.id === ACC(2))).toBe(true);
    expect(await balancesOf(ACC(2))).toEqual(["EUR:100"]);
  });

  it("does not publish the account when the balance to delete does not exist", async () => {
    const { userId } = await seededAccount("bal-delete-missing", ACC(4));
    const cursor = new Date();
    expect(await deleteBalance(db, ACC(4), "GBP")).toBe(false);
    expect((await buildChanges(db, userId, cursor)).moneyAccounts.some((row) => row.id === ACC(4))).toBe(false);
    expect(await balancesOf(ACC(4))).toEqual(["EUR:100", "USD:5"]);
  });

  it("does not let a push of the version before the PUT overwrite it", async () => {
    const { userId, spaceId } = await seededAccount("bal-stale", ACC(3));
    await upsertBalance(db, { accountId: ACC(3), currency: "USD", openingBalanceMinor: 9n, displayOrder: 1 });
    const result = await syncSpaceData(db, spaceId, userId, {
      installationId: "install-B", categories: [], recurringSeries: [], transactions: [],
      moneyAccounts: [account(ACC(3), T1, [{ currency: "EUR", openingBalanceMinor: 1 }])],
    });
    expect(result.conflicts?.map((conflict) => conflict.reason)).toEqual(["NEWER_VERSION"]);
    expect(await balancesOf(ACC(3))).toEqual(["EUR:100", "USD:9"]);
  });
});
