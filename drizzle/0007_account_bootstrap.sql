ALTER TABLE "user_profiles" ADD COLUMN "personal_space_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_personal_space_id_spaces_id_fk" FOREIGN KEY ("personal_space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "categories_space_template_key_idx" ON "categories" USING btree ("space_id", "template_key") WHERE "template_key" IS NOT NULL;
