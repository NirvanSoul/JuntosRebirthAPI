import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  check,
  date,
  integer,
  index,
  uniqueIndex,
  uuid,
  bigint,
  numeric,
  jsonb,
  varchar,
  pgEnum,
} from "drizzle-orm/pg-core";

// Better Auth Tables
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("account_issuer_accountId_uidx").on(
      table.issuer,
      table.accountId,
    ),
    index("account_userId_idx").on(table.userId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/** Contadores distribuidos de Better Auth para limitar OTP y autenticación. */
export const rateLimit = pgTable("rate_limit", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// Juntoss Enums
export const spaceTypeEnum = pgEnum("space_type", [
  "personal",
  "couple",
  "other",
]);

export const spaceMemberRoleEnum = pgEnum("space_member_role", [
  "owner",
  "admin",
  "member",
]);

export const spaceMemberStatusEnum = pgEnum("space_member_status", [
  "active",
  "left",
]);

export const spaceInvitationStatusEnum = pgEnum("space_invitation_status", [
  "pending",
  "accepted",
  // Rechazada por la persona invitada; `revoked` lo hace quien invitó.
  "declined",
  "revoked",
  "expired",
]);

export const pushPlatformEnum = pgEnum("push_platform", ["ios", "android"]);

export const importSourceTypeEnum = pgEnum("import_source_type", [
  "xls",
  "xlsx",
  "csv",
  "tsv",
]);

export const importBatchStatusEnum = pgEnum("import_batch_status", [
  "parsing",
  "mapping_required",
  "needs_review",
  "ready",
  "imported",
  "failed",
  "cancelled",
]);

export const importMovementTypeEnum = pgEnum("import_movement_type", [
  "expense",
  "income",
  "unknown",
]);

export const importDuplicateStatusEnum = pgEnum("import_duplicate_status", [
  "none",
  "exact",
  "probable",
]);

export const importItemStatusEnum = pgEnum("import_item_status", [
  "pending",
  "ready",
  "ignored",
  "duplicate",
  "imported",
  "error",
]);

export const merchantRuleSourceEnum = pgEnum("merchant_rule_source", [
  "manual",
  "import_correction",
  "system",
]);

export const legalDocumentTypeEnum = pgEnum("legal_document_type", [
  "privacy-policy",
  "terms-of-service",
]);

export const moneyAccountKindEnum = pgEnum("money_account_kind", [
  "cash",
  "bank",
  "card",
]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "expense",
  "income",
]);

export const transactionRecurrenceEnum = pgEnum("transaction_recurrence", [
  "once",
  "weekly",
  "biweekly",
  "monthly",
  "custom",
]);

export const recurringTransactionFrequencyEnum = pgEnum(
  "recurring_transaction_frequency",
  ["weekly", "biweekly", "monthly", "custom"],
);

export const recurringTransactionOccurrenceStatusEnum = pgEnum(
  "recurring_transaction_occurrence_status",
  ["pending", "generated", "skipped"],
);

// Juntoss Tables

/**
 * Bloqueo de fuerza bruta por correo. Sustituye la edge function
 * `login-with-lockout` de la base anterior: 9 intentos fallidos bloquean el
 * acceso durante una hora. Se indexa por correo en minúsculas, nunca por
 * usuario, para no revelar si la cuenta existe.
 */
export const loginAttempts = pgTable("login_attempts", {
  email: text("email").primaryKey(),
  failedCount: integer("failed_count").default(0).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Tokens de Expo para notificaciones push. La clave primaria es el token: el
 * mismo dispositivo puede cambiar de cuenta y el token debe seguir a la última.
 */
export const userPushTokens = pgTable(
  "user_push_tokens",
  {
    expoPushToken: text("expo_push_token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: pushPlatformEnum("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("user_push_tokens_user_idx").on(table.userId),
    check(
      "user_push_tokens_expo_format",
      sql`${table.expoPushToken} ~ '^Expo(nent)?PushToken\\[[^\\]]+\\]$'`,
    ),
  ],
);

/** Registro de consentimientos. Obligatorio para el RGPD y para las stores. */
export const legalAcceptances = pgTable(
  "legal_acceptances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    documentType: legalDocumentTypeEnum("document_type").notNull(),
    documentVersion: text("document_version").notNull(),
    appVersion: text("app_version"),
    locale: text("locale"),
    source: text("source"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("legal_acceptances_user_idx").on(table.userId, table.documentType)],
);

export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  avatarPath: text("avatar_path"),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
  locale: text("locale").default("es").notNull(),
  defaultCurrency: text("default_currency").default("EUR").notNull(),
  countryCode: text("country_code"),
  personalSpaceId: uuid("personal_space_id").references(() => spaces.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    type: spaceTypeEnum("type").default("personal").notNull(),
    currency: text("currency").default("EUR").notNull(),
    timezone: varchar("timezone", { length: 64 }).default("UTC").notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    // Sin `defaultNow()`: un espacio `couple` nace con `activated_at = NULL` y
    // solo se activa cuando la pareja acepta la invitación. El cliente deriva
    // de aquí su estado "esperando pareja".
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    sourceInstallationId: text("source_installation_id"),
    sourceLocalId: text("source_local_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("spaces_createdBy_idx").on(table.createdBy),
    uniqueIndex("spaces_source_local_idx")
      .on(table.createdBy, table.sourceInstallationId, table.sourceLocalId)
      .where(sql`${table.sourceLocalId} IS NOT NULL`),
    // Un usuario solo puede tener un espacio de pareja activo a la vez.
    uniqueIndex("spaces_one_active_couple_per_creator_idx")
      .on(table.createdBy)
      .where(sql`${table.type} = 'couple' AND ${table.archivedAt} IS NULL`),
  ],
);

export const spaceMembers = pgTable(
  "space_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: spaceMemberRoleEnum("role").default("member").notNull(),
    status: spaceMemberStatusEnum("status").default("active").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("space_members_space_user_idx").on(table.spaceId, table.userId),
    index("space_members_userId_idx").on(table.userId),
  ],
);

export const spaceInvitations = pgTable(
  "space_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    invitedEmail: text("invited_email").notNull(),
    inviteeUserId: text("invitee_user_id").references(() => user.id, { onDelete: "set null" }),
    role: spaceMemberRoleEnum("role").default("member").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: spaceInvitationStatusEnum("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (table) => [
    index("space_invitations_space_status_idx").on(table.spaceId, table.status),
    // La migración 0015 añade además un índice único parcial sobre
    // (space_id, lower(invited_email)) WHERE status = 'pending'. Drizzle no
    // sabe expresar `lower()` dentro de un índice, así que vive solo en el SQL.
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    colorToken: text("color_token"),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    isDefault: boolean("is_default").default(false).notNull(),
    templateKey: text("template_key"),
    sourceInstallationId: text("source_installation_id"),
    sourceLocalId: text("source_local_id"),
    isArchived: boolean("is_archived").default(false).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("categories_spaceId_idx").on(table.spaceId),
    // Creado por la migración 0007; faltaba aquí y hacía divergir el snapshot.
    uniqueIndex("categories_space_template_key_idx")
      .on(table.spaceId, table.templateKey)
      .where(sql`${table.templateKey} IS NOT NULL`),
    uniqueIndex("categories_source_local_idx")
      .on(table.spaceId, table.sourceInstallationId, table.sourceLocalId)
      .where(sql`${table.sourceLocalId} IS NOT NULL`),
  ],
);

export const categoryBudgets = pgTable(
  "category_budgets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    currency: varchar("currency", { length: 3 }).notNull(),
    budgetAmountMinor: bigint("budget_amount_minor", { mode: "bigint" })
      .notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check(
      "category_budgets_budget_amount_minor_nonnegative",
      sql`${table.budgetAmountMinor} >= 0`,
    ),
    uniqueIndex("category_budgets_category_currency_idx").on(
      table.categoryId,
      table.currency,
    ),
  ],
);

/**
 * Alias durable de `(spaceId, sourceInstallationId, sourceLocalId)` hacia una
 * categoría ya existente. Necesaria porque una categoría solo guarda un par
 * instalación/id-local (el del último dispositivo que la escribió): cuando el
 * sync fusiona la categoría "propia" de un segundo dispositivo en la fila que
 * ya tenía el primero (por `templateKey`), el id local del segundo dispositivo
 * no queda registrado en ningún sitio. Si ese dispositivo sincroniza después
 * un movimiento que referencia esa categoría por su id local, sin volver a
 * incluir la categoría en el mismo lote, el servidor no tiene forma de
 * resolverlo — de ahí esta tabla, que registra el alias la primera vez que se
 * ve y sigue funcionando en cualquier sync posterior.
 */
export const categoryAliases = pgTable(
  "category_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    sourceInstallationId: text("source_installation_id").notNull(),
    sourceLocalId: text("source_local_id").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("category_aliases_source_local_idx").on(
      table.spaceId,
      table.sourceInstallationId,
      table.sourceLocalId,
    ),
    index("category_aliases_category_idx").on(table.categoryId),
  ],
);

export const categoryAliasesRelations = relations(categoryAliases, ({ one }) => ({
  space: one(spaces, {
    fields: [categoryAliases.spaceId],
    references: [spaces.id],
  }),
  category: one(categories, {
    fields: [categoryAliases.categoryId],
    references: [categories.id],
  }),
}));

export const moneyAccounts = pgTable(
  "money_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: moneyAccountKindEnum("kind").notNull(),
    icon: text("icon"),
    colorToken: text("color_token"),
    primaryCurrency: varchar("primary_currency", { length: 3 }).notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    sourceInstallationId: text("source_installation_id"),
    sourceLocalId: text("source_local_id"),
    isArchived: boolean("is_archived").default(false).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("money_accounts_spaceId_idx").on(table.spaceId),
    uniqueIndex("money_accounts_source_local_idx")
      .on(table.spaceId, table.sourceInstallationId, table.sourceLocalId)
      .where(sql`${table.sourceLocalId} IS NOT NULL`),
  ],
);

