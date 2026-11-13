import { DECISION_CODES } from "@flow-ai/contracts";
import { describe, expect, it } from "vitest";
import { DECISION_TABLE_CODES, explainDecision } from "../src/components/decision-codes";
describe("decision code explanations", () => {
  it("covers every decision code, so a new code without an entry fails here", () => {
    expect([...DECISION_TABLE_CODES].sort()).toEqual([...DECISION_CODES].sort());
    expect(DECISION_CODES.length).toBe(28);
  });
  it.each([...DECISION_CODES])("%s has a non-empty plain-language explanation with no markup", (code) => {
    const e = explainDecision(code);
    for (const text of [e.title, e.plain, e.whatToDo]) {
      expect(text.length).toBeGreaterThan(8);
      expect(text).not.toMatch(/[<>{}`]/);
    }
    expect(e.title).not.toBe(explainDecision("NOT_A_CODE").title);
  });
  it("maps unknown, malformed and hostile input to the generic line without throwing", () => {
    const generic = explainDecision(null);
    for (const bad of [undefined, "", "lower_case", "<script>", "A".repeat(200), "__proto__", "constructor", "TOSTRING"]) expect(explainDecision(bad as string)).toEqual(generic);
    expect(generic.plain).toContain("No funds were moved");
  });
  it("never says a blocked payment moved funds", () => {
    for (const code of DECISION_CODES) expect(explainDecision(code).plain).not.toMatch(/\bwas paid\b|\bhas been paid\b/i);
  });
});
