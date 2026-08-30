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