export const moneyAccountBalances = pgTable(
  "money_account_balances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    moneyAccountId: uuid("money_account_id")
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: "cascade" }),
    currency: varchar("currency", { length: 3 }).notNull(),
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),
    displayOrder: integer("display_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check(
      "money_account_balances_display_order_nonnegative",
      sql`${table.displayOrder} >= 0`,
    ),
    uniqueIndex("money_account_balances_account_currency_idx").on(
      table.moneyAccountId,
      table.currency,
    ),
  ],
);

export const recurringTransactionSeries = pgTable(
  "recurring_transaction_series",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    moneyAccountId: uuid("money_account_id").references(() => moneyAccounts.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    type: transactionTypeEnum("type").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    title: text("title").notNull(),
    frequency: recurringTransactionFrequencyEnum("frequency").notNull(),
    startsOn: date("starts_on").notNull(),
    nextOccurrenceOn: date("next_occurrence_on"),
    generatedOccurrences: integer("generated_occurrences").default(0).notNull(),
    sourceInstallationId: text("source_installation_id"),
    sourceLocalId: text("source_local_id"),
    isArchived: boolean("is_archived").default(false).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check("recurring_transaction_series_amount_minor_positive", sql`${table.amountMinor} > 0`),
    check(
      "recurring_transaction_series_generated_occurrences_nonnegative",
      sql`${table.generatedOccurrences} >= 0`,
    ),
    check(
      "recurring_transaction_series_next_occurrence_required",
      sql`${table.isArchived} OR ${table.frequency} = 'custom' OR ${table.nextOccurrenceOn} IS NOT NULL`,
    ),
    index("recurring_transaction_series_space_active_next_idx").on(
      table.spaceId,
      table.isArchived,
      table.nextOccurrenceOn,
    ),
    uniqueIndex("recurring_transaction_series_source_local_idx")
      .on(table.spaceId, table.sourceInstallationId, table.sourceLocalId)
      .where(sql`${table.sourceLocalId} IS NOT NULL`),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    moneyAccountId: uuid("money_account_id").references(() => moneyAccounts.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    type: transactionTypeEnum("type").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    title: text("title").notNull(),
    occurredOn: date("occurred_on").notNull(),
    note: text("note"),
    // El SQLite local modela las recurrencias personalizadas como N movimientos
    // que comparten `recurrence_group_id`, sin serie. Sin estas dos columnas la
    // agrupación se perdía al migrar o restaurar.
    recurrence: transactionRecurrenceEnum("recurrence").default("once").notNull(),
    recurrenceGroupId: text("recurrence_group_id"),
    recurrenceSeriesId: uuid("recurrence_series_id").references(
      () => recurringTransactionSeries.id,
    ),
    sourceLocalTransactionId: text("source_local_transaction_id"),
    sourceInstallationId: text("source_installation_id"),
    sourceLocalId: text("source_local_id"),
    isArchived: boolean("is_archived").default(false).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check("transactions_amount_minor_positive", sql`${table.amountMinor} > 0`),
    index("transactions_space_occurred_on_idx").on(table.spaceId, table.occurredOn),
    index("transactions_category_occurred_on_idx").on(
      table.categoryId,
      table.occurredOn,
    ),
    index("transactions_account_currency_occurred_on_idx").on(
      table.moneyAccountId,
      table.currency,
      table.occurredOn,
    ),
    uniqueIndex("transactions_series_occurred_on_idx").on(
      table.recurrenceSeriesId,
      table.occurredOn,
    ).where(sql`${table.recurrenceSeriesId} IS NOT NULL`),
    index("transactions_recurrence_group_idx")
      .on(table.spaceId, table.recurrenceGroupId)
      .where(sql`${table.recurrenceGroupId} IS NOT NULL`),
    uniqueIndex("transactions_source_local_idx")
      .on(table.spaceId, table.sourceInstallationId, table.sourceLocalId)
      .where(sql`${table.sourceLocalId} IS NOT NULL`),
  ],
);

export const recurringTransactionOccurrences = pgTable(
  "recurring_transaction_occurrences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => recurringTransactionSeries.id, { onDelete: "cascade" }),
    scheduledOn: date("scheduled_on").notNull(),
    status: recurringTransactionOccurrenceStatusEnum("status")
      .default("pending")
      .notNull(),
    generatedTransactionId: uuid("generated_transaction_id").references(
      () => transactions.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("recurring_transaction_occurrences_series_scheduled_idx").on(
      table.seriesId,
      table.scheduledOn,
    ),
    uniqueIndex("recurring_transaction_occurrences_generated_transaction_idx").on(
      table.generatedTransactionId,
    ),
    index("recurring_transaction_occurrences_status_scheduled_idx").on(
      table.status,
      table.scheduledOn,
    ),
  ],
);

export const exchangeRateSnapshots = pgTable(
  "exchange_rate_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    rateSource: text("rate_source").notNull(),
    referenceAsset: varchar("reference_asset", { length: 8 }).notNull(),
    quoteCurrency: varchar("quote_currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 24, scale: 10 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("exchange_rate_snapshots_rate_positive", sql`${table.rate} > 0`),
    index("exchange_rate_snapshots_latest_idx").on(
      table.countryCode,
      table.rateSource,
      table.referenceAsset,
      table.quoteCurrency,
      table.observedAt,
    ),
  ],
);

/**
 * Tasa personalizada de un usuario para el modo Venezuela. Fijamos
 * `baseCurrency`/`quoteCurrency` a "USD"/"VES" a nivel de servicio (no como
 * constraint SQL) porque el puente de conversión VES↔USD↔EUR de
 * `MoneyConversionService` asume esa dirección para cualquier tasa CUSTOM.
 */
export const customExchangeRates = pgTable(
  "custom_exchange_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    name: text("name").notNull(),
    baseCurrency: varchar("base_currency", { length: 3 }).notNull(),
    quoteCurrency: varchar("quote_currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 24, scale: 10 }).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check("custom_exchange_rates_rate_positive", sql`${table.rate} > 0`),
    index("custom_exchange_rates_user_idx").on(table.userId),
  ],
);

export const transactionReferenceRates = pgTable(
  "transaction_reference_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    displayCurrency: varchar("display_currency", { length: 3 }).notNull(),
    rateSource: text("rate_source").notNull(),
    referenceAsset: varchar("reference_asset", { length: 8 }).notNull(),
    rate: numeric("rate", { precision: 24, scale: 10 }).notNull(),
    convertedAmountMinor: bigint("converted_amount_minor", { mode: "bigint" })
      .notNull(),
    rateSnapshotId: uuid("rate_snapshot_id").references(
      () => exchangeRateSnapshots.id,
    ),
    // Solo poblado en la fila `rateSource = "CUSTOM"`: qué tasa personalizada
    // del usuario se congeló en el momento de crear el movimiento.
    customRateId: uuid("custom_rate_id").references(
      () => customExchangeRates.id,
      { onDelete: "set null" },
    ),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check("transaction_reference_rates_rate_positive", sql`${table.rate} > 0`),
    check(
      "transaction_reference_rates_converted_amount_nonnegative",
      sql`${table.convertedAmountMinor} >= 0`,
    ),
    // Un movimiento puede tener varias filas congeladas simultáneamente (BCV,
    // EURO, CUSTOM), una por fuente — a diferencia del índice previo que solo
    // admitía una tasa de referencia por movimiento.
    uniqueIndex("transaction_reference_rates_transaction_source_idx").on(
      table.transactionId,
      table.rateSource,
    ),
  ],
);

