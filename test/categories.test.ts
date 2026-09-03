import { Hono } from "hono";
import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Database } from "../src/db/client";
import type { AuthVariables } from "../src/middleware/auth";
import type { SpaceAccessVariables } from "../src/middleware/space-access";
import { createCategoriesRoute } from "../src/routes/categories";
import {
  buildCategoryListQuery,
  updateCategory,
  type CategoryResponse,
} from "../src/services/categories";
import type { Bindings } from "../src/types/env";

const bindings: Bindings = {
  DATABASE_URL: "postgresql://user:pass@ep-test.neon.tech/neondb",
  BETTER_AUTH_SECRET: "test-secret-min-32-chars-long-example-12345",
  BETTER_AUTH_URL: "https://juntos.test",
  GOOGLE_CLIENT_ID: "mock-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "mock-google-client-secret",
};

const category: CategoryResponse = {
  id: "category-1",
  name: "Comida",
  icon: "🍔",
  colorToken: "orange",
  createdBy: "user-1",
  isDefault: false,
  templateKey: null,
  isArchived: false,
  createdAt: new Date("2026-08-28T10:00:00.000Z"),
  budgets: [{ currency: "EUR", budgetAmountMinor: "30000" }],
};

function createTestApp(overrides: Record<string, unknown> = {}) {
  const dependencies = {
    createDb: () => ({} as Database),
    listCategories: vi.fn().mockResolvedValue([category]),
    findCategoryInSpace: vi.fn().mockResolvedValue({ id: category.id }),
    findCategoryBudgets: vi.fn().mockResolvedValue([
      { currency: "EUR", budgetAmountMinor: "30000" },
    ]),
    createCategory: vi.fn().mockImplementation((_db, input) =>
      Promise.resolve({ ...category, ...input, id: "category-2", budgets: [] }),
    ),
    updateCategory: vi.fn().mockResolvedValue({ ...category, budgets: [] }),
    upsertCategoryBudget: vi.fn().mockResolvedValue({
      currency: "EUR",
      budgetAmountMinor: "30000",
    }),
    deleteCategoryBudget: vi.fn().mockResolvedValue(undefined),
    categoryHasFutureRecurringSeries: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
  const testApp = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables & SpaceAccessVariables;
  }>();
  testApp.use("*", async (c, next) => {
    c.set("currentUserId", "user-1");
    c.set("activeSpaceMembership", { spaceId: "space-1", role: "member" });
    await next();
  });
  testApp.route(
    "/v1/spaces/:spaceId/categories",
    createCategoriesRoute(dependencies, async (_c, next) => next()),
  );
  return { testApp, dependencies };
}

