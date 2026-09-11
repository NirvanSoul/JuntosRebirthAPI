import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client";
import { buildChanges } from "../src/services/sync-snapshot";
import { createChangesRoute } from "../src/routes/sync";

const NOW = new Date("2026-08-29T10:00:00.000Z");

describe("changes route input and database failures", () => {
  it("returns 400 when since query parameter is missing", async () => {
    const route = createChangesRoute({
      createDb: vi.fn(),
      buildChanges: vi.fn(),
    });

    const response = await route.request("/changes", {}, { DATABASE_URL: "unused" });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("INVALID_REQUEST");
  });

  it("returns 400 when since query parameter is not a valid date", async () => {
    const route = createChangesRoute({
      createDb: vi.fn(),
      buildChanges: vi.fn(),
    });

    const response = await route.request("/changes?since=not-a-date", {}, { DATABASE_URL: "unused" });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("INVALID_REQUEST");
  });

  it.each(["42P01", "42703"])("returns a retryable 503 for PostgreSQL %s wrapped by Drizzle", async (code) => {
    const route = createChangesRoute({
      createDb: vi.fn(),
      buildChanges: vi.fn().mockRejectedValue({
        cause: { code, message: 'column "server_updated_at" does not exist' },
      }),
    });

    const response = await route.request("/changes?since=2026-08-29T10:00:00.000Z", {}, { DATABASE_URL: "unused" });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.text()).toContain("DATABASE_SCHEMA_OUTDATED");
  });
});

/** Devuelve las lecturas en el orden del servicio buildChanges. */
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

describe("account delta changes", () => {
  it("returns empty collections when user has no spaces", async () => {
    const changes = await buildChanges(fakeDatabase([[]]), "user-1", NOW);

    expect(changes).toEqual({
      activeFinancialContextId: null,
      serverTime: expect.any(String),
      spaces: [],
      categories: [],
      moneyAccounts: [],
      recurringSeries: [],
      transactions: [],
    });
  });

  it("reads delta parents and filters child tables by changed parent IDs", async () => {
    const db = fakeDatabase([
      // 0: memberships
      [{ id: "space-1", name: "Personal", type: "personal", currency: "EUR", timezone: "UTC", role: "owner", activatedAt: NOW, createdAt: NOW, updatedAt: NOW }],
      // 1: categories (changed)
      [{ id: "cat-1", spaceId: "space-1", name: "Ocio", icon: null, colorToken: null, createdBy: "user-author-cat", isDefault: false, templateKey: null, isArchived: false, createdAt: NOW, updatedAt: NOW, archivedAt: null }],
      // 2: moneyAccounts (empty)
      [],
      // 3: recurringSeries (empty)
      [],
      // 4: transactions (empty)
      [],
      // 5: budgets (for changed cat-1)
      [{ categoryId: "cat-1", currency: "EUR", budgetAmountMinor: 50000n }],
    ]);

    const changes = await buildChanges(db, "user-1", NOW);

    expect(changes.spaces).toHaveLength(1);
    expect(changes.categories).toHaveLength(1);
    expect(changes.categories[0]?.budgets).toEqual([{ currency: "EUR", budgetAmountMinor: "50000" }]);
    expect(changes.moneyAccounts).toEqual([]);
    expect(changes.recurringSeries).toEqual([]);
    expect(changes.transactions).toEqual([]);
    expect((changes as any).members).toBeUndefined();
  });
});
