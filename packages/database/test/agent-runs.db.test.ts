import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing";
import { loadMigrations } from "../src/migrate";
import { localAdminConfig } from "../src/local";
import pg from "pg";
import { withTransaction } from "../src/tx";
import { DbError } from "../src/errors";
import {
  appendAgentRunEvent, createAgentRun, finishAgentRun, getAgentRun, getRunningAgentRunId, interruptAgentRun, listAgentRunEvents, listAgentRunPaymentRequests,
  listAgentRunsForBusiness, lockStaleRunningRuns, recordAgentRunPaymentRequest, verifyAuditChain, withWebTx,
} from "../src/repos";
import { makeBusiness, makePayment, paymentAt, sqlState, type Fixture } from "./helpers";

let db: TestDatabase;
let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  db = await createTestDatabase();
  a = await makeBusiness(db.adminPool);
  b = await makeBusiness(db.adminPool);
});
afterAll(async () => {
  await db.drop();
});

const start = (f: Fixture) => createAgentRun(db.guardPool, { business_id: f.businessId, trigger: "manual", mode: "deterministic" });
const append = (runId: string, f: Fixture, ev = { kind: "note" }) => withTransaction(db.guardPool, (c) => appendAgentRunEvent(c, runId, f.businessId, ev));
const finish = (runId: string, f: Fixture, status: "blocked" | "paid" | "no_candidate" = "no_candidate") =>
  withTransaction(db.guardPool, (c) => finishAgentRun(c, runId, f.businessId, { status, summary: "done", tool_call_count: 1 }));
const expectDb = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(DbError);
  expect((err as DbError).code).toBe(code);
};

describe("migration 0007", () => {
  it("is idempotent when re-run", async () => {
    const file = loadMigrations().find((m) => m.version === "0007");
    expect(file).toBeDefined();
    const c = new pg.Client(localAdminConfig(db.secrets, db.name));
    await c.connect();
    try {
      await c.query(file?.sql ?? "");
      await c.query(file?.sql ?? "");
    } finally {
      await c.end();
    }
  });
  it("enables and forces RLS and grants flow_guard no DELETE/TRUNCATE", async () => {
    const r = await db.adminPool.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('agent_runs','agent_run_events')");
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect([row.relrowsecurity, row.relforcerowsecurity]).toEqual([true, true]);
    for (const t of ["agent_runs", "agent_run_events"]) {
      expect(await sqlState(db.guardPool.query(`DELETE FROM ${t}`)), t).toBe("42501");
      expect(await sqlState(db.guardPool.query(`TRUNCATE ${t}`)), t).toBe("42501");
    }
  });
});

