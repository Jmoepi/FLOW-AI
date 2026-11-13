import { describe, expect, it } from "vitest";
import { displayStatus, outcomeOf, outcomeText } from "../src/components/agent-format";
import { AGENT_RUNS } from "./ui-fixtures";
/** M-1 defence in depth: the page shows "Paid" only when the run's own linked payment is validated. */
const base = AGENT_RUNS.runs[0]!;
describe("agent run display status", () => {
  it("shows paid only for a validated linked payment", () => {
    expect(displayStatus(base)).toBe("paid");
    expect(outcomeOf(displayStatus(base)).label).toBe("Paid");
  });
  it.each(["pending_confirmation", "reserved", "submitted", "failed", "blocked", "cancelled", null])("does not show paid when the linked payment is %s", (status) => {
    const run = { ...base, payment: { id: "p", status, tx_hash: null, explorer_url: null } };
    expect(displayStatus(run)).toBe("failed");
    expect(outcomeOf(displayStatus(run)).label).not.toBe("Paid");
    expect(outcomeText(run)).not.toMatch(/validated on the ledger/);
  });
  it("does not show paid without any linked payment", () => {
    expect(displayStatus({ ...base, payment: null })).toBe("failed");
  });
  it("leaves every other derived status alone", () => {
    for (const status of ["blocked", "pending", "no_candidate", "failed", "timed_out", "limit_exceeded", "interrupted", "running"]) expect(displayStatus({ ...base, status, payment: null })).toBe(status);
  });
});
