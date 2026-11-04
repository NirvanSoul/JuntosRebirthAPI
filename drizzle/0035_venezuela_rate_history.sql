-- Espejo local de `daily_rates` (Supabase de Kuanto) y lecturas USDT
-- intradía. Ver `venezuelaDailyRates` / `venezuelaUsdtReadings` en el esquema.
CREATE TABLE "venezuela_daily_rates" (
  "rate_date" date PRIMARY KEY NOT NULL,
  "bcv_usd" numeric(24, 10),
  "bcv_eur" numeric(24, 10),
  "usdt_last" numeric(24, 10),
  "usdt_daily_average" numeric(24, 10),
  "usdt_sources" jsonb,
  "bcv_published_at" timestamp with time zone,
  "usdt_observed_at" timestamp with time zone,
  "source_updated_at" timestamp with time zone NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venezuela_daily_rates_bcv_usd_positive" CHECK ("bcv_usd" IS NULL OR "bcv_usd" > 0),
  CONSTRAINT "venezuela_daily_rates_bcv_eur_positive" CHECK ("bcv_eur" IS NULL OR "bcv_eur" > 0),
  CONSTRAINT "venezuela_daily_rates_usdt_last_positive" CHECK ("usdt_last" IS NULL OR "usdt_last" > 0),
  CONSTRAINT "venezuela_daily_rates_usdt_daily_average_positive" CHECK ("usdt_daily_average" IS NULL OR "usdt_daily_average" > 0)
);
--> statement-breakpoint
CREATE INDEX "venezuela_daily_rates_source_updated_idx" ON "venezuela_daily_rates" ("source_updated_at");
--> statement-breakpoint
CREATE TABLE "venezuela_usdt_readings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "rate" numeric(24, 10) NOT NULL,
  "sources" jsonb,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "venezuela_usdt_readings_rate_positive" CHECK ("rate" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "venezuela_usdt_readings_observed_at_idx" ON "venezuela_usdt_readings" ("observed_at");
