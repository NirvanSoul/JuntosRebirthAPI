/**
 * `23505` es `unique_violation` en PostgreSQL. Lo usamos para traducir un
 * choque de índice único en un error de negocio en vez de un 500 opaco.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code !== "23505") return false;
  if (!constraint) return true;
  if (candidate.constraint === constraint) return true;
  return typeof candidate.message === "string" && candidate.message.includes(constraint);
}

/** Detecta una guarda `CHECK` o trigger de dominio identificada por constraint. */
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code !== "23514") return false;
  if (!constraint) return true;
  if (candidate.constraint === constraint) return true;
  return typeof candidate.message === "string" && candidate.message.includes(constraint);
}

/**
 * Errores de PostgreSQL provocados por valores o relaciones del lote recibido.
 * No son caídas del servidor: el cliente debe poder detener el reintento y
 * corregir/restaurar sus datos locales sin recibir un 500 opaco.
 */
export function isDataViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (
      code === "22001" || // string_data_right_truncation
      code === "22003" || // numeric_value_out_of_range
      code === "22P02" || // invalid_text_representation
      code === "23502" || // not_null_violation
      code === "23503" || // foreign_key_violation
      code === "23514"   // check_violation
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