describe("Categories routes", () => {
  it("rejects unauthenticated category access", async () => {
    const response = await app.request("/v1/spaces/space-1/categories");

    expect(response.status).toBe(401);
  });

  it("GET returns categories and serializes minor amounts as strings", async () => {
    const { testApp } = createTestApp();
    const response = await testApp.request("/v1/spaces/space-1/categories", {}, bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { categories: [{ id: "category-1", budgets: [{ budgetAmountMinor: "30000" }] }] },
    });
  });

  it("POST creates a category using only the authenticated user and path space", async () => {
    const { testApp, dependencies } = createTestApp();
    const response = await testApp.request(
      "/v1/spaces/space-1/categories",
      { method: "POST", body: JSON.stringify({ name: "  Comida  ", icon: "🍔" }) },
      bindings,
    );

    expect(response.status).toBe(201);
    expect(dependencies.createCategory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spaceId: "space-1", userId: "user-1", name: "Comida" }),
    );
  });

  it("POST rejects attempts to set server-controlled category fields", async () => {
    const { testApp } = createTestApp();
    const response = await testApp.request(
      "/v1/spaces/space-1/categories",
      { method: "POST", body: JSON.stringify({ name: "Comida", isDefault: true }) },
      bindings,
    );

    expect(response.status).toBe(400);
  });

  it("PATCH changes category fields", async () => {
    const { testApp, dependencies } = createTestApp();
    const response = await testApp.request(
      "/v1/spaces/space-1/categories/category-1",
      { method: "PATCH", body: JSON.stringify({ name: " Hogar ", colorToken: null }) },
      bindings,
    );

    expect(response.status).toBe(200);
    expect(dependencies.updateCategory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spaceId: "space-1", categoryId: "category-1", name: "Hogar", colorToken: null }),
    );
  });

  it("PATCH returns 404 for a category outside the requested space", async () => {
    const { testApp } = createTestApp({ updateCategory: vi.fn().mockResolvedValue(null) });
    const response = await testApp.request(
      "/v1/spaces/space-1/categories/category-other",
      { method: "PATCH", body: JSON.stringify({ name: "Hogar" }) },
      bindings,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "CATEGORY_NOT_FOUND" } });
  });

  it("PATCH forwards archive and restore state for timestamp handling in the service", async () => {
    const { testApp, dependencies } = createTestApp();
    await testApp.request(
      "/v1/spaces/space-1/categories/category-1",
      { method: "PATCH", body: JSON.stringify({ isArchived: true }) },
      bindings,
    );
    await testApp.request(
      "/v1/spaces/space-1/categories/category-1",
      { method: "PATCH", body: JSON.stringify({ isArchived: false }) },
      bindings,
    );

    expect(dependencies.updateCategory).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ isArchived: true }),
    );
    expect(dependencies.updateCategory).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ isArchived: false }),
    );
  });

  it("PATCH returns the real budgets, not an empty list", async () => {
    const { testApp } = createTestApp();

    const response = await testApp.request(
      "/v1/spaces/space-1/categories/category-1",
      { method: "PATCH", body: JSON.stringify({ name: "Ocio" }) },
      bindings,
    );
    const payload = (await response.json()) as {
      data: { category: { budgets: unknown[] } };
    };

    // Un cliente que fusione la respuesta del PATCH no puede perder los
    // presupuestos que sí devuelve el GET.
    expect(payload.data.category.budgets).toEqual([
      { currency: "EUR", budgetAmountMinor: "30000" },
    ]);
  });

  it("PUT creates or updates one normalized budget through the shared upsert", async () => {
    const { testApp, dependencies } = createTestApp();
    const first = await testApp.request(
      "/v1/spaces/space-1/categories/category-1/budgets/eur",
      { method: "PUT", body: JSON.stringify({ budgetAmountMinor: "30000" }) },
      bindings,
    );
    const second = await testApp.request(
      "/v1/spaces/space-1/categories/category-1/budgets/EUR",
      { method: "PUT", body: JSON.stringify({ budgetAmountMinor: "40000" }) },
      bindings,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(dependencies.upsertCategoryBudget).toHaveBeenCalledTimes(2);
    expect(dependencies.upsertCategoryBudget).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ currency: "EUR", budgetAmountMinor: 40000n, userId: "user-1" }),
    );
  });

  it.each(["-1", "300.50", 30000])(
    "PUT rejects invalid minor amount %j",
    async (budgetAmountMinor) => {
      const { testApp } = createTestApp();
      const response = await testApp.request(
        "/v1/spaces/space-1/categories/category-1/budgets/EUR",
        { method: "PUT", body: JSON.stringify({ budgetAmountMinor }) },
        bindings,
      );

      expect(response.status).toBe(400);
    },
  );

  it("DELETE removes only the selected budget", async () => {
    const { testApp, dependencies } = createTestApp();
    const response = await testApp.request(
      "/v1/spaces/space-1/categories/category-1/budgets/eur",
      { method: "DELETE" },
      bindings,
    );

    expect(response.status).toBe(204);
    expect(dependencies.deleteCategoryBudget).toHaveBeenCalledWith(
      expect.anything(),
      "category-1",
      "EUR",
    );
  });
});

describe("Categories service", () => {
  it("filters the requested space and excludes archived categories", () => {
    const db = drizzle.mock() as unknown as Database;
    const { sql, params } = buildCategoryListQuery(db, "space-1").toSQL();

    expect(sql).toContain('"categories"."space_id" = $1');
    expect(sql).toContain('"categories"."is_archived" = $2');
    expect(sql).toContain('"categories"."archived_at" is null');
    expect(params).toEqual(["space-1", false]);
  });

  it("sets archived_at when archiving and clears it when restoring", async () => {
    const values: Array<Record<string, unknown>> = [];
    const db = {
      update: vi.fn(() => ({
        set: (input: Record<string, unknown>) => {
          values.push(input);
          return {
            where: () => ({
              returning: () =>
                Promise.resolve([
                  {
                    id: "category-1",
                    name: "Comida",
                    icon: null,
                    colorToken: null,
                    isDefault: false,
                    templateKey: null,
                    isArchived: input.isArchived,
                    createdAt: new Date(),
                  },
                ]),
            }),
          };
        },
      })),
    } as unknown as Database;

    await updateCategory(db, {
      spaceId: "space-1",
      categoryId: "category-1",
      isArchived: true,
    });
    await updateCategory(db, {
      spaceId: "space-1",
      categoryId: "category-1",
      isArchived: false,
    });

    expect(values[0]).toMatchObject({
      isArchived: true,
      archivedAt: expect.any(Date),
    });
    expect(values[1]).toMatchObject({ isArchived: false, archivedAt: null });
  });
});
