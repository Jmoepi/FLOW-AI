import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createTestDatabase, type TestDatabase } from "../src/testing";
import { loadMigrations } from "../src/migrate";
import { localAdminConfig } from "../src/local";
import {
  addBusinessMember,
  appendAudit,
  bumpAttempt,
  createCredential,
  createSession,
  findCredentialByEmail,
  getAttempts,
  getMembership,
  getPolicyForWeb,
  getSessionByHash,
  listAuditForBusiness,
  listSuppliersForBusiness,
  lockPolicyForWeb,
  recordLoginFailure,
  resetLoginFailures,
  revokeAllSessionsForUser,
  revokeSession,
  setSupplierFlags,
  touchSession,
  updatePolicyVersioned,
  verifyAuditChain,
  withWebTx,
  withWebUserTx,
} from "../src/repos";
import { makeBusiness, sqlState, type Fixture } from "./helpers";
let db: TestDatabase;
let a: Fixture;
let b: Fixture;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const owner = randomUUID();
/** Runs `fn` as flow_web in a transaction scoped to a business (what withWebTx does), without the repo layer. */
async function asBusiness<T>(businessId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.webPool.connect();
  try {
    await c.query("BEGIN");
    if (businessId !== null) await c.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    const out = await fn(c);
    await c.query("ROLLBACK");
    return out;
  } finally {
    c.release();
  }
}
const state = async (businessId: string | null, sql: string, values: unknown[] = []): Promise<string> => {
  const c = await db.webPool.connect();
  try {
    await c.query("BEGIN");
    if (businessId !== null) await c.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    return await sqlState(c.query(sql, values));
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
};
beforeAll(async () => {
  db = await createTestDatabase();
  a = await makeBusiness(db.adminPool);
  b = await makeBusiness(db.adminPool);
});
afterAll(async () => {
  await db.drop();
});
describe("flow_web role and migration 0006", () => {
  it("is a plain login role: not superuser, not BYPASSRLS, cannot create roles or databases", async () => {
    const r = await db.adminPool.query("SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin FROM pg_roles WHERE rolname = 'flow_web'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolcanlogin: true });
    expect((await db.webPool.query("SELECT current_user AS u")).rows[0].u).toBe("flow_web");
  });
  it("re-running the migration SQL is a no-op (idempotent)", async () => {
    const file = loadMigrations().find((m) => m.version === "0006");
    expect(file).toBeDefined();
    const c = new pg.Client(localAdminConfig(db.secrets, db.name));
    await c.connect();
    try {
      await c.query(file?.sql ?? "");
      await c.query(file?.sql ?? "");
    } finally {
      await c.end();
    }
    expect((await db.webPool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
  });
  it("has RLS enabled and forced on the new tables, and the guard cannot touch them", async () => {
    const r = await db.adminPool.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('web_credentials','web_sessions','login_attempts')");
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) expect([row.relname, row.relrowsecurity, row.relforcerowsecurity]).toEqual([row.relname, true, true]);
    for (const t of ["web_credentials", "web_sessions", "login_attempts"]) {
      expect(await sqlState(db.guardPool.query(`SELECT * FROM ${t}`)), t).toBe("42501");
      expect(await sqlState(db.guardPool.query(`INSERT INTO ${t} DEFAULT VALUES`)), t).toBe("42501");
    }
  });
});
describe("tenant isolation (RLS keyed on app.business_id)", () => {
  it("returns only the scoped business and nothing without the setting", async () => {
    expect((await asBusiness(a.businessId, (c) => c.query("SELECT business_id FROM suppliers"))).rows.map((r) => r.business_id)).toEqual([a.businessId]);
    expect((await asBusiness(a.businessId, (c) => c.query("SELECT id FROM businesses"))).rows.map((r) => r.id)).toEqual([a.businessId]);
    for (const t of ["suppliers", "treasury_policies", "treasury_wallets", "invoices", "payments", "daily_spend_reservations", "audit_events", "businesses", "balance_snapshots", "business_members"]) {
      expect((await asBusiness(null, (c) => c.query(`SELECT 1 FROM ${t}`))).rowCount, `no setting: ${t}`).toBe(0);
    }
    expect((await asBusiness("", (c) => c.query("SELECT 1 FROM suppliers"))).rowCount).toBe(0);
  });
  it("cannot read or update another tenant's policy and supplier", async () => {
    const rows = await asBusiness(a.businessId, (c) => c.query("SELECT id FROM treasury_policies WHERE business_id = $1", [b.businessId]));
    expect(rows.rowCount).toBe(0);
    const upd = await asBusiness(a.businessId, (c) => c.query("UPDATE treasury_policies SET enabled = false WHERE business_id = $1", [b.businessId]));
    expect(upd.rowCount).toBe(0);
    const sup = await asBusiness(a.businessId, (c) => c.query("UPDATE suppliers SET is_approved = false WHERE id = $1", [b.supplierId]));
    expect(sup.rowCount).toBe(0);
    const stored = await db.adminPool.query("SELECT enabled FROM treasury_policies WHERE business_id = $1", [b.businessId]);
    expect(stored.rows[0].enabled).toBe(true);
  });
  it("cannot move a row into another tenant (WITH CHECK)", async () => {
    expect(await state(a.businessId, "UPDATE suppliers SET business_id = $2 WHERE id = $1", [a.supplierId, b.businessId])).toBe("42501");
  });
});
describe("least privilege", () => {
  it("can change the owner-controlled policy columns and supplier flags of its own business", async () => {
    await withWebTx(db.webPool, a.businessId, async (c) => {
      const r = await c.query("UPDATE treasury_policies SET enabled = false, max_payment_amount = '1', daily_spend_limit = '2', minimum_reserve = '0', allowed_assets = '[]'::jsonb, valid_until = NULL, version = version + 1, updated_by = 'x', updated_at = now() WHERE business_id = $1", [a.businessId]);
      expect(r.rowCount).toBe(1);
      const s = await c.query("UPDATE suppliers SET is_approved = false, is_active = false, updated_at = now() WHERE id = $1", [a.supplierId]);
      expect(s.rowCount).toBe(1);
      await c.query("ROLLBACK");
      await c.query("BEGIN");
    });
  });
  it("cannot change protected columns, wallets, businesses, invoices, payments or reservations", async () => {
    const id = a.businessId;
    const cases: [string, string][] = [
      ["UPDATE suppliers SET name = 'x'", "supplier name"],
      ["UPDATE suppliers SET xrpl_address = 'rAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'", "supplier address"],
      ["UPDATE suppliers SET business_id = business_id", "supplier business_id"],
      ["UPDATE treasury_policies SET business_id = business_id", "policy business_id"],
      ["UPDATE treasury_policies SET id = id", "policy id"],
      ["UPDATE businesses SET timezone = 'UTC'", "business timezone"],
      ["UPDATE treasury_wallets SET is_active = false", "wallet update"],
      ["UPDATE treasury_wallets SET address = address", "wallet address"],
      ["UPDATE invoices SET status = 'paid'", "invoice update"],
      ["UPDATE payments SET status = 'failed'", "payment update"],
      ["UPDATE daily_spend_reservations SET amount = 0", "reservation update"],
      ["INSERT INTO payments (business_id) VALUES (gen_random_uuid())", "payment insert"],
      ["INSERT INTO daily_spend_reservations (business_id) VALUES (gen_random_uuid())", "reservation insert"],
      ["INSERT INTO treasury_wallets (business_id) VALUES (gen_random_uuid())", "wallet insert"],
      ["INSERT INTO invoices (business_id) VALUES (gen_random_uuid())", "invoice insert"],
      ["INSERT INTO suppliers (business_id) VALUES (gen_random_uuid())", "supplier insert"],
      ["INSERT INTO treasury_policies (business_id) VALUES (gen_random_uuid())", "policy insert"],
      ["INSERT INTO businesses (name) VALUES ('x')", "business insert"],
      ["INSERT INTO business_members (business_id, user_id, role) VALUES (gen_random_uuid(), gen_random_uuid(), 'owner')", "member insert"],
      ["UPDATE business_members SET role = 'owner'", "member update"],
      ["INSERT INTO web_credentials (email, password_hash) VALUES ('x@y.zz', repeat('x', 30))", "credential insert"],
      ["UPDATE web_credentials SET email = 'z@y.zz'", "credential email"],
      ["DELETE FROM web_credentials", "credential delete"],
      ["DELETE FROM web_sessions", "session delete"],
      ["UPDATE web_sessions SET user_id = user_id", "session user"],
      ["UPDATE web_sessions SET role = 'owner'", "session role"],
      ["UPDATE web_sessions SET business_id = business_id", "session business"],
      ["UPDATE web_sessions SET absolute_expires_at = now()", "session expiry"],
    ];
    for (const [sql, label] of cases) expect(await state(id, sql), label).toBe("42501");
    for (const t of ["payments", "daily_spend_reservations", "treasury_wallets", "invoices", "suppliers", "treasury_policies", "businesses", "business_members", "agent_runs", "agent_run_events", "agent_run_payment_requests", "audit_events", "balance_snapshots"]) {
      expect(await state(id, `DELETE FROM ${t}`), `delete ${t}`).toBe("42501");
    }
    expect(await state(id, "INSERT INTO balance_snapshots (wallet_id, xrp_balance) VALUES (gen_random_uuid(), 1)")).toBe("42501");
    for (const sql of ["INSERT INTO agent_runs (business_id, status, trigger, mode) VALUES (gen_random_uuid(), 'running', 'manual', 'deterministic')", "UPDATE agent_runs SET status = 'paid'", "UPDATE agent_run_events SET ok = true", "INSERT INTO agent_run_events (run_id, business_id, seq, kind) VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'note')", "INSERT INTO agent_run_payment_requests (run_id, business_id, invoice_id, idempotency_key, observed_status) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'abcdefgh12', 'blocked')", "UPDATE agent_runs SET client_status = 'paid'"]) expect(await state(id, sql), sql).toBe("42501");
    expect(await state(id, "SELECT * FROM schema_migrations")).toBe("42501");
  });
  it("cannot UPDATE, DELETE or TRUNCATE audit_events, but can append for its own business only", async () => {
    await appendAudit(db.adminPool, { business_id: a.businessId, actor_type: "system", event_type: "test.seed", entity_type: "test", entity_id: "1" });
    expect(await state(a.businessId, "UPDATE audit_events SET actor_id = 'x'")).toBe("42501");
    expect(await state(a.businessId, "DELETE FROM audit_events")).toBe("42501");
    expect(await state(a.businessId, "TRUNCATE audit_events")).toBe("42501");
    expect(await state(a.businessId, "TRUNCATE treasury_policies")).toBe("42501");
    const ev = await withWebTx(db.webPool, a.businessId, (c) =>
      appendAudit(c, { business_id: a.businessId, actor_type: "human", actor_id: owner, event_type: "policy.updated", entity_type: "treasury_policy", entity_id: "p", metadata: { n: 1 }, request_id: "req-1" }),
    );
    expect(ev.seq).toBeGreaterThan(1);
    await expect(withWebTx(db.webPool, a.businessId, (c) => appendAudit(c, { business_id: b.businessId, actor_type: "human", event_type: "x.y", entity_type: "t", entity_id: "1" }))).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(appendAudit(db.webPool, { business_id: a.businessId, actor_type: "human", event_type: "x.y", entity_type: "t", entity_id: "1" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await verifyAuditChain(db.adminPool, a.businessId)).toBe(true);
  });
});
describe("web repos", () => {
  it("updatePolicyVersioned bumps the version once and returns null for a stale version", async () => {
    const patch = { enabled: true, max_payment_amount: "1.5", daily_spend_limit: "3", minimum_reserve: "0", allowed_assets: [], valid_until: null };
    const first = await withWebTx(db.webPool, b.businessId, async (c) => {
      const before = await lockPolicyForWeb(c, b.businessId);
      return { before, after: await updatePolicyVersioned(c, b.businessId, before?.version ?? -1, patch, owner, new Date()) };
    });
    expect(first.after?.version).toBe((first.before?.version ?? 0) + 1);
    expect(first.after?.max_payment_amount).toBe("1.5");
    expect(first.after?.updated_by).toBe(owner);
    const stale = await withWebTx(db.webPool, b.businessId, (c) => updatePolicyVersioned(c, b.businessId, first.before?.version ?? -1, patch, owner, new Date()));
    expect(stale).toBeNull();
    await expect(withWebTx(db.webPool, b.businessId, (c) => updatePolicyVersioned(c, b.businessId, 1, { ...patch, max_payment_amount: "1e3" }, owner, new Date()))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(withWebTx(db.webPool, b.businessId, (c) => updatePolicyVersioned(c, b.businessId, 1, patch, "not-a-uuid", new Date()))).rejects.toMatchObject({ code: "INVALID_ID" });
    expect((await withWebTx(db.webPool, b.businessId, (c) => getPolicyForWeb(c, a.businessId)))).toBeNull();
  });
  it("suppliers: list is tenant-scoped; setSupplierFlags only touches the own tenant", async () => {
    const list = await withWebTx(db.webPool, a.businessId, (c) => listSuppliersForBusiness(c, a.businessId));
    expect(list.map((s) => s.id)).toEqual([a.supplierId]);
    const other = await withWebTx(db.webPool, a.businessId, (c) => setSupplierFlags(c, a.businessId, b.supplierId, { is_approved: false }, new Date()));
    expect(other).toBeNull();
    const own = await withWebTx(db.webPool, a.businessId, (c) => setSupplierFlags(c, a.businessId, a.supplierId, { is_approved: false }, new Date()));
    expect(own?.is_approved).toBe(false);
    expect(own?.is_active).toBe(true);
  });
  it("audit listing is tenant-scoped, newest first, bounded and exposes no hashes", async () => {
    const rows = await withWebTx(db.webPool, a.businessId, (c) => listAuditForBusiness(c, a.businessId, { limit: 1 }));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain("row_hash");
    expect(await withWebTx(db.webPool, b.businessId, (c) => listAuditForBusiness(c, a.businessId))).toEqual([]);
    await expect(withWebTx(db.webPool, a.businessId, (c) => listAuditForBusiness(c, a.businessId, { limit: 101 }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("audit listing orders by the numeric sequence (not text) and pages with beforeSeq", async () => {
    for (let i = 0; i < 12; i++) await appendAudit(db.adminPool, { business_id: b.businessId, actor_type: "system", event_type: "test.order", entity_type: "test", entity_id: String(i) });
    const all = await withWebTx(db.webPool, b.businessId, (c) => listAuditForBusiness(c, b.businessId, { limit: 100 }));
    const seqs = all.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => y - x));
    expect(seqs[0]).toBeGreaterThanOrEqual(12);
    const page = await withWebTx(db.webPool, b.businessId, (c) => listAuditForBusiness(c, b.businessId, { limit: 3, beforeSeq: 10 }));
    expect(page.map((r) => r.seq)).toEqual([9, 8, 7]);
  });
  it("credentials, membership, sessions and attempt counters work through the web role", async () => {
    const cred = await createCredential(db.adminPool, { email: `Owner-${randomUUID()}@Example.COM`, password_hash: `scrypt$${"x".repeat(40)}` });
    expect(cred.email).toBe(cred.email.toLowerCase());
    await addBusinessMember(db.adminPool, { business_id: a.businessId, user_id: cred.user_id, role: "owner" });
    expect((await findCredentialByEmail(db.webPool, cred.email.toUpperCase()))?.user_id).toBe(cred.user_id);
    expect(await findCredentialByEmail(db.webPool, "nobody@example.com")).toBeNull();
    expect(await withWebUserTx(db.webPool, cred.user_id, (c) => getMembership(c, cred.user_id))).toEqual({ business_id: a.businessId, role: "owner" });
    expect(await getMembership(db.webPool, cred.user_id)).toBeNull();
    expect(await withWebUserTx(db.webPool, randomUUID(), (c) => getMembership(c, cred.user_id))).toBeNull();
    const now = new Date();
    const token = sha(randomBytes(32).toString("hex"));
    const s = await createSession(db.webPool, { id_hash: token, user_id: cred.user_id, business_id: a.businessId, role: "owner", csrf_hash: sha("c"), now, absolute_expires_at: new Date(now.getTime() + 3600_000) });
    expect(s.revoked_at).toBeNull();
    await touchSession(db.webPool, token, new Date(now.getTime() + 1000));
    expect((await getSessionByHash(db.webPool, token))?.last_seen_at).toBe(new Date(now.getTime() + 1000).toISOString());
    await revokeSession(db.webPool, token, now);
    expect((await getSessionByHash(db.webPool, token))?.revoked_at).not.toBeNull();
    await expect(getSessionByHash(db.webPool, "nothex")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await revokeAllSessionsForUser(db.webPool, cred.user_id, now)).toBe(0);
    const f1 = await recordLoginFailure(db.webPool, cred.user_id, now, { threshold: 2, baseSeconds: 10, maxSeconds: 100 });
    expect(f1).toEqual({ failed_count: 1, locked_until: null });
    const f2 = await recordLoginFailure(db.webPool, cred.user_id, now, { threshold: 2, baseSeconds: 10, maxSeconds: 100 });
    expect(f2.locked_until).toBe(new Date(now.getTime() + 10_000).toISOString());
    const f3 = await recordLoginFailure(db.webPool, cred.user_id, now, { threshold: 2, baseSeconds: 10, maxSeconds: 100 });
    expect(f3.locked_until).toBe(new Date(now.getTime() + 20_000).toISOString());
    await resetLoginFailures(db.webPool, cred.user_id);
    expect((await findCredentialByEmail(db.webPool, cred.email))?.failed_count).toBe(0);
    const key = sha("1.2.3.4");
    expect(await bumpAttempt(db.webPool, key, now)).toBe(1);
    expect(await bumpAttempt(db.webPool, key, now)).toBe(2);
    expect(await getAttempts(db.webPool, key, now)).toBe(2);
    expect(await getAttempts(db.webPool, key, new Date(now.getTime() + 60_000))).toBe(0);
  });
});
