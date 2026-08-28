export type Bindings = {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Backend-only Resend credential; configure as a Worker secret in production. */
  RESEND_API_KEY?: string;
  /** Set only for local/development Workers to enable Expo's exp:// origins. */
  ENVIRONMENT?: "development" | "production";
};
