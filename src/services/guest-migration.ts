import { and, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  categories,
  categoryBudgets,
  guestEntityLinks,
  guestMigrationBatches,
  moneyAccountBalances,
  moneyAccounts,
  recurringTransactionSeries,
  spaceMembers,
  spaces,
  transactions,
  userProfiles,
} from "../db/schema";

type RecordValue = Record<string, unknown>;

export type GuestPayload = {
  batchId: string;
  installationId: string;
  spaces: RecordValue[];
  categories: RecordValue[];
  moneyAccounts: RecordValue[];
  recurringSeries: RecordValue[];
  transactions: RecordValue[];
};

export type GuestResult = {
  batchId: string;
  spaceCount: number;
  categoryCount: number;
  moneyAccountCount: number;
  seriesCount: number;
  transactionCount: number;
};

/**
 * Sube el ledger del modo invitado a la cuenta recién autenticada.
 *
 * Es idempotente por `(userId, installationId, batchId)`: reenviar el mismo
 * lote devuelve los mismos contadores sin duplicar nada. Toda la escritura va
 * en un único `db.batch`, que el driver Neon HTTP ejecuta como transacción, de
 * modo que un fallo no deja ni la fila del lote ni datos a medias: el cliente
 * puede reintentar con el mismo `batchId`.
 */
