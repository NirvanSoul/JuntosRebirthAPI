export type Bindings = {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Backend-only Resend credential; configure as a Worker secret in production. */
  RESEND_API_KEY?: string;
  /** Verified sender, e.g. `Juntoss <hola@juntoss.app>`. Falls back to Resend's sandbox. */
  RESEND_FROM?: string;
  /** Deep-link base used in emails, e.g. `juntoss://`. */
  APP_URL?: string;
  /** R2 bucket backing user avatars; replaces the Supabase `avatars` bucket. */
  AVATARS?: R2Bucket;
  /** Set only for local/development Workers to widen the browser CORS allowlist. */
  ENVIRONMENT?: "development" | "production";
};
