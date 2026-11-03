-- El presupuesto de una categoría deja de ser siempre mensual. `period`
-- guarda la periodicidad (`custom` repite cada `interval_days` días desde
-- `anchor_on`) y `overrides` los importes editados para un único periodo,
-- como `[{ "periodStartOn": "YYYY-MM-DD", "budgetAmountMinor": "123" }]`.
-- Las filas existentes quedan mensuales y sin excepciones.
ALTER TABLE "category_budgets"
  ADD COLUMN "period" varchar(16) DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "category_budgets" ADD COLUMN "interval_days" integer;--> statement-breakpoint
ALTER TABLE "category_budgets" ADD COLUMN "anchor_on" date;--> statement-breakpoint
ALTER TABLE "category_budgets"
  ADD COLUMN "overrides" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "category_budgets" ADD CONSTRAINT "category_budgets_period_valid"
  CHECK (
    ("period" IN ('month', 'week', 'fortnight') AND "interval_days" IS NULL AND "anchor_on" IS NULL)
    OR ("period" = 'custom' AND "interval_days" BETWEEN 2 AND 365 AND "anchor_on" IS NOT NULL)
  );
