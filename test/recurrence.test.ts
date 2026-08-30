import { describe, expect, it } from "vitest";
import { localDate, occurrenceDate } from "../src/lib/recurrence";

describe("recurrence calendar", () => {
  it("uses the space local date rather than UTC", () => {
    const instant = new Date("2026-09-01T00:30:00.000Z");
    expect(localDate(instant, "Europe/Madrid")).toBe("2026-09-01");
    expect(localDate(instant, "America/Caracas")).toBe("2026-08-31");
  });

  it("anchors weekly and biweekly dates to startsOn", () => {
    expect(occurrenceDate("2026-09-01", "weekly", 2)).toBe("2026-09-15");
    expect(occurrenceDate("2026-09-01", "biweekly", 2)).toBe("2026-09-29");
  });

  it("keeps the monthly anchor through short months", () => {
    expect([0, 1, 2, 3, 4].map(n => occurrenceDate("2026-01-31", "monthly", n))).toEqual([
      "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31",
    ]);
  });

  it("uses February 29 for leap years", () => {
    expect(occurrenceDate("2028-01-31", "monthly", 1)).toBe("2028-02-29");
    expect(occurrenceDate("2028-01-31", "monthly", 2)).toBe("2028-03-31");
  });
});
