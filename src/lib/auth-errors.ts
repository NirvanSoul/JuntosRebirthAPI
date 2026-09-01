import type { Context } from "hono";
import { errorResponse, type ErrorCode } from "./http";

const AUTH_ERROR_CODES: Record<string, ErrorCode> = {
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  INVALID_OTP: "INVALID_OTP",
  OTP_EXPIRED: "OTP_EXPIRED",
  TOO_MANY_ATTEMPTS: "TOO_MANY_ATTEMPTS",
  TOO_MANY_REQUESTS: "TOO_MANY_ATTEMPTS",
  ACCOUNT_LOCKED: "TOO_MANY_ATTEMPTS",
  USER_ALREADY_EXISTS: "USER_ALREADY_EXISTS",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "USER_ALREADY_EXISTS",
  FAILED_TO_CREATE_USER: "FAILED_TO_CREATE_USER",
};

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
  const code = rawCode && AUTH_ERROR_CODES[rawCode]
    ? AUTH_ERROR_CODES[rawCode]
    : fallbackCode(response.status);
  const normalized = errorResponse(c, code);
  const retryAfter = response.headers.get("retry-after")
    ?? response.headers.get("x-retry-after");
  if (retryAfter) normalized.headers.set("Retry-After", retryAfter);
  return normalized;
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
