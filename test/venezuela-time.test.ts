import { describe, expect, it } from "vitest";
import {
  addDaysToDateString,
  isWithinVenezuelaPublishWindow,
  veDateString,
  veMidnightUtc,
} from "../src/lib/venezuela-time";

describe("veDateString", () => {
  it("stays on the same VE day right before midnight VE (03:59 UTC)", () => {
    expect(veDateString(new Date("2026-09-12T03:59:00.000Z"))).toBe("2026-09-11");
  });

  it("rolls over to the next VE day exactly at 04:00 UTC (00:00 VE)", () => {
    expect(veDateString(new Date("2026-09-12T04:00:00.000Z"))).toBe("2026-09-12");
  });
});

describe("veMidnightUtc / addDaysToDateString round-trip", () => {
  it("maps a VE calendar date to 04:00 UTC", () => {
    expect(veMidnightUtc("2026-09-12").toISOString()).toBe("2026-09-12T04:00:00.000Z");
  });

  it("advances across a month boundary", () => {
    expect(addDaysToDateString("2026-09-30", 1)).toBe("2026-10-01");
  });
});

describe("isWithinVenezuelaPublishWindow", () => {
  it("is false just before 3:00pm VE (18:59 UTC)", () => {
    expect(isWithinVenezuelaPublishWindow(new Date("2026-09-11T18:59:00.000Z"))).toBe(false);
  });

  it("is true exactly at 3:00pm VE (19:00 UTC)", () => {
    expect(isWithinVenezuelaPublishWindow(new Date("2026-09-11T19:00:00.000Z"))).toBe(true);
  });

  it("is true exactly at 8:30pm VE (00:30 UTC next day)", () => {
    expect(isWithinVenezuelaPublishWindow(new Date("2026-09-12T00:30:00.000Z"))).toBe(true);
  });

  it("is false right after 8:30pm VE (00:31 UTC next day)", () => {
    expect(isWithinVenezuelaPublishWindow(new Date("2026-09-12T00:31:00.000Z"))).toBe(false);
  });
});
