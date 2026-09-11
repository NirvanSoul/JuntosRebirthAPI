import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser, updateProfile } from "../../src/services/account";
import { listActiveSpaces } from "../../src/services/spaces";
import { findActiveSpaceMembership } from "../../src/services/space-access";
import { buildSnapshot } from "../../src/services/sync-snapshot";
import { categories, financialContexts, spaces, transactions, user, userProfiles } from "../../src/db/schema";
import { createTestUser, testDb } from "./harness";

const db = testDb();
const fixtureIds: string[] = [];

afterAll(async () => {
  if (!fixtureIds.length) return;
  await db.delete(spaces).where(inArray(spaces.createdBy, fixtureIds));
  await db.delete(user).where(inArray(user.id, fixtureIds));
});

describe("bootstrap schema regression against PostgreSQL", () => {
  it("restores the active personal ledger despite stale country metadata without leaking another account or context", async () => {
    const userId = await createTestUser(db, "restore-stale-country");
    fixtureIds.push(userId);
    const currentUser = (await findCurrentUser(db, userId))!;
    const initial = await bootstrapAccount(db, currentUser, "Europe/Madrid");
    await updateProfile(db, userId, { countryCode: "VE" });
    const active = await bootstrapAccount(db, currentUser, "Europe/Madrid");
    const spaceId = active.personalSpace.id;
    const [category] = await db.select().from(categories).where(eq(categories.spaceId, spaceId));
    const [movement] = await db.insert(transactions).values({
      spaceId, categoryId: category.id, createdBy: userId, type: "expense",
      currency: "USD", amountMinor: 1234n, title: "Restored test movement", occurredOn: "2026-09-09",
    }).returning();
    // Reproduce el caso real: el contexto VE apunta a un espacio marcado ES.
    await db.update(spaces).set({ countryCode: "ES" }).where(eq(spaces.id, spaceId));
    // Otro libro personal con el mismo país tampoco debe mezclarse en snapshot.
    await db.update(spaces).set({ countryCode: "VE" }).where(eq(spaces.id, initial.personalSpace.id));

    for (let login = 0; login < 2; login++) {
      await bootstrapAccount(db, currentUser, "Europe/Madrid");
      const snapshot = await buildSnapshot(db, userId);
      expect(snapshot.spaces.map(s => s.id)).toEqual([spaceId]);
      expect(snapshot.transactions).toHaveLength(1);
      expect(snapshot.transactions[0]).toMatchObject({ id: movement.id, amountMinor: "1234", currency: "USD" });
      expect(snapshot.activeFinancialContextId).toBe(active.activeFinancialContext!.id);
      expect((await listActiveSpaces(db, userId)).map(s => s.id)).toEqual([spaceId]);
      expect(await findActiveSpaceMembership(db, userId, spaceId)).not.toBeNull();
      expect(await findActiveSpaceMembership(db, userId, initial.personalSpace.id)).toBeNull();
    }

    const otherId = await createTestUser(db, "restore-other-account");
    fixtureIds.push(otherId);
    const other = (await findCurrentUser(db, otherId))!;
    await bootstrapAccount(db, other, "Europe/Madrid");
    expect(await findActiveSpaceMembership(db, otherId, spaceId)).toBeNull();
    expect((await buildSnapshot(db, otherId)).transactions).toHaveLength(0);
  });

  it.each([null, "ES"])("creates and restores an active context with country %s", async (countryCode) => {
    const userId = await createTestUser(db, "bootstrap-schema");
    fixtureIds.push(userId);
    const currentUser = await findCurrentUser(db, userId);
    if (countryCode) {
      await db.insert(userProfiles).values({ userId, displayName: "Test", countryCode, defaultCurrency: "EUR" });
    }

    const first = await bootstrapAccount(db, currentUser!, "Europe/Madrid");
    expect(first.created.personalSpace).toBe(true);
    expect(first.personalSpace.timezone).toBe("Europe/Madrid");
    expect(first.activeFinancialContext).toMatchObject({
      countryCode: countryCode ?? "ZZ",
      canonicalCurrency: first.personalSpace.currency,
      personalSpaceId: first.personalSpace.id,
    });

    const second = await bootstrapAccount(db, currentUser!, "Europe/Madrid");
    expect(second.created).toEqual({ profile: false, personalSpace: false });
    expect(second.activeFinancialContext).toEqual(first.activeFinancialContext);
    expect(second.personalSpace.id).toBe(first.personalSpace.id);
    expect(await db.select().from(financialContexts).where(eq(financialContexts.userId, userId))).toHaveLength(1);

    const snapshot = await buildSnapshot(db, userId);
    expect(snapshot.activeFinancialContextId).toBe(first.activeFinancialContext!.id);
    expect(snapshot.spaces).toHaveLength(1);
    expect(snapshot.categories).toHaveLength(18);

    // Un perfil antiguo puede tener espacio y contexto, pero aún no el puntero activo.
    await db.update(userProfiles).set({ activeFinancialContextId: null }).where(eq(userProfiles.userId, userId));
    const repaired = await bootstrapAccount(db, currentUser!, "Europe/Madrid");
    expect(repaired.activeFinancialContext).toEqual(first.activeFinancialContext);
  });

  it("has the 5 server_updated_at triggers installed on sync collections", async () => {
    const result = await db.execute<{ trigger_name: string }>(
      sql`SELECT DISTINCT trigger_name FROM information_schema.triggers WHERE trigger_schema = 'public' AND trigger_name LIKE '%_touch_server_updated_at' ORDER BY trigger_name`,
    );
    const rows = (result.rows ?? result) as Array<{ trigger_name: string }>;
    expect(rows.map(r => r.trigger_name).sort()).toEqual([
      "categories_touch_server_updated_at",
      "money_accounts_touch_server_updated_at",
      "recurring_transaction_series_touch_server_updated_at",
      "spaces_touch_server_updated_at",
      "transactions_touch_server_updated_at",
    ]);
  });
});
