ALTER TABLE "spaces" ADD COLUMN "country_code" varchar(2);
--> statement-breakpoint
UPDATE "spaces" s
SET "country_code" = p."country_code"
FROM "user_profiles" p
WHERE s."type" = 'personal' AND s."created_by" = p."user_id";
