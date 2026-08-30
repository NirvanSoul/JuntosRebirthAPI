import { neon } from "@neondatabase/serverless";
import { localDate, occurrenceDate } from "../lib/recurrence";

type Candidate = {
  id: string;
  space_id: string;
  timezone: string;
  frequency: "weekly" | "biweekly" | "monthly" | "custom";
  starts_on: string;
  next_occurrence_on: string;
  generated_occurrences: number;
};

export type RecurrenceRun = {
  /** Series que llegaron a evaluarse, no movimientos creados. */
  processedSeries: number;
  generatedTransactions: number;
  /**
   * Series cuya categoría o cuenta dejó de ser válida. Sin este contador una
   * serie rota se reintentaba en silencio cada hora, para siempre.
   */
  invalidSeries: number;
  /** Series que alcanzaron el tope de la ejecución y siguen atrasadas. */
  truncatedSeries: number;
  errors: number;
};

/** Tope de puesta al día por serie y ejecución. */
const MAX_PER_RUN = 100;

type SqlClient = ReturnType<typeof neon<false, false>>;

export async function runRecurrences(
  databaseUrl: string,
  now = new Date(),
  spaceIds?: string[],
): Promise<RecurrenceRun> {
  const sql = neon(databaseUrl);
  const scope = spaceIds?.length
    ? ` AND s.space_id IN (${spaceIds.map((_, index) => `$${index + 1}`).join(",")})`
    : "";
  const rows = (await sql.query(
    `SELECT s.id,s.space_id,sp.timezone,s.frequency,s.starts_on,s.next_occurrence_on,s.generated_occurrences
       FROM recurring_transaction_series s
       JOIN spaces sp ON sp.id=s.space_id
      WHERE s.is_archived=false AND s.next_occurrence_on IS NOT NULL AND sp.archived_at IS NULL${scope}`,
    spaceIds ?? [],
  )) as Candidate[];

  const result: RecurrenceRun = {
    processedSeries: 0,
    generatedTransactions: 0,
    invalidSeries: 0,
    truncatedSeries: 0,
    errors: 0,
  };

  for (const series of rows) {
    result.processedSeries++;
    try {
      await catchUp(sql, series, now, result);
    } catch (error) {
      result.errors++;
      console.error(`Recurrence series ${series.id} failed:`, error);
    }
  }

  return result;
}

async function catchUp(
  sql: SqlClient,
  series: Candidate,
  now: Date,
  result: RecurrenceRun,
): Promise<void> {
  let generatedHere = 0;

  while (generatedHere < MAX_PER_RUN) {
    const today = localDate(now, series.timezone);
    if (series.next_occurrence_on > today) return;

    const transactionId = crypto.randomUUID();
    const generated =
      series.frequency === "custom"
        ? await claimCustom(sql, series, transactionId)
        : await claimRegular(
            sql,
            series,
            transactionId,
            occurrenceDate(series.starts_on, series.frequency, series.generated_occurrences + 1),
          );

    if (!generated) {
      // La reclamación falla por dos motivos muy distintos: otra ejecución se
      // adelantó (correcto, nada que hacer) o la serie apunta a una categoría o
      // cuenta que ya no vale (hay que señalarlo, si no se reintenta eternamente).
      if (!(await isSeriesClaimable(sql, series.id))) result.invalidSeries++;
      return;
    }

    result.generatedTransactions++;
    generatedHere++;
    series.generated_occurrences++;

    const next = await nextOccurrence(sql, series);
    if (next === null) return;
    series.next_occurrence_on = next;
  }

  // Se agotó el tope y la serie sigue atrasada: la próxima ejecución continúa.
  result.truncatedSeries++;
}

/** `null` significa que la serie ya no tiene más ocurrencias pendientes. */
async function nextOccurrence(sql: SqlClient, series: Candidate): Promise<string | null> {
  if (series.frequency !== "custom") {
    return occurrenceDate(series.starts_on, series.frequency, series.generated_occurrences);
  }

  const rows = (await sql`
    SELECT min(scheduled_on)::text AS next
      FROM recurring_transaction_occurrences
     WHERE series_id=${series.id} AND status='pending'
  `) as { next: string | null }[];
  return rows[0]?.next ?? null;
}

/**
 * ¿Sigue siendo generable esta serie? Repite las mismas comprobaciones de
 * integridad que la reclamación, sin escribir nada.
 */
async function isSeriesClaimable(sql: SqlClient, seriesId: string): Promise<boolean> {
  const rows = (await sql.query(
    `SELECT 1
       FROM recurring_transaction_series s
       JOIN categories c ON c.id=s.category_id AND c.space_id=s.space_id
       LEFT JOIN money_accounts a ON a.id=s.money_account_id
       LEFT JOIN money_account_balances b ON b.money_account_id=a.id AND b.currency=s.currency
      WHERE s.id=$1
        AND s.is_archived=false
        AND c.is_archived=false AND c.archived_at IS NULL
        AND (s.money_account_id IS NULL OR (a.space_id=s.space_id AND a.is_archived=false AND a.archived_at IS NULL AND b.id IS NOT NULL))
      LIMIT 1`,
    [seriesId],
  )) as unknown[];
  return rows.length > 0;
}

