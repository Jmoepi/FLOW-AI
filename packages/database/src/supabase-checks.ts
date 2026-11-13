import type pg from "pg";

/**
 * Read-only verification of a hosted Supabase database (spec 13.1A/13.3). Results carry names, booleans and counts only.
 * Write probes run inside a transaction that is always rolled back.
 */
export interface VerifyResult {
  name: string;
  ok: boolean;
  detail: string;
}

export type AppRole = "flow_guard" | "flow_web";

const PRIVS = "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER";

/** Role name, superuser and BYPASSRLS flags of the connected role (used to prove a pooler login works). */
export async function currentRoleSummary(client: pg.Client): Promise<{ user: string; superuser: boolean; bypassrls: boolean }> {
  const r = await client.query<{ u: string; s: boolean; b: boolean }>("SELECT current_user AS u, r.rolsuper AS s, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user");
  const row = r.rows[0];
  if (row === undefined) throw new Error("current role not found");
  return { user: row.u, superuser: row.s, bypassrls: row.b };
}

async function deniedWrite(c: pg.Client, role: string, label: string, sql: string, out: VerifyResult[]): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query(sql);
    out.push({ name: `${role} denied: ${label}`, ok: false, detail: "statement succeeded" });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "?";
    out.push({ name: `${role} denied: ${label}`, ok: code === "42501", detail: `sqlstate ${code}` });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
  }
}

/** Admin-connection checks: RLS, role attributes, anon/authenticated/PUBLIC access, default ACLs, audit chain objects. */
export async function verifyAdminChecks(admin: pg.Client): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  const add = (name: string, ok: boolean, detail = ""): void => void out.push({ name, ok, detail });
  await admin.query("SET default_transaction_read_only = on");
  const tables = (await admin.query<{ relname: string; en: boolean; fo: boolean }>(
    "SELECT c.relname, c.relrowsecurity AS en, c.relforcerowsecurity AS fo FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1",
  )).rows;
  add("public tables present", tables.length >= 14, `${String(tables.length)} tables`);
  const noRls = tables.filter((t) => !t.en || !t.fo).map((t) => t.relname);
  add("RLS enabled and forced on every public table", noRls.length === 0, noRls.length === 0 ? `${String(tables.length)}/${String(tables.length)}` : noRls.join(","));

  const roles = (await admin.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolcanlogin: boolean }>(
    "SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin FROM pg_roles WHERE rolname IN ('flow_guard','flow_web')",
  )).rows;
  for (const r of ["flow_guard", "flow_web"]) {
    const row = roles.find((x) => x.rolname === r);
    add(`${r} attributes`, row !== undefined && !row.rolsuper && !row.rolbypassrls && !row.rolcreaterole && !row.rolcreatedb && !row.rolreplication && row.rolcanlogin, "login, no super/bypassrls/createrole/createdb/replication");
  }

  for (const role of ["anon", "authenticated"]) {
    const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount === 1;
    if (!exists) {
      add(`${role} has no access (role absent)`, true);
      continue;
    }
    const t = (await admin.query<{ n: string }>(`SELECT count(*) AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind IN ('r','p','v','m','S') AND (has_table_privilege($1, c.oid, '${PRIVS}') OR has_any_column_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))`, [role])).rows[0]?.n;
    add(`${role} has no privilege on any public table/view/sequence`, t === "0", `${String(t)} objects`);
    const f = (await admin.query<{ n: string }>("SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND has_function_privilege($1, p.oid, 'EXECUTE')", [role])).rows[0]?.n;
    add(`${role} cannot EXECUTE any public function`, f === "0", `${String(f)} functions`);
    const s = (await admin.query<{ u: boolean; c: boolean }>("SELECT has_schema_privilege($1, 'public', 'USAGE') AS u, has_schema_privilege($1, 'public', 'CREATE') AS c", [role])).rows[0];
    add(`${role} has no USAGE/CREATE on schema public`, s?.u === false && s.c === false);
  }
  const pub = (await admin.query<{ n: string }>("SELECT count(*) AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a WHERE ns.nspname = 'public' AND a.grantee = 0")).rows[0]?.n;
  add("PUBLIC holds no table privilege in public", pub === "0", `${String(pub)} grants`);
  const pubFn = (await admin.query<{ n: string }>("SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE ns.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'")).rows[0]?.n;
  add("PUBLIC cannot EXECUTE any public function", pubFn === "0", `${String(pubFn)} functions`);
  const defAcl = (await admin.query<{ n: string }>("SELECT count(*) AS n FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a JOIN pg_roles g ON g.oid = a.grantee WHERE g.rolname IN ('anon','authenticated') AND d.defaclnamespace IN (0, 'public'::regnamespace) AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)")).rows[0]?.n;
  add("no default privileges for anon/authenticated on objects the migration role creates in public", defAcl === "0", `${String(defAcl)} default ACL entries`);

  const trg = (await admin.query<{ tgname: string }>("SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.audit_events'::regclass AND NOT tgisinternal")).rows.map((r) => r.tgname).sort();
  add("audit_events has chain, immutability and no-truncate triggers", ["audit_chain", "audit_immutable", "audit_no_truncate"].every((t) => trg.includes(t)), trg.join(","));
  const fn = (await admin.query<{ n: string }>("SELECT count(*) AS n FROM pg_proc WHERE proname IN ('verify_audit_chain','audit_row_hash','audit_chain','audit_immutable') AND pronamespace = 'public'::regnamespace")).rows[0]?.n;
  add("audit chain functions exist", fn === "4", `${String(fn)}/4`);
  const cons = (await admin.query<{ n: string }>("SELECT count(*) AS n FROM pg_constraint WHERE conrelid = 'public.audit_events'::regclass AND contype IN ('p','u','c','f')")).rows[0]?.n;
  add("audit_events has key and check constraints", Number(cons) >= 2, `${String(cons)} constraints`);
  return out;
}

