import { createDb } from "../db/client";
import { logFailure } from "../lib/log";
import type { Bindings } from "../types/env";
import { KuantoRatesClient } from "./rates/kuanto";
import { syncVenezuelaRateHistory, type SyncResult } from "./venezuela-rate-history";

/**
 * Deben coincidir con `triggers.crons` de `wrangler.jsonc`.
 *
 * Kuanto actualiza `daily_rates` a los :05 de cada hora, así que las tasas se
 * copian a los :10 y :40 (cada 30 min, a 5 min de cada actualización). Las
 * tareas horarias (recurrencias, invitaciones, BCV del día siguiente) siguen
 * en su propio disparo para no correr el doble.
 */
export const HOURLY_CRON = "0 * * * *";
export const RATES_CRON = "10,40 * * * *";

/** Copia `daily_rates` de Kuanto. Nunca lanza: una caída de Supabase no puede tumbar el resto del cron. */
export async function runVenezuelaRateSync(env: Bindings): Promise<SyncResult | { skipped: string } | { failed: true }> {
  if (!env.KUANTO_SUPABASE_URL || !env.KUANTO_SUPABASE_PUBLISHABLE_KEY) return { skipped: "KUANTO_SUPABASE_NOT_CONFIGURED" };
  try {
    const client = new KuantoRatesClient({ url: env.KUANTO_SUPABASE_URL, publishableKey: env.KUANTO_SUPABASE_PUBLISHABLE_KEY });
    return await syncVenezuelaRateHistory(createDb(env.DATABASE_URL), client);
  } catch (error) {
    logFailure("cron.venezuela_rate_sync", error);
    return { failed: true };
  }
}
