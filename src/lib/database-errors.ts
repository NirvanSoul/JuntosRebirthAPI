import type { Context } from "hono";
import { errorResponse } from "./http";

type DatabaseError = {
  code?: unknown;
  message?: unknown;
};

/**
 * A worker nuevo contra una base aún no migrada suele informar 42P01 (tabla
 * ausente) o 42703 (columna ausente). No exponemos el detalle de PostgreSQL al
 * cliente, pero sí damos una señal recuperable para que no reintente en bucle.
 */
export function isDatabaseSchemaOutdated(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as DatabaseError;
  if (code === "42P01" || code === "42703") return true;
  return typeof message === "string" && /(?:relation|column) .+ does not exist/i.test(message);
}

export function databaseErrorResponse(c: Context, error: unknown): Response {
  if (!isDatabaseSchemaOutdated(error)) return errorResponse(c, "INTERNAL_SERVER_ERROR");

  const response = errorResponse(c, "DATABASE_SCHEMA_OUTDATED");
  // Indica una espera corta y permite al cliente detener su ráfaga de sync.
  response.headers.set("Retry-After", "60");
  return response;
}