/**
 * Reclama la siguiente ocurrencia y crea su movimiento en una sola sentencia.
 *
 * Las comprobaciones de integridad van en `EXISTS` y no en el `FROM` del
 * `UPDATE`: PostgreSQL no permite referenciar la tabla destino desde el `ON`
 * de un `JOIN` del `FROM` (42P01), y esa era la razón de que el motor no
 * generase nada.
 */
async function claimRegular(
  sql: SqlClient,
  s: Candidate,
  id: string,
  next: string,
): Promise<boolean> {
  const rows = (await sql.query(
    `WITH claimed AS (
       UPDATE recurring_transaction_series s
          SET generated_occurrences=$1, next_occurrence_on=$2, updated_at=now()
        WHERE s.id=$3
          AND s.is_archived=false
          AND s.next_occurrence_on=$4
          AND s.generated_occurrences=$5
          AND EXISTS (
            SELECT 1 FROM categories c
             WHERE c.id=s.category_id AND c.space_id=s.space_id
               AND c.is_archived=false AND c.archived_at IS NULL)
          AND (s.money_account_id IS NULL OR EXISTS (
            SELECT 1 FROM money_accounts a
              JOIN money_account_balances b
                ON b.money_account_id=a.id AND b.currency=s.currency
             WHERE a.id=s.money_account_id AND a.space_id=s.space_id
               AND a.is_archived=false AND a.archived_at IS NULL))
       RETURNING s.*
     ), inserted AS (
       INSERT INTO transactions
         (id,space_id,category_id,money_account_id,created_by,type,amount_minor,currency,title,occurred_on,recurrence,recurrence_series_id)
       SELECT $6,space_id,category_id,money_account_id,created_by,type,amount_minor,currency,title,$4,
              frequency::text::transaction_recurrence,id
         FROM claimed
       RETURNING id
     ) SELECT id FROM inserted`,
    [s.generated_occurrences + 1, next, s.id, s.next_occurrence_on, s.generated_occurrences, id],
  )) as unknown[];
  return rows.length > 0;
}

/**
 * Reclama la ocurrencia personalizada del día y crea su movimiento.
 *
 * La marca de `generated` y el enlace al movimiento se hacen en el mismo
 * `UPDATE`, con el id del movimiento generado antes en JavaScript. La versión
 * anterior tocaba la fila de ocurrencias dos veces dentro de la misma
 * sentencia y, como los CTE comparten instantánea, el segundo `UPDATE` no veía
 * al primero y no llegaba a aplicarse: la serie nunca avanzaba.
 */
async function claimCustom(sql: SqlClient, s: Candidate, id: string): Promise<boolean> {
  const rows = (await sql.query(
    `WITH claimed AS (
       UPDATE recurring_transaction_occurrences o
          SET status='generated', generated_transaction_id=$3, updated_at=now()
        WHERE o.id = (
          SELECT o2.id
            FROM recurring_transaction_occurrences o2
            JOIN recurring_transaction_series s ON s.id=o2.series_id
           WHERE o2.series_id=$1 AND o2.scheduled_on=$2 AND o2.status='pending'
             AND s.is_archived=false AND s.next_occurrence_on=$2
             AND EXISTS (
               SELECT 1 FROM categories c
                WHERE c.id=s.category_id AND c.space_id=s.space_id
                  AND c.is_archived=false AND c.archived_at IS NULL)
             AND (s.money_account_id IS NULL OR EXISTS (
               SELECT 1 FROM money_accounts a
                 JOIN money_account_balances b
                   ON b.money_account_id=a.id AND b.currency=s.currency
                WHERE a.id=s.money_account_id AND a.space_id=s.space_id
                  AND a.is_archived=false AND a.archived_at IS NULL))
           LIMIT 1)
       RETURNING o.id, o.series_id
     ), inserted AS (
       INSERT INTO transactions
         (id,space_id,category_id,money_account_id,created_by,type,amount_minor,currency,title,occurred_on,recurrence,recurrence_series_id)
       SELECT $3,s.space_id,s.category_id,s.money_account_id,s.created_by,s.type,
              s.amount_minor,s.currency,s.title,$2,'custom',s.id
         FROM claimed
         JOIN recurring_transaction_series s ON s.id=claimed.series_id
       RETURNING id
     ), advanced AS (
       UPDATE recurring_transaction_series s
          SET generated_occurrences=s.generated_occurrences+1,
              -- Los CTE leen la instantánea previa, donde la ocurrencia
              -- reclamada sigue pendiente: por eso se excluye explícitamente.
              next_occurrence_on=(
                SELECT min(o3.scheduled_on)
                  FROM recurring_transaction_occurrences o3
                 WHERE o3.series_id=s.id AND o3.status='pending'
                   AND o3.id <> (SELECT id FROM claimed)),
              updated_at=now()
        WHERE s.id=$1 AND EXISTS (SELECT 1 FROM inserted)
       RETURNING s.id
     ) SELECT id FROM advanced`,
    [s.id, s.next_occurrence_on, id],
  )) as unknown[];
  return rows.length > 0;
}
