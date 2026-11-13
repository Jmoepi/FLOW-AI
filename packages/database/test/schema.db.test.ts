import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing";
import { appendAudit, verifyAuditChain } from "../src/repos";
import { migrate } from "../src/migrate";
import pg from "pg";
import { localAdminConfig } from "../src/local";
import { makeBusiness, sqlState, type Fixture } from "./helpers";

let db: TestDatabase;
let fx: Fixture;
const createdRoles: string[] = [];

const TABLES = [
  "businesses", "business_members", "treasury_wallets", "balance_snapshots", "suppliers", "invoices",
  "treasury_policies", "daily_spend_reservations", "payments", "agent_runs", "audit_events", "schema_migrations",
];

beforeAll(async () => {
  db = await createTestDatabase({
    // Simulate Supabase: anon/authenticated exist and get ALL on new public tables by default.
    beforeMigrate: async (admin) => {
      for (const role of ["anon", "authenticated"]) {
        const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
        if (exists.rowCount === 0) {
          await admin.query(`CREATE ROLE ${role} NOLOGIN`);
          createdRoles.push(role);
        }
        await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
        await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${role}`);
      }
    },
  });
  fx = await makeBusiness(db.adminPool);
});

afterAll(async () => {
  await db.drop();
  if (createdRoles.length > 0) {
    const c = new pg.Client(localAdminConfig(db.secrets, "postgres"));
    await c.connect();
    for (const r of createdRoles) await c.query(`DROP ROLE IF EXISTS ${r}`);
    await c.end();
  }
});

describe("migrations", () => {
  it("are idempotent: a second run applies nothing", async () => {
    const c = new pg.Client(localAdminConfig(db.secrets, db.name));
    await c.connect();
    try {
      const again = await migrate(c);
      expect(again.applied).toEqual([]);
      expect(again.skipped.length).toBe(5);
    } finally {
      await c.end();
    }
  });
  it("refuse a migration whose checksum changed after it was applied", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "mig-"));
    writeFileSync(path.join(dir, "0001_extensions_roles.sql"), "SELECT 1;");
    const c = new pg.Client(localAdminConfig(db.secrets, db.name));
    await c.connect();
    try {
      await expect(migrate(c, { dir })).rejects.toThrow(/changed after it was applied/);
    } finally {
      await c.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("row-level security (AZ-5)", () => {
  it("is enabled AND forced on every table in public", async () => {
    const r = await db.adminPool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1",
    );
    expect(r.rows.map((x) => x.relname).sort()).toEqual([...TABLES].sort());
    for (const row of r.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });
  it("flow_guard is not superuser, bypassrls, createdb, createrole, and has no password in any migration", async () => {
    const r = await db.adminPool.query("SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin FROM pg_roles WHERE rolname = 'flow_guard'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolcanlogin: true });
    const who = await db.guardPool.query("SELECT current_user AS u");
    expect(who.rows[0].u).toBe("flow_guard");
  });
  it("a role with no grants is denied on every table (read and write)", async () => {
    for (const t of TABLES) {
      expect(await sqlState(db.noGrantPool.query(`SELECT * FROM public.${t} LIMIT 1`)), `select ${t}`).toBe("42501");
      expect(await sqlState(db.noGrantPool.query(`DELETE FROM public.${t}`)), `delete ${t}`).toBe("42501");
    }
  });
  it("anon and authenticated (Supabase) read and write nothing, even though default privileges granted them ALL", async () => {
    for (const role of ["anon", "authenticated"]) {
      const c = await db.adminPool.connect();
      try {
        await c.query(`SET ROLE ${role}`);
        for (const t of TABLES) {
          expect(await sqlState(c.query(`SELECT * FROM public.${t} LIMIT 1`)), `${role} select ${t}`).toBe("42501");
          expect(await sqlState(c.query(`INSERT INTO public.${t} DEFAULT VALUES`)), `${role} insert ${t}`).toBe("42501");
        }
      } finally {
        await c.query("RESET ROLE");
        c.release();
      }
    }
  });
  it("flow_guard has no access to agent_runs, business_members or schema_migrations, and cannot write policies/suppliers/wallets/businesses", async () => {
    for (const t of ["agent_runs", "business_members", "schema_migrations"]) {
      expect(await sqlState(db.guardPool.query(`SELECT * FROM ${t}`)), t).toBe("42501");
    }
    for (const t of ["treasury_policies", "suppliers", "treasury_wallets", "businesses"]) {
      expect(await sqlState(db.guardPool.query(`DELETE FROM public.${t}`)), `delete ${t}`).toBe("42501");
      expect(await sqlState(db.guardPool.query(`INSERT INTO public.${t} DEFAULT VALUES`)), `insert ${t}`).toBe("42501");
    }
    expect(await sqlState(db.guardPool.query("UPDATE treasury_policies SET enabled = false"))).toBe("42501");
    expect(await sqlState(db.guardPool.query("UPDATE treasury_policies SET daily_spend_limit = 999999"))).toBe("42501");
    expect(await sqlState(db.guardPool.query("UPDATE suppliers SET is_approved = true"))).toBe("42501");
  });
  it("flow_guard cannot DELETE or TRUNCATE any table", async () => {
    for (const t of TABLES) {
      expect(await sqlState(db.guardPool.query(`DELETE FROM public.${t}`)), `delete ${t}`).toBe("42501");
      expect(await sqlState(db.guardPool.query(`TRUNCATE public.${t}`)), `truncate ${t}`).toBe("42501");
    }
  });
  it("guard can only update the granted payment columns", async () => {
    expect(await sqlState(db.guardPool.query("UPDATE payments SET amount = 99"))).toBe("42501");
    expect(await sqlState(db.guardPool.query("UPDATE payments SET destination_address = 'rX'"))).toBe("42501");
  });
});

describe("audit log (AL-2, AL-3)", () => {
  it("chains rows, computed by the database, and verifies", async () => {
    const a = await appendAudit(db.guardPool, { business_id: fx.businessId, actor_type: "policy_service", event_type: "payment.requested", entity_type: "payment", entity_id: "p1", metadata: { a: 1 } });
    const b = await appendAudit(db.guardPool, { business_id: fx.businessId, actor_type: "system", event_type: "payment.blocked", entity_type: "payment", entity_id: "p1" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.prev_hash).toBe("0".repeat(64));
    expect(b.prev_hash).toBe(a.row_hash);
    expect(await verifyAuditChain(db.guardPool, fx.businessId)).toBe(true);
  });
  it("ignores caller-supplied chain values", async () => {
    const r = await db.guardPool.query(
      "INSERT INTO audit_events (business_id, seq, prev_hash, row_hash, actor_type, event_type, entity_type, entity_id) VALUES ($1, 999, 'x', 'y', 'system', 'forged.event', 'payment', 'p9') RETURNING seq, prev_hash, row_hash",
      [fx.businessId],
    );
    expect(r.rows[0].seq).toBe("3");
    expect(r.rows[0].row_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyAuditChain(db.guardPool, fx.businessId)).toBe(true);
  });
  it("stays consistent under 20 concurrent appends", async () => {
    const other = await makeBusiness(db.adminPool);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => appendAudit(db.guardPool, { business_id: other.businessId, actor_type: "system", event_type: "load.test", entity_type: "payment", entity_id: `p${String(i)}` })),
    );
    const seqs = await db.adminPool.query<{ seq: string }>("SELECT seq FROM audit_events WHERE business_id = $1 ORDER BY seq", [other.businessId]);
    expect(seqs.rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await verifyAuditChain(db.guardPool, other.businessId)).toBe(true);
  });
  it("flow_guard cannot UPDATE, DELETE or TRUNCATE audit_events", async () => {
    expect(await sqlState(db.guardPool.query("UPDATE audit_events SET event_type = 'x'"))).toBe("42501");
    expect(await sqlState(db.guardPool.query("DELETE FROM audit_events"))).toBe("42501");
    expect(await sqlState(db.guardPool.query("TRUNCATE audit_events"))).toBe("42501");
  });
  it("even the owner/superuser is blocked by the trigger", async () => {
    expect(await sqlState(db.adminPool.query("UPDATE audit_events SET event_type = 'tamper'"))).toBe("55000");
    expect(await sqlState(db.adminPool.query("DELETE FROM audit_events"))).toBe("55000");
    expect(await sqlState(db.adminPool.query("TRUNCATE audit_events"))).toBe("55000");
  });
  it("a tampered row (trigger disabled in this throwaway DB) makes verify_audit_chain fail", async () => {
    const t = await makeBusiness(db.adminPool);
    await appendAudit(db.guardPool, { business_id: t.businessId, actor_type: "system", event_type: "a.b", entity_type: "payment", entity_id: "p1" });
    await appendAudit(db.guardPool, { business_id: t.businessId, actor_type: "system", event_type: "a.c", entity_type: "payment", entity_id: "p1" });
    expect(await verifyAuditChain(db.guardPool, t.businessId)).toBe(true);
    const c = await db.adminPool.connect();
    try {
      await c.query("ALTER TABLE audit_events DISABLE TRIGGER audit_immutable");
      await c.query("UPDATE audit_events SET metadata = '{\"x\":1}'::jsonb WHERE business_id = $1 AND seq = 1", [t.businessId]);
      await c.query("ALTER TABLE audit_events ENABLE TRIGGER audit_immutable");
    } finally {
      c.release();
    }
    expect(await verifyAuditChain(db.guardPool, t.businessId)).toBe(false);
  });
});
