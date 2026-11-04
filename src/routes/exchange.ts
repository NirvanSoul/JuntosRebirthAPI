import { Hono } from "hono";
import { logFailure } from "../lib/log";
import { createDb } from "../db/client";
import { daysBetween, parseClockTime, parseIsoDate } from "../lib/date";
import { isPositiveDecimal } from "../lib/decimal";
import { errorResponse } from "../lib/http";
import { parseBody } from "../lib/validation";
import { addDaysToDateString, veDateString } from "../lib/venezuela-time";
import { ExchangeRatesUnavailableError, getCurrentRates, previewConversion } from "../services/exchange-rates";
import { getRateHistory, getRatesAt } from "../services/venezuela-rate-history";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings };
type Deps = {
  createDb: typeof createDb;
  getCurrentRates: typeof getCurrentRates;
  previewConversion: typeof previewConversion;
  getRatesAt: typeof getRatesAt;
  getRateHistory: typeof getRateHistory;
};

const defaults: Deps = { createDb, getCurrentRates, previewConversion, getRatesAt, getRateHistory };

/** Un año y un día: suficiente para cualquier gráfico, acotado para no volcar la tabla entera. */
const MAX_HISTORY_DAYS = 366;

export function createExchangeRoute(deps: Partial<Deps> = {}) {
  const d: Deps = { ...defaults, ...deps };
  const route = new Hono<Env>();

  route.get("/rates", async (c) => {
    try {
      const rates = await d.getCurrentRates(d.createDb(c.env.DATABASE_URL), "VE");
      return c.json({ data: rates });
    } catch (error) {
      return handleUnavailable(c, error);
    }
  });

  /**
   * Tasas que regían en una fecha (y hora opcional) de Venezuela:
   * `?date=YYYY-MM-DD&time=HH:mm`. Lee solo la base de Juntos.
   */
  route.get("/rates/at", async (c) => {
    const date = parseIsoDate(c.req.query("date"));
    const rawTime = c.req.query("time");
    const time = rawTime === undefined ? null : parseClockTime(rawTime);
    // Mañana es el límite: el BCV publica por la tarde la tasa del día siguiente.
    if (!date || (rawTime !== undefined && !time) || date > addDaysToDateString(veDateString(new Date()), 1)) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      return c.json({ data: await d.getRatesAt(d.createDb(c.env.DATABASE_URL), date, time) });
    } catch (error) {
      logFailure("venezuela_rates_at", error);
      return errorResponse(c, "VENEZUELA_RATES_UNAVAILABLE");
    }
  });

  /** Una fila por día: `?from=YYYY-MM-DD&to=YYYY-MM-DD`, máximo 366 días. */
  route.get("/rates/history", async (c) => {
    const from = parseIsoDate(c.req.query("from"));
    const to = parseIsoDate(c.req.query("to"));
    if (!from || !to || from > to || daysBetween(from, to) >= MAX_HISTORY_DAYS) {
      return errorResponse(c, "INVALID_REQUEST");
    }

    try {
      return c.json({ data: { from, to, rates: await d.getRateHistory(d.createDb(c.env.DATABASE_URL), from, to) } });
    } catch (error) {
      logFailure("venezuela_rate_history", error);
      return errorResponse(c, "VENEZUELA_RATES_UNAVAILABLE");
    }
  });

  route.post("/preview", async (c) => {
    const input = await parsePreview(c.req.raw);
    if (!input) return errorResponse(c, "INVALID_REQUEST");

    try {
      const preview = await d.previewConversion(d.createDb(c.env.DATABASE_URL), input);
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
    logFailure("venezuela_exchange_rates", error);
    return errorResponse(c, "VENEZUELA_RATES_UNAVAILABLE");
  }
  logFailure("unexpected_exchange_rates_failure", error);
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
