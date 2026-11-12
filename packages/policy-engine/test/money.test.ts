import { describe, expect, it } from "vitest";
import { Dec, parseMoney } from "../src";

describe("amount parser", () => {
  it("accepts canonical decimals, including 6 decimal places", () => {
    for (const v of ["1", "0.000001", "120.00", "27.5", "999999999999.999999", "0"]) {
      expect(parseMoney(v, true)).not.toBeNull();
    }
  });
  it("rejects zero when zero is not allowed", () => {
    expect(parseMoney("0", false)).toBeNull();
    expect(parseMoney("0.000000", false)).toBeNull();
  });
  it.each([
    "-1", "-0.01", "+1", "", " 1", "1 ", "1e3", "1E-2", "NaN", "Infinity", "-Infinity", "0x10", "1,000", ".5", "5.", "01",
    "0.0000001", "1.2345678", "1000000000000", "١٢٣", "1_000",
  ])("rejects %j", (v) => {
    expect(parseMoney(v, true)).toBeNull();
  });
  it.each([NaN, Infinity, -1, 0, 1.5, 120, null, undefined, {}, [], true, 10n])("rejects non-string %o (no JS numbers in money)", (v) => {
    expect(parseMoney(v, true)).toBeNull();
  });
  it("is exact where floats are not (0.1 + 0.2)", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(new Dec("0.1").plus(new Dec("0.2")).eq(new Dec("0.3"))).toBe(true);
    expect(new Dec("0.000001").plus(new Dec("0.000002")).toFixed()).toBe("0.000003");
    expect(new Dec("999999999999.999999").plus(new Dec("0.000001")).toFixed()).toBe("1000000000000");
  });
});
