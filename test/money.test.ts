import { describe, expect, it } from "vitest";
import { parseMinorAmount, serializeMinorAmount } from "../src/lib/money";

describe("minor amount utility", () => {
  it("converts integer strings to bigint without Number", () => {
    expect(parseMinorAmount("9007199254740993")).toBe(9007199254740993n);
  });

  it.each(["12.50", "1e3", "", 125000, null])(
    "rejects non-integer JSON value %j",
    (value) => {
      expect(parseMinorAmount(value)).toBeNull();
    },
  );

  it("serializes bigint values as integer strings", () => {
    expect(serializeMinorAmount(-35000n)).toBe("-35000");
  });
});
