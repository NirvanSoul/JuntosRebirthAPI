import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { customExchangeRates, exchangeRateSnapshots } from "../db/schema";
import { convertMinorAmount, fromMinorUnits, toMinorUnits } from "../lib/decimal";
import { addDaysToDateString, isWithinVenezuelaPublishWindow, veDateString, veMidnightUtc } from "../lib/venezuela-time";
import { VenezuelaRateService, type VenezuelaRate } from "./rates/venezuela";

type ReferenceAsset = "USD" | "EUR";
type SnapshotRow = typeof exchangeRateSnapshots.$inferSelect;

const SOURCE_BY_ASSET: Record<ReferenceAsset, "BCV" | "EURO"> = { USD: "BCV", EUR: "EURO" };

export type NormalizedRate = {
  source: "BCV" | "EURO";
  baseCurrency: ReferenceAsset;
  quoteCurrency: "VES";
  rate: string;
  observedAt: string;
  fetchedAt: string;
};

export type CurrentRates = {
  rates: { BCV: NormalizedRate; EURO: NormalizedRate };
  ratesUpdatedAt: string;
  stale: boolean;
};

export class ExchangeRatesUnavailableError extends Error {}

/**
 * La tasa BCV no "vence" cada N minutos: rige un día calendario completo de
 * Venezuela y solo cambia una vez al día (publicada entre ~3:00pm y ~8:30pm
 * VE para el día *siguiente* — ver `isWithinVenezuelaPublishWindow`). Cada
 * fila queda anclada a un día mediante `observedAt` (medianoche VE en que
 * empieza a regir) y `expiresAt` (medianoche VE del día después), así que
 * "la tasa vigente ahora" es, literalmente, la fila cuya ventana
 * `[observedAt, expiresAt)` contiene el instante actual — sin TTL.
 */
async function loadAllSnapshots(db: Database, countryCode: string): Promise<SnapshotRow[]> {
  return db
    .select()
    .from(exchangeRateSnapshots)
    .where(
      and(
        eq(exchangeRateSnapshots.countryCode, countryCode),
        eq(exchangeRateSnapshots.quoteCurrency, "VES"),
      ),
    )
    .orderBy(desc(exchangeRateSnapshots.observedAt))
    .limit(20);
}

function byAssetDeduped(rows: SnapshotRow[], keep: (row: SnapshotRow) => boolean): Map<ReferenceAsset, SnapshotRow> | null {
  const byAsset = new Map<ReferenceAsset, SnapshotRow>();
  for (const row of rows) {
    const asset = row.referenceAsset as ReferenceAsset;
    if (asset !== "USD" && asset !== "EUR") continue;
    // Ya vista y descartada por `keep`, u otra fila más reciente del mismo
    // activo ya elegida: `rows` viene ordenado por `observedAt` descendente.
    if (byAsset.has(asset) || !keep(row)) continue;
    byAsset.set(asset, row);
  }
  return byAsset.has("USD") && byAsset.has("EUR") ? byAsset : null;
}

/** La fila vigente en `at` para cada activo (la tasa "de hoy", normalmente). */
function pickCurrent(rows: SnapshotRow[], at: Date): Map<ReferenceAsset, SnapshotRow> | null {
  return byAssetDeduped(rows, (row) => row.observedAt <= at && at < row.expiresAt);
}

/** La fila más reciente de cada activo, vigente o no — solo para el fallback "mejor esfuerzo" cuando el proveedor falla. */
function pickLatest(rows: SnapshotRow[]): Map<ReferenceAsset, SnapshotRow> | null {
  return byAssetDeduped(rows, () => true);
}

