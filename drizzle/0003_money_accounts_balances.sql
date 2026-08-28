CREATE TYPE "public"."money_account_kind" AS ENUM('cash', 'bank', 'card');--> statement-breakpoint
CREATE TABLE "money_account_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"money_account_id" uuid NOT NULL,
	"currency" varchar(3) NOT NULL,
	"opening_balance_minor" bigint DEFAULT 0 NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "money_account_balances_display_order_nonnegative" CHECK ("money_account_balances"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "money_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "money_account_kind" NOT NULL,
	"icon" text,
	"color_token" text,
	"primary_currency" varchar(3) NOT NULL,
	"created_by" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "money_account_balances" ADD CONSTRAINT "money_account_balances_money_account_id_money_accounts_id_fk" FOREIGN KEY ("money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "money_account_balances_account_currency_idx" ON "money_account_balances" USING btree ("money_account_id","currency");--> statement-breakpoint
CREATE INDEX "money_accounts_spaceId_idx" ON "money_accounts" USING btree ("space_id");