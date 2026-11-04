import { and, asc, desc, gte, isNotNull, lt, lte, max, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { venezuelaDailyRates, venezuelaUsdtReadings } from "../db/schema";
import { addDaysToDateString, veDateString, veMidnightUtc } from "../lib/venezuela-time";
import type { KuantoDailyRate, KuantoRatesClient } from "./rates/kuanto";

/**
 * Historial de tasas de Venezuela (BCV USD, BCV EUR y USDT P2P) servido desde
 * la base de Juntos. La fuente es `daily_rates` del Supabase de Kuanto; este
 * módulo la copia (cron) y responde todas las lecturas sin salir de Postgres.
 */

/** Una lectura USDT más vieja que esto se marca `stale`. */
export const USDT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
/**
 * Solo se guarda como lectura intradía un valor observado hace menos que
 * esto. Así la copia inicial del historial (cuyo `p2p_observed_at` es el
 * último del día) no se hace pasar por una lectura con hora real.
 */
const READING_FRESHNESS_MS = 2 * 60 * 60 * 1000;
const UPSERT_CHUNK = 200;

export type UsdtPrecision = "intraday" | "daily_average";

export type CurrentUsdtRate = {
  source: "USDT";
  baseCurrency: "USDT";
  quoteCurrency: "VES";
  rate: string;
  dailyAverage: string | null;
  observedAt: string | null;
  fetchedAt: string;
  stale: boolean;
};

export type RatesAt = {
  date: string;
  time: string | null;
  bcv: {
    /** Día cuya publicación BCV se usó: puede ser anterior a `date` (fin de semana, feriado). */
    effectiveDate: string;
    usd: string;
    eur: string | null;
  } | null;
  usdt: {
    rate: string;
    precision: UsdtPrecision;
    observedAt: string | null;
  } | null;
};

export type DailyRateHistoryRow = {
  date: string;
  bcvUsd: string | null;
  bcvEur: string | null;
  usdtDailyAverage: string | null;
};

export type SyncResult = {
  initial: boolean;
  fetchedRows: number;
  readingsInserted: number;
};

/**
 * Trae de Kuanto lo que cambió desde la última sincronización y lo guarda.
 * Con la tabla vacía copia el historial completo; después, normalmente, son
 * una o dos filas (la de hoy y, por la tarde, la de mañana con el BCV nuevo).
 * Es idempotente: repetirla no duplica nada.
 */
export async function syncVenezuelaRateHistory(
  db: Database,
  client: KuantoRatesClient,
  now: Date = new Date(),
): Promise<SyncResult> {
  const [cursorRow] = await db.select({ cursor: max(venezuelaDailyRates.sourceUpdatedAt) }).from(venezuelaDailyRates);
  const cursor = cursorRow?.cursor ?? null;

  const rows = await client.fetchUpdatedSince(cursor);
  for (let index = 0; index < rows.length; index += UPSERT_CHUNK) {
    await upsertDailyRates(db, rows.slice(index, index + UPSERT_CHUNK));
  }

  const readings = rows.filter(
    (row): row is KuantoDailyRate & { usdtLast: string; usdtObservedAt: Date } =>
      row.usdtLast !== null &&
      row.usdtObservedAt !== null &&
      now.getTime() - row.usdtObservedAt.getTime() <= READING_FRESHNESS_MS,
  );
  let readingsInserted = 0;
  if (readings.length) {
    const inserted = await db
      .insert(venezuelaUsdtReadings)
      .values(readings.map((row) => ({ observedAt: row.usdtObservedAt, rate: row.usdtLast, sources: row.usdtSources })))
      .onConflictDoNothing({ target: venezuelaUsdtReadings.observedAt })
      .returning({ id: venezuelaUsdtReadings.id });
    readingsInserted = inserted.length;
  }

  return { initial: cursor === null, fetchedRows: rows.length, readingsInserted };
}

async function upsertDailyRates(db: Database, rows: KuantoDailyRate[]) {
  if (!rows.length) return;
  await db
    .insert(venezuelaDailyRates)
    .values(
      rows.map((row) => ({
        rateDate: row.rateDate,
        bcvUsd: row.bcvUsd,
        bcvEur: row.bcvEur,
        usdtLast: row.usdtLast,
        usdtDailyAverage: row.usdtDailyAverage,
        usdtSources: row.usdtSources,
        bcvPublishedAt: row.bcvPublishedAt,
        usdtObservedAt: row.usdtObservedAt,
        sourceUpdatedAt: row.sourceUpdatedAt,
      })),
    )
    .onConflictDoUpdate({
      target: venezuelaDailyRates.rateDate,
      set: {
        bcvUsd: sql.raw("excluded.bcv_usd"),
        bcvEur: sql.raw("excluded.bcv_eur"),
        usdtLast: sql.raw("excluded.usdt_last"),
        usdtDailyAverage: sql.raw("excluded.usdt_daily_average"),
        usdtSources: sql.raw("excluded.usdt_sources"),
        bcvPublishedAt: sql.raw("excluded.bcv_published_at"),
        usdtObservedAt: sql.raw("excluded.usdt_observed_at"),
        sourceUpdatedAt: sql.raw("excluded.source_updated_at"),
        syncedAt: sql.raw("now()"),
      },
      // Una lectura más vieja (p. ej. dos crons solapados) nunca pisa una más nueva.
      setWhere: sql.raw(`excluded.source_updated_at >= "venezuela_daily_rates"."source_updated_at"`),
    });
}

/**
 * Tasa USDT vigente: el último valor observado en el día más reciente que lo
 * tenga. `null` si todavía no hay ningún dato (antes de la primera
 * sincronización). Nunca lanza por datos viejos: los marca `stale`.
 */
export async function getCurrentUsdtRate(db: Database, now: Date = new Date()): Promise<CurrentUsdtRate | null> {
  const [row] = await db
    .select()
    .from(venezuelaDailyRates)
    .where(and(isNotNull(venezuelaDailyRates.usdtLast), lte(venezuelaDailyRates.rateDate, veDateString(now))))
    .orderBy(desc(venezuelaDailyRates.rateDate))
    .limit(1);
  if (!row?.usdtLast) return null;

  const observedAt = row.usdtObservedAt;
  return {
    source: "USDT",
    baseCurrency: "USDT",
    quoteCurrency: "VES",
    rate: row.usdtLast,
    dailyAverage: row.usdtDailyAverage,
    observedAt: observedAt?.toISOString() ?? null,
    fetchedAt: row.syncedAt.toISOString(),
    stale: !observedAt || now.getTime() - observedAt.getTime() > USDT_STALE_AFTER_MS,
  };
}

/**
 * Tasas que regían en una fecha (y opcionalmente una hora) de Venezuela.
 *
 * - BCV/EUR: la publicación más reciente con `rate_date <= date`. El BCV no
 *   publica fines de semana ni feriados, y esos días rige la última tasa.
 * - USDT con hora: la última lectura intradía de ese día anterior o igual a
 *   la hora (si ninguna es anterior, la primera del día). Solo existen
 *   lecturas desde que este cron empezó a guardarlas.
 * - USDT sin hora (o sin lecturas ese día): el promedio del día; para hoy,
 *   el último valor observado.
 * - USDT de un día sin datos (antes de 2026-01-19): `null`. No se rellena con
 *   otro día: el P2P se mueve demasiado como para presentarlo como de esa fecha.
 */
export async function getRatesAt(
  db: Database,
  date: string,
  time: string | null,
  now: Date = new Date(),
): Promise<RatesAt> {
  const [bcvRows, dayRows, readings] = await Promise.all([
    db
      .select({ rateDate: venezuelaDailyRates.rateDate, bcvUsd: venezuelaDailyRates.bcvUsd, bcvEur: venezuelaDailyRates.bcvEur })
      .from(venezuelaDailyRates)
      .where(and(isNotNull(venezuelaDailyRates.bcvUsd), lte(venezuelaDailyRates.rateDate, date)))
      .orderBy(desc(venezuelaDailyRates.rateDate))
      .limit(1),
    db
      .select({
        usdtLast: venezuelaDailyRates.usdtLast,
        usdtDailyAverage: venezuelaDailyRates.usdtDailyAverage,
        usdtObservedAt: venezuelaDailyRates.usdtObservedAt,
      })
      .from(venezuelaDailyRates)
      .where(sql`${venezuelaDailyRates.rateDate} = ${date}`)
      .limit(1),
    time
      ? db
          .select({ observedAt: venezuelaUsdtReadings.observedAt, rate: venezuelaUsdtReadings.rate })
          .from(venezuelaUsdtReadings)
          .where(
            and(
              gte(venezuelaUsdtReadings.observedAt, veMidnightUtc(date)),
              lt(venezuelaUsdtReadings.observedAt, veMidnightUtc(addDaysToDateString(date, 1))),
            ),
          )
          .orderBy(asc(venezuelaUsdtReadings.observedAt))
      : Promise.resolve([] as Array<{ observedAt: Date; rate: string }>),
  ]);

  const bcvRow = bcvRows[0];
  return {
    date,
    time,
    bcv: bcvRow?.bcvUsd ? { effectiveDate: bcvRow.rateDate, usd: bcvRow.bcvUsd, eur: bcvRow.bcvEur } : null,
    usdt: pickUsdt(date, time, dayRows[0], readings, now),
  };
}

function pickUsdt(
  date: string,
  time: string | null,
  day: { usdtLast: string | null; usdtDailyAverage: string | null; usdtObservedAt: Date | null } | undefined,
  readings: Array<{ observedAt: Date; rate: string }>,
  now: Date,
): RatesAt["usdt"] {
  if (time && readings.length) {
    const instant = veInstant(date, time);
    const before = readings.filter((reading) => reading.observedAt.getTime() <= instant.getTime());
    const chosen = before.length ? before[before.length - 1]! : readings[0]!;
    return { rate: chosen.rate, precision: "intraday", observedAt: chosen.observedAt.toISOString() };
  }

  if (!day) return null;
  if (!time && date === veDateString(now) && day.usdtLast) {
    return { rate: day.usdtLast, precision: "intraday", observedAt: day.usdtObservedAt?.toISOString() ?? null };
  }
  if (day.usdtDailyAverage) return { rate: day.usdtDailyAverage, precision: "daily_average", observedAt: null };
  if (day.usdtLast) {
    return { rate: day.usdtLast, precision: "intraday", observedAt: day.usdtObservedAt?.toISOString() ?? null };
  }
  return null;
}

/** "HH:mm" de un día de Venezuela → instante UTC. */
function veInstant(date: string, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(veMidnightUtc(date).getTime() + (hours! * 60 + minutes!) * 60_000);
}

/** Una fila por día del rango (incluidos fines de semana, con BCV nulo). */
export async function getRateHistory(db: Database, from: string, to: string): Promise<DailyRateHistoryRow[]> {
  const rows = await db
    .select({
      date: venezuelaDailyRates.rateDate,
      bcvUsd: venezuelaDailyRates.bcvUsd,
      bcvEur: venezuelaDailyRates.bcvEur,
      usdtDailyAverage: venezuelaDailyRates.usdtDailyAverage,
    })
    .from(venezuelaDailyRates)
    .where(and(gte(venezuelaDailyRates.rateDate, from), lte(venezuelaDailyRates.rateDate, to)))
    .orderBy(asc(venezuelaDailyRates.rateDate));
  return rows;
}
