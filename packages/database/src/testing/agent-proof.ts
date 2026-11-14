import pg from "pg";
import { localAdminConfig, type LocalDbSecrets } from "../local";
/** Test-only SQL for the agent demo proof (the data-access boundary keeps SQL text inside this package). Never imported by production code. */
export function openLocalAdminPool(secrets: LocalDbSecrets, database: string): pg.Pool {
  const pool = new pg.Pool({ ...localAdminConfig(secrets, database), max: 2 });
  pool.on("error", () => undefined);
  return pool;
}
export async function paymentReplayInputs(admin: pg.Pool, paymentId: string): Promise<{ idempotency_key: string; agent_reason: string | null } | undefined> {
  const r = await admin.query<{ idempotency_key: string; agent_reason: string | null }>("SELECT idempotency_key, agent_reason FROM payments WHERE id = $1", [paymentId]);
  return r.rows[0];
}
export async function invoicePaymentCounts(admin: pg.Pool, invoiceId: string): Promise<{ validated: string; hashed: string; total: string }> {
  const r = await admin.query<{ validated: string; hashed: string; total: string }>(
    "SELECT count(*) FILTER (WHERE status = 'validated')::text AS validated, count(tx_hash)::text AS hashed, count(*)::text AS total FROM payments WHERE invoice_id = $1",
    [invoiceId],
  );
  return r.rows[0] as { validated: string; hashed: string; total: string };
}
export async function runStatusesForPayment(admin: pg.Pool, businessId: string, paymentId: string): Promise<string[]> {
  const r = await admin.query<{ status: string }>("SELECT status FROM agent_runs WHERE business_id = $1 AND payment_id = $2", [businessId, paymentId]);
  return r.rows.map((x) => x.status);
}
export async function auditChainValid(admin: pg.Pool, businessId: string): Promise<boolean> {
  const r = await admin.query<{ ok: boolean }>("SELECT verify_audit_chain($1) AS ok", [businessId]);
  return r.rows[0]?.ok === true;
}
