import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbError, appendAudit, getPayment, listPayments, verifyAuditChain, withTransaction } from "@flow-ai/database";
import { attack, businessIds, paymentSummaries, tableCounts, type AttackName } from "@flow-ai/database/testing";
import { assertNoLeaks, createHarness, key, type Harness } from "./db-harness";
import { TOKEN, bearer } from "./helpers";
let h: Harness;
let limited: Harness;
beforeAll(async () => {
  // flow_nogrant is a cluster-level role whose password is rotated by every createTestDatabase(): build `h` last so its
  // no-grant pool holds the current password (otherwise it would fail with an authentication error, not a privilege one).
  limited = await createHarness({ config: { rateLimitPerMinute: 3 } });
  h = await createHarness();
});
afterAll(async () => {
  await limited.close();
  await h.close();
});
const UUID = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
const raw = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: string) =>
  h.guard.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
describe("HTTP hardening on the real stack", () => {
  it("IN-2: unknown keys are 400 and create nothing", async () => {
    const s = await h.scenario();
    const invoice = await h.invoice(s);
    const before = await tableCounts(h.db.adminPool);
    for (const extra of [{ amount: "999" }, { destination: "rEvil" }, { tx_blob: "AB" }, { business_id: UUID }]) {
      const res = await h.post(invoice, key("unk"), extra);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "INVALID_REQUEST" });
    }
    expect(await tableCounts(h.db.adminPool)).toEqual(before);
    expect(h.ledger.submits).toHaveLength(0);
  });
  it("oversize body is 413 and a non-JSON content type is 415", async () => {
    const big = JSON.stringify({ invoice_id: UUID, idempotency_key: "run-1:inv-0001", pad: "x".repeat(5000) });
    const tooBig = await raw("POST", "/internal/payment-requests", { ...bearer(), "content-type": "application/json" }, big);
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toEqual({ error: "payload_too_large" });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/xml"]) {
      const res = await raw("POST", "/internal/payment-requests", { ...bearer(), "content-type": type }, "invoice_id=1");
      expect(res.statusCode, type).toBe(415);
      expect(res.json()).toEqual({ error: "unsupported_media_type" });
    }
  });
  it("IN-1: SQL-injection strings are rejected or not found and every table is intact", async () => {
    const s = await h.scenario();
    await h.invoice(s);
    const before = await tableCounts(h.db.adminPool);
    const sql = "1'; DROP TABLE payments;--";
    expect((await h.post(sql, key("sqli"))).status).toBe(400);
    expect((await h.post(UUID, sql)).status).toBe(400);
    expect((await h.get(`/internal/payments/${encodeURIComponent(sql)}`)).status).toBe(400);
    expect((await h.get(`/internal/invoices/${encodeURIComponent(sql)}/eligibility`)).status).toBe(400);
    expect((await h.get(`/internal/payments?invoice_id=${encodeURIComponent(sql)}`)).status).toBe(400);
    expect((await h.get(`/internal/payments?status=${encodeURIComponent("validated' OR '1'='1")}`)).status).toBe(400);
    expect((await h.get(`/internal/payments?limit=${encodeURIComponent("1; DROP TABLE payments")}`)).status).toBe(400);
    expect((await h.get(`/internal/payments/${UUID}`)).status).toBe(404);
    expect(await tableCounts(h.db.adminPool)).toEqual(before);
  });
  it("AZ-1: a missing or wrong token gets the identical 401 body and reaches no handler", async () => {
    const s = await h.scenario();
    const invoice = await h.invoice(s);
    const before = await tableCounts(h.db.adminPool);
    const body = JSON.stringify({ invoice_id: invoice, idempotency_key: key("auth") });
    const missing = await raw("POST", "/internal/payment-requests", { "content-type": "application/json" }, body);
    const wrong = await raw("POST", "/internal/payment-requests", { ...bearer("w".repeat(48)), "content-type": "application/json" }, body);
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(missing.body).toBe('{"error":"unauthorized"}');
    expect(wrong.body).toBe(missing.body);
    expect(await tableCounts(h.db.adminPool)).toEqual(before);
  });
  it("readyz reports healthy with the real pool and gateway, and exposes only flags", async () => {
    const res = await raw("GET", "/readyz", {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: true, ledger: true, audit_chain: "unverified", audit_verified_at: null });
  });
  it("429 with Retry-After once the per-IP limit is hit", async () => {
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 6; i++) {
      last = await limited.guard.app.inject({ method: "GET", url: "/internal/status", headers: bearer() });
      codes.push(last.statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3).every((c) => c === 429)).toBe(true);
    expect(last?.headers["retry-after"]).toBeDefined();
    expect(last?.json()).toEqual({ error: "rate_limited" });
  });
});
describe("database privileges through the application's own pools (13.1B, AL-2, AL-3, AZ-5)", () => {
  let paymentId = "";
  let businessId = "";
  beforeAll(async () => {
    const s = await h.scenario({ dailyLimit: "10" });
    businessId = s.businessId;
    const res = await h.post(await h.invoice(s), key("priv"));
    expect(res.body.status).toBe("validated");
    paymentId = res.body.payment_id as string;
  });
  const expected: [AttackName, string][] = [
    ["update_audit", "42501"],
    ["delete_audit", "42501"],
    ["truncate_audit", "42501"],
    ["delete_payment", "42501"],
    ["change_amount", "42501"],
    ["update_policy", "42501"],
    ["update_supplier", "42501"],
    ["insert_supplier", "42501"],
    ["read_members", "42501"],
    ["illegal_transition", "55000"],
    ["rewrite_terminal", "55000"],
  ];
  it.each(expected)("flow_guard cannot %s (SQLSTATE %s)", async (name, state) => {
    expect(await attack(h.db.guardPool, name, { paymentId, businessId })).toBe(state);
  });
  it("a role with no grants cannot read or write through the same repositories", async () => {
    // Without schema USAGE the unqualified repo queries fail as "relation does not exist" (DB_ERROR) or as permission denied.
    await expect(getPayment(h.db.noGrantPool, paymentId)).rejects.toBeInstanceOf(DbError);
    await expect(listPayments(h.db.noGrantPool, {})).rejects.toBeInstanceOf(DbError);
    await expect(
      withTransaction(h.db.noGrantPool, (c) => appendAudit(c, { business_id: businessId, actor_type: "system", event_type: "x", entity_type: "payment", entity_id: paymentId })),
    ).rejects.toBeInstanceOf(DbError);
    expect(await attack(h.db.noGrantPool, "read_payments", {})).toBe("42501");
  });
  it("the audited payment survived every attack unchanged and the audit chain verifies", async () => {
    const [p] = await paymentSummaries(h.db.adminPool, businessId);
    expect(p).toMatchObject({ status: "validated", reservation: "committed", invoice_status: "paid" });
    for (const id of await businessIds(h.db.adminPool)) expect(await verifyAuditChain(h.db.guardPool, id)).toBe(true);
  });
});
describe("leak scan", () => {
  it("G-3/PG-10: logs, responses and stored rows hold no seed, token, password or signed blob", async () => {
    expect(await assertNoLeaks(h)).toEqual([]);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });
});
