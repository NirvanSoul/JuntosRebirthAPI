import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as account from "../../src/services/account";
import { buildSnapshot } from "../../src/services/sync-snapshot";
import { createAccountRoute } from "../../src/routes/account";
import { createRequireAuth, type AuthVariables } from "../../src/middleware/auth";
import type { Bindings } from "../../src/types/env";
import { categories, financialContexts, spaces, transactions, user, userProfiles } from "../../src/db/schema";
import { createTestUser, testDb } from "./harness";

const db = testDb();
const users: string[] = [];
afterAll(async () => {
  if (!users.length) return;
  await db.delete(spaces).where(inArray(spaces.createdBy, users));
  await db.delete(user).where(inArray(user.id, users));
});

async function fixture(bootstrap = true) {
  const id = await createTestUser(db, "profile-country");
  users.push(id);
  const current = (await account.findCurrentUser(db, id))!;
  if (bootstrap) await account.bootstrapAccount(db, current, "Europe/Madrid");
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("/v1/*", createRequireAuth(async () => ({ userId: id, emailVerified: true })));
  app.route("/v1", createAccountRoute({ ...account, createDb: () => db } as never));
  const request = (path: string, init?: RequestInit) => app.request(path, init, {} as Bindings);
  const patch = (body: unknown) => request("/v1/me/profile", { method: "PATCH", body: JSON.stringify(body) });
  return { id, current, request, patch };
}

describe("profile country persistence against PostgreSQL", () => {
  it("persists ES to ve as VE, restores contexts and movements, and ignores timezone on subsequent bootstrap", async () => {
    const f = await fixture();
    await f.patch({ countryCode: "ES" });
    const spanish = await account.getAccountState(db, f.id);
    const [category] = await db.select().from(categories).where(eq(categories.spaceId, spanish.personalSpaceId!));
    const [movement] = await db.insert(transactions).values({
      spaceId: spanish.personalSpaceId!, categoryId: category.id, createdBy: f.id,
      type: "expense", currency: "EUR", amountMinor: 1234n, title: "Preserved", occurredOn: "2026-09-11",
    }).returning();

    const changed = await f.patch({ countryCode: " ve " });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ data: {
      profile: { countryCode: "VE", defaultCurrency: "USD" },
      activeFinancialContext: { countryCode: "VE", canonicalCurrency: "USD" },
      leftSharedSpaceIds: [],
    } });
    const venezuelan = await account.getAccountState(db, f.id);
    expect(venezuelan.personalSpaceId).not.toBe(spanish.personalSpaceId);
    expect((await db.select().from(userProfiles).where(eq(userProfiles.userId, f.id)))[0].countryCode).toBe("VE");
    expect((await db.select().from(spaces).where(eq(spaces.id, venezuelan.personalSpaceId!)))[0]).toMatchObject({ countryCode: "VE", currency: "USD" });

    // Neither a currency preference nor device timezone/locale changes country.
    await f.patch({ defaultCurrency: "EUR", locale: "es-ES" });
    const boot = await f.request("/v1/bootstrap", { method: "POST", body: JSON.stringify({ timezone: "Europe/Madrid" }) });
    expect(boot.status).toBe(200);
    expect(await boot.json()).toMatchObject({ data: { profile: { countryCode: "VE" }, activeFinancialContext: venezuelan.activeFinancialContext } });
    const me = await f.request("/v1/me");
    expect(await me.json()).toMatchObject({ data: { profile: { countryCode: "VE" }, bootstrapRequired: false } });
    const snapshot = await buildSnapshot(db, f.id);
    expect(snapshot.activeFinancialContextId).toBe(venezuelan.activeFinancialContext!.id);
    expect(snapshot.spaces.map(s => s.id)).toEqual([venezuelan.personalSpaceId]);
    expect(snapshot.transactions).toEqual([]);

    await f.patch({ countryCode: "es" });
    expect((await account.getAccountState(db, f.id)).activeFinancialContext).toEqual(spanish.activeFinancialContext);
    expect((await buildSnapshot(db, f.id)).transactions).toContainEqual(expect.objectContaining({ id: movement.id, amountMinor: "1234" }));
    await f.patch({ countryCode: "ve" });
    expect((await account.getAccountState(db, f.id)).activeFinancialContext).toEqual(venezuelan.activeFinancialContext);
  });

  it("cannot read or overwrite another user's profile through query or body IDs", async () => {
    const first = await fixture(), second = await fixture();
    await first.patch({ countryCode: "ES" });
    await second.patch({ countryCode: "VE" });
    const before = await account.getAccountState(db, second.id);
    const me = await first.request(`/v1/me?userId=${second.id}`);
    expect(await me.json()).toMatchObject({ data: { user: { id: first.id }, profile: { countryCode: "ES" } } });
    expect((await first.patch({ userId: second.id, countryCode: "ES" })).status).toBe(400);
    expect((await first.request(`/v1/me/profile?userId=${second.id}`, {
      method: "PATCH", body: JSON.stringify({ countryCode: "FR" }),
    })).status).toBe(200);
    expect(await account.getAccountState(db, second.id)).toEqual(before);
    expect((await account.getAccountState(db, first.id)).profile?.countryCode).toBe("FR");
  });

  it("does not create orphan contexts when the authenticated user has no profile", async () => {
    const f = await fixture(false);
    const response = await f.patch({ countryCode: "VE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "PROFILE_NOT_FOUND" } });
    expect(await db.select().from(financialContexts).where(eq(financialContexts.userId, f.id))).toEqual([]);
    expect(await db.select().from(spaces).where(eq(spaces.createdBy, f.id))).toEqual([]);
  });

  it("validates and normalizes country for service callers too", async () => {
    const f = await fixture();
    await expect(account.updateProfile(db, f.id, { countryCode: "ZZ" })).rejects.toThrow("INVALID_REQUEST");
    await expect(account.updateProfile(db, f.id, { countryCode: null })).rejects.toThrow("INVALID_REQUEST");
    expect((await account.updateProfile(db, f.id, { countryCode: "ve" }))?.countryCode).toBe("VE");
  });
});
