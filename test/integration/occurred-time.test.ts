import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import { syncSpaceData, type SpaceSyncPayload } from "../../src/services/space-sync";
import { buildChanges, buildSnapshot } from "../../src/services/sync-snapshot";
import { transactions } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

/**
 * Hora del movimiento (`occurredTime`, `HH:mm` local o `null`), contrato de
 * `Juntos Rebirth/Bible/API.md`: la subida la envía siempre; una clave ausente
 * (app o API anteriores) conserva la guardada y `null` la quita.
 */
const db = testDb();
afterAll(cleanupTestUsers);

const T0 = "2026-11-01T08:00:00.000Z";
const TX = (n: number) => `e1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function space(label: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  const created = await createSpaceWithOwner(db, userId, { name: "Juntos", type: "other", currency: "EUR", timezone: "Europe/Madrid" });
  const categoryId = crypto.randomUUID();
  const category = { id: categoryId, remoteId: categoryId, name: "Comida", icon: null, colorToken: null, budgetMinor: null, isDefault: false, templateKey: null, isArchived: false, createdAt: T0, updatedAt: T0 };
  return { userId, spaceId: created.id, category };
}

function movement(id: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id, remoteId: id, categoryId: "", moneyAccountId: null, type: "expense", amountMinor: 50000, currency: "EUR",
    title: "Compra de prueba", occurredOn: "2026-11-01", note: null, recurrence: "once", recurrenceGroupId: null,
    recurrenceSeriesId: null, sourceTransactionId: null, isArchived: false, createdAt: T0, updatedAt, ...extra,
  };
}

function push(spaceId: string, userId: string, category: { id: string }, rows: Record<string, unknown>[]) {
  rows = rows.map((row) => ({ ...row, categoryId: category.id }));
  const payload = { installationId: "install-A", categories: [category], moneyAccounts: [], recurringSeries: [], transactions: rows } as SpaceSyncPayload;
  return syncSpaceData(db, spaceId, userId, payload);
}

async function storedTime(id: string) {
  const [row] = await db.select({ occurredTime: transactions.occurredTime }).from(transactions).where(eq(transactions.id, id));
  return row?.occurredTime;
}

describe("transaction occurredTime through sync", () => {
  it("stores the time and returns it in snapshot and changes", async () => {
    const { userId, spaceId, category } = await space("time-store");
    const cursor = new Date(Date.now() - 1000);
    await push(spaceId, userId, category, [movement(TX(1), "2026-11-01T09:00:00.000Z", { occurredTime: "14:35" })]);

    expect(await storedTime(TX(1))).toBe("14:35");
    const fromSnapshot = (await buildSnapshot(db, userId)).transactions.find((row) => row.id === TX(1));
    const fromChanges = (await buildChanges(db, userId, cursor)).transactions.find((row) => row.id === TX(1));
    expect(fromSnapshot?.occurredTime).toBe("14:35");
    expect(fromChanges?.occurredTime).toBe("14:35");
  });

  it("keeps the stored time when the key is absent and clears it with null", async () => {
    const { userId, spaceId, category } = await space("time-absent");
    await push(spaceId, userId, category, [movement(TX(2), "2026-11-01T09:00:00.000Z", { occurredTime: "08:05" })]);

    // App anterior (o la app tras el reintento sin la clave): no toca la hora.
    await push(spaceId, userId, category, [movement(TX(2), "2026-11-01T10:00:00.000Z", { title: "Renombrada" })]);
    expect(await storedTime(TX(2))).toBe("08:05");

    await push(spaceId, userId, category, [movement(TX(2), "2026-11-01T11:00:00.000Z", { occurredTime: null })]);
    expect(await storedTime(TX(2))).toBeNull();
  });

  it("creates movements without a time as null", async () => {
    const { userId, spaceId, category } = await space("time-new");
    await push(spaceId, userId, category, [movement(TX(3), "2026-11-01T09:00:00.000Z")]);
    expect(await storedTime(TX(3))).toBeNull();
    const fromSnapshot = (await buildSnapshot(db, userId)).transactions.find((row) => row.id === TX(3));
    expect(fromSnapshot && "occurredTime" in fromSnapshot && fromSnapshot.occurredTime).toBeNull();
  });

  it("a stale version does not change the time", async () => {
    const { userId, spaceId, category } = await space("time-stale");
    await push(spaceId, userId, category, [movement(TX(4), "2026-11-01T10:00:00.000Z", { occurredTime: "21:00" })]);
    const result = await push(spaceId, userId, category, [movement(TX(4), "2026-11-01T09:00:00.000Z", { occurredTime: "07:00" })]);
    expect(result.conflicts?.map((conflict) => conflict.reason)).toEqual(["NEWER_VERSION"]);
    expect(await storedTime(TX(4))).toBe("21:00");
  });

  it("rejects a malformed time with its own reason, not as an unknown field", async () => {
    const { userId, spaceId, category } = await space("time-bad");
    for (const bad of ["24:00", "9:30", "14:35:00", 1435]) {
      await expect(push(spaceId, userId, category, [movement(TX(5), "2026-11-01T09:00:00.000Z", { occurredTime: bad })]))
        .rejects.toMatchObject({ apiCode: "INVALID_SYNC_PAYLOAD", issue: { path: ["transactions", 0, "occurredTime"], reason: "INVALID_TIME_OF_DAY" } });
    }
  });
});
