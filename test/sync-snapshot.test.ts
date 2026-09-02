import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { buildSnapshot } from "../src/services/sync-snapshot";

const NOW = new Date("2026-08-29T10:00:00.000Z");

/** Devuelve las lecturas en el orden del servicio: espacios, miembros y luego las cinco colecciones. */
function fakeDatabase(reads: unknown[][]) {
  let call = 0;
  const db = {
    select: () => ({
      from: () => {
        const rows = reads[call++] ?? [];
        const chain = {
          where: () => Promise.resolve(rows),
          innerJoin: () => chain,
          leftJoin: () => chain,
        };
        return chain;
      },
    }),
  } as unknown as Database;
  return db;
}

describe("account snapshot", () => {
  it("returns empty collections when the user has no active space", async () => {
    const snapshot = await buildSnapshot(fakeDatabase([[]]), "user-1");

    expect(snapshot).toEqual({
      spaces: [],
      members: [],
      categories: [],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });
  });

  it("folds budgets and balances into their parent and serializes amounts as strings", async () => {
    const db = fakeDatabase([
      [{ id: "space-1", name: "Personal", type: "personal", currency: "EUR", timezone: "UTC", role: "owner", activatedAt: NOW, createdAt: NOW, updatedAt: NOW }],
      [{ spaceId: "space-1", userId: "user-1", displayName: "Ana", image: null, avatarPath: "user-1/avatar.jpg", avatarUpdatedAt: NOW }],
      [{ id: "cat-1", spaceId: "space-1", name: "Ocio", icon: null, colorToken: null, isDefault: false, templateKey: null, isArchived: false, createdAt: NOW, updatedAt: NOW, archivedAt: null }],
      [{ categoryId: "cat-1", currency: "EUR", budgetAmountMinor: 25000n }],
      [{ id: "acc-1", spaceId: "space-1", name: "Revolut", kind: "bank", icon: null, colorToken: null, primaryCurrency: "EUR", isArchived: false, createdAt: NOW, updatedAt: NOW, archivedAt: null }],
      [
        { moneyAccountId: "acc-1", currency: "USD", openingBalanceMinor: -2500n, displayOrder: 1 },
        { moneyAccountId: "acc-1", currency: "EUR", openingBalanceMinor: 100000n, displayOrder: 0 },
      ],
      [{ id: "ser-1", spaceId: "space-1", amountMinor: 900n }],
      [{ id: "tx-1", spaceId: "space-1", amountMinor: 1250n, note: "Con Ana", recurrence: "custom", recurrenceGroupId: "group-9" }],
    ]);

    const snapshot = await buildSnapshot(db, "user-1");

    // Regresión: los miembros de un espacio compartido viajan en el propio
    // snapshot para que su avatar se refresque en el mismo ciclo de sync
    // automático que el resto de datos, sin depender de una llamada aparte a
    // GET /v1/spaces/:spaceId/members.
    expect(snapshot.members).toEqual([
      {
        spaceId: "space-1",
        userId: "user-1",
        displayName: "Ana",
        image: null,
        avatarPath: "user-1/avatar.jpg",
        avatarUpdatedAt: NOW,
      },
    ]);

    expect(snapshot.categories[0]?.budgets).toEqual([
      { currency: "EUR", budgetAmountMinor: "25000" },
    ]);
    // El cliente pinta las divisas en el orden que fijó la persona.
    expect(snapshot.moneyAccounts[0]?.balances.map((balance) => balance.currency)).toEqual([
      "EUR",
      "USD",
    ]);
    expect(snapshot.moneyAccounts[0]?.balances[1]?.openingBalanceMinor).toBe("-2500");
    expect(snapshot.recurringSeries[0]?.amountMinor).toBe("900");
    // Los campos de paridad del ledger tienen que llegar al restaurar.
    expect(snapshot.transactions[0]).toMatchObject({
      amountMinor: "1250",
      note: "Con Ana",
      recurrence: "custom",
      recurrenceGroupId: "group-9",
    });
  });
});