// Relations
export const userRelations = relations(user, ({ one, many }) => ({
  sessions: many(session),
  accounts: many(account),
  profile: one(userProfiles, {
    fields: [user.id],
    references: [userProfiles.userId],
  }),
  memberships: many(spaceMembers),
  createdSpaces: many(spaces),
  createdCategories: many(categories),
  createdCategoryBudgets: many(categoryBudgets),
  createdMoneyAccounts: many(moneyAccounts),
  createdRecurringTransactionSeries: many(recurringTransactionSeries),
  createdTransactions: many(transactions),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(user, {
    fields: [userProfiles.userId],
    references: [user.id],
  }),
}));

export const spacesRelations = relations(spaces, ({ one, many }) => ({
  creator: one(user, {
    fields: [spaces.createdBy],
    references: [user.id],
  }),
  members: many(spaceMembers),
  categories: many(categories),
  moneyAccounts: many(moneyAccounts),
  recurringTransactionSeries: many(recurringTransactionSeries),
  transactions: many(transactions),
}));

export const spaceMembersRelations = relations(spaceMembers, ({ one }) => ({
  space: one(spaces, {
    fields: [spaceMembers.spaceId],
    references: [spaces.id],
  }),
  user: one(user, {
    fields: [spaceMembers.userId],
    references: [user.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  space: one(spaces, {
    fields: [categories.spaceId],
    references: [spaces.id],
  }),
  creator: one(user, {
    fields: [categories.createdBy],
    references: [user.id],
  }),
  budgets: many(categoryBudgets),
  recurringTransactionSeries: many(recurringTransactionSeries),
  transactions: many(transactions),
}));

export const categoryBudgetsRelations = relations(categoryBudgets, ({ one }) => ({
  category: one(categories, {
    fields: [categoryBudgets.categoryId],
    references: [categories.id],
  }),
  creator: one(user, {
    fields: [categoryBudgets.createdBy],
    references: [user.id],
  }),
}));

export const moneyAccountsRelations = relations(moneyAccounts, ({ one, many }) => ({
  space: one(spaces, {
    fields: [moneyAccounts.spaceId],
    references: [spaces.id],
  }),
  creator: one(user, {
    fields: [moneyAccounts.createdBy],
    references: [user.id],
  }),
  balances: many(moneyAccountBalances),
  recurringTransactionSeries: many(recurringTransactionSeries),
  transactions: many(transactions),
}));

export const moneyAccountBalancesRelations = relations(
  moneyAccountBalances,
  ({ one }) => ({
    moneyAccount: one(moneyAccounts, {
      fields: [moneyAccountBalances.moneyAccountId],
      references: [moneyAccounts.id],
    }),
  }),
);

export const recurringTransactionSeriesRelations = relations(
  recurringTransactionSeries,
  ({ one, many }) => ({
    space: one(spaces, {
      fields: [recurringTransactionSeries.spaceId],
      references: [spaces.id],
    }),
    category: one(categories, {
      fields: [recurringTransactionSeries.categoryId],
      references: [categories.id],
    }),
    moneyAccount: one(moneyAccounts, {
      fields: [recurringTransactionSeries.moneyAccountId],
      references: [moneyAccounts.id],
    }),
    creator: one(user, {
      fields: [recurringTransactionSeries.createdBy],
      references: [user.id],
    }),
    transactions: many(transactions),
    occurrences: many(recurringTransactionOccurrences),
  }),
);

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  space: one(spaces, {
    fields: [transactions.spaceId],
    references: [spaces.id],
  }),
  category: one(categories, {
    fields: [transactions.categoryId],
    references: [categories.id],
  }),
  moneyAccount: one(moneyAccounts, {
    fields: [transactions.moneyAccountId],
    references: [moneyAccounts.id],
  }),
  creator: one(user, {
    fields: [transactions.createdBy],
    references: [user.id],
  }),
  recurrenceSeries: one(recurringTransactionSeries, {
    fields: [transactions.recurrenceSeriesId],
    references: [recurringTransactionSeries.id],
  }),
  referenceRate: one(transactionReferenceRates),
  generatedOccurrences: many(recurringTransactionOccurrences),
}));

