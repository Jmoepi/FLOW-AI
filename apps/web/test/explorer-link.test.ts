import { describe, expect, it } from "vitest";
import { EXPLORER_PREFIX, explorerUrl, isTxHash } from "../src/components/explorer";
const HASH = "0123456789ABCDEF".repeat(4);
describe("explorer link", () => {
  it("builds the link only for a validated payment with a canonical hash on the fixed Testnet origin", () => {
    expect(explorerUrl("validated", HASH)).toBe(`https://testnet.xrpl.org/transactions/${HASH}`);
    expect(EXPLORER_PREFIX).toBe("https://testnet.xrpl.org/transactions/");
  });
  it.each(["submitted", "pending_confirmation", "failed", "blocked", "requested", "VALIDATED", null])("no link for status %s", (status) => {
    expect(explorerUrl(status, HASH)).toBeNull();
  });
  it.each([
    ["lower case", HASH.toLowerCase()],
    ["short", HASH.slice(1)],
    ["long", `${HASH}A`],
    ["javascript scheme", "javascript:alert(1)"],
    ["path traversal", `../${HASH.slice(3)}`],
    ["query string", `${HASH.slice(0, 60)}?a=1`],
    ["unicode lookalike", `${HASH.slice(0, 63)}Ａ`],
    ["whitespace", ` ${HASH.slice(1)}`],
    ["newline", `${HASH.slice(0, 63)}\n`],
    ["empty", ""],
  ])("rejects %s", (_n, value) => {
    expect(isTxHash(value)).toBe(false);
    expect(explorerUrl("validated", value)).toBeNull();
  });
  it("rejects null and non-strings", () => {
    expect(isTxHash(null)).toBe(false);
    expect(isTxHash(12)).toBe(false);
    expect(explorerUrl("validated", null)).toBeNull();
  });
});
