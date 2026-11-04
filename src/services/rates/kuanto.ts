/**
 * Lector de `daily_rates` del Supabase de Kuanto (`kuanto-mobile`), la misma
 * tabla que alimenta kuanto.online y su app móvil. Solo se usa desde el cron:
 * los usuarios de Juntos leen el espejo local (`venezuela_daily_rates`).
 *
 * Usa la clave *publicable* de ese proyecto, que es pública por diseño y solo
 * permite lo que la RLS de `daily_rates` deje leer.
 */

const SELECT_COLUMNS = [
  "rate_date",
  "bcv_usd",
  "bcv_eur",
  "p2p_average",
  "p2p_daily_average",
  "p2p_sources",
  "bcv_published_at",
  "p2p_observed_at",
  "updated_at",
].join(",");

/** PostgREST corta en 1000 filas por defecto; pedir más no sirve. */
export const KUANTO_PAGE_SIZE = 1000;
/** El historial completo (desde 2023) cabe hoy en 2 páginas; esto es solo un tope de seguridad. */
const MAX_PAGES = 20;

export type KuantoDailyRate = {
  rateDate: string;
  bcvUsd: string | null;
  bcvEur: string | null;
  usdtLast: string | null;
  usdtDailyAverage: string | null;
  usdtSources: unknown;
  bcvPublishedAt: Date | null;
  usdtObservedAt: Date | null;
  sourceUpdatedAt: Date;
};

export class KuantoRatesError extends Error {
  override name = "KuantoRatesError";
}

export type KuantoConfig = { url: string; publishableKey: string };

export class KuantoRatesClient {
  /** Envuelto por el mismo motivo que en `rates/venezuela.ts` ("Illegal invocation" en workerd). */
  constructor(
    private readonly config: KuantoConfig,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  /**
   * Filas modificadas en Supabase desde `since` (inclusive), ordenadas por
   * `updated_at`. Sin `since` devuelve el historial completo.
   */
  async fetchUpdatedSince(since: Date | null): Promise<KuantoDailyRate[]> {
    const rows: KuantoDailyRate[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        select: SELECT_COLUMNS,
        order: "updated_at.asc,rate_date.asc",
        limit: String(KUANTO_PAGE_SIZE),
        offset: String(page * KUANTO_PAGE_SIZE),
      });
      if (since) params.set("updated_at", `gte.${since.toISOString()}`);

      const batch = await this.request(params);
      rows.push(...batch);
      if (batch.length < KUANTO_PAGE_SIZE) return rows;
    }

    throw new KuantoRatesError("Kuanto rates pagination exceeded the safety limit");
  }

  private async request(params: URLSearchParams): Promise<KuantoDailyRate[]> {
    const base = this.config.url.replace(/\/+$/, "");
    let response: Response;
    try {
      response = await this.fetchFn(`${base}/rest/v1/daily_rates?${params.toString()}`, {
        headers: { apikey: this.config.publishableKey, Accept: "application/json" },
      });
    } catch (error) {
      throw new KuantoRatesError("Unable to reach Kuanto rates", { cause: error });
    }

    if (!response.ok) {
      throw new KuantoRatesError(`Kuanto rates returned HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new KuantoRatesError("Kuanto rates returned invalid JSON");
    }

    if (!Array.isArray(payload)) {
      throw new KuantoRatesError("Kuanto rates returned an unexpected payload");
    }

    return payload.map(parseRow);
  }
}

function parseRow(raw: unknown): KuantoDailyRate {
  if (!raw || typeof raw !== "object") throw new KuantoRatesError("Kuanto rates returned an invalid row");
  const row = raw as Record<string, unknown>;

  const rateDate = typeof row.rate_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.rate_date) ? row.rate_date : null;
  const sourceUpdatedAt = timestampOrNull(row.updated_at);
  if (!rateDate || !sourceUpdatedAt) throw new KuantoRatesError("Kuanto rates returned a row without date");

  return {
    rateDate,
    bcvUsd: rateOrNull(row.bcv_usd),
    bcvEur: rateOrNull(row.bcv_eur),
    // `p2p_average` es el último promedio observado (Binance + Bybit); Kuanto
    // lo sobrescribe en cada actualización del día.
    usdtLast: rateOrNull(row.p2p_average),
    usdtDailyAverage: rateOrNull(row.p2p_daily_average),
    usdtSources: row.p2p_sources ?? null,
    bcvPublishedAt: timestampOrNull(row.bcv_published_at),
    usdtObservedAt: timestampOrNull(row.p2p_observed_at),
    sourceUpdatedAt,
  };
}

/**
 * PostgREST entrega `numeric` como número JSON. Un valor ausente, no finito o
 * no positivo se trata como "sin dato" en vez de tumbar toda la fila: el BCV,
 * por ejemplo, viene nulo cada fin de semana.
 */
function rateOrNull(value: unknown): string | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric.toFixed(10);
}

function timestampOrNull(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
