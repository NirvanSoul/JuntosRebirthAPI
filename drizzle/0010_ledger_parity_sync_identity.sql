CREATE TYPE "public"."transaction_recurrence" AS ENUM('once', 'weekly', 'biweekly', 'monthly', 'custom');
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "note" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recurrence" "transaction_recurrence" DEFAULT 'once' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recurrence_group_id" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_local_transaction_id" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_installation_id" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_local_id" text;
--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "source_installation_id" text;
--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "source_local_id" text;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "source_installation_id" text;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "source_local_id" text;
--> statement-breakpoint
ALTER TABLE "money_accounts" ADD COLUMN "source_installation_id" text;
--> statement-breakpoint
ALTER TABLE "money_accounts" ADD COLUMN "source_local_id" text;
--> statement-breakpoint
ALTER TABLE "recurring_transaction_series" ADD COLUMN "source_installation_id" text;
--> statement-breakpoint
ALTER TABLE "recurring_transaction_series" ADD COLUMN "source_local_id" text;
--> statement-breakpoint
ALTER TABLE "spaces" ALTER COLUMN "activated_at" DROP DEFAULT;
--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_source_local_idx" ON "spaces" ("created_by","source_installation_id","source_local_id") WHERE "spaces"."source_local_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_one_active_couple_per_creator_idx" ON "spaces" ("created_by") WHERE "spaces"."type" = 'couple' AND "spaces"."archived_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "categories_source_local_idx" ON "categories" ("space_id","source_installation_id","source_local_id") WHERE "categories"."source_local_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "money_accounts_source_local_idx" ON "money_accounts" ("space_id","source_installation_id","source_local_id") WHERE "money_accounts"."source_local_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_transaction_series_source_local_idx" ON "recurring_transaction_series" ("space_id","source_installation_id","source_local_id") WHERE "recurring_transaction_series"."source_local_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_source_local_idx" ON "transactions" ("space_id","source_installation_id","source_local_id") WHERE "transactions"."source_local_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "transactions_recurrence_group_idx" ON "transactions" ("space_id","recurrence_group_id") WHERE "transactions"."recurrence_group_id" IS NOT NULL;
