CREATE TABLE "transaction_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"source_installation_id" text NOT NULL,
	"source_local_id" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_aliases" ADD CONSTRAINT "transaction_aliases_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transaction_aliases" ADD CONSTRAINT "transaction_aliases_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_aliases_source_local_idx" ON "transaction_aliases" ("space_id","source_installation_id","source_local_id");
--> statement-breakpoint
CREATE INDEX "transaction_aliases_transaction_idx" ON "transaction_aliases" ("transaction_id");
