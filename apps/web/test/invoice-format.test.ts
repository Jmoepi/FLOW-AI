import { describe, expect, it } from "vitest";
import { ageText } from "../src/components/Freshness";
import { BALANCE_STALE_SECONDS } from "../src/components/format";
import { dueInfo, hashNote, shortDate } from "../src/components/invoice-format";
describe("due text", () => {
  it("states overdue, today, soon and later in words", () => {
    expect(dueInfo("2026-01-10", "2026-01-15")).toEqual({ text: "2026-01-10 (overdue by 5 days)", urgent: true });
    expect(dueInfo("2026-01-14", "2026-01-15").text).toContain("overdue by 1 day)");
    expect(dueInfo("2026-01-15", "2026-01-15")).toEqual({ text: "2026-01-15 (due today)", urgent: true });
    expect(dueInfo("2026-01-16", "2026-01-15").text).toContain("due in 1 day)");
    expect(dueInfo("2026-01-18", "2026-01-15").urgent).toBe(true);
    expect(dueInfo("2026-02-18", "2026-01-15")).toEqual({ text: "2026-02-18", urgent: false });
  });
  it("handles month ends, leap days and malformed dates without throwing", () => {
    expect(dueInfo("2028-03-01", "2028-02-28").text).toContain("due in 2 days");
    expect(dueInfo("not a date", "2026-01-15")).toEqual({ text: "not a date", urgent: false });
  });
});
describe("payment display helpers", () => {
  it("never calls an unconfirmed hash paid", () => {
    expect(hashNote("pending_confirmation", true, false)).toMatch(/not yet confirmed/i);
    expect(hashNote("submitted", true, false)).not.toMatch(/\bpaid\b(?!\.)/i);
    expect(hashNote("validated", true, true)).toMatch(/confirmed/i);
    expect(hashNote("blocked", false, false)).toBe("No transaction was sent.");
  });
  it("formats dates in the business time zone and tolerates bad input", () => {
    expect(shortDate("2026-01-15T23:30:00.000Z", "Africa/Johannesburg")).toBe("16 Jan 2026");
    expect(shortDate(null, "UTC")).toBe("Not set");
    expect(shortDate("nope", "UTC")).toBe("Unknown");
    expect(shortDate("2026-01-15T10:00:00.000Z", "Not/AZone")).toBe("15 Jan 2026");
  });
});
describe("balance freshness", () => {
  it("uses a named five minute threshold and relative ages", () => {
    expect(BALANCE_STALE_SECONDS).toBe(300);
    expect(ageText(5)).toBe("less than a minute ago");
    expect(ageText(60)).toBe("1 minute ago");
    expect(ageText(3600 * 5)).toBe("5 hours ago");
    expect(ageText(86_400 * 4)).toBe("4 days ago");
  });
});
