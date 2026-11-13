import { describe, expect, it } from "vitest";
import { createTokenVerifier, safeEqual } from "../src/auth";
import { TOKEN, TOKEN_NEXT } from "./helpers";
describe("safeEqual", () => {
  it("compares equal and unequal strings of any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });
});
describe("createTokenVerifier", () => {
  const verify = createTokenVerifier([TOKEN, TOKEN_NEXT]);
  it("accepts the current and the next token", () => {
    expect(verify(`Bearer ${TOKEN}`)).toBe(true);
    expect(verify(`Bearer ${TOKEN_NEXT}`)).toBe(true);
  });
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["wrong scheme", `Basic ${TOKEN}`],
    ["lower-case scheme", `bearer ${TOKEN}`],
    ["no scheme", TOKEN],
    ["prefix of token", `Bearer ${TOKEN.slice(0, -1)}`],
    ["token plus suffix", `Bearer ${TOKEN}x`],
    ["short", "Bearer abc"],
    ["very long", `Bearer ${"a".repeat(5000)}`],
    ["array header", [`Bearer ${TOKEN}`]],
    ["extra space", `Bearer  ${TOKEN}`],
    ["trailing newline", `Bearer ${TOKEN}\n`],
  ])("rejects %s", (_n, header) => {
    expect(verify(header)).toBe(false);
  });
  it("rejects everything when no token is configured", () => {
    expect(createTokenVerifier([])("Bearer x")).toBe(false);
  });
});
