CREATE TABLE "custom_exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"name" text NOT NULL,
	"base_currency" varchar(3) NOT NULL,
	"quote_currency" varchar(3) NOT NULL,
	"rate" numeric(24, 10) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_exchange_rates_rate_positive" CHECK ("custom_exchange_rates"."rate" > 0)
);
--> statement-breakpoint
ALTER TABLE "custom_exchange_rates" ADD CONSTRAINT "custom_exchange_rates_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_exchange_rates_user_idx" ON "custom_exchange_rates" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "transaction_reference_rates" ADD COLUMN "custom_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_reference_rates" ADD CONSTRAINT "transaction_reference_rates_custom_rate_id_custom_exchange_rates_id_fk" FOREIGN KEY ("custom_rate_id") REFERENCES "public"."custom_exchange_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP INDEX "transaction_reference_rates_transaction_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_reference_rates_transaction_source_idx" ON "transaction_reference_rates" USING btree ("transaction_id","rate_source");
