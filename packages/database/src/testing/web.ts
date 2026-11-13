import type pg from "pg";
/**
 * SQL helpers for the owner web app's integration tests. The data-access boundary (AZ-5) keeps SQL text inside this
 * package, so web tests inspect and sabotage the database through these functions. Test-only: never imported by
 * production code. Run with the superuser test pool (bypasses RLS).
 */
export async function listSessionHashes(admin: pg.Pool): Promise<string[]> {
  const r = await admin.query<{ id_hash: string }>("SELECT id_hash FROM web_sessions ORDER BY created_at");
  return r.rows.map((x) => x.id_hash);
}
export async function sessionRevokedAt(admin: pg.Pool, idHash: string): Promise<Date | null | undefined> {
  const r = await admin.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM web_sessions WHERE id_hash = $1", [idHash]);
  return r.rows[0]?.revoked_at;
}
export async function credentialState(admin: pg.Pool, userId: string): Promise<{ failed_count: number; locked_until: number | null }> {
  const r = await admin.query<{ failed_count: number; locked_until: Date | null }>("SELECT failed_count, locked_until FROM web_credentials WHERE user_id = $1", [userId]);
  const row = r.rows[0];
  return { failed_count: row?.failed_count ?? -1, locked_until: row?.locked_until ? row.locked_until.getTime() : null };
}
export async function storedPasswordHash(admin: pg.Pool, userId: string): Promise<string> {
  const r = await admin.query<{ password_hash: string }>("SELECT password_hash FROM web_credentials WHERE user_id = $1", [userId]);
  return r.rows[0]?.password_hash ?? "";
}
/** Makes every audit insert for `eventType` fail inside the database (to prove the policy write rolls back with it). */
export async function installAuditFailure(admin: pg.Pool, eventType: string): Promise<void> {
  await admin.query(`CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type = ${"'" + eventType.replace(/[^a-z0-9_.]/g, "") + "'"} THEN RAISE EXCEPTION 'forced audit failure'; END IF;
  RETURN NEW;
END $$`);
  await admin.query("DROP TRIGGER IF EXISTS test_fail_audit ON audit_events");
  await admin.query("CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_fail_audit()");
}
export async function removeAuditFailure(admin: pg.Pool): Promise<void> {
  await admin.query("DROP TRIGGER IF EXISTS test_fail_audit ON audit_events");
}
/** SQLSTATE of an attempt to change a policy amount through `pool` ("ok" when it was allowed). Used to prove the guard role cannot. */
export async function policyAmountWriteAttempt(pool: pg.Pool): Promise<string> {
  try {
    await pool.query("UPDATE treasury_policies SET max_payment_amount = 1000000");
    return "ok";
  } catch (err) {
    return typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "error";
  }
}
