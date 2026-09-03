import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { customExchangeRates } from "../db/schema";

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
  if (input.isDefault) await clearDefault(db, input.userId);

  const [row] = await db
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

  return serialize(row);
}

export async function updateCustomExchangeRate(
  db: Database,
  input: { userId: string; id: string; name?: string; rate?: string; isDefault?: boolean },
): Promise<CustomExchangeRateResponse | null> {
  if (input.isDefault) await clearDefault(db, input.userId);

  const values: { name?: string; rate?: string; isDefault?: boolean; updatedAt: Date } = { updatedAt: new Date() };
  if (input.name !== undefined) values.name = input.name;
  if (input.rate !== undefined) values.rate = input.rate;
  if (input.isDefault !== undefined) values.isDefault = input.isDefault;

  const [row] = await db
    .update(customExchangeRates)
    .set(values)
    .where(and(eq(customExchangeRates.id, input.id), eq(customExchangeRates.userId, input.userId)))
    .returning();

  return row ? serialize(row) : null;
}

export async function deleteCustomExchangeRate(db: Database, userId: string, id: string): Promise<boolean> {
  const [row] = await db
    .delete(customExchangeRates)
    .where(and(eq(customExchangeRates.id, id), eq(customExchangeRates.userId, userId)))
    .returning({ id: customExchangeRates.id });
  return Boolean(row);
}

async function clearDefault(db: Database, userId: string) {
  await db
    .update(customExchangeRates)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(customExchangeRates.userId, userId), eq(customExchangeRates.isDefault, true)));
}
