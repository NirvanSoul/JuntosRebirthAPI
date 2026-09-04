import { Hono } from "hono";
import { createDb } from "../db/client";
import { convertMinorAmount, fromMinorUnits, isPositiveDecimal, toMinorUnits } from "../lib/decimal";
import { errorResponse } from "../lib/http";
import { parseBody } from "../lib/validation";
import { veDateString } from "../lib/venezuela-time";
import { ExchangeRatesUnavailableError, getCurrentRates } from "../services/exchange-rates";
import type { Bindings } from "../types/env";

type Env = { Bindings: Bindings };
type Currency = "USD" | "VES";
type PreviewInput = {
  amount: string;
  fromCurrency: Currency;
  toCurrency: Currency;
  source: "BCV";
};
type Deps = { createDb: typeof createDb; getCurrentRates: typeof getCurrentRates };

const defaults: Deps = { createDb, getCurrentRates };

/**
 * Contrato reducido para la pantalla de creación de movimientos. A diferencia
 * de `/v1/exchange/*`, que devuelve todas las referencias disponibles, estas
 * rutas modelan una conversión puntual USD ↔ VES para el selector Venezuela.
 */
export function createExchangeRatesRoute(deps: Deps = defaults) {
  const route = new Hono<Env>();

  route.get("/current", async (c) => {
    if (c.req.query("source") !== "BCV") return errorResponse(c, "INVALID_REQUEST");

    try {
      const current = await deps.getCurrentRates(deps.createDb(c.env.DATABASE_URL), "VE");
      const rate = current.rates.BCV;
      return c.json({
        source: rate.source,
        baseCurrency: rate.baseCurrency,
        quoteCurrency: rate.quoteCurrency,
        rate: rate.rate,
        effectiveDate: veDateString(new Date(rate.observedAt)),
        stale: current.stale,
      });
    } catch (error) {
      return handleUnavailable(c, error);
    }
  });

  route.post("/preview", async (c) => {
    const input = await parsePreview(c.req.raw);
    if (!input) return errorResponse(c, "INVALID_REQUEST");

    try {
      const current = await deps.getCurrentRates(deps.createDb(c.env.DATABASE_URL), "VE");
      const rate = current.rates.BCV;
      const amountMinor = toMinorUnits(input.amount);
      const convertedMinor = convertMinorAmount(
        amountMinor,
        rate.rate,
        input.fromCurrency === "USD" ? "multiply" : "divide",
      );

      return c.json({
        convertedAmount: fromMinorUnits(convertedMinor),
        rate: rate.rate,
        effectiveDate: veDateString(new Date(rate.observedAt)),
        stale: current.stale,
      });
    } catch (error) {
      return handleUnavailable(c, error);
    }
  });

  return route;
}

export const exchangeRatesRoute = createExchangeRatesRoute();

async function parsePreview(request: Request): Promise<PreviewInput | null> {
  const body = await parseBody(request, ["amount", "fromCurrency", "toCurrency", "source"]);
  if (!body || !isPositiveDecimal(body.amount)) return null;
  if (body.source !== "BCV") return null;
  if (!isCurrency(body.fromCurrency) || !isCurrency(body.toCurrency) || body.fromCurrency === body.toCurrency) return null;
  return {
    amount: body.amount.trim(),
    fromCurrency: body.fromCurrency,
    toCurrency: body.toCurrency,
    source: body.source,
  };
}

function isCurrency(value: unknown): value is Currency {
  return value === "USD" || value === "VES";
}

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