/** Checks run on a connection logged in as the app role itself: no DELETE/TRUNCATE grant and denied writes (rolled back). */
export async function verifyRoleChecks(c: pg.Client, role: AppRole): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  const priv = (await c.query<{ n: string }>("SELECT count(*) AS n FROM information_schema.role_table_grants WHERE grantee = current_user AND table_schema = 'public' AND privilege_type IN ('DELETE','TRUNCATE')")).rows[0]?.n;
  out.push({ name: `${role} holds no DELETE/TRUNCATE grant`, ok: priv === "0", detail: `${String(priv)} grants` });
  await deniedWrite(c, role, "DELETE FROM payments", "DELETE FROM payments", out);
  await deniedWrite(c, role, "TRUNCATE audit_events", "TRUNCATE audit_events", out);
  await deniedWrite(c, role, "UPDATE audit_events", "UPDATE audit_events SET event_type = event_type", out);
  await deniedWrite(c, role, "DELETE FROM audit_events", "DELETE FROM audit_events", out);
  await deniedWrite(c, role, "UPDATE businesses", "UPDATE businesses SET name = name", out);
  await deniedWrite(c, role, "INSERT INTO businesses", "INSERT INTO businesses (name) VALUES ('x')", out);
  await deniedWrite(c, role, "UPDATE treasury_wallets", "UPDATE treasury_wallets SET address = address", out);
  if (role === "flow_web") {
    await deniedWrite(c, role, "INSERT INTO payments", "INSERT INTO payments (id) VALUES (gen_random_uuid())", out);
    await deniedWrite(c, role, "UPDATE payments", "UPDATE payments SET status = status", out);
    await deniedWrite(c, role, "UPDATE invoices (amount)", "UPDATE invoices SET amount = amount", out);
    // Without the tenant setting, RLS must show a web session nothing.
    await c.query("BEGIN");
    const n = (await c.query<{ n: string }>("SELECT (SELECT count(*) FROM invoices) + (SELECT count(*) FROM suppliers) + (SELECT count(*) FROM treasury_policies) AS n")).rows[0]?.n;
    await c.query("ROLLBACK");
    out.push({ name: "flow_web sees no tenant rows without app.business_id", ok: n === "0", detail: `${String(n)} rows` });
  } else {
    await deniedWrite(c, role, "UPDATE treasury_policies", "UPDATE treasury_policies SET updated_at = now()", out);
    await deniedWrite(c, role, "INSERT INTO treasury_policies", "INSERT INTO treasury_policies (business_id) VALUES (gen_random_uuid())", out);
  }
  return out;
}