describe("migration 0008 (guard-derived outcomes)", () => {
  const record = (runId: string, f: Fixture, r: { invoice_id: string; idempotency_key: string; payment_id: string | null; observed_status: string }) =>
    withTransaction(db.guardPool, (c) => recordAgentRunPaymentRequest(c, runId, f.businessId, { observed_decision_code: null, ...r }));
  it("is idempotent when re-run", async () => {
    const file = loadMigrations().find((m) => m.version === "0008");
    expect(file).toBeDefined();
    const c = new pg.Client(localAdminConfig(db.secrets, db.name));
    await c.connect();
    try {
      await c.query(file?.sql ?? "");
      await c.query(file?.sql ?? "");
    } finally {
      await c.end();
    }
  });
  it("enables and forces RLS; flow_guard may only SELECT/INSERT; flow_web may only SELECT its own tenant", async () => {
    const r = await db.adminPool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'agent_run_payment_requests'");
    expect(r.rows.map((x) => [x.relrowsecurity, x.relforcerowsecurity])).toEqual([[true, true]]);
    expect(await sqlState(db.guardPool.query("DELETE FROM agent_run_payment_requests"))).toBe("42501");
    expect(await sqlState(db.guardPool.query("UPDATE agent_run_payment_requests SET observed_status = 'blocked'"))).toBe("42501");
    expect(await sqlState(db.guardPool.query("TRUNCATE agent_run_payment_requests"))).toBe("42501");
    expect(await sqlState(db.webPool.query("DELETE FROM agent_run_payment_requests"))).toBe("42501");
  });
  it("records requests only for a running run of the same tenant, with in-tenant references, append-only and capped", async () => {
    const run = await start(a);
    expect(await getRunningAgentRunId(db.guardPool, a.businessId)).toBe(run.id);
    const mine = await makePayment(db.adminPool, a);
    const foreign = await makePayment(db.adminPool, b);
    expect(await record(run.id, a, { invoice_id: mine.invoiceId, idempotency_key: "request-key-1", payment_id: mine.id, observed_status: "requested" })).toBe(true);
    expect(await record(run.id, a, { invoice_id: mine.invoiceId, idempotency_key: "request-key-1", payment_id: mine.id, observed_status: "requested" })).toBe(false); // replay: no-op
    await expectDb(record(run.id, a, { invoice_id: foreign.invoiceId, idempotency_key: "request-key-2", payment_id: null, observed_status: "blocked" }), "CHECK_VIOLATION"); // foreign invoice
    await expectDb(record(run.id, a, { invoice_id: mine.invoiceId, idempotency_key: "request-key-3", payment_id: foreign.id, observed_status: "requested" }), "CHECK_VIOLATION"); // foreign payment
    await expectDb(record(run.id, b, { invoice_id: foreign.invoiceId, idempotency_key: "request-key-4", payment_id: null, observed_status: "blocked" }), "CHECK_VIOLATION"); // other tenant's run
    const rows = await withTransaction(db.guardPool, (c) => listAgentRunPaymentRequests(c, run.id, a.businessId));
    expect(rows.map((r) => [r.idempotency_key, r.payment_status])).toEqual([["request-key-1", "requested"]]);
    expect(await sqlState(db.adminPool.query("UPDATE agent_run_payment_requests SET observed_status = 'blocked'"))).toBe("55000");
    expect(await sqlState(db.adminPool.query("DELETE FROM agent_run_payment_requests"))).toBe("55000");
    for (let i = 2; i <= 5; i++) await record(run.id, a, { invoice_id: mine.invoiceId, idempotency_key: `request-key-1${String(i)}`, payment_id: null, observed_status: "blocked" });
    await expectDb(record(run.id, a, { invoice_id: mine.invoiceId, idempotency_key: "request-key-over", payment_id: null, observed_status: "blocked" }), "CHECK_VIOLATION"); // 6th
    await finish(run.id, a);
    await expectDb(record(run.id, a, { invoice_id: mine.invoiceId, idempotency_key: "request-key-late", payment_id: null, observed_status: "blocked" }), "STATE_VIOLATION"); // not running any more
    expect(await getRunningAgentRunId(db.guardPool, a.businessId)).toBeNull();
  });
  it("refuses 'paid' unless one of the run's own requested payments is validated", async () => {
    const run = await start(a);
    const pending = await paymentAt(db.adminPool, a, "pending_confirmation");
    await record(run.id, a, { invoice_id: pending.invoiceId, idempotency_key: "paid-check-1", payment_id: pending.id, observed_status: "pending_confirmation" });
    await expectDb(withTransaction(db.guardPool, (c) => finishAgentRun(c, run.id, a.businessId, { status: "paid", summary: "x", tool_call_count: 1 })), "CHECK_VIOLATION"); // no payment
    await expectDb(
      withTransaction(db.guardPool, (c) => finishAgentRun(c, run.id, a.businessId, { status: "paid", summary: "x", tool_call_count: 1, payment_id: pending.id })),
      "CHECK_VIOLATION",
    ); // not validated
    const done = await withTransaction(db.guardPool, (c) => finishAgentRun(c, run.id, a.businessId, { status: "pending", client_status: "paid", summary: "x", tool_call_count: 1, payment_id: pending.id }));
    expect(done).toMatchObject({ status: "pending", client_status: "paid", payment_id: pending.id });
  });
  it("keeps client_status separate and immutable once finished", async () => {
    const run = await start(a);
    expect(await sqlState(db.guardPool.query("UPDATE agent_runs SET status = 'paid' WHERE id = $1", [run.id]))).toBe("23514");
    const done = await withTransaction(db.guardPool, (c) => finishAgentRun(c, run.id, a.businessId, { status: "failed", client_status: "paid", summary: "x", tool_call_count: 0 }));
    expect(done).toMatchObject({ status: "failed", client_status: "paid" });
    expect(await sqlState(db.adminPool.query("UPDATE agent_runs SET client_status = 'failed' WHERE id = $1", [run.id]))).toBe("55000");
    expect(await sqlState(db.adminPool.query("INSERT INTO agent_runs (business_id, status, trigger, mode, client_status) VALUES ($1,'running','manual','llm','paid')", [b.businessId]))).toBe("55000");
  });
});
describe("agent runs (flow_guard)", () => {
  it("creates a running run, appends gap-free events, finishes once", async () => {
    const run = await start(a);
    expect(run.status).toBe("running");
    expect(run.completed_at).toBeNull();
    expect(await append(run.id, a)).toEqual({ seq: 1 });
    expect(await append(run.id, a, { kind: "tool_call" })).toEqual({ seq: 2 });
    const done = await finish(run.id, a);
    expect(done?.status).toBe("no_candidate");
    expect(done?.completed_at).not.toBeNull();
    expect(await finish(run.id, a)).toBeNull();
    await expectDb(append(run.id, a), "STATE_VIOLATION");
    expect((await getAgentRun(db.guardPool, run.id, a.businessId))?.status).toBe("no_candidate");
  });
  it("allows only one running run per business (the guard-side lock), including under concurrency", async () => {
    const results = await Promise.allSettled([start(b), start(b), start(b), start(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as DbError).code).toBe("UNIQUE_VIOLATION");
    const running = await db.adminPool.query("SELECT id FROM agent_runs WHERE business_id = $1 AND status = 'running'", [b.businessId]);
    expect(running.rows).toHaveLength(1);
    await finish(running.rows[0].id as string, b);
    const next = await start(b);
    await finish(next.id, b);
  });
  it("rejects a 33rd event, a seq gap, and an event on another tenant's run", async () => {
    const run = await start(a);
    for (let i = 0; i < 32; i++) await append(run.id, a);
    await expectDb(append(run.id, a), "STATE_VIOLATION");
    expect(await append(run.id, b)).toBeNull();
    const gap = await sqlState(db.guardPool.query("INSERT INTO agent_run_events (run_id, business_id, seq, kind) VALUES ($1,$2,40,'note')", [run.id, a.businessId]));
    expect(gap).toBe("23514");
    const wrongTenant = await sqlState(db.guardPool.query("INSERT INTO agent_run_events (run_id, business_id, seq, kind) VALUES ($1,$2,33,'note')", [run.id, b.businessId]));
    expect(wrongTenant).toBe("23514");
    await finish(run.id, a);
  });
  it("makes events append-only and terminal runs immutable", async () => {
    const run = await start(a);
    await append(run.id, a);
    expect(await sqlState(db.guardPool.query("UPDATE agent_run_events SET ok = true WHERE run_id = $1", [run.id]))).toBe("42501");
    expect(await sqlState(db.adminPool.query("UPDATE agent_run_events SET ok = true WHERE run_id = $1", [run.id]))).toBe("55000");
    expect(await sqlState(db.adminPool.query("DELETE FROM agent_run_events WHERE run_id = $1", [run.id]))).toBe("55000");
    expect(await sqlState(db.adminPool.query("DELETE FROM agent_runs WHERE id = $1", [run.id]))).toBe("55000");
    await finish(run.id, a);
    expect(await sqlState(db.adminPool.query("UPDATE agent_runs SET status = 'running', completed_at = NULL WHERE id = $1", [run.id]))).toBe("55000");
    expect(await sqlState(db.adminPool.query("UPDATE agent_runs SET summary = 'x' WHERE id = $1", [run.id]))).toBe("55000");
  });
  it("blocks writes to identity columns and cross-tenant references", async () => {
    const run = await start(a);
    expect(await sqlState(db.guardPool.query("UPDATE agent_runs SET business_id = $2 WHERE id = $1", [run.id, b.businessId]))).toBe("42501");
    expect(await sqlState(db.guardPool.query("UPDATE agent_runs SET mode = 'llm' WHERE id = $1", [run.id]))).toBe("42501");
    expect(await sqlState(db.guardPool.query("UPDATE agent_runs SET trigger = 'interval' WHERE id = $1", [run.id]))).toBe("42501");
    expect(await sqlState(db.guardPool.query("UPDATE agent_runs SET started_at = now() WHERE id = $1", [run.id]))).toBe("42501");
    expect(await sqlState(db.adminPool.query("UPDATE agent_runs SET started_at = now() - interval '1 day' WHERE id = $1", [run.id]))).toBe("55000");
    const other = await makePayment(db.adminPool, b);
    await expectDb(
      withTransaction(db.guardPool, (c) => finishAgentRun(c, run.id, a.businessId, { status: "paid", summary: "x", tool_call_count: 1, payment_id: other.id })),
      "CHECK_VIOLATION",
    );
    // M-1: even the same tenant's payment is refused unless THIS run requested it (recorded by the guard).
    const own = await paymentAt(db.adminPool, a, "validated");
    await expectDb(
      withTransaction(db.guardPool, (c) => finishAgentRun(c, run.id, a.businessId, { status: "paid", summary: "x", tool_call_count: 1, payment_id: own.id })),
      "CHECK_VIOLATION",
    );
    await withTransaction(db.guardPool, (c) =>
      recordAgentRunPaymentRequest(c, run.id, a.businessId, { invoice_id: own.invoiceId, idempotency_key: "key-for-own-payment", payment_id: own.id, observed_status: "validated", observed_decision_code: "ALLOWED" }),
    );
    const done = await withTransaction(db.guardPool, (c) =>
      finishAgentRun(c, run.id, a.businessId, {
        status: "paid", client_status: "paid", summary: "x", tool_call_count: 1, payment_id: own.id, decision_code: "ALLOWED", agent_reason: "because", effective_mode: "deterministic",
      }),
    );
    expect(done?.payment_id).toBe(own.id);
    expect(done?.client_status).toBe("paid");
    expect(done?.agent_reason).toBe("because");
  });
  it("rejects a run that does not start as running", async () => {
    const bad = await sqlState(db.adminPool.query("INSERT INTO agent_runs (business_id, status, trigger, mode) VALUES ($1,'paid','manual','llm')", [a.businessId]));
    expect(bad).toBe("55000");
    expect(await sqlState(db.adminPool.query("INSERT INTO agent_runs (business_id, status, trigger, mode) VALUES ($1,'bogus','manual','llm')", [a.businessId]))).toBe("55000");
  });
  it("sweeps stale running runs to interrupted exactly once; a late finish gets nothing", async () => {
    const run = await start(a);
    await append(run.id, a, { kind: "tool_call" });
    expect(await withTransaction(db.guardPool, (c) => lockStaleRunningRuns(c, 30, 10))).toEqual([]);
    await db.adminPool.query("UPDATE agent_runs SET last_activity_at = now() - interval '10 minutes' WHERE id = $1", [run.id]);
    const swept = await withTransaction(db.guardPool, async (c) => {
      const stale = await lockStaleRunningRuns(c, 30, 10);
      return Promise.all(stale.map((s) => interruptAgentRun(c, s, "Run did not finish; marked interrupted by the guard.")));
    });
    expect(swept.map((s) => s?.status)).toEqual(["interrupted"]);
    expect(swept[0]?.tool_call_count).toBe(1);
    expect(await finish(run.id, a)).toBeNull();
    expect(await withTransaction(db.guardPool, (c) => lockStaleRunningRuns(c, 30, 10))).toEqual([]);
  });
});

describe("agent runs (flow_web reads)", () => {
  it("lists only its own tenant, newest first, with events; cannot write", async () => {
    const run = await start(a);
    await append(run.id, a, { kind: "tool_call" });
    await finish(run.id, a, "blocked");
    const rows = await withWebTx(db.webPool, a.businessId, (c) => listAgentRunsForBusiness(c, a.businessId, { limit: 50 }));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.business_id === a.businessId)).toBe(true);
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((x, y) => y - x));
    const paged = await withWebTx(db.webPool, a.businessId, (c) => listAgentRunsForBusiness(c, a.businessId, { limit: 1, beforeSeq: rows[0]?.seq ?? 1 }));
    expect(paged[0]?.id).toBe(rows[1]?.id);
    const events = await withWebTx(db.webPool, a.businessId, (c) => listAgentRunEvents(c, a.businessId, [run.id]));
    expect(events).toHaveLength(1);
    // RLS: asking for another tenant's rows under this tenant's scope returns nothing.
    expect(await withWebTx(db.webPool, a.businessId, (c) => listAgentRunsForBusiness(c, b.businessId))).toEqual([]);
    expect(await withWebTx(db.webPool, a.businessId, (c) => listAgentRunEvents(c, b.businessId, [run.id]))).toEqual([]);
    await expect(withWebTx(db.webPool, a.businessId, (c) => listAgentRunsForBusiness(c, a.businessId, { limit: 51 }))).rejects.toBeInstanceOf(DbError);
  });
  it("keeps the audit chain intact", async () => {
    expect(await verifyAuditChain(db.guardPool, a.businessId)).toBe(true);
  });
});
