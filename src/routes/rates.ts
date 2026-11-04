import { Hono } from "hono";
import { createDb } from "../db/client";
import { logFailure } from "../lib/log";
import { errorResponse } from "../lib/http";
import { VenezuelaRateService } from "../services/rates/venezuela";
import { getCurrentUsdtRate } from "../services/venezuela-rate-history";
import type { Bindings } from "../types/env";

type Deps = { createDb: typeof createDb; getCurrentUsdtRate: typeof getCurrentUsdtRate };
const defaults: Deps = { createDb, getCurrentUsdtRate };

export function createRatesRoute(deps: Partial<Deps> = {}) {
  const d: Deps = { ...defaults, ...deps };
  const route = new Hono<{ Bindings: Bindings }>();

  route.get("/venezuela", async (c) => {
    const usdtPromise = currentUsdt(d, c.env?.DATABASE_URL);
    try {
      const rates = await new VenezuelaRateService().getRates();
      const usdt = await usdtPromise;

      return c.json({
        data: {
          rates: usdt
            ? [...rates, { source: usdt.source, baseCurrency: usdt.baseCurrency, quoteCurrency: usdt.quoteCurrency, rate: usdt.rate }]
            : rates,
        },
      });
    } catch (error) {
      // Tragarse el motivo es justo lo que escondió durante semanas el fallo del
      // motor de recurrencias: el cliente ve un 502 opaco, pero el log dice cuál
      // de las cuatro comprobaciones del proveedor falló.
      logFailure("venezuela_rates", error);
      return errorResponse(c, "VENEZUELA_RATES_UNAVAILABLE");
    }
  });

  return route;
}

/** El USDT sale de la base de Juntos y es opcional: su falla nunca tumba el BCV. */
async function currentUsdt(deps: Deps, databaseUrl: string | undefined) {
  if (!databaseUrl) return null;
  try {
    return await deps.getCurrentUsdtRate(deps.createDb(databaseUrl));
  } catch (error) {
    logFailure("venezuela_rates.usdt", error);
    return null;
  }
}

export const ratesRoute = createRatesRoute();
