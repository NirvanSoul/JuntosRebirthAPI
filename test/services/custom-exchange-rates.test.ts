import { describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client";
import { createCustomExchangeRate, updateCustomExchangeRate } from "../../src/services/custom-exchange-rates";

type Call = { op: "update" | "insert"; set?: Record<string, unknown>; values?: Record<string, unknown> };

/**
 * Registra las escrituras en el orden en que se ejecutan: fuera de un batch al
 * esperarlas, dentro de un batch en el orden del batch (una transacción).
 */
function mockDb() {
  const calls: Call[] = [];
  const tagged = <T extends object>(call: Call, value: T) => Object.assign(value, { call });
  const run = (item: unknown) => {
    const call = (item as { call?: Call }).call;
    if (call) calls.push(call);
  };
  const db = {
    update: () => ({
      set: (set: Record<string, unknown>) => {
        const call: Call = { op: "update", set };
        const result = () => {
          run(where);
          return Promise.resolve([{ id: "rate-2", ...set }]);
        };
        const where = tagged(call, { returning: () => tagged(call, { then: (resolve: (v: unknown) => void) => resolve(result()) }) });
        return { where: () => where };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const call: Call = { op: "insert", values };
        const row = { id: "rate-2", createdAt: new Date(), updatedAt: new Date(), ...values };
        return {
          returning: () => tagged(call, {
            then: (resolve: (v: unknown) => void) => {
              calls.push(call);
              resolve([row]);
            },
            rows: [row],
          }),
        };
      },
    }),
    // Bloqueo por persona: no es una escritura.
    execute: () => ({ rows: [] }),
    select: () => ({ from: () => ({ where: () => ({}) }) }),
    batch: (items: unknown[]) =>
      Promise.resolve(items.map((item) => {
        run(item);
        return (item as { rows?: unknown[] }).rows ?? [{ id: "rate-2", ...((item as { call?: Call }).call?.set ?? {}) }];
      })),
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
