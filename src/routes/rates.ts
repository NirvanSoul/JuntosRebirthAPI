import { Hono } from "hono";
import { errorResponse } from "../lib/http";
import { VenezuelaRateService } from "../services/rates/venezuela";
import type { Bindings } from "../types/env";

export const ratesRoute = new Hono<{ Bindings: Bindings }>();

ratesRoute.get("/venezuela", async (c) => {
  try {
    const rates = await new VenezuelaRateService().getRates();

    return c.json({ data: { rates } });
  } catch (error) {
    // Tragarse el motivo es justo lo que escondió durante semanas el fallo del
    // motor de recurrencias: el cliente ve un 502 opaco, pero el log dice cuál
    // de las cuatro comprobaciones del proveedor falló.
    const cause = error instanceof Error ? error.cause : undefined;
    console.error(
      "Venezuela rates failed:",
      error instanceof Error ? error.message : String(error),
      cause instanceof Error ? `| cause: ${cause.message}` : "",
    );
    return errorResponse(c, "VENEZUELA_RATES_UNAVAILABLE");
  }
});
