CREATE TYPE "public"."recurring_transaction_frequency" AS ENUM('weekly', 'biweekly', 'monthly', 'custom');--> statement-breakpoint
CREATE TYPE "public"."recurring_transaction_occurrence_status" AS ENUM('pending', 'generated', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('expense', 'income');--> statement-breakpoint
CREATE TABLE "exchange_rate_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"rate_source" text NOT NULL,
	"reference_asset" varchar(8) NOT NULL,
	"quote_currency" varchar(3) NOT NULL,
	"rate" numeric(24, 10) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rate_snapshots_rate_positive" CHECK ("exchange_rate_snapshots"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "recurring_transaction_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"scheduled_on" date NOT NULL,
	"status" "recurring_transaction_occurrence_status" DEFAULT 'pending' NOT NULL,
	"generated_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_transaction_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"money_account_id" uuid,
	"created_by" text,
	"type" "transaction_type" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"title" text NOT NULL,
	"frequency" "recurring_transaction_frequency" NOT NULL,
	"starts_on" date NOT NULL,
	"next_occurrence_on" date,
	"generated_occurrences" integer DEFAULT 0 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_transaction_series_amount_minor_positive" CHECK ("recurring_transaction_series"."amount_minor" > 0),
	CONSTRAINT "recurring_transaction_series_generated_occurrences_nonnegative" CHECK ("recurring_transaction_series"."generated_occurrences" >= 0),
	CONSTRAINT "recurring_transaction_series_next_occurrence_required" CHECK ("recurring_transaction_series"."is_archived" OR "recurring_transaction_series"."frequency" = 'custom' OR "recurring_transaction_series"."next_occurrence_on" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "transaction_reference_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"display_currency" varchar(3) NOT NULL,
	"rate_source" text NOT NULL,
	"reference_asset" varchar(8) NOT NULL,
	"rate" numeric(24, 10) NOT NULL,
	"converted_amount_minor" bigint NOT NULL,
	"rate_snapshot_id" uuid,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_reference_rates_rate_positive" CHECK ("transaction_reference_rates"."rate" > 0),
	CONSTRAINT "transaction_reference_rates_converted_amount_nonnegative" CHECK ("transaction_reference_rates"."converted_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"money_account_id" uuid,
	"created_by" text,
	"type" "transaction_type" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"title" text NOT NULL,
	"occurred_on" date NOT NULL,
	"recurrence_series_id" uuid,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_amount_minor_positive" CHECK ("transactions"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "recurring_transaction_occurrences" ADD CONSTRAINT "recurring_transaction_occurrences_series_id_recurring_transaction_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."recurring_transaction_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transaction_occurrences" ADD CONSTRAINT "recurring_transaction_occurrences_generated_transaction_id_transactions_id_fk" FOREIGN KEY ("generated_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transaction_series" ADD CONSTRAINT "recurring_transaction_series_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transaction_series" ADD CONSTRAINT "recurring_transaction_series_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transaction_series" ADD CONSTRAINT "recurring_transaction_series_money_account_id_money_accounts_id_fk" FOREIGN KEY ("money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transaction_series" ADD CONSTRAINT "recurring_transaction_series_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_reference_rates" ADD CONSTRAINT "transaction_reference_rates_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_reference_rates" ADD CONSTRAINT "transaction_reference_rates_rate_snapshot_id_exchange_rate_snapshots_id_fk" FOREIGN KEY ("rate_snapshot_id") REFERENCES "public"."exchange_rate_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_money_account_id_money_accounts_id_fk" FOREIGN KEY ("money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurrence_series_id_recurring_transaction_series_id_fk" FOREIGN KEY ("recurrence_series_id") REFERENCES "public"."recurring_transaction_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchange_rate_snapshots_latest_idx" ON "exchange_rate_snapshots" USING btree ("country_code","rate_source","reference_asset","quote_currency","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_transaction_occurrences_series_scheduled_idx" ON "recurring_transaction_occurrences" USING btree ("series_id","scheduled_on");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_transaction_occurrences_generated_transaction_idx" ON "recurring_transaction_occurrences" USING btree ("generated_transaction_id");--> statement-breakpoint
CREATE INDEX "recurring_transaction_occurrences_status_scheduled_idx" ON "recurring_transaction_occurrences" USING btree ("status","scheduled_on");--> statement-breakpoint
CREATE INDEX "recurring_transaction_series_space_active_next_idx" ON "recurring_transaction_series" USING btree ("space_id","is_archived","next_occurrence_on");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_reference_rates_transaction_idx" ON "transaction_reference_rates" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_space_occurred_on_idx" ON "transactions" USING btree ("space_id","occurred_on");--> statement-breakpoint
CREATE INDEX "transactions_category_occurred_on_idx" ON "transactions" USING btree ("category_id","occurred_on");--> statement-breakpoint
CREATE INDEX "transactions_account_currency_occurred_on_idx" ON "transactions" USING btree ("money_account_id","currency","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_series_occurred_on_idx" ON "transactions" USING btree ("recurrence_series_id","occurred_on");