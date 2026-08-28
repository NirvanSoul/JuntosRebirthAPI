export type Bindings = {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Set only for local/development Workers to enable Expo's exp:// origins. */
  ENVIRONMENT?: "development" | "production";
};
