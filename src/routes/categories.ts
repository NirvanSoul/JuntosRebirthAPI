import { Hono, type MiddlewareHandler } from "hono";
import { normalizeCurrency } from "../lib/currency";
import { errorResponse } from "../lib/http";
import { parseMinorAmount } from "../lib/money";
import type { AuthVariables } from "../middleware/auth";
import {
  requireActiveSpaceMember,
  type SpaceAccessVariables,
} from "../middleware/space-access";
import {
  createCategory,
  deleteCategoryBudget,
  findCategoryInSpace,
  listCategories,
  updateCategory,
  upsertCategoryBudget,
} from "../services/categories";
import { createDb } from "../db/client";
import type { Bindings } from "../types/env";

type CategoriesEnvironment = {
  Bindings: Bindings;
  Variables: AuthVariables & SpaceAccessVariables;
};

type CategoriesDependencies = {
  createDb: typeof createDb;
  listCategories: typeof listCategories;
  findCategoryInSpace: typeof findCategoryInSpace;
  createCategory: typeof createCategory;
  updateCategory: typeof updateCategory;
  upsertCategoryBudget: typeof upsertCategoryBudget;
  deleteCategoryBudget: typeof deleteCategoryBudget;
};

const defaultDependencies: CategoriesDependencies = {
  createDb,
  listCategories,
  findCategoryInSpace,
  createCategory,
  updateCategory,
  upsertCategoryBudget,
  deleteCategoryBudget,
};

export function createCategoriesRoute(
  dependencies: CategoriesDependencies = defaultDependencies,
  spaceAccessMiddleware: MiddlewareHandler<CategoriesEnvironment> = requireActiveSpaceMember,
) {
  const route = new Hono<CategoriesEnvironment>();
  route.use("*", spaceAccessMiddleware);

  route.get("/", async (c) => {
    try {
      const categories = await dependencies.listCategories(
        dependencies.createDb(c.env.DATABASE_URL),
        c.req.param("spaceId")!,
      );

      return c.json({ data: { categories } });
    } catch {
      return errorResponse(c, 500, "INTERNAL_ERROR", "Internal error.");
    }
  });

  route.post("/", async (c) => {
    const input = await parseCreateCategoryInput(c.req.raw);
    if (!input) return errorResponse(c, 400, "INVALID_REQUEST", "Invalid request.");

    try {
      const category = await dependencies.createCategory(
        dependencies.createDb(c.env.DATABASE_URL),
        {
          spaceId: c.req.param("spaceId")!,
          userId: c.get("currentUserId"),
          ...input,
        },
      );

      return c.json({ data: { category } }, 201);
    } catch {
      return errorResponse(c, 500, "INTERNAL_ERROR", "Internal error.");
    }
  });

  route.patch("/:categoryId", async (c) => {
    const input = await parseUpdateCategoryInput(c.req.raw);
    if (!input) return errorResponse(c, 400, "INVALID_REQUEST", "Invalid request.");

    try {
      const category = await dependencies.updateCategory(
        dependencies.createDb(c.env.DATABASE_URL),
        {
          spaceId: c.req.param("spaceId")!,
          categoryId: c.req.param("categoryId")!,
          ...input,
        },
      );

      if (!category) {
        return errorResponse(c, 404, "CATEGORY_NOT_FOUND", "Category not found.");
      }

      return c.json({ data: { category } });
    } catch {
      return errorResponse(c, 500, "INTERNAL_ERROR", "Internal error.");
    }
  });

  route.put("/:categoryId/budgets/:currency", async (c) => {
    const budgetAmountMinor = await parseBudgetAmount(c.req.raw);
    const currency = normalizeCurrency(c.req.param("currency"));
    if (budgetAmountMinor === null || !currency) {
      return errorResponse(c, 400, "INVALID_REQUEST", "Invalid request.");
    }

    try {
      const db = dependencies.createDb(c.env.DATABASE_URL);
      const category = await dependencies.findCategoryInSpace(
        db,
        c.req.param("spaceId")!,
        c.req.param("categoryId")!,
      );
      if (!category) {
        return errorResponse(c, 404, "CATEGORY_NOT_FOUND", "Category not found.");
      }

      const budget = await dependencies.upsertCategoryBudget(db, {
        categoryId: category.id,
        userId: c.get("currentUserId"),
        currency,
        budgetAmountMinor,
      });

      return c.json({ data: { budget } });
    } catch {
      return errorResponse(c, 500, "INTERNAL_ERROR", "Internal error.");
    }
  });

  route.delete("/:categoryId/budgets/:currency", async (c) => {
    const currency = normalizeCurrency(c.req.param("currency"));
    if (!currency) return errorResponse(c, 400, "INVALID_REQUEST", "Invalid request.");

    try {
      const db = dependencies.createDb(c.env.DATABASE_URL);
      const category = await dependencies.findCategoryInSpace(
        db,
        c.req.param("spaceId")!,
        c.req.param("categoryId")!,
      );
      if (!category) {
        return errorResponse(c, 404, "CATEGORY_NOT_FOUND", "Category not found.");
      }

      await dependencies.deleteCategoryBudget(db, category.id, currency);
      return c.body(null, 204);
    } catch {
      return errorResponse(c, 500, "INTERNAL_ERROR", "Internal error.");
    }
  });

  return route;
}

export const categoriesRoute = createCategoriesRoute();

async function parseCreateCategoryInput(request: Request) {
  const body = await parseObjectBody(request);
  if (!body || !hasOnlyKeys(body, ["name", "icon", "colorToken"])) return null;

  const name = parseCategoryName(body.name);
  const icon = "icon" in body ? parseOptionalText(body.icon) : null;
  const colorToken =
    "colorToken" in body ? parseOptionalText(body.colorToken) : null;

  if (!name || icon === undefined || colorToken === undefined) return null;
  return { name, icon, colorToken };
}

async function parseUpdateCategoryInput(request: Request) {
  const body = await parseObjectBody(request);
  if (!body || !hasOnlyKeys(body, ["name", "icon", "colorToken", "isArchived"])) {
    return null;
  }

  const input: {
    name?: string;
    icon?: string | null;
    colorToken?: string | null;
    isArchived?: boolean;
  } = {};

  if ("name" in body) {
    const name = parseCategoryName(body.name);
    if (!name) return null;
    input.name = name;
  }
  if ("icon" in body) {
    const icon = parseOptionalText(body.icon);
    if (icon === undefined) return null;
    input.icon = icon;
  }
  if ("colorToken" in body) {
    const colorToken = parseOptionalText(body.colorToken);
    if (colorToken === undefined) return null;
    input.colorToken = colorToken;
  }
  if ("isArchived" in body) {
    if (typeof body.isArchived !== "boolean") return null;
    input.isArchived = body.isArchived;
  }

  return Object.keys(input).length > 0 ? input : null;
}

async function parseBudgetAmount(request: Request) {
  const body = await parseObjectBody(request);
  if (!body || !hasOnlyKeys(body, ["budgetAmountMinor"])) return null;

  const amount = parseMinorAmount(body.budgetAmountMinor);
  return amount === null || amount < 0n ? null : amount;
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseCategoryName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 60 ? name : null;
}

function parseOptionalText(value: unknown): string | null | undefined {
  return value === undefined || value === null || typeof value === "string"
    ? value
    : undefined;
}

function hasOnlyKeys(body: Record<string, unknown>, allowedKeys: string[]) {
  return Object.keys(body).every((key) => allowedKeys.includes(key));
}
