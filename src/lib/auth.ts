import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins/email-otp";
import { expo } from "@better-auth/expo";
import { createDb } from "../db/client";
import * as schema from "../db/schema";
import {
  sendPasswordResetOtp,
  sendSignInOtp,
  sendVerificationOtp,
} from "../services/email";
import {
  clearFailedAttempts,
  lockedUntil,
  normalizeEmail,
  registerFailedAttempt,
} from "../services/login-attempts";
import {
  consumeOtpRequestLimit,
  OTP_REQUEST_LIMIT,
  OTP_REQUEST_WINDOW_SECONDS,
} from "../services/otp-request-limits";
import type { Bindings } from "../types/env";

const SIGN_IN_EMAIL_PATH = "/sign-in/email";
const OTP_REQUEST_PATHS = new Set([
  "/sign-up/email",
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
]);

/**
 * Better Auth se configura una vez por isolate. Construirlo por request
 * significaba rehacer el adaptador Drizzle y la tabla de rutas en cada
 * llamada autenticada, que son todas menos `/health` y `/v1/rates`.
 */
const cache = new Map<string, Auth>();

export function createAuth(env: Bindings): Auth {
  const key = `${env.DATABASE_URL}|${env.BETTER_AUTH_URL}|${env.ENVIRONMENT ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const auth = buildAuth(env);
  if (cache.size >= 4) cache.clear();
  cache.set(key, auth);
  return auth;
}

function buildAuth(env: Bindings) {
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
    ...(env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : []),
    "https://api.aoraestudio.com",
    "https://juntosapi.aora-estudio-o.workers.dev",
    "juntoss://",
    "juntoss://*",
    ...(isDevelopment ? ["exp://", "exp://**"] : []),
  ].filter((v, i, a) => a.indexOf(v) === i);

  const emailConfig = {
    apiKey: env.RESEND_API_KEY,
    from: env.RESEND_FROM,
    appUrl: env.APP_URL,
  };

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: schema,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins,
    user: {
      additionalFields: {
        // El registro envía el nombre elegido en la app; el perfil de Juntoss
        // lo recoge después en `POST /v1/bootstrap`.
        displayName: { type: "string", required: false, input: true },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // El código de un solo uso sustituye al enlace de restablecimiento: la
      // app es nativa y sus pantallas piden un código de 6 dígitos.
      requireEmailVerification: true,
    },
    emailVerification: {
      // El registro no crea sesión mientras el correo no esté confirmado.
      // Tras un OTP válido sí se debe emitir una nueva sesión para que la app
      // nativa pueda continuar directamente con bootstrap.
      autoSignInAfterVerification: true,
    },
    // En Workers, la memoria pertenece a cada isolate. PostgreSQL mantiene el
    // contador entre instancias y evita que se pueda eludir rotando isolate.
    rateLimit: {
      storage: "database",
    },
    plugins: [
      expo(),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        // La tabla `verification` forma parte de PostgreSQL: nunca debe
        // contener un código reutilizable en claro.
        storeOTP: "hashed",
        // Complementa el límite por correo de abajo con una barrera por IP.
        rateLimit: {
          max: OTP_REQUEST_LIMIT,
          window: OTP_REQUEST_WINDOW_SECONDS,
        },
        sendVerificationOnSignUp: true,
        async sendVerificationOTP({ email, otp, type }) {
          if (type === "forget-password") {
            await sendPasswordResetOtp(emailConfig, { to: email, otp });
            return;
          }
          if (type === "sign-in") {
            await sendSignInOtp(emailConfig, { to: email, otp });
            return;
          }
          await sendVerificationOtp(emailConfig, { to: email, otp });
        },
      }),
    ],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (OTP_REQUEST_PATHS.has(ctx.path)) {
          const email = normalizeEmail(ctx.body?.email);
          if (email) {
            const allowed = await consumeOtpRequestLimit(db, email);
            if (!allowed) {
              throw new APIError("TOO_MANY_REQUESTS", {
                code: "TOO_MANY_ATTEMPTS",
                message: "Too many verification code requests. Try again later.",
              });
            }
          }
        }

        if (ctx.path !== SIGN_IN_EMAIL_PATH) return;
        const email = normalizeEmail(ctx.body?.email);
        if (!email) return;

        // Si la contabilidad del bloqueo falla, se deja pasar: un error de
        // infraestructura no puede dejar a nadie fuera de su cuenta.
        let until: Date | null = null;
        try {
          until = await lockedUntil(db, email);
        } catch (error) {
          console.error("Lockout check failed:", error);
          return;
        }

        if (until) {
          throw new APIError("TOO_MANY_REQUESTS", {
            code: "ACCOUNT_LOCKED",
            message: "Too many failed attempts. Try again later.",
            lockedUntil: until.toISOString(),
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_EMAIL_PATH) return;
        const email = normalizeEmail(ctx.body?.email);
        if (!email) return;

        const failed = ctx.context.returned instanceof APIError;
        try {
          await (failed
            ? registerFailedAttempt(db, email)
            : clearFailedAttempts(db, email));
        } catch (error) {
          console.error("Lockout bookkeeping failed:", error);
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof buildAuth>;
