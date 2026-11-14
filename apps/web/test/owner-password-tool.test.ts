import { describe, expect, it } from "vitest";
import { assertLocalHost, isLoopbackHost, parseEnvFile, parseResetArgs } from "../../../scripts/lib/owner-password";

describe("parseEnvFile", () => {
  it("parses LF and CRLF identically, with no trailing CR in values", () => {
    const lf = parseEnvFile("A_KEY=one\nB_KEY=two\n");
    const crlf = parseEnvFile("A_KEY=one\r\nB_KEY=two\r\n");
    expect([...crlf]).toEqual([...lf]);
    expect(crlf.get("B_KEY")).toBe("two");
  });
  it("handles a lone CR separator and keeps '=' and spaces inside values", () => {
    const m = parseEnvFile("A_KEY=a=b c\rB_KEY=x");
    expect(m.get("A_KEY")).toBe("a=b c");
    expect(m.get("B_KEY")).toBe("x");
  });
  it("ignores comments and malformed lines", () => {
    expect(parseEnvFile("# c\nbad line\nlower=1\n").size).toBe(0);
  });
});

describe("host guard", () => {
  it("accepts loopback hosts only", () => {
    for (const h of ["127.0.0.1", "localhost", "::1"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["db.example.supabase.co", "10.0.0.5", "0.0.0.0", ""]) expect(isLoopbackHost(h)).toBe(false);
    expect(() => assertLocalHost("aws-0-eu.pooler.supabase.com")).toThrow(/not loopback/);
    expect(() => assertLocalHost("127.0.0.1")).not.toThrow();
  });
});

describe("parseResetArgs", () => {
  it("--local targets web-owner.env", () => {
    expect(parseResetArgs(["--", "--local"])).toEqual({ supabase: false, file: "web-owner.env" });
  });
  it("supabase needs --allow-remote and writes the supabase file", () => {
    expect(() => parseResetArgs(["--supabase"])).toThrow(/--allow-remote/);
    expect(parseResetArgs(["--supabase", "--allow-remote"])).toEqual({ supabase: true, file: "web-owner.supabase.env" });
  });
  it("refuses no target, both targets, stray --allow-remote and unknown flags", () => {
    expect(() => parseResetArgs([])).toThrow();
    expect(() => parseResetArgs(["--local", "--supabase", "--allow-remote"])).toThrow();
    expect(() => parseResetArgs(["--local", "--allow-remote"])).toThrow();
    expect(() => parseResetArgs(["--local", "--force"])).toThrow(/Usage/);
  });
});
