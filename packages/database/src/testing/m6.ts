import type pg from "pg";
/**
 * Test-only SQL for the M6 dashboard tests (the data-access boundary keeps SQL text inside this package). Never imported by
 * production code.
 */
export interface RawPayment {
  businessId: string;
  invoiceId: string;
  supplierId: string;
  walletId: string;
  currencyHex: string;
  issuer: string;
  destination: string;
  status: string;
  idempotencyKey: string;
  txHash?: string | null;
  signedBlob?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  agentReason?: string | null;
}
/** Inserts a payment in any state. The state-machine triggers allow only requested/blocked on insert, so they are skipped for this one row. */
export async function insertRawPayment(admin: pg.Pool, p: RawPayment): Promise<string> {
  const c = await admin.connect();
  try {
    await c.query("SET session_replication_role = replica");
    const validated = p.status === "validated";
    const r = await c.query<{ id: string }>(
      `INSERT INTO payments (business_id, invoice_id, supplier_id, wallet_id, network, asset_currency, asset_issuer, amount, destination_address, status, policy_version,
                             idempotency_key, request_hash, business_date, tx_hash, last_ledger_sequence, ledger_index, delivered_amount, validated_at, signed_blob, failure_code, failure_message, agent_reason)
       VALUES ($1,$2,$3,$4,'xrpl-testnet',$5,$6,'1.5',$7,$8,3,$9,$10,current_date,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [p.businessId, p.invoiceId, p.supplierId, p.walletId, p.currencyHex, p.issuer, p.destination, p.status, p.idempotencyKey, "a".repeat(64), p.txHash ?? null, p.txHash ? 100 : null, validated ? 90 : null, validated ? "1.5" : null, validated ? new Date() : null, p.signedBlob ?? null, p.failureCode ?? null, p.failureMessage ?? null, p.agentReason ?? null],
    );
    return r.rows[0]?.id as string;
  } finally {
    await c.query("SET session_replication_role = DEFAULT").catch(() => undefined);
    c.release();
  }
}
export async function setInvoiceStatus(admin: pg.Pool, invoiceId: string, status: string): Promise<void> {
  await admin.query("UPDATE invoices SET status = $2 WHERE id = $1", [invoiceId, status]);
}
export async function insertBalanceSnapshot(admin: pg.Pool, walletId: string, rlusd: string, ageSeconds: number): Promise<void> {
  await admin.query("INSERT INTO balance_snapshots (wallet_id, xrp_balance, rlusd_balance, as_of) VALUES ($1, 100, $2, now() - make_interval(secs => $3))", [walletId, rlusd, ageSeconds]);
}
export async function countAuditEvents(admin: pg.Pool, businessId: string, eventType: string): Promise<number> {
  const r = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND event_type = $2", [businessId, eventType]);
  return r.rows[0]?.n ?? 0;
}
export async function auditActorsForEntity(admin: pg.Pool, entityId: string, eventType: string): Promise<string[]> {
  const r = await admin.query<{ actor_type: string }>("SELECT actor_type FROM audit_events WHERE entity_id = $1 AND event_type = $2", [entityId, eventType]);
  return r.rows.map((x) => x.actor_type);
}
/** Moves every request of the business back in time so it counts as stale. */
export async function ageRunRequests(admin: pg.Pool, businessId: string, minutes: number): Promise<void> {
  await admin.query("UPDATE agent_run_requests SET requested_at = now() - make_interval(mins => $2) WHERE business_id = $1", [businessId, minutes]);
}
export async function resetLoginAttempts(admin: pg.Pool, rows: { keyHash: string; ageDays: number }[]): Promise<void> {
  await admin.query("DELETE FROM login_attempts");
  for (const r of rows) await admin.query("INSERT INTO login_attempts (key_hash, window_start, attempts) VALUES ($1, now() - make_interval(days => $2), 3)", [r.keyHash, r.ageDays]);
}
export async function loginAttemptKeys(admin: pg.Pool): Promise<string[]> {
  const r = await admin.query<{ key_hash: string }>("SELECT key_hash FROM login_attempts ORDER BY key_hash");
  return r.rows.map((x) => x.key_hash);
}
export async function guardCanDeleteLoginAttempts(guard: pg.Pool): Promise<string> {
  try {
    await guard.query("DELETE FROM login_attempts");
    return "ok";
  } catch (err) {
    return (err as { code?: string }).code ?? "error";
  }
}
