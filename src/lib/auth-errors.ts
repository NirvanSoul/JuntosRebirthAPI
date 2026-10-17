import type { Context } from "hono";
import { errorResponse, type ErrorCode } from "./http";

const AUTH_ERROR_CODES: Record<string, ErrorCode> = {
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  // Sin este par, un fallo de credenciales llegaba a la app como
  // `UNAUTHORIZED` genérico y la pantalla no podía decir qué corregir.
  INVALID_EMAIL_OR_PASSWORD: "INVALID_EMAIL_OR_PASSWORD",
  INVALID_PASSWORD: "INVALID_EMAIL_OR_PASSWORD",
  INVALID_OTP: "INVALID_OTP",
  OTP_EXPIRED: "OTP_EXPIRED",
  TOO_MANY_ATTEMPTS: "TOO_MANY_ATTEMPTS",
  TOO_MANY_REQUESTS: "TOO_MANY_ATTEMPTS",
  ACCOUNT_LOCKED: "TOO_MANY_ATTEMPTS",
  USER_ALREADY_EXISTS: "USER_ALREADY_EXISTS",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "USER_ALREADY_EXISTS",
  FAILED_TO_CREATE_USER: "FAILED_TO_CREATE_USER",
};

const SOCIAL_SIGN_IN_PATH = "/sign-in/social";

// `INVALID_TOKEN` también lo emiten los enlaces de verificación y de
// restablecimiento, así que estos códigos solo se aplican a `/sign-in/social`.
const SOCIAL_ERROR_CODES: Record<string, ErrorCode> = {
  INVALID_TOKEN: "INVALID_SOCIAL_TOKEN",
  FAILED_TO_GET_USER_INFO: "SOCIAL_PROFILE_UNAVAILABLE",
  USER_EMAIL_NOT_FOUND: "SOCIAL_PROFILE_UNAVAILABLE",
  // El proveedor no está configurado: es un fallo nuestro, no del usuario.
  PROVIDER_NOT_FOUND: "SOCIAL_SIGN_IN_FAILED",
  ID_TOKEN_NOT_SUPPORTED: "SOCIAL_SIGN_IN_FAILED",
};

// Better Auth agrupa bajo `OAUTH_LINK_ERROR` motivos fijos de
// `handleOAuthUserInfo`. Solo "account not linked" depende del usuario: ya
// existe una cuenta local sin verificar con ese correo y
// `requireLocalEmailVerified` impide enlazarla en silencio.
const LINK_REASONS = new Set([
  "account not linked",
  "unable to link account",
  "unable to update account",
  "unable to create user",
  "unable to create session",
  "signup disabled",
]);

function socialCode(rawCode: string | null, linkReason: string | null): ErrorCode | null {
  if (rawCode === "OAUTH_LINK_ERROR") {
    return linkReason === "account not linked"
      ? "SOCIAL_ACCOUNT_NOT_LINKED"
      : "SOCIAL_SIGN_IN_FAILED";
  }
  return rawCode ? SOCIAL_ERROR_CODES[rawCode] ?? null : null;
}

function readLinkReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const message = (payload as Record<string, unknown>).message;
  return typeof message === "string" && LINK_REASONS.has(message) ? message : "other";
}

/**
 * Better Auth sirve sus propias respuestas y no pasa por `app.onError`.
 * Convertimos solo sus fallos al contrato público de Juntoss; éxitos y
 * redirecciones OAuth se conservan intactos para no romper cookies ni flujos
 * de navegador.
 */
export async function normalizeAuthErrorResponse(
  c: Context,
  response: Response,
): Promise<Response> {
  if (response.ok || response.status >= 300 && response.status < 400) {
    return response;
  }

  const payload = await response.clone().json().catch(() => null) as unknown;
  const rawCode = readCode(payload);
  const social = c.req.path.endsWith(SOCIAL_SIGN_IN_PATH);
  const linkReason = rawCode === "OAUTH_LINK_ERROR" ? readLinkReason(payload) : null;
  const code = (social ? socialCode(rawCode, linkReason) : null)
    ?? (rawCode && AUTH_ERROR_CODES[rawCode]
      ? AUTH_ERROR_CODES[rawCode]
      : fallbackCode(response.status));
  if (social) {
    // Solo constantes de Better Auth: nunca token, correo ni cookie. Basta
    // para separar un SHA-1/audience mal configurado de un fallo de base de
    // datos durante una prueba con un usuario real.
    console.warn(JSON.stringify({
      event: "auth_social_sign_in_failed",
      status: response.status,
      upstreamCode: rawCode,
      linkReason,
      code,
    }));
  }
  // Solo se conserva este metadato de control de flujo. No reenviamos el
  // mensaje ni otros detalles de Better Auth, que podrían exponer información
  // interna; el cliente lo usa para informar cuándo puede reintentarse.
  const lockedUntil = readLockedUntil(payload);
  const normalized = errorResponse(
    c,
    code,
    undefined,
    lockedUntil ? { lockedUntil } : undefined,
  );
  const retryAfter = response.headers.get("retry-after")
    ?? response.headers.get("x-retry-after");
  if (retryAfter) normalized.headers.set("Retry-After", retryAfter);
  return normalized;
}

function readLockedUntil(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const source = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : record;
  if (typeof source.lockedUntil !== "string") return null;
  return Number.isNaN(new Date(source.lockedUntil).getTime())
    ? null
    : source.lockedUntil;
}

function readCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    return typeof error.code === "string" ? error.code : null;
  }
  return null;
}

function fallbackCode(status: number): ErrorCode {
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 429) return "TOO_MANY_ATTEMPTS";
  return "INTERNAL_SERVER_ERROR";
}
