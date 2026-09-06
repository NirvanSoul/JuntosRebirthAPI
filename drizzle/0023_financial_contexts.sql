CREATE TABLE "financial_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"canonical_currency" varchar(3) NOT NULL,
	"personal_space_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "financial_contexts" ADD CONSTRAINT "financial_contexts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "financial_contexts" ADD CONSTRAINT "financial_contexts_personal_space_id_spaces_id_fk" FOREIGN KEY ("personal_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Cada perfil existente conserva su espacio personal como el contexto activo.
-- ZZ representa el estado previo a escoger país y evita duplicar NULL en una
-- clave única; en el primer cambio real se crea el contexto del país elegido.
INSERT INTO "financial_contexts" ("user_id", "country_code", "canonical_currency", "personal_space_id")
SELECT p."user_id", COALESCE(p."country_code", 'ZZ'), p."default_currency", p."personal_space_id"
FROM "user_profiles" p
JOIN "spaces" s ON s."id" = p."personal_space_id"
WHERE p."personal_space_id" IS NOT NULL
ON CONFLICT ("user_id", "country_code") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "active_financial_context_id" uuid;
--> statement-breakpoint
UPDATE "user_profiles" p
SET "active_financial_context_id" = fc."id"
FROM "financial_contexts" fc
WHERE fc."user_id" = p."user_id" AND fc."personal_space_id" = p."personal_space_id";
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_active_financial_context_id_financial_contexts_id_fk" FOREIGN KEY ("active_financial_context_id") REFERENCES "public"."financial_contexts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "financial_contexts_user_country_idx" ON "financial_contexts" USING btree ("user_id", "country_code");
--> statement-breakpoint
CREATE UNIQUE INDEX "financial_contexts_personal_space_idx" ON "financial_contexts" USING btree ("personal_space_id");
--> statement-breakpoint
CREATE INDEX "financial_contexts_user_idx" ON "financial_contexts" USING btree ("user_id");
