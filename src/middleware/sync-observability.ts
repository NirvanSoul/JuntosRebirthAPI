import { createMiddleware } from "hono/factory";

/**
 * Métricas ligeras para el polling de sincronización.
 *
 * No se incluyen usuario, espacio, cursor ni cuerpo de la petición: los logs
 * se agregan en Workers y deben servir para medir latencia, 429 y solapamiento
 * sin convertir la telemetría en otra fuente de datos personales.
 */
export type SyncPollingEndpoint = "sync_changes" | "account_me" | "space_members" | "space_sync";

const inFlightByEndpoint = new Map<SyncPollingEndpoint, number>();
const DEFAULT_SUCCESS_SAMPLE_RATE = 0.01;

function successSampleRate(value: unknown): number {
  if (typeof value !== "string") return DEFAULT_SUCCESS_SAMPLE_RATE;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_SUCCESS_SAMPLE_RATE;
}

export function observeSyncPolling(endpoint: SyncPollingEndpoint) {
  return createMiddleware(async (c, next) => {
    const startedAt = performance.now();
    const inFlight = (inFlightByEndpoint.get(endpoint) ?? 0) + 1;
    inFlightByEndpoint.set(endpoint, inFlight);

    try {
      await next();
    } finally {
      // `finally` conserva la métrica cuando una ruta lanza y Hono transforma
      // el error en su respuesta final a través de `onError`.
      const status = c.res.status || 500;
      // Registrar cada ciclo correcto convertiría los logs en un coste lineal
      // con usuarios activos. Los errores (incluidos 429) siempre se emiten;
      // los éxitos se muestrean y llevan su tasa para agregarlos sin sesgo.
      const sampleRate = status >= 400
        ? 1
        : successSampleRate((c.env as { SYNC_POLLING_METRICS_SAMPLE_RATE?: string } | undefined)?.SYNC_POLLING_METRICS_SAMPLE_RATE);
      if (status >= 400 || Math.random() < sampleRate) {
        console.log(JSON.stringify({
          metric: "sync_poll_request",
          endpoint,
          method: c.req.method,
          status,
          durationMs: Math.round(performance.now() - startedAt),
          inFlight,
          isError: status >= 400,
          isThrottled: status === 429,
          sampleRate,
        }));
      }
      const remaining = (inFlightByEndpoint.get(endpoint) ?? 1) - 1;
      if (remaining > 0) inFlightByEndpoint.set(endpoint, remaining);
      else inFlightByEndpoint.delete(endpoint);
    }
  });
}
