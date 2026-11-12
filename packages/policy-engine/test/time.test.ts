import { describe, expect, it } from "vitest";
import { businessDate, parseInstant } from "../src";

const JHB = "Africa/Johannesburg";
const ms = (s: string): number => Date.parse(s);

describe("business date window", () => {
  it("rolls over at local midnight (22:00 UTC) in Africa/Johannesburg", () => {
    expect(businessDate(ms("2026-03-10T21:59:59Z"), JHB)).toBe("2026-03-10");
    expect(businessDate(ms("2026-03-10T22:00:00Z"), JHB)).toBe("2026-03-11");
    expect(businessDate(ms("2026-03-10T23:30:00Z"), JHB)).toBe("2026-03-11");
  });
  it("differs from the UTC date around midnight", () => {
    expect(businessDate(ms("2026-03-10T23:30:00Z"), "UTC")).toBe("2026-03-10");
    expect(businessDate(ms("2026-03-10T23:30:00Z"), JHB)).toBe("2026-03-11");
  });
  it("has no DST shift: offset is +2 in both January and July", () => {
    expect(businessDate(ms("2026-01-15T21:59:59Z"), JHB)).toBe("2026-01-15");
    expect(businessDate(ms("2026-01-15T22:00:00Z"), JHB)).toBe("2026-01-16");
    expect(businessDate(ms("2026-07-15T21:59:59Z"), JHB)).toBe("2026-07-15");
    expect(businessDate(ms("2026-07-15T22:00:00Z"), JHB)).toBe("2026-07-16");
  });
  it("handles year and leap-day boundaries", () => {
    expect(businessDate(ms("2025-12-31T22:00:00Z"), JHB)).toBe("2026-01-01");
    expect(businessDate(ms("2028-02-28T22:00:00Z"), JHB)).toBe("2028-02-29");
  });
  it("accepts offsets in the instant", () => {
    expect(businessDate(ms("2026-03-11T00:00:00+02:00"), JHB)).toBe("2026-03-11");
    expect(businessDate(ms("2026-03-10T23:59:59+02:00"), JHB)).toBe("2026-03-10");
  });
  it("throws on an unknown timezone", () => {
    expect(() => businessDate(0, "Mars/Olympus")).toThrow();
  });
  it("parseInstant is strict", () => {
    expect(parseInstant("2026-03-10T08:00:00Z")).not.toBeNull();
    for (const v of ["2026-03-10", "2026-03-10 08:00:00", "2026-02-30T00:00:00Z", "garbage", 123, null, "2026-03-10T08:00:00"]) {
      expect(parseInstant(v)).toBeNull();
    }
  });
});
