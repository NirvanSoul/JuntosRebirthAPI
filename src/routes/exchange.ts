import { Hono } from "hono";
import { createDb } from "../db/client";
import { isPositiveDecimal } from "../lib/decimal";
import { errorResponse } from "../lib/http";
import { parseBody } from "../lib/validation";
import { ExchangeRatesUnavailableError, getCurrentRates, previewConversion } from "../services/exchange-rates";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings };
type Deps = { createDb: typeof createDb; getCurrentRates: typeof getCurrentRates; previewConversion: typeof previewConversion };

const defaults: Deps = { createDb, getCurrentRates, previewConversion };

export function createExchangeRoute(deps: Deps = defaults) {
  const route = new Hono<Env>();

  route.get("/rates", async (c) => {
    try {
      const rates = await deps.getCurrentRates(deps.createDb(c.env.DATABASE_URL), "VE");
      return c.json({ data: rates });
    } catch (error) {
      return handleUnavailable(c, error);
    }
  });

  route.post("/preview", async (c) => {
    const input = await parsePreview(c.req.raw);
    if (!input) return errorResponse(c, "INVALID_REQUEST");

    try {
      const preview = await deps.previewConversion(deps.createDb(c.env.DATABASE_URL), input);
      return c.json({ data: preview });
    } catch (error) {
      return handleUnavailable(c, error);
    }
  });

  return route;
}

export const exchangeRoute = createExchangeRoute();

function handleUnavailable(c: Parameters<typeof errorResponse>[0], error: unknown) {
  if (error instanceof ExchangeRatesUnavailableError) {
    const cause = error.cause;
    console.error(
      "Venezuela exchange rates failed:",
      error.message,
      cause instanceof Error ? `| cause: ${cause.message}` : "",
    );
    return errorResponse(c, "VENEZUELA_RATES_UNAVAILABLE");
  }
  console.error("Unexpected exchange rates failure:", error instanceof Error ? error.message : String(error));
  return errorResponse(c, "INTERNAL_SERVER_ERROR");
}

async function parsePreview(request: Request) {
  const body = await parseBody(request, ["countryCode", "amount", "currency"]);
  if (!body) return null;
  if (body.countryCode !== "VE") return null;
  if (!isPositiveDecimal(body.amount)) return null;
  if (body.currency !== "VES" && body.currency !== "USD") return null;
  return { amount: body.amount, currency: body.currency } as const;
}
