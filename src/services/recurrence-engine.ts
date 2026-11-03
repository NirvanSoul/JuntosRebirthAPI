import { sql, type SQL } from "drizzle-orm";
import { createDb, type Database } from "../db/client";
import { transactionReferenceRates } from "../db/schema";
import { insertWhen, spaceWriteLock } from "../db/versioned-writes";
import { localDate, occurrenceDate } from "../lib/recurrence";
import { logFailure } from "../lib/log";
import { buildMovementSnapshot, type MovementSnapshot } from "./exchange-rates";
import { snapshotReferenceRateValues } from "./transactions";

type Candidate = {
  id: string;
  space_id: string;
  timezone: string;
  frequency: "weekly" | "biweekly" | "monthly" | "custom";
  starts_on: string;
  next_occurrence_on: string;
  generated_occurrences: number;
  created_by: string | null;
  creator_country_code: string | null;
  amount_minor: string;
  currency: string;
};

export type RecurrenceRun = {
  /** Series que llegaron a evaluarse, no movimientos creados. */
  processedSeries: number;
  generatedTransactions: number;
  /**
   * Ocurrencias cuyo movimiento ya existía (un dispositivo lo materializó y
   * subió antes, o un push rebobinó el contador de la serie). La serie avanza
   * y la ocurrencia se enlaza con ese movimiento; no se duplica.
   */
  existingTransactions: number;
  /**
   * Series cuya categoría o cuenta dejó de ser válida. Sin este contador una
   * serie rota se reintentaba en silencio cada hora, para siempre.
   */
  invalidSeries: number;
  /** Series que alcanzaron el tope de la ejecución y siguen atrasadas. */
  truncatedSeries: number;
  /** Series personalizadas que apuntaban a una fecha sin ocurrencia pendiente. */
  repairedSeries: number;
  /**
   * Series de Venezuela sin tasas disponibles: no se genera un movimiento sin
   * equivalencia USD (el libro contable no lo admite); la próxima ejecución
   * lo reintenta.
   */
  deferredSeries: number;
  errors: number;
};

/** Tope de puesta al día por serie y ejecución. */
const MAX_PER_RUN = 100;

