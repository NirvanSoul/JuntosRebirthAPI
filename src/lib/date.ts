const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validates a calendar date without interpreting it in the local timezone. */
export function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = datePattern.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day
    ? value
    : null;
}