export const recurringTransactionOccurrencesRelations = relations(
  recurringTransactionOccurrences,
  ({ one }) => ({
    series: one(recurringTransactionSeries, {
      fields: [recurringTransactionOccurrences.seriesId],
      references: [recurringTransactionSeries.id],
    }),
    generatedTransaction: one(transactions, {
      fields: [recurringTransactionOccurrences.generatedTransactionId],
      references: [transactions.id],
    }),
  }),
);

export const exchangeRateSnapshotsRelations = relations(
  exchangeRateSnapshots,
  ({ many }) => ({
    transactionReferenceRates: many(transactionReferenceRates),
  }),
);

export const transactionReferenceRatesRelations = relations(
  transactionReferenceRates,
  ({ one }) => ({
    transaction: one(transactions, {
      fields: [transactionReferenceRates.transactionId],
      references: [transactions.id],
    }),
    rateSnapshot: one(exchangeRateSnapshots, {
      fields: [transactionReferenceRates.rateSnapshotId],
      references: [exchangeRateSnapshots.id],
    }),
    customRate: one(customExchangeRates, {
      fields: [transactionReferenceRates.customRateId],
      references: [customExchangeRates.id],
    }),
  }),
);

export const customExchangeRatesRelations = relations(
  customExchangeRates,
  ({ one, many }) => ({
    user: one(user, {
      fields: [customExchangeRates.userId],
      references: [user.id],
    }),
    transactionReferenceRates: many(transactionReferenceRates),
  }),
);

