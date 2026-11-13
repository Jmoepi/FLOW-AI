import { describe, expect, it } from "vitest";
import { DbError, mapDbError } from "../src/errors";
import { moneyIn, moneyOut, moneyOutOrNull, uuid } from "../src/db";

describe("money mapping (G-4)", () => {
  it("normalises numeric strings from pg to canonical money strings", () => {
    expect(moneyOut("1.200000")).toBe("1.2");
    expect(moneyOut("120.000000")).toBe("120");
    expect(moneyOut("0.000001")).toBe("0.000001");
    expect(moneyOutOrNull(null)).toBeNull();
  });
  it("rejects non-strings, negatives, NaN and Infinity coming out of the database", () => {
    for (const bad of [1.2, -1, "NaN", "-0.5", "Infinity", undefined, null]) {
      expect(() => moneyOut(bad)).toThrow(DbError);
    }
  });
  it("rejects bad money going in", () => {
    for (const bad of [1.2, "-1", "1.0000001", "1e5", "NaN", " 1", "01", "", "1,5", "0"]) {
      expect(() => moneyIn(bad)).toThrow(DbError);
    }
    expect(moneyIn("0", true)).toBe("0");
    expect(moneyIn("1.2")).toBe("1.2");
  });
});

describe("identifier validation (IN-1)", () => {
  it("accepts UUIDs and lower-cases them", () => {
    expect(uuid("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11")).toBe("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
  });
  it("rejects injection strings and non-strings before any query", () => {
    for (const bad of ["1; DROP TABLE payments", "' OR '1'='1", "", "abc", 42, null, undefined, { id: 1 }, ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"]]) {
      expect(() => uuid(bad)).toThrow(DbError);
    }
  });
});

describe("mapDbError", () => {
  it("maps SQLSTATEs to stable codes without leaking driver text", () => {
    const secretish = "SELECT secret FROM t WHERE pw = 'x'";
    const cases: [string, string][] = [
      ["23505", "UNIQUE_VIOLATION"], ["23514", "CHECK_VIOLATION"], ["23503", "FOREIGN_KEY_VIOLATION"],
      ["55000", "STATE_VIOLATION"], ["42501", "PERMISSION_DENIED"], ["40001", "RETRYABLE"], ["40P01", "RETRYABLE"], ["XX000", "DB_ERROR"],
    ];
    for (const [code, expected] of cases) {
      const e = mapDbError(Object.assign(new Error(secretish), { code, constraint: "some_constraint" }));
      expect(e.code).toBe(expected);
      expect(e.message).not.toContain("secret");
      expect(JSON.stringify(e)).not.toContain("SELECT");
    }
  });
  it("maps non-driver errors to DB_ERROR", () => {
    expect(mapDbError(new Error("boom")).code).toBe("DB_ERROR");
    expect(mapDbError("string").code).toBe("DB_ERROR");
  });
});
