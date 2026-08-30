CREATE TYPE "public"."legal_document_type" AS ENUM('privacy-policy', 'terms-of-service');
--> statement-breakpoint
CREATE TABLE "legal_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "document_type" "legal_document_type" NOT NULL,
  "document_version" text NOT NULL,
  "app_version" text,
  "locale" text,
  "source" text,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legal_acceptances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "legal_acceptances_user_idx" ON "legal_acceptances" ("user_id","document_type");
