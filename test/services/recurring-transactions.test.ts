import { describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client";
import { createSeries } from "../../src/services/recurring-transactions";

/** Mismo bug que en `transactions.ts`: `userId` no es una columna de `recurring_transaction_series`, solo `created_by`. */
function mockDb() {
  let capturedValues: Record<string, unknown> | undefined;
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        capturedValues = values;
        return Promise.resolve();
      },
    }),
  } as unknown as Database;
  return { db, getCapturedValues: () => capturedValues };
}

describe("createSeries", () => {
  it("writes the creator's id to created_by, not to a nonexistent user_id column", async () => {
    const { db, getCapturedValues } = mockDb();

    const result = await createSeries(db, {
      spaceId: "space-1", userId: "user-b", type: "expense", amountMinor: 5000n, currency: "EUR",
      title: "Netflix", categoryId: "category-1", moneyAccountId: null, frequency: "monthly",
      startsOn: "2026-09-11",
    });

    const values = getCapturedValues();
    expect(values?.createdBy).toBe("user-b");
    expect(values?.userId).toBeUndefined();
    expect(result.createdBy).toBe("user-b");
  });
});
