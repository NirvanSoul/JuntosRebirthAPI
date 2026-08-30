CREATE TYPE "public"."push_platform" AS ENUM('ios', 'android');
--> statement-breakpoint
CREATE TABLE "user_push_tokens" (
  "expo_push_token" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "platform" "push_platform" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_push_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade,
  CONSTRAINT "user_push_tokens_expo_format" CHECK ("expo_push_token" ~ '^Expo(nent)?PushToken\[[^\]]+\]$')
);
--> statement-breakpoint
CREATE INDEX "user_push_tokens_user_idx" ON "user_push_tokens" ("user_id");
