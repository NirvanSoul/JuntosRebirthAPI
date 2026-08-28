CREATE TYPE "public"."space_invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');
--> statement-breakpoint
CREATE TABLE "space_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "space_id" uuid NOT NULL,
  "invited_by" text,
  "invited_email" text NOT NULL,
  "invitee_user_id" text,
  "role" "space_member_role" DEFAULT 'member' NOT NULL,
  "token_hash" text NOT NULL,
  "status" "space_invitation_status" DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "space_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_invitee_user_id_user_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "space_invitations_space_status_idx" ON "space_invitations" USING btree ("space_id", "status");