async function insertSnapshots(
  db: Database,
  countryCode: string,
  liveRates: VenezuelaRate[],
  observedAt: Date,
  expiresAt: Date,
  fetchedAt: Date,
): Promise<Map<ReferenceAsset, SnapshotRow>> {
  const inserted = await db
    .insert(exchangeRateSnapshots)
    .values(
      liveRates.map((rate) => ({
        countryCode,
        rateSource: SOURCE_BY_ASSET[rate.baseCurrency],
        referenceAsset: rate.baseCurrency,
        quoteCurrency: rate.quoteCurrency,
        rate: rate.rate,
        observedAt,
        fetchedAt,
        expiresAt,
      })),
    )
    .returning();

  const byAsset = new Map<ReferenceAsset, SnapshotRow>();
  for (const row of inserted) byAsset.set(row.referenceAsset as ReferenceAsset, row);
  return byAsset;
}

/**
 * Ruta *reactiva*: "dame la tasa vigente ahora". Si ya hay una fila cuya
 * ventana cubre `now` (lo normal, gracias a `captureNextDayRate` corriendo
 * de antemano en el cron), se sirve directo sin tocar el proveedor. Si no
 * hay ninguna — primer arranque, o nadie sondeó a tiempo — lo que devuelva
 * el proveedor ahora mismo es, por definición, la tasa de hoy (la ambigüedad
 * "¿esto es de hoy o de mañana?" solo existe cuando la de hoy YA se conoce,
 * que es exactamente el caso que cubre `captureNextDayRate`, no este).
 */
async function resolveRates(
  db: Database,
  countryCode: string,
  venezuelaRateService: VenezuelaRateService,
): Promise<{ byAsset: Map<ReferenceAsset, SnapshotRow>; stale: boolean }> {
  const now = new Date();
  const rows = await loadAllSnapshots(db, countryCode);

  const current = pickCurrent(rows, now);
  if (current) return { byAsset: current, stale: false };

  try {
    const liveRates = await venezuelaRateService.getRates();
    const today = veDateString(now);
    const byAsset = await insertSnapshots(
      db,
      countryCode,
      liveRates,
      veMidnightUtc(today),
      veMidnightUtc(addDaysToDateString(today, 1)),
      now,
    );
    return { byAsset, stale: false };
  } catch (error) {
    // Nunca devolver una tasa fabricada: si el proveedor cae, se sirve la
    // última tasa persistida (marcada `stale`) o se propaga el error.
    const stale = pickLatest(rows);
    if (stale) return { byAsset: stale, stale: true };
    throw error;
  }
}

/**
 * Ruta *proactiva*: pensada para correr desde el cron, solo dentro de la
 * ventana de publicación del BCV (`isWithinVenezuelaPublishWindow`). Compara
 * lo que devuelve el proveedor contra la tasa de HOY ya conocida; si es
 * distinta, es la tasa recién publicada para MAÑANA, y la guarda anclada a
 * ese día — así, cuando cambie el día calendario de Venezuela, `resolveRates`
 * ya encuentra la fila correcta sin necesitar ninguna llamada en vivo.
 */
export async function captureNextDayRate(
  db: Database,
  countryCode: "VE",
  venezuelaRateService: VenezuelaRateService = new VenezuelaRateService(),
): Promise<{ captured: boolean }> {
  const now = new Date();
  if (!isWithinVenezuelaPublishWindow(now)) return { captured: false };

  const rows = await loadAllSnapshots(db, countryCode);
  const today = pickCurrent(rows, now);

  let liveRates: VenezuelaRate[];
  try {
    liveRates = await venezuelaRateService.getRates();
  } catch (error) {
    console.error(
      "Venezuela next-day rate poll failed:",
      error instanceof Error ? error.message : String(error),
    );
    return { captured: false };
  }

  // Si coincide con la de hoy, el BCV todavía no publicó la de mañana — no
  // hay nada que guardar todavía.
  const changed = liveRates.filter((rate) => today?.get(rate.baseCurrency)?.rate !== rate.rate);
  if (!changed.length) return { captured: false };

  const tomorrow = addDaysToDateString(veDateString(now), 1);
  const observedAt = veMidnightUtc(tomorrow);
  const expiresAt = veMidnightUtc(addDaysToDateString(tomorrow, 1));

  // Si un sondeo anterior el mismo día ya había guardado un valor distinto
  // para mañana, lo sustituye (el BCV puede corregirlo antes de que entre en
  // vigor) en vez de acumular filas duplicadas para el mismo día.
  await db
    .delete(exchangeRateSnapshots)
    .where(and(eq(exchangeRateSnapshots.countryCode, countryCode), eq(exchangeRateSnapshots.observedAt, observedAt)));
  await insertSnapshots(db, countryCode, changed, observedAt, expiresAt, now);
  return { captured: true };
}

