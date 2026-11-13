import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEventTypes, heldTotal, paymentSummaries, tableCounts } from "@flow-ai/database/testing";
import { verifyAuditChain } from "@flow-ai/database";
import { assertNoLeaks, createHarness, key, type Harness } from "./db-harness";
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
describe("concurrency and idempotency against real Postgres", () => {
  it("PG-2/PG-3: 20 concurrent requests for 20 invoices with a cap of 3 pay exactly 3 and never exceed the cap", async () => {
    const s = await h.scenario({ dailyLimit: "3", maxPayment: "2" });
    const invoices = await Promise.all(Array.from({ length: 20 }, () => h.invoice(s, { amount: "1" })));
    const results = await Promise.all(invoices.map((id) => h.post(id, key("cap"))));
    const validated = results.filter((r) => r.body.status === "validated");
    const blocked = results.filter((r) => r.body.status === "blocked");
    expect(validated).toHaveLength(3);
    expect(blocked).toHaveLength(17);
    for (const r of blocked) expect((r.body.policy_decision as { decision_code: string }).decision_code).toBe("DAILY_LIMIT_EXCEEDED");
    expect(Number(await heldTotal(h.db.adminPool, s.businessId))).toBeLessThanOrEqual(3);
    expect(await heldTotal(h.db.adminPool, s.businessId)).toBe("3");
    const rows = await paymentSummaries(h.db.adminPool, s.businessId);
    expect(rows.filter((r) => r.status === "validated")).toHaveLength(3);
    expect(rows.filter((r) => r.status === "blocked" && r.reservation === null)).toHaveLength(17);
    expect(h.ledger.submits).toHaveLength(3);
    expect(await verifyAuditChain(h.db.guardPool, s.businessId)).toBe(true);
  });
  it("PG-3: 20 concurrent requests for ONE invoice with different keys execute exactly one payment", async () => {
    const before = h.ledger.submits.length;
    const s = await h.scenario({ dailyLimit: "10" });
    const invoice = await h.invoice(s, { amount: "1" });
    const results = await Promise.all(Array.from({ length: 20 }, () => h.post(invoice, key("same-inv"))));
    const rows = await paymentSummaries(h.db.adminPool, s.businessId);
    expect(rows.filter((r) => r.status === "validated")).toHaveLength(1);
    expect(h.ledger.submits.length - before).toBe(1);
    expect(results.filter((r) => r.body.status === "validated")).toHaveLength(1);
    for (const r of results.filter((x) => x.body.status !== "validated")) {
      expect(["blocked", "reserved", "submitted", "pending_confirmation"]).toContain(r.body.status);
    }
    expect(Number(await heldTotal(h.db.adminPool, s.businessId))).toBe(1);
  });
  it("IN-3: 20 concurrent requests with the same key and body create one payment and identical responses", async () => {
    const before = h.ledger.submits.length;
    const s = await h.scenario({ dailyLimit: "10" });
    const invoice = await h.invoice(s, { amount: "1" });
    const k = key("replay");
    const results = await Promise.all(Array.from({ length: 20 }, () => h.post(invoice, k, { agent_reason: "monthly run" })));
    const rows = await paymentSummaries(h.db.adminPool, s.businessId);
    expect(rows).toHaveLength(1);
    expect(h.ledger.submits.length - before).toBe(1);
    const ids = new Set(results.map((r) => r.body.payment_id));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.status === 200 || r.status === 202)).toBe(true);
    // Once settled every later replay returns the same stored result.
    const later = await h.post(invoice, k, { agent_reason: "monthly run" });
    expect(later.body.status).toBe("validated");
    expect(later.body.payment_id).toBe([...ids][0]);
  });
  it("IN-3: the same key with a different agent_reason is a 409 and creates nothing", async () => {
    const s = await h.scenario({ dailyLimit: "10" });
    const invoice = await h.invoice(s);
    const k = key("conflict");
    expect((await h.post(invoice, k, { agent_reason: "first" })).body.status).toBe("validated");
    const counts = await tableCounts(h.db.adminPool);
    const second = await h.post(invoice, k, { agent_reason: "second" });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await tableCounts(h.db.adminPool)).toEqual(counts);
  });
  it("PG-3: a double submit after validation returns the stored response and never submits again", async () => {
    const s = await h.scenario({ dailyLimit: "10" });
    const invoice = await h.invoice(s);
    const k = key("double");
    const first = await h.post(invoice, k);
    const submits = h.ledger.submits.length;
    const second = await h.post(invoice, k);
    expect(second.body.payment_id).toBe(first.body.payment_id);
    expect(second.body.tx_hash).toBe(first.body.tx_hash);
    expect(second.body.status).toBe("validated");
    expect(h.ledger.submits.length).toBe(submits);
    // A NEW key for the already-paid invoice is blocked, not paid again.
    const third = await h.post(invoice, key("again"));
    expect(third.body.status).toBe("blocked");
    expect(h.ledger.submits.length).toBe(submits);
    expect(await auditEventTypes(h.db.adminPool, first.body.payment_id as string)).toEqual(
      expect.arrayContaining(["payment.requested", "payment.reserved", "payment.signed", "payment.validated"]),
    );
  });
  it("PG-6: two workers racing on one wallet are serialised by the advisory lock (no overlapping submits)", async () => {
    const s = await h.scenario({ dailyLimit: "10" });
    const other = h.spawnWorker();
    h.ledger.submitDelayMs = 400;
    try {
      const ids = await Promise.all([h.invoice(s), h.invoice(s), h.invoice(s), h.invoice(s)]);
      const requested = await Promise.all(
        ids.map(async (id) => {
          // Reserve through the shared HTTP path without executing, then run executions from two different workers.
                    const { requestPayment } = await import("../src/services/payments");
          return requestPayment(h.reserveOnlyDeps, { invoice_id: id, idempotency_key: key("race") }, "00000000-0000-4000-8000-000000000000");
        }),
      );
      const start = h.ledger.submits.length;
      expect(requested.every((r) => r.body.status === "reserved")).toBe(true);
      const workers = [h.executor, other.executor];
      await Promise.all(requested.map((r, i) => (workers[i % 2] as typeof h.executor).execute(r.body.payment_id as string)));
      const windows = h.ledger.submits.slice(start).map((x) => [x.startedAt, x.endedAt] as const);
      expect(windows).toHaveLength(4);
      const sorted = [...windows].sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < sorted.length; i++) expect((sorted[i] as readonly [number, number])[0]).toBeGreaterThanOrEqual((sorted[i - 1] as readonly [number, number])[1]);
      const rows = await paymentSummaries(h.db.adminPool, s.businessId);
      expect(rows.every((r) => r.status === "validated")).toBe(true);
    } finally {
      h.ledger.submitDelayMs = 0;
    }
  });
  it("G-3/PG-10: nothing leaked to logs, responses or stored text", async () => {
    expect(await assertNoLeaks(h)).toEqual([]);
  });
});
