-- Reloj del servidor para el cursor de cambios incrementales.
--
-- `updated_at` lo fija el cliente (last-write-wins en /v1/spaces/:id/sync):
-- una fila creada sin conexión hace días y subida hoy conserva su fecha
-- antigua y nunca saldría en un `?since=` reciente. `server_updated_at` lo
-- escribe siempre la base al insertar o actualizar, por cualquier vía.
ALTER TABLE "spaces" ADD COLUMN "server_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "server_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "money_accounts" ADD COLUMN "server_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_transaction_series" ADD COLUMN "server_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "server_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE FUNCTION public.touch_server_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Un UPDATE que fija la columna explícitamente (reparaciones, pruebas)
  -- se respeta; el resto recibe el reloj de la base.
  IF TG_OP = 'INSERT' OR NEW.server_updated_at IS NOT DISTINCT FROM OLD.server_updated_at THEN
    NEW.server_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER spaces_touch_server_updated_at
BEFORE INSERT OR UPDATE ON public.spaces
FOR EACH ROW EXECUTE FUNCTION public.touch_server_updated_at();--> statement-breakpoint
CREATE TRIGGER categories_touch_server_updated_at
BEFORE INSERT OR UPDATE ON public.categories
FOR EACH ROW EXECUTE FUNCTION public.touch_server_updated_at();--> statement-breakpoint
CREATE TRIGGER money_accounts_touch_server_updated_at
BEFORE INSERT OR UPDATE ON public.money_accounts
FOR EACH ROW EXECUTE FUNCTION public.touch_server_updated_at();--> statement-breakpoint
CREATE TRIGGER recurring_transaction_series_touch_server_updated_at
BEFORE INSERT OR UPDATE ON public.recurring_transaction_series
FOR EACH ROW EXECUTE FUNCTION public.touch_server_updated_at();--> statement-breakpoint
CREATE TRIGGER transactions_touch_server_updated_at
BEFORE INSERT OR UPDATE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.touch_server_updated_at();--> statement-breakpoint
CREATE INDEX "categories_space_server_updated_idx" ON "categories" USING btree ("space_id","server_updated_at");--> statement-breakpoint
CREATE INDEX "money_accounts_space_server_updated_idx" ON "money_accounts" USING btree ("space_id","server_updated_at");--> statement-breakpoint
CREATE INDEX "recurring_transaction_series_space_server_updated_idx" ON "recurring_transaction_series" USING btree ("space_id","server_updated_at");--> statement-breakpoint
CREATE INDEX "transactions_space_server_updated_idx" ON "transactions" USING btree ("space_id","server_updated_at");
