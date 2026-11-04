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

const clockTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Hora de reloj "HH:mm" (24 h, sin segundos ni zona). */
export function parseClockTime(value: unknown): string | null {
  return typeof value === "string" && clockTimePattern.test(value) ? value : null;
}

/** Días entre dos fechas "YYYY-MM-DD" ya validadas (`to - from`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
