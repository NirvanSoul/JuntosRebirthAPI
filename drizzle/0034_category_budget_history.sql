-- Tramos anteriores del presupuesto cuando su periodicidad cambia desde un
-- periodo concreto: `[{ "endsOn": "YYYY-MM-DD", "budgetAmountMinor": "123",
-- "period": "month", "intervalDays": null, "anchorOn": null }]`.
ALTER TABLE "category_budgets"
  ADD COLUMN "history" jsonb DEFAULT '[]'::jsonb NOT NULL;
