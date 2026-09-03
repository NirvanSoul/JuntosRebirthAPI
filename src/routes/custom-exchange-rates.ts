import { Hono } from "hono";
import { createDb } from "../db/client";
import { isPositiveDecimal } from "../lib/decimal";
import { errorResponse } from "../lib/http";
import { boundedString, parseBody } from "../lib/validation";
import type { AuthVariables } from "../middleware/auth";
import {
  createCustomExchangeRate,
  deleteCustomExchangeRate,
  findCustomExchangeRate,
  listCustomExchangeRates,
  updateCustomExchangeRate,
} from "../services/custom-exchange-rates";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings; Variables: AuthVariables };
type Deps = {
  createDb: typeof createDb;
  listCustomExchangeRates: typeof listCustomExchangeRates;
  findCustomExchangeRate: typeof findCustomExchangeRate;
  createCustomExchangeRate: typeof createCustomExchangeRate;
  updateCustomExchangeRate: typeof updateCustomExchangeRate;
  deleteCustomExchangeRate: typeof deleteCustomExchangeRate;
};

const defaults: Deps = {
  createDb,
  listCustomExchangeRates,
  findCustomExchangeRate,
  createCustomExchangeRate,
  updateCustomExchangeRate,
  deleteCustomExchangeRate,
};

export function createCustomExchangeRatesRoute(deps: Deps = defaults) {
  const route = new Hono<Env>();

  route.get("/", async (c) => {
    try {
      const rates = await deps.listCustomExchangeRates(deps.createDb(c.env.DATABASE_URL), c.get("currentUserId"));
      return c.json({ data: { rates } });
    } catch {
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  route.post("/", async (c) => {
    const input = await parseCreate(c.req.raw);
    if (!input) return errorResponse(c, "INVALID_REQUEST");

    try {
      const rate = await deps.createCustomExchangeRate(deps.createDb(c.env.DATABASE_URL), {
        userId: c.get("currentUserId"),
        countryCode: "VE",
        ...input,
      });
      return c.json({ data: { rate } }, 201);
    } catch {
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  route.patch("/:id", async (c) => {
    const input = await parsePatch(c.req.raw);
    if (!input) return errorResponse(c, "INVALID_REQUEST");

    try {
      const db = deps.createDb(c.env.DATABASE_URL);
      const userId = c.get("currentUserId");
      const existing = await deps.findCustomExchangeRate(db, userId, c.req.param("id")!);
      if (!existing) return errorResponse(c, "CUSTOM_RATE_NOT_FOUND");

      const rate = await deps.updateCustomExchangeRate(db, { userId, id: existing.id, ...input });
      return c.json({ data: { rate } });
    } catch {
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  route.delete("/:id", async (c) => {
    try {
      const deleted = await deps.deleteCustomExchangeRate(
        deps.createDb(c.env.DATABASE_URL),
        c.get("currentUserId"),
        c.req.param("id")!,
      );
      if (!deleted) return errorResponse(c, "CUSTOM_RATE_NOT_FOUND");
      return c.body(null, 204);
    } catch {
      return errorResponse(c, "INTERNAL_SERVER_ERROR");
    }
  });

  return route;
}

export const customExchangeRatesRoute = createCustomExchangeRatesRoute();

async function parseCreate(request: Request) {
  const body = await parseBody(request, ["name", "rate", "isDefault"]);
  if (!body) return null;

  const name = boundedString(body.name, 60);
  if (!name || !isPositiveDecimal(body.rate)) return null;
  if (body.isDefault !== undefined && typeof body.isDefault !== "boolean") return null;

  return { name, rate: body.rate, isDefault: body.isDefault ?? false };
}

async function parsePatch(request: Request) {
  const body = await parseBody(request, ["name", "rate", "isDefault"]);
  if (!body || !Object.keys(body).length) return null;

  const input: { name?: string; rate?: string; isDefault?: boolean } = {};
  if ("name" in body) {
    const name = boundedString(body.name, 60);
    if (!name) return null;
    input.name = name;
  }
  if ("rate" in body) {
    if (!isPositiveDecimal(body.rate)) return null;
    input.rate = body.rate;
  }
  if ("isDefault" in body) {
    if (typeof body.isDefault !== "boolean") return null;
    input.isDefault = body.isDefault;
  }
  return input;
}
