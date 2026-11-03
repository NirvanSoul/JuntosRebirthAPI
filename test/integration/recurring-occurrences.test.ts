import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { bootstrapAccount, findCurrentUser } from "../../src/services/account";
import { createSpaceWithOwner } from "../../src/services/spaces";
import * as service from "../../src/services/recurring-transactions";
import * as financial from "../../src/services/transactions";
import { runRecurrences } from "../../src/services/recurrence-engine";
import { createRecurringTransactionsRoute } from "../../src/routes/recurring-transactions";
import { createDb } from "../../src/db/client";
import { categories, recurringTransactionSeries } from "../../src/db/schema";
import type { AuthVariables } from "../../src/middleware/auth";
import type { SpaceAccessVariables } from "../../src/middleware/space-access";
import type { Bindings } from "../../src/types/env";
import { cleanupTestUsers, createTestUser, databaseUrlForEngine, testDb } from "./harness";

/**
 * Añadir o editar una ocurrencia personalizada recalcula la siguiente fecha de
 * la serie. Si el motor genera entre la lectura y la escritura de esa fecha,
 * la serie no puede quedar apuntando a una ocurrencia ya generada.
 */
const db = testDb();
afterAll(cleanupTestUsers);

async function customSeries(label: string) {
  const userId = await createTestUser(db, label);
  const currentUser = await findCurrentUser(db, userId);
  await bootstrapAccount(db, currentUser!, "Europe/Madrid");
  const space = await createSpaceWithOwner(db, userId, { name: "Recurrencias", type: "other", currency: "EUR", timezone: "Europe/Madrid" });
  const [category] = await db.insert(categories).values({ spaceId: space.id, name: "Extras", createdBy: userId }).returning({ id: categories.id });
  const series = await service.createSeries(db, {
    spaceId: space.id, userId, categoryId: category!.id, moneyAccountId: null, type: "income", amountMinor: 5000n,
    currency: "EUR", title: "Extras", frequency: "custom", startsOn: "2026-08-05", customDates: ["2026-08-05", "2026-08-12", "2026-09-30"],
  });
  return { userId, spaceId: space.id, seriesId: series.id };
}

/**
 * La ruta real, con el motor intercalado justo después de que lea la siguiente
 * fecha pendiente (antes de escribirla). Con el arreglo la ruta ya no hace esa
 * lectura separada: ocurrencia y fecha se escriben en la misma transacción.
 */
function routeWithEngineInterleaved(userId: string, spaceId: string) {
  let interleaved = false;
  const interleave = async () => {
    if (interleaved) return;
    interleaved = true;
    await runRecurrences(databaseUrlForEngine(), new Date("2026-08-20T10:00:00.000Z"), [spaceId]);
  };
  const deps = {
    createDb,
    ...service,
    runRecurrences,
    findActiveCategory: financial.findActiveCategory,
    findActiveMoneyAccount: financial.findActiveMoneyAccount,
    accountHasCurrency: financial.accountHasCurrency,
    // Antes: la ruta leía aquí la siguiente pendiente y luego la escribía.
    pendingNext: async (...args: Parameters<typeof service.pendingNext>) => {
      const next = await service.pendingNext(...args);
      await interleave();
      return next;
    },
  };
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables & SpaceAccessVariables }>();
  app.use("*", async (c, next) => {
    c.set("currentUserId", userId);
    await next();
  });
  app.route("/v1/spaces/:spaceId/recurring-transactions", createRecurringTransactionsRoute(deps as never, async (_c, next) => next()));
  // Sin hueco entre lectura y escritura, el motor solo puede ir antes o después.
  return { app, finish: interleave };
}

async function nextOf(seriesId: string) {
  const [row] = await db.select({ next: recurringTransactionSeries.nextOccurrenceOn }).from(recurringTransactionSeries).where(eq(recurringTransactionSeries.id, seriesId));
  return row?.next;
}

describe("custom occurrences edited while the engine runs", () => {
  it("adding an occurrence never leaves the series pointing at a generated one", async () => {
    const { userId, spaceId, seriesId } = await customSeries("occ-add");
    const { app, finish } = routeWithEngineInterleaved(userId, spaceId);

    const response = await app.request(
      `/v1/spaces/${spaceId}/recurring-transactions/${seriesId}/occurrences`,
      { method: "POST", body: JSON.stringify({ scheduledOn: "2026-09-10" }) },
      { DATABASE_URL: databaseUrlForEngine() } as Bindings,
    );

    expect(response.status).toBe(201);
    await finish();
    expect(await nextOf(seriesId)).toBe("2026-09-10");
    const later = await runRecurrences(databaseUrlForEngine(), new Date("2026-10-01T10:00:00.000Z"), [spaceId]);
    expect(later.generatedTransactions).toBe(2);
  });

  it("skipping an occurrence never leaves the series pointing at a generated one", async () => {
    const { userId, spaceId, seriesId } = await customSeries("occ-skip");
    const pending = (await service.listOccurrences(db, seriesId)).find((occurrence) => occurrence.scheduledOn === "2026-09-30")!;
    const { app, finish } = routeWithEngineInterleaved(userId, spaceId);

    const response = await app.request(
      `/v1/spaces/${spaceId}/recurring-transactions/${seriesId}/occurrences/${pending.id}`,
      { method: "PATCH", body: JSON.stringify({ scheduledOn: "2026-09-29" }) },
      { DATABASE_URL: databaseUrlForEngine() } as Bindings,
    );

    expect(response.status).toBe(200);
    await finish();
    expect(await nextOf(seriesId)).toBe("2026-09-29");
  });
});
