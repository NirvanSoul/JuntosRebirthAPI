import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { createDb } from "../db/client";
import * as schema from "../db/schema";
import type { Bindings } from "../types/env";

export function createAuth(env: Bindings) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to initialize auth");
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      "Google OAuth is misconfigured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required",
    );
  }

  const db = createDb(env.DATABASE_URL);
  // Cloudflare Workers does not provide NODE_ENV automatically. Deployments
  // default to the restrictive production origin set unless explicitly marked
  // as development through the ENVIRONMENT binding.
  const isDevelopment = env.ENVIRONMENT === "development";
  const trustedOrigins = [
    "juntoss://",
    "juntoss://*",
    ...(isDevelopment ? ["exp://", "exp://**"] : []),
  ];

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: schema,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins,
    plugins: [expo()],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
