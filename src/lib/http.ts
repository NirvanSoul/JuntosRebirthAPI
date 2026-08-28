import type { Context } from "hono";

export function errorResponse(
  c: Context,
  status: 400 | 401 | 404 | 409 | 500,
  code: "INVALID_REQUEST" | "UNAUTHORIZED" | "SPACE_NOT_FOUND" | "CATEGORY_NOT_FOUND" | "MONEY_ACCOUNT_NOT_FOUND" | "TRANSACTION_NOT_FOUND" | "RECURRING_SERIES_NOT_FOUND" | "RECURRING_OCCURRENCE_NOT_FOUND" | "BALANCE_IN_USE" | "INTERNAL_ERROR",
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}
