import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimAgentRunRequest, createAgentRunRequest, getLatestAgentRunRequest, withWebTx } from "../src/repos";
import { createTestDatabase, type TestDatabase } from "../src/testing";
import { makeBusiness, sqlState, type Fixture } from "./helpers";
let db: TestDatabase;
let a: Fixture;
let b: Fixture;
const USER = "00000000-0000-4000-8000-0000000000aa";
beforeAll(async () => {
  db = await createTestDatabase();
  a = await makeBusiness(db.adminPool);
  b = await makeBusiness(db.adminPool);
});
afterAll(async () => {
  await db.drop();
});
const asWeb = async (businessId: string, sql: string, values: unknown[] = []): Promise<string> => {
  const c = await db.webPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    return await sqlState(c.query(sql, values));
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
};
describe("agent_run_requests (migration 0009)", () => {
  it("enables and forces row level security and grants PUBLIC nothing", async () => {
    const r = await db.adminPool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'agent_run_requests'");
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await sqlState(db.noGrantPool.query("SELECT * FROM public.agent_run_requests"))).toBe("42501");
  });
  it("flow_web may insert and read only its own tenant, never delete, and never write another tenant", async () => {
    await withWebTx(db.webPool, a.businessId, (c) => createAgentRunRequest(c, a.businessId, USER));
    expect((await withWebTx(db.webPool, a.businessId, (c) => getLatestAgentRunRequest(c, a.businessId)))?.status).toBe("open");
    expect(await withWebTx(db.webPool, b.businessId, (c) => getLatestAgentRunRequest(c, a.businessId))).toBeNull();
    expect(await asWeb(b.businessId, "INSERT INTO agent_run_requests (business_id, requested_by) VALUES ($1, 'x')", [a.businessId])).toBe("42501");
    expect(await asWeb(a.businessId, "DELETE FROM agent_run_requests")).toBe("42501");
    expect(await asWeb(a.businessId, "UPDATE agent_run_requests SET requested_by = 'x'")).toBe("42501");
    expect(await asWeb(a.businessId, "INSERT INTO agent_run_requests (business_id, requested_by, status) VALUES ($1, 'x', 'claimed')", [a.businessId])).toBe("42501");
  });
  it("allows only one open request per business, but two businesses can each have one", async () => {
    await expect(withWebTx(db.webPool, a.businessId, (c) => createAgentRunRequest(c, a.businessId, USER))).rejects.toMatchObject({ code: "UNIQUE_VIOLATION" });
    await withWebTx(db.webPool, b.businessId, (c) => createAgentRunRequest(c, b.businessId, USER));
  });
  it("flow_guard can read and move status and claimed_at only, and cannot insert or delete", async () => {
    expect(await sqlState(db.guardPool.query("INSERT INTO agent_run_requests (business_id, requested_by) VALUES ($1, 'x')", [a.businessId]))).toBe("42501");
    expect(await sqlState(db.guardPool.query("DELETE FROM agent_run_requests"))).toBe("42501");
    expect(await sqlState(db.guardPool.query("UPDATE agent_run_requests SET requested_by = 'x'"))).toBe("42501");
    expect(await sqlState(db.guardPool.query("UPDATE agent_run_requests SET business_id = business_id"))).toBe("42501");
  });
  it("a claim is atomic: ten concurrent claimers produce exactly one winner", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => claimAgentRunRequest(db.guardPool, a.businessId)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await claimAgentRunRequest(db.guardPool, a.businessId)).toBeNull();
    expect((await withWebTx(db.webPool, a.businessId, (c) => getLatestAgentRunRequest(c, a.businessId)))?.status).toBe("claimed");
  });
  it("a claim never crosses businesses", async () => {
    const id = await claimAgentRunRequest(db.guardPool, b.businessId);
    expect(id).not.toBeNull();
    const row = await db.adminPool.query("SELECT business_id FROM agent_run_requests WHERE id = $1", [id]);
    expect(row.rows[0].business_id).toBe(b.businessId);
  });
  it("requests older than ten minutes expire instead of being claimed", async () => {
    await withWebTx(db.webPool, a.businessId, (c) => createAgentRunRequest(c, a.businessId, USER));
    await db.adminPool.query("UPDATE agent_run_requests SET requested_at = now() - interval '11 minutes' WHERE business_id = $1 AND status = 'open'", [a.businessId]);
    await db.adminPool.query("DELETE FROM agent_run_requests WHERE business_id = $1 AND status = 'claimed'", [a.businessId]);
    expect((await withWebTx(db.webPool, a.businessId, (c) => getLatestAgentRunRequest(c, a.businessId)))?.status).toBe("expired");
    expect(await claimAgentRunRequest(db.guardPool, a.businessId)).toBeNull();
    const rows = await db.adminPool.query("SELECT status FROM agent_run_requests WHERE business_id = $1 ORDER BY requested_at", [a.businessId]);
    expect(rows.rows.map((r: { status: string }) => r.status)).toEqual(["expired"]);
  });
  it("the web role can expire a stale open request but cannot claim a fresh one or reopen anything", async () => {
    await db.adminPool.query("DELETE FROM agent_run_requests WHERE business_id = $1", [a.businessId]);
    await withWebTx(db.webPool, a.businessId, (c) => createAgentRunRequest(c, a.businessId, USER));
    // A fresh open request: the policy hides it from UPDATE, so the statement changes nothing.
    const fresh = await db.webPool.connect();
    try {
      await fresh.query("BEGIN");
      await fresh.query("SELECT set_config('app.business_id', $1, true)", [a.businessId]);
      expect((await fresh.query("UPDATE agent_run_requests SET status = 'expired' WHERE status = 'open'")).rowCount).toBe(0);
      // Column grant lets the statement parse, but the policy only exposes stale open rows and only to the value 'expired'.
      expect((await fresh.query("UPDATE agent_run_requests SET status = 'claimed'")).rowCount).toBe(0);
    } finally {
      await fresh.query("ROLLBACK").catch(() => undefined);
      fresh.release();
    }
  });
});
describe("login_attempts delete policy (migration 0010)", () => {
  it("the web role can delete old windows only, the guard role nothing", async () => {
    const k = (c: string): string => c.repeat(64);
    await db.adminPool.query("DELETE FROM login_attempts");
    await db.adminPool.query("INSERT INTO login_attempts (key_hash, window_start, attempts) VALUES ($1, now() - interval '2 days', 1), ($2, now(), 1)", [k("1"), k("2")]);
    expect((await db.webPool.query("DELETE FROM login_attempts")).rowCount).toBe(1);
    expect((await db.adminPool.query("SELECT key_hash FROM login_attempts")).rows).toEqual([{ key_hash: k("2") }]);
    expect(await sqlState(db.guardPool.query("DELETE FROM login_attempts"))).toBe("42501");
  });
  it("re-applying every migration is clean (idempotent)", async () => {
    const { loadMigrations } = await import("../src/migrate");
    for (const f of loadMigrations().filter((m) => m.version === "0009" || m.version === "0010")) await db.adminPool.query(f.sql);
    expect((await db.adminPool.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'agent_run_requests'")).rows[0].n).toBe(5);
  });
});
