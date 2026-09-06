import type { Context } from "hono";
import { errorResponse } from "./http";

type DatabaseError = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  table?: unknown;
  column?: unknown;
  constraint?: unknown;
};

function databaseErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const code = (current as DatabaseError).code;
    if (typeof code === "string") codes.push(code);
    current = (current as DatabaseError).cause;
  }
  return codes;
}

function databaseErrorIdentifiers(error: unknown): string[] {
  const identifiers: string[] = [];
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const record = current as DatabaseError;
    for (const value of [record.table, record.column, record.constraint]) {
      if (typeof value === "string") identifiers.push(value);
    }
    current = record.cause;
  }
  return identifiers;
}

/**
 * A worker nuevo contra una base aún no migrada suele informar 42P01 (tabla
 * ausente) o 42703 (columna ausente). No exponemos el detalle de PostgreSQL al
 * cliente, pero sí damos una señal recuperable para que no reintente en bucle.
 */
export function isDatabaseSchemaOutdated(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (databaseErrorCodes(error).some((code) => code === "42P01" || code === "42703")) return true;
  const { message } = error as DatabaseError;
  return typeof message === "string" && /(?:relation|column) .+ does not exist/i.test(message);
}

/** Registra solo metadatos operativos: nunca SQL, parámetros, correo ni URL. */
export function logDatabaseFailure(operation: string, error: unknown): void {
  console.error(JSON.stringify({
    operation,
    errorName: error instanceof Error ? error.name : typeof error,
    databaseCodes: databaseErrorCodes(error),
    databaseIdentifiers: databaseErrorIdentifiers(error),
    schemaOutdated: isDatabaseSchemaOutdated(error),
  }));
}

export function databaseErrorResponse(c: Context, error: unknown): Response {
  if (!isDatabaseSchemaOutdated(error)) return errorResponse(c, "INTERNAL_SERVER_ERROR");

  const response = errorResponse(c, "DATABASE_SCHEMA_OUTDATED");
  // Indica una espera corta y permite al cliente detener su ráfaga de sync.
  response.headers.set("Retry-After", "60");
  return response;
}
