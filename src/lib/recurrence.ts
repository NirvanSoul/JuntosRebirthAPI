export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((x) => x.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function occurrenceDate(
  startsOn: string,
  frequency: "weekly" | "biweekly" | "monthly",
  n: number,
): string {
  const [year, month, day] = startsOn.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  if (frequency === "weekly" || frequency === "biweekly")
    date.setUTCDate(day + n * (frequency === "weekly" ? 7 : 14));
  else {
    date.setUTCMonth(month - 1 + n);
    date.setUTCDate(
      Math.min(
        day,
        new Date(
          Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
        ).getUTCDate(),
      ),
    );
  }
  return date.toISOString().slice(0, 10);
}
