ALTER TABLE "spaces" ADD COLUMN "timezone" varchar(64) DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
DROP INDEX "transactions_series_occurred_on_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_series_occurred_on_idx" ON "transactions" USING btree ("recurrence_series_id", "occurred_on") WHERE "recurrence_series_id" IS NOT NULL;
