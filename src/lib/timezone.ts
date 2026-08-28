/** Accepts IANA identifiers understood by the Workers Intl implementation. */
export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timeZone = value.trim();
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
