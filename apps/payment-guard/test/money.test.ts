import { describe, expect, it } from "vitest";
import { requestHash } from "../src/decision/idempotency";
import { xrpToDrops } from "../src/services/payments";
describe("xrpToDrops", () => {
  it("converts with BigInt and rejects malformed input", () => {
    expect(xrpToDrops("10")).toBe("10000000");
    expect(xrpToDrops("0.000001")).toBe("1");
    expect(xrpToDrops("12.345678")).toBe("12345678");
    for (const bad of ["1e3", "-1", "1.1234567", "1..2", "", "abc", "1.2.3"]) expect(xrpToDrops(bad)).toBeNull();
  });
});
describe("requestHash", () => {
  const id = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
  it("is stable and sensitive to the reason", () => {
    expect(requestHash({ invoice_id: id })).toBe(requestHash({ invoice_id: id.toUpperCase(), agent_reason: undefined }));
    expect(requestHash({ invoice_id: id })).not.toBe(requestHash({ invoice_id: id, agent_reason: "x" }));
    expect(requestHash({ invoice_id: id })).toMatch(/^[0-9a-f]{64}$/);
  });
});
