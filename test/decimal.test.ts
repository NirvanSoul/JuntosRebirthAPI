import { describe, expect, it } from "vitest";
import { convertMinorAmount, fromMinorUnits, isPositiveDecimal, toMinorUnits } from "../src/lib/decimal";

describe("convertMinorAmount", () => {
  it("multiplies a bigint minor amount by a decimal rate", () => {
    // 100.00 USD * 50.5000000000 VES/USD = 5050.00 VES
    expect(convertMinorAmount(10000n, "50.5000000000", "multiply")).toBe(505000n);
  });

  it("divides a bigint minor amount by a decimal rate", () => {
    // 5050.00 VES / 50.5000000000 = 100.00 USD
    expect(convertMinorAmount(505000n, "50.5000000000", "divide")).toBe(10000n);
  });

  it("rounds half-up on the boundary", () => {
    // 1.00 / 3 = 0.333... -> minor units stay integral, so this checks the
    // rounding of a division that doesn't land exactly.
    expect(convertMinorAmount(100n, "3", "divide")).toBe(33n);
    expect(convertMinorAmount(100n, "8", "multiply")).toBe(800n);
    expect(convertMinorAmount(5n, "1", "divide")).toBe(5n);
    // 0.5 rounds away from zero, not toward even.
    expect(convertMinorAmount(1n, "2", "divide")).toBe(1n);
  });

  it("never loses precision to floating point on repeating decimals", () => {
    // 10000.00 VES / 791.6667000000 would be lossy in float arithmetic.
    const result = convertMinorAmount(1000000n, "791.6667000000", "divide");
    expect(result).toBe(1263n);
  });
});

describe("toMinorUnits / fromMinorUnits", () => {
  it("round-trips a two-decimal amount", () => {
    expect(toMinorUnits("10000.50")).toBe(1000050n);
    expect(fromMinorUnits(1000050n)).toBe("10000.50");
  });

  it("pads a whole number to minor units", () => {
    expect(toMinorUnits("10000")).toBe(1000000n);
    expect(fromMinorUnits(1000000n)).toBe("10000.00");
  });

  it("rounds a value with more precision than minor units", () => {
    expect(toMinorUnits("10.005")).toBe(1001n);
  });

  it("preserves sign", () => {
    expect(fromMinorUnits(-1050n)).toBe("-10.50");
  });
});

describe("isPositiveDecimal", () => {
  it.each(["54.50", "1", "0.0001"])("accepts %j", (value) => {
    expect(isPositiveDecimal(value)).toBe(true);
  });

  it.each(["0", "-1", "1.2.3", "abc", "", null, 54.5])("rejects %j", (value) => {
    expect(isPositiveDecimal(value)).toBe(false);
  });
});
