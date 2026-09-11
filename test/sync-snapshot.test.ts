import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { buildSnapshot } from "../src/services/sync-snapshot";
import { createSnapshotRoute } from "../src/routes/sync";

const NOW = new Date("2026-08-29T10:00:00.000Z");

describe("snapshot route database failures", () => {
  it.each(["42P01", "42703"])("returns a retryable 503 for PostgreSQL %s wrapped by Drizzle", async (code) => {
    const route = createSnapshotRoute({
      createDb: vi.fn(),
      buildSnapshot: vi.fn().mockRejectedValue({
        cause: { code, message: 'column "user_profiles.country_code" does not exist' },
      }),
    });

    const response = await route.request("/snapshot", {}, { DATABASE_URL: "unused" });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.text()).toContain("DATABASE_SCHEMA_OUTDATED");
  });

  it("keeps unrelated failures as internal errors without leaking details", async () => {
    const route = createSnapshotRoute({
      createDb: vi.fn(),
      buildSnapshot: vi.fn().mockRejectedValue(new Error("private database detail")),
    });

    const response = await route.request("/snapshot", {}, { DATABASE_URL: "unused" });

    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    const body = await response.text();
    expect(body).toContain("INTERNAL_SERVER_ERROR");
    expect(body).not.toContain("private database detail");
  });
});

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
      activeFinancialContextId: null,
      serverTime: expect.any(String),
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
      [{ id: "cat-1", spaceId: "space-1", name: "Ocio", icon: null, colorToken: null, createdBy: "user-author-cat", isDefault: false, templateKey: null, isArchived: false, createdAt: NOW, updatedAt: NOW, archivedAt: null }],
      [{ categoryId: "cat-1", currency: "EUR", budgetAmountMinor: 25000n }],
      [{ id: "acc-1", spaceId: "space-1", name: "Revolut", kind: "bank", icon: null, colorToken: null, primaryCurrency: "EUR", createdBy: "user-author-acc", isArchived: false, createdAt: NOW, updatedAt: NOW, archivedAt: null }],
      [
        { moneyAccountId: "acc-1", currency: "USD", openingBalanceMinor: -2500n, displayOrder: 1 },
        { moneyAccountId: "acc-1", currency: "EUR", openingBalanceMinor: 100000n, displayOrder: 0 },
      ],
      [{ id: "ser-1", spaceId: "space-1", amountMinor: 900n, createdBy: "user-author-ser" }],
      [{ id: "tx-1", spaceId: "space-1", amountMinor: 1250n, accountingAmountMinorUsd: 2500n, currency: "VES", note: "Con Ana", createdBy: "user-author-tx", recurrence: "custom", recurrenceGroupId: "group-9" }],
      [{ transactionId: "tx-1", rateSource: "BCV", displayCurrency: "USD", referenceAsset: "USD", rate: "50.0000000000", convertedAmountMinor: 2500n, observedAt: NOW }],
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
    expect(snapshot.categories[0]?.createdBy).toBe("user-author-cat");
    // El cliente pinta las divisas en el orden que fijó la persona.
    expect(snapshot.moneyAccounts[0]?.balances.map((balance) => balance.currency)).toEqual([
      "EUR",
      "USD",
    ]);
    expect(snapshot.moneyAccounts[0]?.balances[1]?.openingBalanceMinor).toBe("-2500");
    expect(snapshot.moneyAccounts[0]?.createdBy).toBe("user-author-acc");
    expect(snapshot.recurringSeries[0]?.amountMinor).toBe("900");
    expect(snapshot.recurringSeries[0]?.createdBy).toBe("user-author-ser");
    // Los campos de paridad del ledger tienen que llegar al restaurar.
    expect(snapshot.transactions[0]).toMatchObject({
      amountMinor: "1250",
      accountingAmountMinorUsd: "2500",
      note: "Con Ana",
      createdBy: "user-author-tx",
      recurrence: "custom",
      recurrenceGroupId: "group-9",
    });
    expect(snapshot.transactions[0]?.exchangeSnapshot).toMatchObject({
      rates: { BCV: { convertedAmountMinor: "2500", convertedCurrency: "USD" } },
    });
  });
});
