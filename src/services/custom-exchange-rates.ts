import { and, eq, exists, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../db/client";
import { customExchangeRates } from "../db/schema";

const promoted = alias(customExchangeRates, "promoted");

export type CustomExchangeRateResponse = {
  id: string;
  name: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  isDefault: boolean;
  createdAt: Date;
};

function serialize(row: typeof customExchangeRates.$inferSelect): CustomExchangeRateResponse {
  return {
    id: row.id,
    name: row.name,
    baseCurrency: row.baseCurrency,
    quoteCurrency: row.quoteCurrency,
    rate: row.rate,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
  };
}

export async function listCustomExchangeRates(db: Database, userId: string): Promise<CustomExchangeRateResponse[]> {
  const rows = await db
    .select()
    .from(customExchangeRates)
    .where(eq(customExchangeRates.userId, userId))
    .orderBy(customExchangeRates.createdAt);
  return rows.map(serialize);
}

export async function findCustomExchangeRate(db: Database, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(customExchangeRates)
    .where(and(eq(customExchangeRates.id, id), eq(customExchangeRates.userId, userId)));
  return row ?? null;
}

/**
 * `baseCurrency`/`quoteCurrency` se fijan aquí a "USD"/"VES", no vienen del
 * payload: el puente de conversión VES↔USD↔EUR de `exchange-rates.ts` asume
 * que toda tasa CUSTOM es USD/VES.
 */
export async function createCustomExchangeRate(
  db: Database,
  input: { userId: string; countryCode: string; name: string; rate: string; isDefault: boolean },
): Promise<CustomExchangeRateResponse> {
  const insert = db
    .insert(customExchangeRates)
    .values({
      userId: input.userId,
      countryCode: input.countryCode,
      name: input.name,
      baseCurrency: "USD",
      quoteCurrency: "VES",
      rate: input.rate,
      isDefault: input.isDefault,
    })
    .returning();
  const [row] = input.isDefault
    ? (await db.batch([lockDefaults(db, input.userId), clearDefault(db, input.userId), insert]))[2]
    : await insert;

  return serialize(row!);
}

export async function updateCustomExchangeRate(
  db: Database,
  input: { userId: string; id: string; name?: string; rate?: string; isDefault?: boolean },
): Promise<CustomExchangeRateResponse | null> {
  const values: { name?: string; rate?: string; isDefault?: boolean; updatedAt: Date } = { updatedAt: new Date() };
  if (input.name !== undefined) values.name = input.name;
  if (input.rate !== undefined) values.rate = input.rate;
  if (input.isDefault !== undefined) values.isDefault = input.isDefault;

  const update = db
    .update(customExchangeRates)
    .set(values)
    .where(and(eq(customExchangeRates.id, input.id), eq(customExchangeRates.userId, input.userId)))
    .returning();
  // Solo se desmarca la predeterminada actual si la que se promueve existe y
  // es de esta persona; antes un id inexistente o ajeno la dejaba sin ninguna.
  const [row] = input.isDefault
    ? (await db.batch([lockDefaults(db, input.userId), clearDefault(db, input.userId, input.id), update]))[2]
    : await update;

  return row ? serialize(row) : null;
}

export async function deleteCustomExchangeRate(db: Database, userId: string, id: string): Promise<boolean> {
  const [row] = await db
    .delete(customExchangeRates)
    .where(and(eq(customExchangeRates.id, id), eq(customExchangeRates.userId, userId)))
    .returning({ id: customExchangeRates.id });
  return Boolean(row);
}

/**
 * Elegir predeterminada es "desmarcar las demás y marcar esta": sin serializar
 * por persona, dos peticiones simultáneas desmarcaban antes de que la otra
 * marcase y quedaban dos predeterminadas.
 */
function lockDefaults(db: Database, userId: string) {
  return db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`juntos.custom-rate-default:${userId}`}, 0))`);
}

function clearDefault(db: Database, userId: string, promotedId?: string) {
  return db
    .update(customExchangeRates)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(
      eq(customExchangeRates.userId, userId),
      eq(customExchangeRates.isDefault, true),
      ...(promotedId
        ? [
            ne(customExchangeRates.id, promotedId),
            exists(db.select({ one: sql`1` }).from(promoted).where(and(eq(promoted.id, promotedId), eq(promoted.userId, userId)))),
          ]
        : []),
    ));
}
