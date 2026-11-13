import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pruneLoginAttempts } from "@flow-ai/database";
import { ageRunRequests, auditActorsForEntity, countAuditEvents, guardCanDeleteLoginAttempts, insertBalanceSnapshot, insertRawPayment, loginAttemptKeys, resetLoginAttempts, seedInvoice, seedScenario, setInvoiceStatus, type Scenario } from "@flow-ai/database/testing";
import { routes } from "../src/server/api/routes";
import { CURRENCY_HEX, ISSUER, createWebHarness, fakeAddress, type Session, type WebHarness } from "./helpers";
let h: WebHarness;
let owner: Session;
let other: Scenario;
const HASH = "ABCDEF0123456789".repeat(4);
const BLOB = "DEADBEEF".repeat(20);
interface P {
  invoiceId: string;
  status: string;
  tx?: string;
  blob?: string;
  failureCode?: string;
  failureMessage?: string;
  reason?: string;
  business?: Scenario;
}
async function addPayment(p: P): Promise<string> {
  const s = p.business ?? h.scenario;
  return insertRawPayment(h.db.adminPool, {
    businessId: s.businessId,
    invoiceId: p.invoiceId,
    supplierId: s.supplierId,
    walletId: s.walletId,
    currencyHex: CURRENCY_HEX,
    issuer: ISSUER,
    destination: fakeAddress(),
    status: p.status,
    idempotencyKey: `key-${randomUUID()}`,
    txHash: p.tx ?? null,
    signedBlob: p.blob ?? null,
    failureCode: p.failureCode ?? null,
    failureMessage: p.failureMessage ?? null,
    agentReason: p.reason ?? null,
  });
}
beforeAll(async () => {
  h = await createWebHarness();
  owner = await h.login(h.owner);
  other = await seedScenario(h.db.adminPool, { walletAddress: fakeAddress(), supplierAddress: fakeAddress(), issuer: ISSUER, currencyHex: CURRENCY_HEX });
});
afterAll(async () => {
  await h.close();
});
describe("invoices", () => {
  it("lists own invoices with the corridor, filters by status and pages with a bounded size", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) ids.push(await seedInvoice(h.db.adminPool, h.scenario, { invoiceNumber: `INV-P-${String(i).padStart(3, "0")}`, status: i % 2 === 0 ? "open" : "draft" }));
    const first = await h.authed(routes.invoicesList, owner);
    expect(first.status).toBe(200);
    expect(first.body.invoices).toHaveLength(20);
    expect(first.body.has_more).toBe(true);
    expect((first.body.invoices[0] as { corridor: string }).corridor).toBe("Cross-border"); // supplier NG, business ZA
    const second = await h.authed(routes.invoicesList, owner, { query: "?page=2" });
    expect(second.body.invoices).toHaveLength(3);
    expect(second.body.has_more).toBe(false);
    const open = await h.authed(routes.invoicesList, owner, { query: "?status=open" });
    expect((open.body.invoices as { status: string }[]).every((i) => i.status === "open")).toBe(true);
    expect(new Set([...(first.body.invoices as { id: string }[]), ...(second.body.invoices as { id: string }[])].map((i) => i.id)).size).toBe(23);
  });
  it("rejects an unknown status filter, unknown keys and bad paging", async () => {
    for (const q of ["?status=hacked", "?status=open&status=paid", "?page=0", "?page=1001", "?page=x", "?business_id=x", "?limit=500"]) {
      expect((await h.authed(routes.invoicesList, owner, { query: q })).status, q).toBe(400);
    }
  });
  it("another business's invoice is a 404 and never appears in a list", async () => {
    const foreign = await seedInvoice(h.db.adminPool, other, { invoiceNumber: "FOREIGN-1" });
    expect((await h.authed(routes.invoiceGet, owner, { params: { id: foreign } })).status).toBe(404);
    expect((await h.authed(routes.invoiceGet, owner, { params: { id: randomUUID() } })).status).toBe(404);
    const list = await h.authed(routes.invoicesList, owner, { query: "?page=1" });
    expect(list.raw).not.toContain("FOREIGN-1");
    expect((await h.authed(routes.invoiceGet, owner, { params: { id: "not-a-uuid" } })).status).toBe(400);
  });
  it("shows the decision code of a blocked invoice, and escapes nothing (text is returned as data)", async () => {
    const inv = await seedInvoice(h.db.adminPool, h.scenario, { invoiceNumber: "INV-BLK", description: "<img src=x onerror=alert(1)>" });
    await setInvoiceStatus(h.db.adminPool, inv, "blocked");
    await addPayment({ invoiceId: inv, status: "blocked", failureCode: "DAILY_LIMIT_EXCEEDED" });
    const res = await h.authed(routes.invoiceGet, owner, { params: { id: inv } });
    expect(res.status).toBe(200);
    expect(res.body.invoice.blocked_code).toBe("DAILY_LIMIT_EXCEEDED");
    expect(res.body.invoice.description).toBe("<img src=x onerror=alert(1)>");
    expect(res.body.invoice.latest_payment_id).not.toBeNull();
  });
});
describe("payments", () => {
  it("never returns signed_blob, builds the explorer link only for a validated payment, and omits it otherwise", async () => {
    const inv1 = await seedInvoice(h.db.adminPool, h.scenario, { invoiceNumber: "INV-PAID" });
    const paid = await addPayment({ invoiceId: inv1, status: "validated", tx: HASH, reason: "earliest due" });
    const inv2 = await seedInvoice(h.db.adminPool, h.scenario, { invoiceNumber: "INV-SUB" });
    const sub = await addPayment({ invoiceId: inv2, status: "submitted", tx: HASH.toLowerCase().toUpperCase().replace(/A/g, "B"), blob: BLOB });
    const a = await h.authed(routes.paymentGet, owner, { params: { id: paid } });
    expect(a.status).toBe(200);
    expect(a.body.payment.explorer_url).toBe(`https://testnet.xrpl.org/transactions/${HASH}`);
    expect(a.body.payment.network).toBe("XRPL Testnet");
    expect(a.body.payment.delivered_amount).toBe("1.5");
    const b = await h.authed(routes.paymentGet, owner, { params: { id: sub } });
    expect(b.body.payment.explorer_url).toBeNull();
    expect(b.body.payment.tx_hash).not.toBeNull();
    const list = await h.authed(routes.paymentsList, owner);
    for (const raw of [a.raw, b.raw, list.raw]) {
      expect(raw).not.toContain(BLOB);
      expect(raw).not.toContain("signed_blob");
    }
    const filtered = await h.authed(routes.paymentsList, owner, { query: "?status=validated" });
    expect((filtered.body.payments as { id: string }[]).map((p) => p.id)).toEqual([paid]);
  });
  it("redacts and caps free text, and another business's payment is a 404", async () => {
    const inv = await seedInvoice(h.db.adminPool, h.scenario, { invoiceNumber: "INV-FAIL" });
    const seedLike = `s${fakeAddress().slice(1, 30)}`; // generated at run time: no secret-shaped literal in source
    const pay = await addPayment({ invoiceId: inv, status: "failed", failureCode: "XRPL_SUBMISSION_FAILED", failureMessage: `failed: seed ${seedLike} leaked` });
    const res = await h.authed(routes.paymentGet, owner, { params: { id: pay } });
    expect(res.body.payment.failure_message).not.toContain(seedLike);
    const foreignInv = await seedInvoice(h.db.adminPool, other, { invoiceNumber: "FOREIGN-2" });
    const foreignPay = await addPayment({ invoiceId: foreignInv, status: "blocked", failureCode: "AUTOMATION_PAUSED", business: other });
    expect((await h.authed(routes.paymentGet, owner, { params: { id: foreignPay } })).status).toBe(404);
    expect((await h.authed(routes.paymentsList, owner)).raw).not.toContain("FOREIGN-2");
  });
  it("viewers and anonymous callers cannot read either list", async () => {
    const viewer = await h.login(h.viewer);
    for (const r of [routes.invoicesList, routes.paymentsList]) {
      expect((await h.authed(r, viewer)).status).toBe(403);
      expect((await h.call(r)).status).toBe(401);
    }
  });
});
describe("overview extras", () => {
  it("returns the freshness fields, the queue, recent payments and the agent block", async () => {
    await insertBalanceSnapshot(h.db.adminPool, h.scenario.walletId, "50", 600);
    const res = await h.authed(routes.overview, owner);
    expect(res.status).toBe(200);
    expect(res.body.treasury.stale).toBe(true);
    expect(res.body.treasury.age_seconds).toBeGreaterThanOrEqual(590);
    expect(res.body.agent.state).toBe("ready");
    expect(res.body.queue.length).toBeGreaterThan(0);
    expect(res.body.queue.length).toBeLessThanOrEqual(5);
    expect(res.body.recent_payments.length).toBeLessThanOrEqual(5);
    expect(res.raw).not.toContain("signed_blob");
    await insertBalanceSnapshot(h.db.adminPool, h.scenario.walletId, "60", 0);
    const fresh = await h.authed(routes.overview, owner);
    expect(fresh.body.treasury.stale).toBe(false);
  });
});
describe("run request route", () => {
  it("queues one request, answers 409 for a second, audits it, and refuses viewers and a missing CSRF token", async () => {
    const viewer = await h.login(h.viewer);
    expect((await h.authed(routes.agentRunRequest, viewer, { body: {} })).status).toBe(403);
    expect((await h.call(routes.agentRunRequest, { cookie: owner.cookie, body: {} })).status).toBe(403);
    const first = await h.authed(routes.agentRunRequest, owner, { body: {} });
    expect(first.status).toBe(202);
    const second = await h.authed(routes.agentRunRequest, owner, { body: {} });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("RUN_REQUESTED");
    expect(await countAuditEvents(h.db.adminPool, h.scenario.businessId, "agent.run_requested")).toBe(1);
    expect(await auditActorsForEntity(h.db.adminPool, first.body.request_id as string, "agent.run_requested")).toEqual(["human"]);
    const ov = await h.authed(routes.overview, owner);
    expect(ov.body.agent.run_request.status).toBe("open");
  });
  it("a stale unclaimed request is expired by the next request instead of blocking it forever", async () => {
    await ageRunRequests(h.db.adminPool, h.scenario.businessId, 20);
    const again = await h.authed(routes.agentRunRequest, owner, { body: {} });
    expect(again.status).toBe(202);
  });
});
describe("login_attempts pruning", () => {
  it("deletes old windows, keeps current ones, and the database refuses to delete a fresh window", async () => {
    const key = (n: string): string => n.repeat(64).slice(0, 64);
    await resetLoginAttempts(h.db.adminPool, [{ keyHash: key("a"), ageDays: 5 }, { keyHash: key("b"), ageDays: 3 }, { keyHash: key("c"), ageDays: 0 }]);
    // The app asks for everything older than 2 days; the policy independently allows only windows older than 1 day.
    expect(await pruneLoginAttempts(h.pool, new Date(Date.now() - 2 * 24 * 3600 * 1000))).toBe(2);
    expect(await loginAttemptKeys(h.db.adminPool)).toEqual([key("c")]);
    // Even a hostile caller asking for "everything" cannot remove the live window.
    expect(await pruneLoginAttempts(h.pool, new Date(Date.now() + 24 * 3600 * 1000))).toBe(0);
    expect(await loginAttemptKeys(h.db.adminPool)).toEqual([key("c")]);
  });
  it("the guard role has no DELETE right on login_attempts", async () => {
    expect(await guardCanDeleteLoginAttempts(h.db.guardPool)).toBe("42501");
  });
});
