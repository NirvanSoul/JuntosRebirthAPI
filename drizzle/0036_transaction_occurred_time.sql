-- Hora de reloj local del movimiento (`HH:mm`, 24 h, sin zona), igual que
-- `occurred_on` es una fecha local. Informativa: no cambia orden ni agrupación.
-- Nula para todo lo existente; ADD COLUMN sin default es solo de metadatos.
ALTER TABLE "transactions" ADD COLUMN "occurred_time" varchar(5);--> statement-breakpoint
-- NOT VALID + VALIDATE: la comprobación de las filas existentes (todas nulas)
-- no bloquea escrituras mientras recorre la tabla.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_occurred_time_format"
  CHECK ("occurred_time" IS NULL OR "occurred_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') NOT VALID;--> statement-breakpoint
ALTER TABLE "transactions" VALIDATE CONSTRAINT "transactions_occurred_time_format";