export async function migrateGuest(
  db: Database,
  userId: string,
  payload: GuestPayload,
): Promise<GuestResult> {
  validate(payload);

  const result: GuestResult = {
    batchId: payload.batchId,
    spaceCount: payload.spaces.length,
    categoryCount: payload.categories.length,
    moneyAccountCount: payload.moneyAccounts.length,
    seriesCount: payload.recurringSeries.length,
    transactionCount: payload.transactions.length,
  };

  const [existing] = await db
    .select({ status: guestMigrationBatches.status })
    .from(guestMigrationBatches)
    .where(
      and(
        eq(guestMigrationBatches.userId, userId),
        eq(guestMigrationBatches.installationId, payload.installationId),
        eq(guestMigrationBatches.batchId, payload.batchId),
      ),
    );
  if (existing?.status === "completed") return result;
  if (existing) throw new Error("MIGRATION_IN_PROGRESS");

  const [profile] = await db
    .select({ personalSpaceId: userProfiles.personalSpaceId })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));
  if (!profile?.personalSpaceId) throw new Error("BOOTSTRAP_REQUIRED");
  const personalSpaceId = profile.personalSpaceId;

  const personalSpace = payload.spaces.find((space) => space.type === "personal");
  const spaceCurrencies = new Map(
    payload.spaces.map((space) => [text(space.id), text(space.currency) || "EUR"]),
  );

  // El bootstrap ya sembró las 18 categorías canónicas en el espacio personal.
  // Las del invitado traen el mismo `templateKey`, así que reutilizamos la fila
  // existente en vez de insertar una duplicada que el índice único rechazaría.
  const seeded = await db
    .select({ id: categories.id, templateKey: categories.templateKey })
    .from(categories)
    .where(
      and(eq(categories.spaceId, personalSpaceId), isNotNull(categories.templateKey)),
    );
  const seededByTemplateKey = new Map(
    seeded.map((category) => [category.templateKey as string, category.id]),
  );

  const ids = new Map<string, string>();
  for (const space of payload.spaces) {
    ids.set(
      `space:${text(space.id)}`,
      space === personalSpace ? personalSpaceId : crypto.randomUUID(),
    );
  }

  const reusedCategoryIds = new Set<string>();
  for (const category of payload.categories) {
    const localId = text(category.id);
    const templateKey = stringOrNull(category.templateKey);
    const inPersonalSpace = text(category.spaceId) === text(personalSpace?.id);
    const reused =
      inPersonalSpace && templateKey ? seededByTemplateKey.get(templateKey) : undefined;

    if (reused) reusedCategoryIds.add(localId);
    ids.set(`category:${localId}`, reused ?? crypto.randomUUID());
  }

  for (const account of payload.moneyAccounts) {
    ids.set(`account:${text(account.id)}`, crypto.randomUUID());
  }
  for (const series of payload.recurringSeries) {
    ids.set(`series:${text(series.id)}`, crypto.randomUUID());
  }
  for (const transaction of payload.transactions) {
    ids.set(`transaction:${text(transaction.id)}`, crypto.randomUUID());
  }

  const now = new Date();
  const source = {
    sourceInstallationId: payload.installationId,
  };
  const links = [...ids].map(([key, remoteId]) => {
    const separator = key.indexOf(":");
    return {
      userId,
      installationId: payload.installationId,
      entityType: key.slice(0, separator),
      localId: key.slice(separator + 1),
      remoteId,
      createdAt: now,
    };
  });

  const importedSpaces = payload.spaces.filter((space) => space !== personalSpace);
  const newCategories = payload.categories.filter(
    (category) => !reusedCategoryIds.has(text(category.id)),
  );

  const queries = [
    db.insert(guestMigrationBatches).values({
      id: crypto.randomUUID(),
      userId,
      installationId: payload.installationId,
      batchId: payload.batchId,
      status: "completed",
      payloadHash: await hashPayload(payload),
      createdAt: now,
      completedAt: now,
    }),

    ...importedSpaces.map((space) =>
      db.insert(spaces).values({
        id: ref(ids, "space", space.id),
        name: text(space.name),
        // Un espacio de pareja local nunca consume la cuota del espacio Juntos
        // real: entra siempre como `other`, igual que hacía la base anterior.
        // El tipo recibido se valida de todos modos para rechazar basura.
        type: assertSpaceType(space.type),
        currency: text(space.currency),
        timezone: "UTC",
        createdBy: userId,
        activatedAt: now,
        ...source,
        sourceLocalId: text(space.id),
        createdAt: now,
        updatedAt: now,
      }),
    ),
    ...importedSpaces.map((space) =>
      db.insert(spaceMembers).values({
        spaceId: ref(ids, "space", space.id),
        userId,
        role: "owner",
        status: "active",
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    ),

    ...newCategories.map((category) =>
      db.insert(categories).values({
        id: ref(ids, "category", category.id),
        spaceId: ref(ids, "space", category.spaceId),
        name: text(category.name),
        icon: stringOrNull(category.icon),
        colorToken: stringOrNull(category.colorToken),
        createdBy: userId,
        isDefault: Boolean(category.isDefault),
        templateKey: stringOrNull(category.templateKey),
        ...source,
        sourceLocalId: text(category.id),
        isArchived: Boolean(category.isArchived),
        archivedAt: dateOrNull(category.archivedAt),
        createdAt: date(category.createdAt),
        updatedAt: date(category.updatedAt),
      }),
    ),
    // El presupuesto local es un único importe sin moneda propia: se registra
    // en la moneda del espacio. Antes se leía `category.currency`, un campo que
    // el cliente nunca envía, así que todo acababa guardado como EUR.
    ...payload.categories
      .filter(
        (category) =>
          typeof category.budgetMinor === "number" && category.budgetMinor > 0,
      )
      .map((category) =>
        db.insert(categoryBudgets).values({
          categoryId: ref(ids, "category", category.id),
          currency: spaceCurrencies.get(text(category.spaceId)) ?? "EUR",
          budgetAmountMinor: BigInt(category.budgetMinor as number),
          createdBy: userId,
        }),
      ),

    ...payload.moneyAccounts.flatMap((account) => [
      db.insert(moneyAccounts).values({
        id: ref(ids, "account", account.id),
        spaceId: ref(ids, "space", account.spaceId),
        name: text(account.name),
        kind: accountKind(account.kind),
        icon: stringOrNull(account.icon),
        colorToken: stringOrNull(account.colorToken),
        primaryCurrency: text(account.currency),
        createdBy: userId,
        ...source,
        sourceLocalId: text(account.id),
        isArchived: Boolean(account.isArchived),
        archivedAt: dateOrNull(account.archivedAt),
        createdAt: date(account.createdAt),
        updatedAt: date(account.updatedAt),
      }),
      ...array(account.balances).map((balance) =>
        db.insert(moneyAccountBalances).values({
          moneyAccountId: ref(ids, "account", account.id),
          currency: text(balance.currency),
          openingBalanceMinor: BigInt(number(balance.openingBalanceMinor)),
          displayOrder: number(balance.position),
        }),
      ),
    ]),

    ...payload.recurringSeries.map((series) =>
      db.insert(recurringTransactionSeries).values({
        id: ref(ids, "series", series.id),
        spaceId: ref(ids, "space", series.spaceId),
        categoryId: ref(ids, "category", series.categoryId),
        moneyAccountId: series.moneyAccountId
          ? ref(ids, "account", series.moneyAccountId)
          : null,
        createdBy: userId,
        type: transactionType(series.type),
        amountMinor: BigInt(number(series.amountMinor)),
        currency: text(series.currency),
        title: text(series.title),
        frequency: frequency(series.frequency),
        startsOn: text(series.startsOn),
        nextOccurrenceOn: text(series.nextOccurrenceOn),
        generatedOccurrences: number(series.generatedOccurrences),
        ...source,
        sourceLocalId: text(series.id),
        isArchived: Boolean(series.isArchived),
        archivedAt: dateOrNull(series.archivedAt),
        createdAt: date(series.createdAt),
        updatedAt: date(series.updatedAt),
      }),
    ),

    ...payload.transactions.map((transaction) =>
      db.insert(transactions).values({
        id: ref(ids, "transaction", transaction.id),
        spaceId: ref(ids, "space", transaction.spaceId),
        categoryId: ref(ids, "category", transaction.categoryId),
        moneyAccountId: transaction.moneyAccountId
          ? ref(ids, "account", transaction.moneyAccountId)
          : null,
        createdBy: userId,
        type: transactionType(transaction.type),
        amountMinor: BigInt(number(transaction.amountMinor)),
        currency: text(transaction.currency),
        title: text(transaction.title),
        occurredOn: text(transaction.occurredOn),
        note: stringOrNull(transaction.note),
        // Las recurrencias personalizadas del cliente son N movimientos que
        // comparten `recurrenceGroupId` y no tienen serie. Sin estos dos campos
        // la agrupación se perdía en la migración.
        recurrence: recurrenceKind(transaction.recurrence),
        recurrenceGroupId: stringOrNull(transaction.recurrenceGroupId),
        recurrenceSeriesId: transaction.recurrenceSeriesId
          ? ref(ids, "series", transaction.recurrenceSeriesId)
          : null,
        sourceLocalTransactionId: stringOrNull(transaction.sourceTransactionId),
        ...source,
        sourceLocalId: text(transaction.id),
        isArchived: Boolean(transaction.isArchived),
        archivedAt: dateOrNull(transaction.archivedAt),
        createdAt: date(transaction.createdAt),
        updatedAt: date(transaction.updatedAt),
      }),
    ),

    db.insert(guestEntityLinks).values(links),
  ];

  await db.batch(queries as [(typeof queries)[number], ...typeof queries]);
  return result;
}

function validate(payload: GuestPayload) {
  if (
    !text(payload.batchId) ||
    !text(payload.installationId) ||
    !payload.spaces.some((space) => space.type === "personal")
  ) {
    throw new Error("INVALID_PAYLOAD");
  }

  const spaceIds = new Set(payload.spaces.map((x) => text(x.id)));
  const categoryIds = new Set(payload.categories.map((x) => text(x.id)));
  const accountIds = new Set(payload.moneyAccounts.map((x) => text(x.id)));
  const seriesIds = new Set(payload.recurringSeries.map((x) => text(x.id)));

  const children = [
    ...payload.categories,
    ...payload.moneyAccounts,
    ...payload.recurringSeries,
    ...payload.transactions,
  ];
  for (const child of children) {
    if (!spaceIds.has(text(child.spaceId))) throw new Error("INVALID_GRAPH");
  }
  for (const row of [...payload.recurringSeries, ...payload.transactions]) {
    if (!categoryIds.has(text(row.categoryId))) throw new Error("INVALID_GRAPH");
    if (row.moneyAccountId && !accountIds.has(text(row.moneyAccountId))) {
      throw new Error("INVALID_GRAPH");
    }
  }
  for (const transaction of payload.transactions) {
    if (
      transaction.recurrenceSeriesId &&
      !seriesIds.has(text(transaction.recurrenceSeriesId))
    ) {
      throw new Error("INVALID_GRAPH");
    }
  }
}

function ref(ids: Map<string, string>, type: string, id: unknown) {
  const value = ids.get(`${type}:${text(id)}`);
  if (!value) throw new Error("INVALID_GRAPH");
  return value;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function number(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("INVALID_PAYLOAD");
  }
  return value;
}

function array(value: unknown) {
  return Array.isArray(value) ? (value as RecordValue[]) : [];
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function date(value: unknown) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("INVALID_PAYLOAD");
  }
  return new Date(value);
}

