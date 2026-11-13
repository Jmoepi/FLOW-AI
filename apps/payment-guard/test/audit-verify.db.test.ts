import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditIntegrity, ACK_ENV } from "../src/jobs/audit-verify";
import { randomUUID } from "node:crypto";
import { createExecutor } from "../src/services/execute";
import { requestPayment } from "../src/services/payments";
import { createLogger } from "../src/logger";
import { appendAudit, getPayment } from "@flow-ai/database";
import { auditEventTypes, tamperAuditRow } from "@flow-ai/database/testing";
import { createHarness, key, type Harness } from "./db-harness";
import { bearer } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe("audit chain verify job against real Postgres", () => {
  it("detects a tampered audit row, shows degraded readiness, blocks execution until acknowledged", async () => {
    const lines: string[] = [];
    const s = await h.scenario();
    for (const t of ["a.one", "a.two", "a.three"]) {
      await appendAudit(h.db.guardPool, { business_id: s.businessId, actor_type: "system", event_type: t, entity_type: "payment", entity_id: "p1" });
    }
    const env: NodeJS.ProcessEnv = { ...h.env };
    const integrity = createAuditIntegrity({ pool: h.db.guardPool, config: { ...h.config, businessId: s.businessId }, env: () => env, logger: createLogger((l) => lines.push(l)) });
    const guardDeps = { ...h.deps, config: { ...h.config, businessId: s.businessId }, env: () => env, integrity };

    expect((await integrity.runOnce()).state).toBe("ok");

    // A payment reserved before the break (never signed).
    const reservedInvoice = await h.invoice(s);
    const reservedResult = await requestPayment(h.reserveOnlyDeps, { invoice_id: reservedInvoice, idempotency_key: key("pre-break") }, randomUUID());
    expect(reservedResult.body.status).toBe("reserved");
    const reserved = reservedResult.body.payment_id as string;

    await tamperAuditRow(h.db.adminPool, s.businessId);
    const after = await integrity.runOnce();
    expect(after).toMatchObject({ state: "broken", blocked: true });
    expect(lines.some((l) => l.includes("audit.chain_broken"))).toBe(true);
    expect(lines.join("\n")).not.toContain(s.businessId);

    // Readiness is degraded without leaking any data.
    const { buildApp } = await import("../src/app");
    const { app } = await buildApp(guardDeps);
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: "degraded", db: true, ledger: true, audit_chain: "broken" });
    expect(ready.body).not.toContain(s.businessId);
    const status = await app.inject({ method: "GET", url: "/internal/status", headers: bearer() });
    expect(status.json()).toMatchObject({ kill_switch: "disabled", audit_chain: "broken" });

    // A new payment request is blocked and nothing is signed or submitted.
    const invoice = await h.invoice(s);
    const blocked = await app.inject({
      method: "POST", url: "/internal/payment-requests", headers: { ...bearer(), "content-type": "application/json" },
      payload: JSON.stringify({ invoice_id: invoice, idempotency_key: key("audit-block") }),
    });
    expect(blocked.json()).toMatchObject({ status: "blocked", policy_decision: { decision_code: "EXECUTION_DISABLED" } });
    expect(h.ledger.submits).toHaveLength(0);

    // Executor guard: a payment reserved before the break is cancelled unsigned, not signed.
    const done = await createExecutor(guardDeps).execute(reserved);
    expect(done).toMatchObject({ status: "cancelled", failure_code: "EXECUTION_DISABLED" });
    expect(done?.signed_blob ?? null).toBeNull();
    expect(await getPayment(h.db.guardPool, reserved)).toMatchObject({ status: "cancelled" });
    expect(await auditEventTypes(h.db.adminPool, reserved)).not.toContain("payment.signed");
    expect(h.ledger.submits).toHaveLength(0);
    await app.close();

    // The operator acknowledges the exact break id: execution is allowed again, the state stays visibly broken.
    env[ACK_ENV] = integrity.breakId() ?? "";
    expect(integrity.status(env)).toMatchObject({ state: "broken", blocked: false });
  });
});
