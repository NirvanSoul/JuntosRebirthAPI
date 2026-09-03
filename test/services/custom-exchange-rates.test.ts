import { describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client";
import { createCustomExchangeRate, updateCustomExchangeRate } from "../../src/services/custom-exchange-rates";

function mockDb() {
  const calls: { op: "update" | "insert"; set?: Record<string, unknown>; values?: Record<string, unknown> }[] = [];
  const db = {
    update: () => ({
      set: (set: Record<string, unknown>) => {
        calls.push({ op: "update", set });
        return { where: () => ({ returning: () => Promise.resolve([{ id: "rate-2", ...set }]) }) };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        calls.push({ op: "insert", values });
        return { returning: () => Promise.resolve([{ id: "rate-2", createdAt: new Date(), updatedAt: new Date(), ...values }]) };
      },
    }),
  } as unknown as Database;
  return { db, calls };
}

describe("custom exchange rates default flag", () => {
  it("clears any existing default before inserting a new default", async () => {
    const { db, calls } = mockDb();
    await createCustomExchangeRate(db, { userId: "user-1", countryCode: "VE", name: "Nueva", rate: "60", isDefault: true });

    expect(calls[0]).toMatchObject({ op: "update", set: { isDefault: false } });
    expect(calls[1]).toMatchObject({ op: "insert", values: { isDefault: true } });
  });

  it("does not touch other rates when isDefault is not set", async () => {
    const { db, calls } = mockDb();
    await createCustomExchangeRate(db, { userId: "user-1", countryCode: "VE", name: "Nueva", rate: "60", isDefault: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe("insert");
  });

  it("clears the previous default before promoting another rate via update", async () => {
    const { db, calls } = mockDb();
    await updateCustomExchangeRate(db, { userId: "user-1", id: "rate-2", isDefault: true });

    expect(calls[0]).toMatchObject({ op: "update", set: { isDefault: false } });
    expect(calls[1]).toMatchObject({ op: "update", set: expect.objectContaining({ isDefault: true }) });
  });
});