function dateOrNull(value: unknown) {
  return value === null || value === undefined ? null : date(value);
}

function assertSpaceType(value: unknown): "other" {
  if (value !== "personal" && value !== "couple" && value !== "other") {
    throw new Error("INVALID_PAYLOAD");
  }
  return "other";
}

function accountKind(value: unknown) {
  if (value === "cash" || value === "bank" || value === "card") return value;
  throw new Error("INVALID_PAYLOAD");
}

function transactionType(value: unknown) {
  if (value === "income" || value === "expense") return value;
  throw new Error("INVALID_PAYLOAD");
}

function frequency(value: unknown) {
  if (value === "weekly" || value === "biweekly" || value === "monthly") return value;
  throw new Error("INVALID_PAYLOAD");
}

function recurrenceKind(value: unknown) {
  if (value === undefined || value === null) return "once" as const;
  if (
    value === "once" ||
    value === "weekly" ||
    value === "biweekly" ||
    value === "monthly" ||
    value === "custom"
  ) {
    return value;
  }
  throw new Error("INVALID_PAYLOAD");
}

/**
 * Hash real del contenido del lote. Antes solo concatenaba longitudes, así que
 * un payload distinto reenviado con el mismo `batchId` pasaba desapercibido.
 */
async function hashPayload(payload: GuestPayload) {
  const canonical = JSON.stringify([
    payload.batchId,
    payload.installationId,
    payload.spaces,
    payload.categories,
    payload.moneyAccounts,
    payload.recurringSeries,
    payload.transactions,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
