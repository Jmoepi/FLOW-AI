import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAYMENT_STATUSES, TERMINAL_STATUSES, canTransition, invoiceStatusFor, isInFlight } from "../src/state/payment-machine";
const sql = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/database/migrations/0003_payments.sql"), "utf8");
function sqlLegalPairs(): Set<string> {
  const block = /legal text\[\] := ARRAY\[([\s\S]*?)\];/.exec(sql)?.[1] ?? "";
  return new Set([...block.matchAll(/'([a-z_]+>[a-z_]+)'/g)].map((m) => m[1] as string));
}
describe("payment state machine", () => {
  it("matches the database transition table for every ordered pair", () => {
    const legal = sqlLegalPairs();
    expect(legal.size).toBe(10);
    for (const from of PAYMENT_STATUSES) for (const to of PAYMENT_STATUSES) expect(canTransition(from, to), `${from}>${to}`).toBe(legal.has(`${from}>${to}`));
  });
  it("matches the database terminal statuses", () => {
    const terminal = /OLD\.status IN \(([^)]*)\) THEN\s+RAISE EXCEPTION 'payment is in terminal/.exec(sql)?.[1] ?? "";
    expect([...terminal.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...TERMINAL_STATUSES].sort());
  });
  it("lets no terminal status move anywhere", () => {
    for (const from of TERMINAL_STATUSES) for (const to of PAYMENT_STATUSES) expect(canTransition(from, to)).toBe(false);
  });
  it("derives invoice status per spec 5A.1", () => {
    expect(PAYMENT_STATUSES.map((s) => [s, invoiceStatusFor(s)])).toEqual([
      ["requested", "processing"], ["blocked", "blocked"], ["reserved", "processing"], ["submitted", "processing"],
      ["pending_confirmation", "processing"], ["validated", "paid"], ["failed", "open"], ["cancelled", "open"],
    ]);
    expect(PAYMENT_STATUSES.filter(isInFlight)).toEqual(["requested", "reserved", "submitted", "pending_confirmation"]);
  });
});