// ---------------------------------------------------------------------------
// Importación bancaria
//
// A diferencia del ledger, estas filas son del usuario y no del espacio: la
// autorización es `user_id = sesión`, igual que hacían las políticas RLS
// `own-rows only` de la base anterior.
// ---------------------------------------------------------------------------

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    sourceType: importSourceTypeEnum("source_type").notNull(),
    sourceProfile: text("source_profile"),
    fileHash: text("file_hash"),
    status: importBatchStatusEnum("status").notNull(),
    totalItems: integer("total_items").default(0).notNull(),
    reviewItems: integer("review_items").default(0).notNull(),
    duplicateItems: integer("duplicate_items").default(0).notNull(),
    sourceInstallationId: text("source_installation_id"),
    sourceLocalId: text("source_local_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("import_batches_user_status_idx").on(table.userId, table.status),
    uniqueIndex("import_batches_source_local_idx")
      .on(table.userId, table.sourceInstallationId, table.sourceLocalId)
      .where(sql`${table.sourceLocalId} IS NOT NULL`),
  ],
);

export const importItems = pgTable(
  "import_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    sourceRow: integer("source_row").notNull(),
    sheetName: text("sheet_name"),
    rawDescription: text("raw_description").notNull(),
    normalizedMerchant: text("normalized_merchant").notNull(),
    occurredOn: date("occurred_on"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    currency: varchar("currency", { length: 3 }),
    movementType: importMovementTypeEnum("movement_type").notNull(),
    finalCategoryId: uuid("final_category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    duplicateStatus: importDuplicateStatusEnum("duplicate_status").default("none").notNull(),
    duplicateTransactionId: uuid("duplicate_transaction_id").references(
      () => transactions.id,
      { onDelete: "set null" },
    ),
    itemStatus: importItemStatusEnum("item_status").notNull(),
    isSelected: boolean("is_selected").default(true).notNull(),
    createdTransactionId: uuid("created_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    issues: jsonb("issues").default(sql`'[]'::jsonb`).notNull(),
    sourceInstallationId: text("source_installation_id"),
    sourceLocalId: text("source_local_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("import_items_batch_idx").on(table.batchId),
    uniqueIndex("import_items_source_local_idx")
      .on(table.batchId, table.sourceInstallationId, table.sourceLocalId)
      .where(sql`${table.sourceLocalId} IS NOT NULL`),
    check("import_items_source_row_positive", sql`${table.sourceRow} > 0`),
  ],
);

export const userMerchantRules = pgTable(
  "user_merchant_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    normalizedMerchant: text("normalized_merchant").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    confirmations: integer("confirmations").default(1).notNull(),
    source: merchantRuleSourceEnum("source").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_merchant_rules_unique_idx").on(
      table.userId,
      table.spaceId,
      table.normalizedMerchant,
    ),
    check("user_merchant_rules_confirmations_positive", sql`${table.confirmations} >= 1`),
  ],
);

/**
 * Un voto por persona y comercio. El agregado se mantiene en la misma
 * escritura, así que no hace falta un proceso aparte para reconstruirlo.
 */
export const merchantFeedbackVotes = pgTable(
  "merchant_feedback_votes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    normalizedMerchant: text("normalized_merchant").notNull(),
    canonicalCategoryKey: text("canonical_category_key").notNull(),
    confirmations: integer("confirmations").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("merchant_feedback_votes_pk").on(
      table.userId,
      table.countryCode,
      table.normalizedMerchant,
    ),
    check(
      "merchant_feedback_votes_key_format",
      sql`${table.canonicalCategoryKey} ~ '^[a-z0-9_]{2,64}$'`,
    ),
  ],
);

export const merchantFeedbackAggregates = pgTable(
  "merchant_feedback_aggregates",
  {
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    normalizedMerchant: text("normalized_merchant").notNull(),
    canonicalCategoryKey: text("canonical_category_key").notNull(),
    uniqueUsers: integer("unique_users").default(0).notNull(),
    totalConfirmations: integer("total_confirmations").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("merchant_feedback_aggregates_pk").on(
      table.countryCode,
      table.normalizedMerchant,
      table.canonicalCategoryKey,
    ),
  ],
);
