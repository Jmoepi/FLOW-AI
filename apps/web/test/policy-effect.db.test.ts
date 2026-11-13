import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPolicyForWeb, insertSnapshot, listAuditForBusiness, verifyAuditChain } from "@flow-ai/database";
import { policyAmountWriteAttempt, tableCounts } from "@flow-ai/database/testing";
import { createHarness, key, type Harness } from "../../payment-guard/test/db-harness";
import { routes } from "../src/server/api/routes";
import { createWebHarness, type Session, type WebHarness } from "./helpers";
/**
 * The M4 proof: an owner change made through the REAL web handlers changes the very next decision of the REAL payment
 * guard, with nothing cached in between. The ledger is the guard test suite's scriptable fake; nothing touches XRPL.
 */
let g: Harness;
let w: WebHarness;
let owner: Session;
/** The preview reads the poller's snapshot, which must be fresh: write one the way the guard poller does (as flow_guard). */
async function eligibility(invoiceId: string): Promise<{ eligible: boolean; failed_checks: string[] }> {
  await insertSnapshot(g.db.guardPool, { wallet_id: w.scenario.walletId, rlusd_balance: "100", xrp_balance: "100", ledger_index: 1000 });
  return (await g.get(`/internal/invoices/${invoiceId}/eligibility`)).body as { eligible: boolean; failed_checks: string[] };
}
async function putPolicy(over: Record<string, unknown>): Promise<Awaited<ReturnType<WebHarness["call"]>>> {
  const cur = (await getPolicyForWeb(g.db.adminPool, w.scenario.businessId))!;
  return w.authed(routes.policyPut, owner, {
    body: {
      enabled: cur.enabled,
      max_payment_amount: cur.max_payment_amount,
      daily_spend_limit: cur.daily_spend_limit,
      minimum_reserve: cur.minimum_reserve,
      allowed_assets: cur.allowed_assets,
      valid_until: cur.valid_until,
      ...over,
    },
    headers: { "if-match": `"${String(cur.version)}"` },
  });
}
beforeAll(async () => {
  g = await createHarness();
  const scenario = await g.scenario({ maxPayment: "2", dailyLimit: "10", minimumReserve: "0" });
  w = await createWebHarness({ existing: { db: g.db, scenario } });
  owner = await w.login(w.owner);
});
afterAll(async () => {
  await w.close();
  await g.close();
});
describe("owner lowers the per-payment cap", () => {
  const business = () => w.scenario.businessId;
  it("is allowed before, blocked with PAYMENT_LIMIT_EXCEEDED after, and the audit event shows exactly what changed", async () => {
    const scenario = w.scenario;
    const first = await g.invoice(scenario, { amount: "1.5" });
    const second = await g.invoice(scenario, { amount: "1.5" });
    // (a) before: eligible, and a payment request is allowed through to the (fake) ledger
    expect(await eligibility(first)).toEqual({ eligible: true, failed_checks: [], as_of: expect.any(String), preview: true });
    const allowed = await g.post(first, key("before"));
    expect(allowed.body.status).toBe("validated");
    expect(g.ledger.submits.length).toBe(1);
    const policyBefore = (await getPolicyForWeb(g.db.adminPool, business()))!;
    expect(policyBefore.max_payment_amount).toBe("2");
    // (b) the owner lowers max_payment_amount below the invoice amount, through the real handler
    const put = await putPolicy({ max_payment_amount: "1" });
    expect(put.status).toBe(200);
    expect(put.body.changed).toEqual(["max_payment_amount"]);
    const policyAfter = (await getPolicyForWeb(g.db.adminPool, business()))!;
    expect(policyAfter.version).toBe(policyBefore.version + 1);
    // (c) the very next guard decision reflects it
    const elig = await eligibility(second);
    expect(elig.eligible).toBe(false);
    expect(elig.failed_checks).toContain("PAYMENT_LIMIT_EXCEEDED");
    const submitsBefore = g.ledger.submits.length;
    const countsBefore = await tableCounts(g.db.adminPool);
    const blocked = await g.post(second, key("after"));
    expect(blocked.body.status).toBe("blocked");
    expect(blocked.body.failure_code).toBe("PAYMENT_LIMIT_EXCEEDED");
    expect((blocked.body.policy_decision as { policy_version: number }).policy_version).toBe(policyAfter.version);
    expect(g.ledger.submits.length).toBe(submitsBefore);
    expect((await tableCounts(g.db.adminPool)).payments).toBe(countsBefore.payments + 1);
    // (d) the audit trail
    const events = (await listAuditForBusiness(g.db.adminPool, business(), { limit: 100 })).filter((e) => e.event_type === "policy.updated");
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.metadata).toMatchObject({ changed: ["max_payment_amount"], before: { max_payment_amount: "2" }, after: { max_payment_amount: "1" }, risky: false, previous_version: policyBefore.version, new_version: policyAfter.version });
    expect(Object.keys(ev.metadata.before as object)).toEqual(["max_payment_amount"]);
    expect(ev.actor_type).toBe("human");
    expect(ev.actor_id).toBe(w.owner.userId);
    expect(ev.entity_type).toBe("treasury_policy");
    expect(ev.entity_id).toBe(policyAfter.id);
    expect(ev.request_id).toBe(put.headers.get("x-request-id"));
    expect(await verifyAuditChain(g.db.adminPool, business())).toBe(true);
    // the owner sees the same event through the audit API
    const feed = await w.authed(routes.auditList, owner);
    const shown = (feed.body.events as { event_type: string; actor: string; metadata: { changed: string[] } }[]).find((e) => e.event_type === "policy.updated");
    expect(shown).toMatchObject({ actor: "you", metadata: { changed: ["max_payment_amount"] } });
    expect(feed.raw).not.toContain(w.owner.userId);
  });
  it("a payment that fits the lowered cap still goes through (the change is not a blanket block)", async () => {
    const small = await g.invoice(w.scenario, { amount: "0.75" });
    expect((await eligibility(small)).eligible).toBe(true);
    expect((await g.post(small, key("fits"))).body.status).toBe("validated");
  });
});
describe("owner pauses and resumes automation", () => {
  it("Pause blocks the next request with AUTOMATION_PAUSED; resume (confirmed) allows it again", async () => {
    const invoice = await g.invoice(w.scenario, { amount: "0.5" });
    expect((await eligibility(invoice)).eligible).toBe(true);
    const pause = await putPolicy({ enabled: false });
    expect(pause.status).toBe(200);
    const elig = await eligibility(invoice);
    expect(elig.eligible).toBe(false);
    expect(elig.failed_checks).toContain("AUTOMATION_PAUSED");
    const submits = g.ledger.submits.length;
    const blocked = await g.post(invoice, key("paused"));
    expect(blocked.body.status).toBe("blocked");
    expect(blocked.body.failure_code).toBe("AUTOMATION_PAUSED");
    expect(g.ledger.submits.length).toBe(submits);
    // resuming loosens a protection: refused without confirmation, and still paused
    const refused = await putPolicy({ enabled: true });
    expect(refused.status).toBe(422);
    expect((await eligibility(invoice)).eligible).toBe(false);
    const resumed = await putPolicy({ enabled: true, confirm_risky: true });
    expect(resumed.status).toBe(200);
    expect((await eligibility(invoice)).eligible).toBe(true);
    const ok = await g.post(invoice, key("resumed"));
    expect(ok.body.status).toBe("validated");
    const events = (await listAuditForBusiness(g.db.adminPool, w.scenario.businessId, { limit: 100 })).filter((e) => e.event_type === "policy.updated");
    expect(events.map((e) => (e.metadata.changed as string[]).join(","))).toEqual(["enabled", "enabled", "max_payment_amount"]);
    expect(events[0]?.metadata).toMatchObject({ risky: true, confirmed: true });
    expect(await verifyAuditChain(g.db.adminPool, w.scenario.businessId)).toBe(true);
  });
  it("the guard role still cannot change the policy itself", async () => {
    const before = (await getPolicyForWeb(g.db.adminPool, w.scenario.businessId))!;
    expect(await policyAmountWriteAttempt(g.db.guardPool)).toBe("42501");
    expect(await getPolicyForWeb(g.db.adminPool, w.scenario.businessId)).toEqual(before);
  });
});
