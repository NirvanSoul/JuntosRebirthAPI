import { describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client";
import { createTransaction } from "../../src/services/transactions";

/**
 * Regresión del bug real detrás de "el movimiento se le atribuye a otro
 * usuario en el espacio compartido": `createTransaction` metía `userId` tal
 * cual en `.values()`, pero la tabla `transactions` no tiene esa columna,
 * solo `created_by` — drizzle lo descartaba en silencio y el movimiento
 * quedaba sin autor. Este test falla si vuelve a pasar: comprueba los
 * valores que de verdad llegan a `.insert().values()`, no una respuesta
 * simulada.
 */
function mockDb(insertedRow: Record<string, unknown>) {
  let capturedValues: Record<string, unknown> | undefined;
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        capturedValues = values;
        return { returning: () => Promise.resolve([{ ...insertedRow, ...values }]) };
      },
    }),
  } as unknown as Database;
  return { db, getCapturedValues: () => capturedValues };
}

describe("createTransaction", () => {
  it("writes the creator's id to created_by, not to a nonexistent user_id column", async () => {
    const { db, getCapturedValues } = mockDb({
      id: "tx-1", type: "expense", amountMinor: 2599n, currency: "EUR", title: "Café",
      occurredOn: "2026-09-11", categoryId: "category-1", moneyAccountId: null, note: null,
      recurrence: "once", recurrenceGroupId: null, recurrenceSeriesId: null,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const result = await createTransaction(db, {
      spaceId: "space-1", userId: "user-b", type: "expense", amountMinor: 2599n, currency: "EUR",
      title: "Café", occurredOn: "2026-09-11", categoryId: "category-1", moneyAccountId: null,
      creatorCountryCode: null,
    });

    const values = getCapturedValues();
    expect(values?.createdBy).toBe("user-b");
    expect(values?.userId).toBeUndefined();
    expect(result.transaction?.createdBy).toBe("user-b");
  });

  it("attributes a second movement in the same space to whoever actually created it", async () => {
    const { db: dbA, getCapturedValues: valuesA } = mockDb({
      id: "tx-a", type: "expense", amountMinor: 1000n, currency: "EUR", title: "A's expense",
      occurredOn: "2026-09-11", categoryId: "category-1", moneyAccountId: null, note: null,
      recurrence: "once", recurrenceGroupId: null, recurrenceSeriesId: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const resultA = await createTransaction(dbA, {
      spaceId: "space-1", userId: "user-a", type: "expense", amountMinor: 1000n, currency: "EUR",
      title: "A's expense", occurredOn: "2026-09-11", categoryId: "category-1", moneyAccountId: null,
      creatorCountryCode: null,
    });

    const { db: dbB, getCapturedValues: valuesB } = mockDb({
      id: "tx-b", type: "expense", amountMinor: 2000n, currency: "EUR", title: "B's expense",
      occurredOn: "2026-09-11", categoryId: "category-1", moneyAccountId: null, note: null,
      recurrence: "once", recurrenceGroupId: null, recurrenceSeriesId: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const resultB = await createTransaction(dbB, {
      spaceId: "space-1", userId: "user-b", type: "expense", amountMinor: 2000n, currency: "EUR",
      title: "B's expense", occurredOn: "2026-09-11", categoryId: "category-1", moneyAccountId: null,
      creatorCountryCode: null,
    });

    expect(valuesA()?.createdBy).toBe("user-a");
    expect(valuesB()?.createdBy).toBe("user-b");
    expect(resultA.transaction?.createdBy).toBe("user-a");
    expect(resultB.transaction?.createdBy).toBe("user-b");
  });
});
