import { Hono } from "hono";
import { VenezuelaRateService } from "../services/rates/venezuela";
import type { Bindings } from "../types/env";

export const ratesRoute = new Hono<{ Bindings: Bindings }>();

ratesRoute.get("/venezuela", async (c) => {
  try {
    const rates = await new VenezuelaRateService().getRates();

    return c.json({ data: { rates } });
  } catch {
    return c.json(
      {
        error: {
          code: "VENEZUELA_RATES_UNAVAILABLE",
          message: "Venezuela rates are unavailable",
        },
      },
      502,
    );
  }
});
