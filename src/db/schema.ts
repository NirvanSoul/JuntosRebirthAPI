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
  (table) => [index("account_userId_idx").on(table.userId)],
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

export const moneyAccountKindEnum = pgEnum("money_account_kind", [
  "cash",
  "bank",
  "card",
]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "expense",
  "income",
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
export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  avatarPath: text("avatar_path"),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
  locale: text("locale").default("es").notNull(),
  defaultCurrency: text("default_currency").default("EUR").notNull(),
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
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("spaces_createdBy_idx").on(table.createdBy)],
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
  (table) => [index("categories_spaceId_idx").on(table.spaceId)],
);

export const categoryBudgets = pgTable(
  "category_budgets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    currency: varchar("currency", { length: 3 }).notNull(),
    budgetAmountMinor: bigint("budget_amount_minor", { mode: "number" })
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
  (table) => [index("money_accounts_spaceId_idx").on(table.spaceId)],
);

export const moneyAccountBalances = pgTable(
  "money_account_balances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    moneyAccountId: uuid("money_account_id")
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: "cascade" }),
    currency: varchar("currency", { length: 3 }).notNull(),
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "number" })
      .default(0)
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
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    title: text("title").notNull(),
    frequency: recurringTransactionFrequencyEnum("frequency").notNull(),
    startsOn: date("starts_on").notNull(),
    nextOccurrenceOn: date("next_occurrence_on"),
    generatedOccurrences: integer("generated_occurrences").default(0).notNull(),
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
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    title: text("title").notNull(),
    occurredOn: date("occurred_on").notNull(),
    recurrenceSeriesId: uuid("recurrence_series_id").references(
      () => recurringTransactionSeries.id,
    ),
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
    ),
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
    convertedAmountMinor: bigint("converted_amount_minor", { mode: "number" })
      .notNull(),
    rateSnapshotId: uuid("rate_snapshot_id").references(
      () => exchangeRateSnapshots.id,
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
    uniqueIndex("transaction_reference_rates_transaction_idx").on(
      table.transactionId,
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
  }),
);