function toCurrentRates(byAsset: Map<ReferenceAsset, SnapshotRow>, stale: boolean): CurrentRates {
  const usd = byAsset.get("USD")!;
  const eur = byAsset.get("EUR")!;
  const ratesUpdatedAt = usd.fetchedAt > eur.fetchedAt ? usd.fetchedAt : eur.fetchedAt;

  return {
    rates: {
      BCV: {
        source: "BCV",
        baseCurrency: "USD",
        quoteCurrency: "VES",
        rate: usd.rate,
        observedAt: usd.observedAt.toISOString(),
        fetchedAt: usd.fetchedAt.toISOString(),
      },
      EURO: {
        source: "EURO",
        baseCurrency: "EUR",
        quoteCurrency: "VES",
        rate: eur.rate,
        observedAt: eur.observedAt.toISOString(),
        fetchedAt: eur.fetchedAt.toISOString(),
      },
    },
    ratesUpdatedAt: ratesUpdatedAt.toISOString(),
    stale,
  };
}

export async function getCurrentRates(
  db: Database,
  countryCode: "VE",
  venezuelaRateService: VenezuelaRateService = new VenezuelaRateService(),
): Promise<CurrentRates> {
  try {
    const { byAsset, stale } = await resolveRates(db, countryCode, venezuelaRateService);
    return toCurrentRates(byAsset, stale);
  } catch (error) {
    throw new ExchangeRatesUnavailableError("Exchange rates are unavailable", { cause: error });
  }
}

export type PreviewInput = { amount: string; currency: "VES" | "USD" };
export type PreviewResult = {
  input: { amount: string; currency: string };
  conversions: {
    BCV: { amount: string; currency: string; rate: string };
    EURO: { amount: string; currency: string; rate: string };
  };
  ratesUpdatedAt: string;
};

export async function previewConversion(db: Database, input: PreviewInput): Promise<PreviewResult> {
  const current = await getCurrentRates(db, "VE");
  const amountMinor = toMinorUnits(input.amount);

  const vesMinor =
    input.currency === "VES" ? amountMinor : convertMinorAmount(amountMinor, current.rates.BCV.rate, "multiply");
  const usdMinor =
    input.currency === "USD" ? amountMinor : convertMinorAmount(vesMinor, current.rates.BCV.rate, "divide");
  const eurMinor = convertMinorAmount(vesMinor, current.rates.EURO.rate, "divide");

  const bcvDisplayCurrency = input.currency === "VES" ? "USD" : "VES";
  const bcvAmountMinor = input.currency === "VES" ? usdMinor : vesMinor;

  return {
    input: { amount: input.amount, currency: input.currency },
    conversions: {
      BCV: { amount: fromMinorUnits(bcvAmountMinor), currency: bcvDisplayCurrency, rate: current.rates.BCV.rate },
      EURO: { amount: fromMinorUnits(eurMinor), currency: "EUR", rate: current.rates.EURO.rate },
    },
    ratesUpdatedAt: current.ratesUpdatedAt,
  };
}

export type MovementSnapshotRow = {
  rateSource: "BCV" | "EURO" | "CUSTOM";
  displayCurrency: string;
  referenceAsset: string;
  rate: string;
  convertedAmountMinor: bigint;
  rateSnapshotId: string | null;
  customRateId: string | null;
  observedAt: Date | null;
};

export type MovementSnapshot = {
  countryCode: "VE";
  createdWithCurrency: string;
  rows: MovementSnapshotRow[];
};

