import { describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { merchantFeedbackAggregates, merchantFeedbackVotes, user } from "../../src/db/schema";
import { cleanupTestUsers, createTestUser, testDb } from "./harness";

const db = testDb();

/**
 * La limpieza del arnés solo puede tocar lo que crearon las pruebas. Antes
 * borraba todos los agregados de comercios sin votos de la base.
 */
describe("integration harness cleanup", () => {
  it("only recomputes or removes merchant aggregates voted by test users", async () => {
    const suffix = `${Date.now()}`;
    const foreignUserId = `harness-foreign-${suffix}`;
    const shared = { countryCode: "ES", normalizedMerchant: `harness-shared-${suffix}`, canonicalCategoryKey: "groceries" };
    const onlyTest = { countryCode: "ES", normalizedMerchant: `harness-only-test-${suffix}`, canonicalCategoryKey: "groceries" };
    const unrelated = { countryCode: "ES", normalizedMerchant: `harness-unrelated-${suffix}`, canonicalCategoryKey: "groceries" };

    // Una persona que no es de prueba (sin el prefijo `itest-`).
    await db.insert(user).values({ id: foreignUserId, name: "Ajena", email: `${foreignUserId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    try {
      const testUserId = await createTestUser(db, "harness-cleanup");
      await db.insert(merchantFeedbackVotes).values([
        { userId: foreignUserId, ...shared, confirmations: 2 },
        { userId: testUserId, ...shared, confirmations: 3 },
        { userId: testUserId, ...onlyTest, confirmations: 1 },
      ]);
      await db.insert(merchantFeedbackAggregates).values([
        { ...shared, uniqueUsers: 2, totalConfirmations: 5 },
        { ...onlyTest, uniqueUsers: 1, totalConfirmations: 1 },
        // Sin votos, pero no lo tocó ninguna prueba: debe sobrevivir.
        { ...unrelated, uniqueUsers: 0, totalConfirmations: 0 },
      ]);

      await cleanupTestUsers();

      const remaining = await db
        .select()
        .from(merchantFeedbackAggregates)
        .where(and(eq(merchantFeedbackAggregates.countryCode, "ES"), inArray(merchantFeedbackAggregates.normalizedMerchant, [shared.normalizedMerchant, onlyTest.normalizedMerchant, unrelated.normalizedMerchant])));
      const byMerchant = new Map(remaining.map((row) => [row.normalizedMerchant, row]));
      expect(byMerchant.get(shared.normalizedMerchant)).toMatchObject({ uniqueUsers: 1, totalConfirmations: 2 });
      expect(byMerchant.has(onlyTest.normalizedMerchant)).toBe(false);
      expect(byMerchant.get(unrelated.normalizedMerchant)).toMatchObject({ uniqueUsers: 0 });
      const [foreign] = await db.select({ id: user.id }).from(user).where(eq(user.id, foreignUserId));
      expect(foreign?.id).toBe(foreignUserId);
    } finally {
      await db.delete(merchantFeedbackAggregates).where(inArray(merchantFeedbackAggregates.normalizedMerchant, [shared.normalizedMerchant, onlyTest.normalizedMerchant, unrelated.normalizedMerchant]));
      await db.delete(user).where(eq(user.id, foreignUserId));
    }
  });
});
