import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explorerUrl } from "../src/server/api/agent-runs";
const HASH = "0123456789ABCDEF".repeat(4);
describe("explorerUrl (IN-5)", () => {
  it("builds a testnet link only for a validated payment with a canonical hash", () => {
    expect(explorerUrl("validated", HASH)).toBe(`https://testnet.xrpl.org/transactions/${HASH}`);
  });
  it.each([
    ["submitted", HASH],
    ["validated", null],
    ["validated", HASH.toLowerCase()],
    ["validated", `${HASH}A`],
    ["validated", "javascript:alert(1)"],
    ["validated", `${HASH.slice(0, 60)}/../`],
    [null, HASH],
  ])("no link for status %s hash %s", (status, hash) => {
    expect(explorerUrl(status, hash)).toBeNull();
  });
});
describe("proxy coverage", () => {
  it("the proxy matcher covers /agent, so it gets the same nonce CSP and headers", () => {
    const src = readFileSync(join(process.cwd(), "src", "proxy.ts"), "utf8");
    expect(src).toContain('source: "/((?!_next/static|_next/image|favicon.ico).*)"');
    // The same pattern as a literal: /agent matches, static assets do not.
    const re = /^\/((?!_next\/static|_next\/image|favicon.ico).*)$/;
    expect(re.test("/agent")).toBe(true);
    expect(re.test("/_next/static/x.js")).toBe(false);
  });
});