type Claim = { claimed: boolean; inserted: boolean };

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export async function runRecurrences(
  databaseUrl: string,
  now = new Date(),
  spaceIds?: string[],
): Promise<RecurrenceRun> {
  const db = createDb(databaseUrl);
  const scope = spaceIds?.length
    ? sql` AND s.space_id IN (${sql.join(spaceIds.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``;
  const rows = rowsOf<Candidate>(await db.execute(sql`
    SELECT s.id, s.space_id, sp.timezone, s.frequency::text AS frequency, s.starts_on::text AS starts_on,
           s.next_occurrence_on::text AS next_occurrence_on, s.generated_occurrences,
           s.created_by, p.country_code AS creator_country_code, s.amount_minor::text AS amount_minor, s.currency
      FROM recurring_transaction_series s
      JOIN spaces sp ON sp.id = s.space_id
      LEFT JOIN user_profiles p ON p.user_id = s.created_by
     WHERE s.is_archived = false AND s.next_occurrence_on IS NOT NULL AND sp.archived_at IS NULL${scope}`));

  const result: RecurrenceRun = {
    processedSeries: 0,
    generatedTransactions: 0,
    existingTransactions: 0,
    invalidSeries: 0,
    truncatedSeries: 0,
    repairedSeries: 0,
    deferredSeries: 0,
    errors: 0,
  };

  for (const series of rows) {
    result.processedSeries++;
    try {
      await catchUp(db, series, now, result);
    } catch (error) {
      result.errors++;
      logFailure("recurrence_series", error, { seriesId: series.id });
    }
  }

  return result;
}

/**
 * Misma regla que `POST /transactions` y el sync: un movimiento USD/VES de
 * alguien que lleva sus cuentas en Venezuela congela su equivalencia USD y sus
 * tasas al crearse.
 */
async function venezuelaSnapshot(
  db: Database,
  series: Candidate,
): Promise<{ snapshot: MovementSnapshot | null; unavailable: boolean }> {
  if (series.creator_country_code !== "VE" || !series.created_by) return { snapshot: null, unavailable: false };
  if (series.currency !== "USD" && series.currency !== "VES") return { snapshot: null, unavailable: false };
  const built = await buildMovementSnapshot(db, {
    userId: series.created_by,
    amountMinor: BigInt(series.amount_minor),
    currency: series.currency,
  });
  return built.snapshot ? { snapshot: built.snapshot, unavailable: false } : { snapshot: null, unavailable: true };
}

function accountingUsd(series: Candidate, snapshot: MovementSnapshot | null): string | null {
  if (!snapshot) return null;
  if (series.currency === "USD") return series.amount_minor;
  const row = snapshot.rows.find((rate) => rate.rateSource === "BCV" && rate.displayCurrency === "USD");
  return row ? row.convertedAmountMinor.toString() : null;
}

async function catchUp(
  db: Database,
  series: Candidate,
  now: Date,
  result: RecurrenceRun,
): Promise<void> {
  if (series.next_occurrence_on > localDate(now, series.timezone)) return;

  const { snapshot, unavailable } = await venezuelaSnapshot(db, series);
  if (unavailable) {
    result.deferredSeries++;
    return;
  }

  let claimedHere = 0;
  while (claimedHere < MAX_PER_RUN) {
    const today = localDate(now, series.timezone);
    if (series.next_occurrence_on > today) return;

    const transactionId = crypto.randomUUID();
    const claimStatement =
      series.frequency === "custom"
        ? claimCustom(series, transactionId, accountingUsd(series, snapshot))
        : claimRegular(
            series,
            transactionId,
            occurrenceDate(series.starts_on, series.frequency, series.generated_occurrences + 1),
            accountingUsd(series, snapshot),
          );
    const claim = await runClaim(db, series, transactionId, claimStatement, snapshot);

    if (!claim.claimed) {
      // Una serie personalizada que apunta a una fecha sin ocurrencia pendiente
      // (lo dejaba una carrera ya corregida en la ruta de ocurrencias) no se
      // podía reclamar nunca: se recoloca en su siguiente pendiente y sigue.
      if (series.frequency === "custom") {
        const repaired = await repairCustomNext(db, series);
        if (repaired !== undefined) {
          result.repairedSeries++;
          if (repaired === null) return;
          series.next_occurrence_on = repaired;
          continue;
        }
      }
      // La reclamación falla por dos motivos muy distintos: otra ejecución se
      // adelantó (correcto, nada que hacer) o la serie apunta a una categoría o
      // cuenta que ya no vale (hay que señalarlo, si no se reintenta eternamente).
      if (!(await isSeriesClaimable(db, series.id))) result.invalidSeries++;
      return;
    }

    if (claim.inserted) result.generatedTransactions++;
    else result.existingTransactions++;
    claimedHere++;
    series.generated_occurrences++;

    const next = await nextOccurrence(db, series);
    if (next === null) return;
    series.next_occurrence_on = next;
  }

  // Se agotó el tope y la serie sigue atrasada: la próxima ejecución continúa.
  result.truncatedSeries++;
}

/**
 * Reclamación, movimiento y tasas congeladas en una sola transacción, detrás
 * del bloqueo del espacio (el mismo que toman el sync y las rutas REST): no
 * puede cruzarse con un push que toque la misma serie.
 */
async function runClaim(
  db: Database,
  series: Candidate,
  transactionId: string,
  claimStatement: SQL,
  snapshot: MovementSnapshot | null,
): Promise<Claim> {
  const results = await db.batch([
    spaceWriteLock(db, series.space_id),
    db.execute(claimStatement),
    ...(snapshot
      ? [insertWhen(
          db,
          transactionReferenceRates,
          snapshotReferenceRateValues(transactionId, snapshot),
          sql`EXISTS (SELECT 1 FROM transactions WHERE id = ${transactionId}::uuid)`,
        )]
      : []),
  ]);
  const [row] = rowsOf<{ claimed: number; inserted: number }>(results[1]);
  return { claimed: Number(row?.claimed ?? 0) > 0, inserted: Number(row?.inserted ?? 0) > 0 };
}

/**
 * Recoloca `next_occurrence_on` en la primera ocurrencia pendiente solo si
 * apunta a otra cosa. Devuelve la nueva fecha (`null`: no quedan pendientes) o
 * `undefined` si no había nada que reparar.
 */
async function repairCustomNext(db: Database, series: Candidate): Promise<string | null | undefined> {
  const [, result] = await db.batch([
    spaceWriteLock(db, series.space_id),
    db.execute(sql`
      WITH target AS (
        SELECT min(scheduled_on) AS next
          FROM recurring_transaction_occurrences
         WHERE series_id = ${series.id}::uuid AND status = 'pending'
      )
      UPDATE recurring_transaction_series s
         SET next_occurrence_on = (SELECT next FROM target), updated_at = now()
       WHERE s.id = ${series.id}::uuid
         AND s.next_occurrence_on IS DISTINCT FROM (SELECT next FROM target)
      RETURNING s.next_occurrence_on::text AS next`),
  ]);
  const [row] = rowsOf<{ next: string | null }>(result);
  return row ? row.next : undefined;
}

/** `null` significa que la serie ya no tiene más ocurrencias pendientes. */
async function nextOccurrence(db: Database, series: Candidate): Promise<string | null> {
  if (series.frequency !== "custom") {
    return occurrenceDate(series.starts_on, series.frequency, series.generated_occurrences);
  }

  const [row] = rowsOf<{ next: string | null }>(await db.execute(sql`
    SELECT min(scheduled_on)::text AS next
      FROM recurring_transaction_occurrences
     WHERE series_id = ${series.id}::uuid AND status = 'pending'`));
  return row?.next ?? null;
}

/**
 * ¿Sigue siendo generable esta serie? Repite las mismas comprobaciones de
 * integridad que la reclamación, sin escribir nada.
 */
async function isSeriesClaimable(db: Database, seriesId: string): Promise<boolean> {
  const rows = rowsOf<unknown>(await db.execute(sql`
    SELECT 1
      FROM recurring_transaction_series s
      JOIN categories c ON c.id = s.category_id AND c.space_id = s.space_id
      LEFT JOIN money_accounts a ON a.id = s.money_account_id
      LEFT JOIN money_account_balances b ON b.money_account_id = a.id AND b.currency = s.currency
     WHERE s.id = ${seriesId}::uuid
       AND s.is_archived = false
       AND c.is_archived = false AND c.archived_at IS NULL
       AND (s.money_account_id IS NULL OR (a.space_id = s.space_id AND a.is_archived = false AND a.archived_at IS NULL AND b.id IS NOT NULL))
     LIMIT 1`));
  return rows.length > 0;
}

/** Categoría y cuenta de la serie siguen vigentes en su espacio. */
const SERIES_TARGETS_VALID = sql`
  EXISTS (
    SELECT 1 FROM categories c
     WHERE c.id = s.category_id AND c.space_id = s.space_id
       AND c.is_archived = false AND c.archived_at IS NULL)
  AND (s.money_account_id IS NULL OR EXISTS (
    SELECT 1 FROM money_accounts a
      JOIN money_account_balances b
        ON b.money_account_id = a.id AND b.currency = s.currency
     WHERE a.id = s.money_account_id AND a.space_id = s.space_id
       AND a.is_archived = false AND a.archived_at IS NULL))`;

/**
 * Reclama la siguiente ocurrencia y crea su movimiento en una sola sentencia.
 *
 * Las comprobaciones de integridad van en `EXISTS` y no en el `FROM` del
 * `UPDATE`: PostgreSQL no permite referenciar la tabla destino desde el `ON`
 * de un `JOIN` del `FROM` (42P01), y esa era la razón de que el motor no
 * generase nada.
 *
 * Si el movimiento de esa fecha ya existe (lo subió un dispositivo, o un push
 * rebobinó el contador), el `INSERT` no hace nada y la serie avanza igual.
 * Antes chocaba con `transactions_series_occurred_on_idx`, la sentencia
 * entera fallaba y la serie quedaba atascada en cada ejecución.
 */
function claimRegular(s: Candidate, id: string, next: string, accountingUsd: string | null): SQL {
  return sql`
    WITH claimed AS (
      UPDATE recurring_transaction_series s
         SET generated_occurrences = ${s.generated_occurrences + 1}, next_occurrence_on = ${next}::date, updated_at = now()
       WHERE s.id = ${s.id}::uuid
         AND s.is_archived = false
         AND s.next_occurrence_on = ${s.next_occurrence_on}::date
         AND s.generated_occurrences = ${s.generated_occurrences}
         AND ${SERIES_TARGETS_VALID}
      RETURNING s.*
    ), inserted AS (
      INSERT INTO transactions
        (id, space_id, category_id, money_account_id, created_by, type, amount_minor, currency, title, occurred_on,
         recurrence, recurrence_series_id, accounting_amount_minor_usd)
      SELECT ${id}::uuid, space_id, category_id, money_account_id, created_by, type, amount_minor, currency, title,
             ${s.next_occurrence_on}::date, frequency::text::transaction_recurrence, id, ${accountingUsd}::bigint
        FROM claimed
      ON CONFLICT (recurrence_series_id, occurred_on) WHERE recurrence_series_id IS NOT NULL DO NOTHING
      RETURNING id
    )
    SELECT (SELECT count(*) FROM claimed)::int AS claimed, (SELECT count(*) FROM inserted)::int AS inserted`;
}

/**
 * Reclama la ocurrencia personalizada del día y crea su movimiento.
 *
 * La marca de `generated` y el enlace al movimiento se hacen en el mismo
 * `UPDATE`, con el id del movimiento generado antes en JavaScript (los CTE
 * comparten instantánea: un segundo `UPDATE` de la misma fila no se vería).
 * Si el movimiento de esa fecha ya existe, la ocurrencia se enlaza con él.
 */
function claimCustom(s: Candidate, id: string, accountingUsd: string | null): SQL {
  return sql`
    WITH existing AS (
      SELECT t.id FROM transactions t
       WHERE t.recurrence_series_id = ${s.id}::uuid AND t.occurred_on = ${s.next_occurrence_on}::date
    ), claimed AS (
      UPDATE recurring_transaction_occurrences o
         SET status = 'generated',
             generated_transaction_id = COALESCE((SELECT id FROM existing), ${id}::uuid),
             updated_at = now()
       WHERE o.id = (
         SELECT o2.id
           FROM recurring_transaction_occurrences o2
           JOIN recurring_transaction_series s ON s.id = o2.series_id
          WHERE o2.series_id = ${s.id}::uuid AND o2.scheduled_on = ${s.next_occurrence_on}::date AND o2.status = 'pending'
            AND s.is_archived = false AND s.next_occurrence_on = ${s.next_occurrence_on}::date
            AND ${SERIES_TARGETS_VALID}
          LIMIT 1)
      RETURNING o.id, o.series_id
    ), inserted AS (
      INSERT INTO transactions
        (id, space_id, category_id, money_account_id, created_by, type, amount_minor, currency, title, occurred_on,
         recurrence, recurrence_series_id, accounting_amount_minor_usd)
      SELECT ${id}::uuid, s.space_id, s.category_id, s.money_account_id, s.created_by, s.type,
             s.amount_minor, s.currency, s.title, ${s.next_occurrence_on}::date, 'custom', s.id, ${accountingUsd}::bigint
        FROM claimed
        JOIN recurring_transaction_series s ON s.id = claimed.series_id
       WHERE NOT EXISTS (SELECT 1 FROM existing)
      ON CONFLICT (recurrence_series_id, occurred_on) WHERE recurrence_series_id IS NOT NULL DO NOTHING
      RETURNING id
    ), advanced AS (
      UPDATE recurring_transaction_series s
         SET generated_occurrences = s.generated_occurrences + 1,
             -- Los CTE leen la instantánea previa, donde la ocurrencia
             -- reclamada sigue pendiente: por eso se excluye explícitamente.
             next_occurrence_on = (
               SELECT min(o3.scheduled_on)
                 FROM recurring_transaction_occurrences o3
                WHERE o3.series_id = s.id AND o3.status = 'pending'
                  AND o3.id <> (SELECT id FROM claimed)),
             updated_at = now()
       WHERE s.id = ${s.id}::uuid AND EXISTS (SELECT 1 FROM claimed)
      RETURNING s.id
    )
    SELECT (SELECT count(*) FROM advanced)::int AS claimed, (SELECT count(*) FROM inserted)::int AS inserted`;
}
