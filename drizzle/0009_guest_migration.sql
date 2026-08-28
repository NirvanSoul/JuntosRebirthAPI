CREATE TYPE "public"."guest_migration_status" AS ENUM('processing', 'completed', 'failed');
--> statement-breakpoint
CREATE TABLE "guest_migration_batches" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "batch_id" text NOT NULL,
  "status" "guest_migration_status" NOT NULL,
  "payload_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "guest_migration_batches_user_installation_batch_unique" UNIQUE("user_id","installation_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "guest_entity_links" (
  "user_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "entity_type" text NOT NULL,
  "local_id" text NOT NULL,
  "remote_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY("user_id","installation_id","entity_type","local_id")
);
--> statement-breakpoint
ALTER TABLE "guest_migration_batches" ADD CONSTRAINT "guest_migration_batches_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "guest_entity_links_remote_idx" ON "guest_entity_links" USING btree ("remote_id");
