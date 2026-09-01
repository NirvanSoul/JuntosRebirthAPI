import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Registro único de códigos de error de la API. El status HTTP se deriva del
 * código, de modo que un mismo código nunca puede viajar con dos status
 * distintos según el router que lo emita.
 *
 * Los códigos son parte del contrato con la app: el cliente los lee en
 * `error.code` para decidir qué copia mostrar. Añadir uno es aditivo;
 * renombrar uno es un cambio incompatible.
 */
const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  // El cliente necesita distinguirlos para decir qué corregir: recomprimir no
  // es lo mismo que elegir otra foto.
  AVATAR_INVALID_FORMAT: 400,
  AVATAR_TOO_LARGE: 400,
  AVATAR_TOO_SMALL: 400,
  BOOTSTRAP_REQUIRED: 400,
  DELETE_CONFIRMATION_REQUIRED: 400,
  DELETE_DATA_CONFIRMATION_REQUIRED: 400,
  UNAUTHORIZED: 401,
  INVALID_EMAIL_OR_PASSWORD: 401,
  EMAIL_NOT_VERIFIED: 403,
  INVALID_OTP: 400,
  OTP_EXPIRED: 400,
  TOO_MANY_ATTEMPTS: 429,
  USER_ALREADY_EXISTS: 409,
  FAILED_TO_CREATE_USER: 500,
  FORBIDDEN: 403,
  MEMBER_ROLE_CHANGE_REJECTED: 403,
  MEMBER_REMOVAL_REJECTED: 403,
  SPACE_NOT_FOUND: 404,
  CATEGORY_NOT_FOUND: 404,
  MONEY_ACCOUNT_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  RECURRING_SERIES_NOT_FOUND: 404,
  RECURRING_OCCURRENCE_NOT_FOUND: 404,
  INVITATION_NOT_FOUND: 404,
  NOT_FOUND: 404,
  PROFILE_NOT_FOUND: 409,
  CATEGORY_IN_USE: 409,
  MONEY_ACCOUNT_IN_USE: 409,
  BALANCE_IN_USE: 409,
  OWNER_MUST_TRANSFER: 409,
  COUPLE_SPACE_LIMIT: 409,
  INVITATION_ALREADY_PENDING: 409,
  INTERNAL_SERVER_ERROR: 500,
  VENEZUELA_RATES_UNAVAILABLE: 502,
} as const satisfies Record<string, ContentfulStatusCode>;

export type ErrorCode = keyof typeof ERROR_STATUS;

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: "Invalid request.",
  AVATAR_INVALID_FORMAT: "Avatar must be a real JPEG file.",
  AVATAR_TOO_LARGE: "Avatar is too large.",
  AVATAR_TOO_SMALL: "Avatar is too small.",
  BOOTSTRAP_REQUIRED: "Run bootstrap first.",
  DELETE_CONFIRMATION_REQUIRED: "Confirm account deletion to continue.",
  DELETE_DATA_CONFIRMATION_REQUIRED: "Confirm data deletion to continue.",
  UNAUTHORIZED: "Unauthorized.",
  INVALID_EMAIL_OR_PASSWORD: "Incorrect email or password.",
  EMAIL_NOT_VERIFIED: "Verify your email address to continue.",
  INVALID_OTP: "Invalid verification code.",
  OTP_EXPIRED: "Verification code has expired.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Try again later.",
  USER_ALREADY_EXISTS: "A user with this email already exists.",
  FAILED_TO_CREATE_USER: "Failed to create user.",
  FORBIDDEN: "Forbidden.",
  MEMBER_ROLE_CHANGE_REJECTED: "Request cannot be completed.",
  MEMBER_REMOVAL_REJECTED: "Request cannot be completed.",
  SPACE_NOT_FOUND: "Space not found.",
  CATEGORY_NOT_FOUND: "Category not found.",
  MONEY_ACCOUNT_NOT_FOUND: "Money account not found.",
  TRANSACTION_NOT_FOUND: "Transaction not found.",
  RECURRING_SERIES_NOT_FOUND: "Recurring series not found.",
  RECURRING_OCCURRENCE_NOT_FOUND: "Recurring occurrence not found.",
  INVITATION_NOT_FOUND: "Invitation not found.",
  NOT_FOUND: "Not found.",
  PROFILE_NOT_FOUND: "Run bootstrap first.",
  CATEGORY_IN_USE: "Category is in use.",
  MONEY_ACCOUNT_IN_USE: "Money account is in use.",
  BALANCE_IN_USE: "Balance is in use.",
  OWNER_MUST_TRANSFER: "Transfer ownership before leaving.",
  COUPLE_SPACE_LIMIT: "You already have an active shared space.",
  INVITATION_ALREADY_PENDING: "There is already a pending invitation for this space.",
  INTERNAL_SERVER_ERROR: "Internal server error.",
  VENEZUELA_RATES_UNAVAILABLE: "Venezuela rates are unavailable",
};

export function errorBody(
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
) {
  return {
    error: {
      code,
      message: message ?? DEFAULT_MESSAGES[code],
      ...details,
    },
  };
}

export function statusForErrorCode(code: ErrorCode): ContentfulStatusCode {
  return ERROR_STATUS[code];
}

export function errorResponse(
  c: Context,
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
) {
  return c.json(
    errorBody(code, message, details),
    ERROR_STATUS[code],
  );
}