/**
 * Congela, en el momento de crear/editar un movimiento, la conversión de su
 * monto usando las tasas BCV/EURO vigentes (y la CUSTOM del usuario si se
 * indicó `customRateId`). Es *best effort*: si el proveedor de tasas falla,
 * el movimiento debe poder crearse igual — nunca debe bloquear el ledger por
 * una caída externa. `error: "CUSTOM_RATE_NOT_FOUND"` es la única falla que
 * el caller debe convertir en un 4xx, porque ahí sí hay un dato inválido en
 * la petición del usuario.
 */
export async function buildMovementSnapshot(
  db: Database,
  input: { userId: string; amountMinor: bigint; currency: string; customRateId?: string | null },
  venezuelaRateService: VenezuelaRateService = new VenezuelaRateService(),
): Promise<{ snapshot: MovementSnapshot | null; error?: "CUSTOM_RATE_NOT_FOUND" }> {
  if (input.currency !== "VES" && input.currency !== "USD") return { snapshot: null };

  let customRate: typeof customExchangeRates.$inferSelect | null = null;
  if (input.customRateId) {
    const [row] = await db
      .select()
      .from(customExchangeRates)
      .where(and(eq(customExchangeRates.id, input.customRateId), eq(customExchangeRates.userId, input.userId)));
    if (!row) return { snapshot: null, error: "CUSTOM_RATE_NOT_FOUND" };
    customRate = row;
  }

  let resolved: { byAsset: Map<ReferenceAsset, SnapshotRow>; stale: boolean } | null;
  try {
    resolved = await resolveRates(db, "VE", venezuelaRateService);
  } catch (error) {
    console.error(
      "Venezuela exchange snapshot unavailable, creating movement without it:",
      error instanceof Error ? error.message : String(error),
    );
    resolved = null;
  }
  if (!resolved) return { snapshot: null };

  const usdSnap = resolved.byAsset.get("USD")!;
  const eurSnap = resolved.byAsset.get("EUR")!;

  const vesMinor =
    input.currency === "VES" ? input.amountMinor : convertMinorAmount(input.amountMinor, usdSnap.rate, "multiply");
  const usdMinor =
    input.currency === "USD" ? input.amountMinor : convertMinorAmount(vesMinor, usdSnap.rate, "divide");
  const eurMinor = convertMinorAmount(vesMinor, eurSnap.rate, "divide");
  const otherCurrency = input.currency === "VES" ? "USD" : "VES";
  const otherAmountMinor = input.currency === "VES" ? usdMinor : vesMinor;

  const rows: MovementSnapshotRow[] = [
    {
      rateSource: "BCV",
      displayCurrency: otherCurrency,
      referenceAsset: "USD",
      rate: usdSnap.rate,
      convertedAmountMinor: otherAmountMinor,
      rateSnapshotId: usdSnap.id,
      customRateId: null,
      observedAt: usdSnap.observedAt,
    },
    {
      rateSource: "EURO",
      displayCurrency: "EUR",
      referenceAsset: "EUR",
      rate: eurSnap.rate,
      convertedAmountMinor: eurMinor,
      rateSnapshotId: eurSnap.id,
      customRateId: null,
      observedAt: eurSnap.observedAt,
    },
  ];

  if (customRate) {
    const customOtherAmountMinor =
      input.currency === "VES"
        ? convertMinorAmount(input.amountMinor, customRate.rate, "divide")
        : convertMinorAmount(input.amountMinor, customRate.rate, "multiply");
    rows.push({
      rateSource: "CUSTOM",
      displayCurrency: otherCurrency,
      referenceAsset: "USD",
      rate: customRate.rate,
      convertedAmountMinor: customOtherAmountMinor,
      rateSnapshotId: null,
      customRateId: customRate.id,
      observedAt: null,
    });
  }

  return { snapshot: { countryCode: "VE", createdWithCurrency: input.currency, rows } };
}
