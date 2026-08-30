CREATE TYPE "public"."import_source_type" AS ENUM('xls', 'xlsx', 'csv', 'tsv');
--> statement-breakpoint
CREATE TYPE "public"."import_batch_status" AS ENUM('parsing', 'mapping_required', 'needs_review', 'ready', 'imported', 'failed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."import_movement_type" AS ENUM('expense', 'income', 'unknown');
--> statement-breakpoint
CREATE TYPE "public"."import_duplicate_status" AS ENUM('none', 'exact', 'probable');
--> statement-breakpoint
CREATE TYPE "public"."import_item_status" AS ENUM('pending', 'ready', 'ignored', 'duplicate', 'imported', 'error');
--> statement-breakpoint
CREATE TYPE "public"."merchant_rule_source" AS ENUM('manual', 'import_correction', 'system');
--> statement-breakpoint
CREATE TABLE "import_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE cascade,
  "space_id" uuid NOT NULL REFERENCES "public"."spaces"("id") ON DELETE cascade,
  "source_type" "import_source_type" NOT NULL,
  "source_profile" text,
  "file_hash" text,
  "status" "import_batch_status" NOT NULL,
  "total_items" integer DEFAULT 0 NOT NULL,
  "review_items" integer DEFAULT 0 NOT NULL,
  "duplicate_items" integer DEFAULT 0 NOT NULL,
  "source_installation_id" text,
  "source_local_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "import_batches_user_status_idx" ON "import_batches" ("user_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_source_local_idx" ON "import_batches" ("user_id","source_installation_id","source_local_id") WHERE "import_batches"."source_local_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "import_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "public"."import_batches"("id") ON DELETE cascade,
  "source_row" integer NOT NULL,
  "sheet_name" text,
  "raw_description" text NOT NULL,
  "normalized_merchant" text NOT NULL,
  "occurred_on" date,
  "amount_minor" bigint,
  "currency" varchar(3),
  "movement_type" "import_movement_type" NOT NULL,
  "final_category_id" uuid REFERENCES "public"."categories"("id") ON DELETE set null,
  "duplicate_status" "import_duplicate_status" DEFAULT 'none' NOT NULL,
  "duplicate_transaction_id" uuid REFERENCES "public"."transactions"("id") ON DELETE set null,
  "item_status" "import_item_status" NOT NULL,
  "is_selected" boolean DEFAULT true NOT NULL,
  "created_transaction_id" uuid REFERENCES "public"."transactions"("id") ON DELETE set null,
  "issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source_installation_id" text,
  "source_local_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "import_items_source_row_positive" CHECK ("source_row" > 0)
);
--> statement-breakpoint
CREATE INDEX "import_items_batch_idx" ON "import_items" ("batch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "import_items_source_local_idx" ON "import_items" ("batch_id","source_installation_id","source_local_id") WHERE "import_items"."source_local_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "user_merchant_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE cascade,
  "space_id" uuid NOT NULL REFERENCES "public"."spaces"("id") ON DELETE cascade,
  "normalized_merchant" text NOT NULL,
  "category_id" uuid NOT NULL REFERENCES "public"."categories"("id") ON DELETE cascade,
  "confirmations" integer DEFAULT 1 NOT NULL,
  "source" "merchant_rule_source" NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_merchant_rules_confirmations_positive" CHECK ("confirmations" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_merchant_rules_unique_idx" ON "user_merchant_rules" ("user_id","space_id","normalized_merchant");
--> statement-breakpoint
CREATE TABLE "merchant_feedback_votes" (
  "user_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE cascade,
  "country_code" varchar(2) NOT NULL,
  "normalized_merchant" text NOT NULL,
  "canonical_category_key" text NOT NULL,
  "confirmations" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "merchant_feedback_votes_key_format" CHECK ("canonical_category_key" ~ '^[a-z0-9_]{2,64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_feedback_votes_pk" ON "merchant_feedback_votes" ("user_id","country_code","normalized_merchant");
--> statement-breakpoint
CREATE TABLE "merchant_feedback_aggregates" (
  "country_code" varchar(2) NOT NULL,
  "normalized_merchant" text NOT NULL,
  "canonical_category_key" text NOT NULL,
  "unique_users" integer DEFAULT 0 NOT NULL,
  "total_confirmations" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_feedback_aggregates_pk" ON "merchant_feedback_aggregates" ("country_code","normalized_merchant","canonical_category_key");
