import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { TestDatabase } from "./index";
/**
 * SQL helpers for integration tests of the payment guard. The data-access boundary (AZ-5) keeps SQL text inside this
 * package, so guard tests seed, inspect and attack the database through these functions. Test-only: never imported by
 * production code.
 */
export interface ScenarioOptions {
  walletAddress: string;
  supplierAddress: string;
  issuer: string;
  currencyHex: string;
  dailyLimit?: string;
  maxPayment?: string;
  minimumReserve?: string;
  enabled?: boolean;
  /** ISO instant or null for no expiry. */
  validUntil?: string | null;
  supplierApproved?: boolean;
  supplierActive?: boolean;
  /** Default true. When false the policy allows no asset at all. */
  assetAllowed?: boolean;
}
export interface Scenario {
  businessId: string;
  walletId: string;
  supplierId: string;
}
export async function seedScenario(admin: pg.Pool, o: ScenarioOptions): Promise<Scenario> {
  const b = await admin.query<{ id: string }>("INSERT INTO businesses (name) VALUES ($1) RETURNING id", [`it-${randomUUID()}`]);
  const businessId = b.rows[0]?.id as string;
  const w = await admin.query<{ id: string }>(
    "INSERT INTO treasury_wallets (business_id, network, address, asset_currency, asset_issuer) VALUES ($1,'xrpl-testnet',$2,$3,$4) RETURNING id",
    [businessId, o.walletAddress, o.currencyHex, o.issuer],
  );
  const assets = o.assetAllowed === false ? [] : [{ currency: o.currencyHex, issuer: o.issuer }];
  await admin.query(
    `INSERT INTO treasury_policies (business_id, enabled, max_payment_amount, daily_spend_limit, minimum_reserve, allowed_assets, valid_until)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [businessId, o.enabled ?? true, o.maxPayment ?? "2", o.dailyLimit ?? "3", o.minimumReserve ?? "0", JSON.stringify(assets), o.validUntil ?? null],
  );
  const s = await admin.query<{ id: string }>(
    "INSERT INTO suppliers (business_id, name, xrpl_address, country_code, is_approved, is_active) VALUES ($1,'Supplier',$2,'NG',$3,$4) RETURNING id",
    [businessId, o.supplierAddress, o.supplierApproved ?? true, o.supplierActive ?? true],
  );
  return { businessId, walletId: w.rows[0]?.id as string, supplierId: s.rows[0]?.id as string };
}
export interface InvoiceOptions {
  amount?: string;
  description?: string | null;
  status?: "open" | "draft" | "paid" | "cancelled";
  supplierId?: string;
  invoiceNumber?: string;
}
export async function seedInvoice(admin: pg.Pool, s: Scenario, o: InvoiceOptions = {}): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO invoices (business_id, supplier_id, invoice_number, description, amount, issue_date, due_date, status)
     VALUES ($1,$2,$3,$4,$5,current_date,current_date + 30,$6) RETURNING id`,
    [s.businessId, o.supplierId ?? s.supplierId, o.invoiceNumber ?? `INV-${randomUUID()}`, o.description ?? null, o.amount ?? "1", o.status ?? "open"],
  );
  return r.rows[0]?.id as string;
}
export async function seedSupplier(admin: pg.Pool, s: Scenario, address: string): Promise<string> {
  const r = await admin.query<{ id: string }>(
    "INSERT INTO suppliers (business_id, name, xrpl_address, country_code, is_approved) VALUES ($1,'Other',$2,'KE',true) RETURNING id",
    [s.businessId, address],
  );
  return r.rows[0]?.id as string;
}
export async function setSupplierApproval(admin: pg.Pool, supplierId: string, flags: { approved?: boolean; active?: boolean }): Promise<void> {
  await admin.query("UPDATE suppliers SET is_approved = COALESCE($2, is_approved), is_active = COALESCE($3, is_active) WHERE id = $1", [supplierId, flags.approved ?? null, flags.active ?? null]);
}
export async function setPolicyEnabled(admin: pg.Pool, businessId: string, enabled: boolean): Promise<void> {
  await admin.query("UPDATE treasury_policies SET enabled = $2 WHERE business_id = $1", [businessId, enabled]);
}
/** Simulates a legacy/corrupt row: drops the invoice amount CHECK on THIS throwaway database only. */
export async function dropInvoiceAmountCheck(admin: pg.Pool): Promise<void> {
  await admin.query("ALTER TABLE invoices DROP CONSTRAINT invoices_amount_check");
}
/** Back-dates a payment so the sweeper sees it as stale (admin bypass of nothing: only updated_at moves). */
export async function ageUpdatedAt(admin: pg.Pool, paymentId: string, seconds: number): Promise<void> {
  await admin.query("ALTER TABLE payments DISABLE TRIGGER payments_guard_transition");
  try {
    await admin.query("UPDATE payments SET updated_at = now() - make_interval(secs => $2) WHERE id = $1", [paymentId, seconds]);
  } finally {
    await admin.query("ALTER TABLE payments ENABLE TRIGGER payments_guard_transition");
  }
}
export interface TableCounts {
  payments: number;
  reservations: number;
  audit: number;
  invoices: number;
  suppliers: number;
}
export async function tableCounts(admin: pg.Pool): Promise<TableCounts> {
  const r = await admin.query<{ p: string; r: string; a: string; i: string; s: string }>(
    `SELECT (SELECT count(*) FROM payments) AS p, (SELECT count(*) FROM daily_spend_reservations) AS r,
            (SELECT count(*) FROM audit_events) AS a, (SELECT count(*) FROM invoices) AS i, (SELECT count(*) FROM suppliers) AS s`,
  );
  const row = r.rows[0];
  return { payments: Number(row?.p), reservations: Number(row?.r), audit: Number(row?.a), invoices: Number(row?.i), suppliers: Number(row?.s) };
}
/** Sum of reserved + committed holds for a business (what the daily cap bounds). */
export async function heldTotal(admin: pg.Pool, businessId: string): Promise<string> {
  const r = await admin.query<{ t: string }>(
    "SELECT COALESCE(sum(amount), 0)::text AS t FROM daily_spend_reservations WHERE business_id = $1 AND status IN ('reserved','committed')",
    [businessId],
  );
  return r.rows[0]?.t ?? "0";
}
export interface PaymentSummary {
  id: string;
  status: string;
  failure_code: string | null;
  tx_hash: string | null;
  signed_blob_present: boolean;
  fee_drops: string | null;
  result_code: string | null;
  delivered_amount: string | null;
  reservation: string | null;
  invoice_status: string;
}
export async function paymentSummaries(admin: pg.Pool, businessId: string): Promise<PaymentSummary[]> {
  const r = await admin.query<PaymentSummary>(
    `SELECT p.id, p.status, p.failure_code, p.tx_hash, (p.signed_blob IS NOT NULL) AS signed_blob_present,
            p.fee_drops::text AS fee_drops, p.result_code, p.delivered_amount::text AS delivered_amount,
            r.status AS reservation, i.status AS invoice_status
       FROM payments p LEFT JOIN daily_spend_reservations r ON r.payment_id = p.id JOIN invoices i ON i.id = p.invoice_id
      WHERE p.business_id = $1 ORDER BY p.requested_at, p.id`,
    [businessId],
  );
  return r.rows;
}
export async function invoiceStatus(admin: pg.Pool, invoiceId: string): Promise<string> {
  const r = await admin.query<{ status: string }>("SELECT status FROM invoices WHERE id = $1", [invoiceId]);
  return r.rows[0]?.status ?? "missing";
}
export async function auditEventTypes(admin: pg.Pool, paymentId: string): Promise<string[]> {
  const r = await admin.query<{ event_type: string }>("SELECT event_type FROM audit_events WHERE entity_id = $1 ORDER BY created_at, seq", [paymentId]);
  return r.rows.map((x) => x.event_type);
}
/** Whole-database text dump of payments + audit rows, for leak scans. Never returns signed_blob. */
export async function storedTextForLeakScan(admin: pg.Pool): Promise<string> {
  const r = await admin.query<{ t: string }>(
    `SELECT COALESCE(string_agg(row_to_json(a)::text, ' '), '') || ' ' ||
            COALESCE((SELECT string_agg((to_jsonb(p) - 'signed_blob')::text, ' ') FROM payments p), '') || ' ' ||
            COALESCE((SELECT string_agg(to_jsonb(r)::text, ' ') FROM agent_runs r), '') || ' ' ||
            COALESCE((SELECT string_agg(to_jsonb(e)::text, ' ') FROM agent_run_events e), '') AS t
       FROM audit_events a`,
  );
  return r.rows[0]?.t ?? "";
}
/** SQLSTATE of a statement run on `pool` ("ok" if it succeeded, "no-code" for non-database errors). */
async function stateOf(pool: pg.Pool, text: string, values: unknown[] = []): Promise<string> {
  try {
    await pool.query(text, values);
    return "ok";
  } catch (err) {
    return (err as { code?: string }).code ?? "no-code";
  }
}
export type AttackName =
  | "update_audit"
  | "delete_audit"
  | "delete_payment"
  | "illegal_transition"
  | "rewrite_terminal"
  | "change_amount"
  | "update_policy"
  | "update_supplier"
  | "insert_supplier"
  | "read_payments"
  | "read_members"
  | "truncate_audit";
/** Runs one hostile statement on `pool` (the guard's own pool or a no-grant role). Returns the SQLSTATE. */
export async function attack(pool: pg.Pool, name: AttackName, ids: { paymentId?: string; businessId?: string }): Promise<string> {
  const p = ids.paymentId ?? randomUUID();
  const b = ids.businessId ?? randomUUID();
  switch (name) {
    case "update_audit":
      return stateOf(pool, "UPDATE audit_events SET event_type = 'tampered' WHERE business_id = $1", [b]);
    case "delete_audit":
      return stateOf(pool, "DELETE FROM audit_events WHERE business_id = $1", [b]);
    case "delete_payment":
      return stateOf(pool, "DELETE FROM payments WHERE id = $1", [p]);
    case "illegal_transition":
      return stateOf(pool, "UPDATE payments SET status = 'reserved' WHERE id = $1", [p]);
    case "rewrite_terminal":
      return stateOf(pool, "UPDATE payments SET status = 'submitted', tx_hash = $2, last_ledger_sequence = 5 WHERE id = $1", [p, "B".repeat(64)]);
    case "change_amount":
      return stateOf(pool, "UPDATE payments SET amount = 999 WHERE id = $1", [p]);
    case "update_policy":
      return stateOf(pool, "UPDATE treasury_policies SET daily_spend_limit = 999999 WHERE business_id = $1", [b]);
    case "update_supplier":
      return stateOf(pool, "UPDATE suppliers SET xrpl_address = 'rEvilEvilEvilEvilEvilEvilEvilEvil' WHERE business_id = $1", [b]);
    case "insert_supplier":
      return stateOf(pool, "INSERT INTO suppliers (business_id, name, xrpl_address, country_code, is_approved) VALUES ($1,'x','rEvilEvilEvilEvilEvilEvilEvilEvil','NG',true)", [b]);
    case "read_payments":
      return stateOf(pool, "SELECT count(*) FROM public.payments");
    case "read_members":
      return stateOf(pool, "SELECT count(*) FROM public.business_members");
    case "truncate_audit":
      return stateOf(pool, "TRUNCATE audit_events");
  }
}
export type { TestDatabase };
export async function businessIds(admin: pg.Pool): Promise<string[]> {
  const r = await admin.query<{ id: string }>("SELECT id FROM businesses");
  return r.rows.map((x) => x.id);
}
/**
 * Test only: simulates an attacker with owner/superuser access by disabling the immutability trigger in the throwaway
 * database and rewriting one audit row's metadata, so verify_audit_chain must report a break.
 */
export async function tamperAuditRow(admin: pg.Pool, businessId: string, seq = 1): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("ALTER TABLE audit_events DISABLE TRIGGER audit_immutable");
    await c.query("UPDATE audit_events SET metadata = '{\"tampered\":true}'::jsonb WHERE business_id = $1 AND seq = $2", [businessId, seq]);
    await c.query("ALTER TABLE audit_events ENABLE TRIGGER audit_immutable");
  } finally {
    c.release();
  }
}

// Agent run inspection (test-only; admin pool, bypasses RLS).
export interface AgentRunTestRow {
  id: string;
  status: string;
  client_status: string | null;
  payment_id: string | null;
  decision_code: string | null;
  candidate_invoice_id: string | null;
  agent_reason: string | null;
  tool_call_count: number;
}
export async function agentRunRows(admin: pg.Pool, businessId: string): Promise<AgentRunTestRow[]> {
  const r = await admin.query<AgentRunTestRow>(
    "SELECT id, status, client_status, payment_id, decision_code, candidate_invoice_id, agent_reason, tool_call_count FROM agent_runs WHERE business_id = $1 ORDER BY seq",
    [businessId],
  );
  return r.rows;
}
export async function agentRunDetail(admin: pg.Pool, runId: string): Promise<{ agent_reason: string | null; payment_id: string | null; decision_code: string | null }> {
  const r = await admin.query<{ agent_reason: string | null; payment_id: string | null; decision_code: string | null }>("SELECT agent_reason, payment_id, decision_code FROM agent_runs WHERE id = $1", [runId]);
  return r.rows[0] as { agent_reason: string | null; payment_id: string | null; decision_code: string | null };
}
export async function agentRunEventInputs(admin: pg.Pool, runId: string): Promise<Record<string, unknown>[]> {
  const r = await admin.query<{ input: Record<string, unknown> }>("SELECT input FROM agent_run_events WHERE run_id = $1 ORDER BY seq", [runId]);
  return r.rows.map((x) => x.input);
}
export async function auditRowsForEntity(admin: pg.Pool, entityId: string): Promise<{ actor_type: string; event_type: string; metadata: Record<string, unknown> }[]> {
  const r = await admin.query<{ actor_type: string; event_type: string; metadata: Record<string, unknown> }>("SELECT actor_type, event_type, metadata FROM audit_events WHERE entity_id = $1 ORDER BY seq", [entityId]);
  return r.rows;
}
/** Back-dates a running run's last activity so the sweeper sees it as stale. */
export async function ageAgentRun(admin: pg.Pool, runId: string, seconds: number): Promise<void> {
  await admin.query("UPDATE agent_runs SET last_activity_at = now() - make_interval(secs => $2) WHERE id = $1", [runId, seconds]);
}
/** Test-only: a running run for a business, inserted directly (admin pool). Returns its id. */
export async function insertRunningAgentRun(admin: pg.Pool, businessId: string): Promise<string> {
  const r = await admin.query<{ id: string }>("INSERT INTO agent_runs (business_id, status, trigger, mode) VALUES ($1,'running','manual','deterministic') RETURNING id", [businessId]);
  return r.rows[0]?.id as string;
}
/** Test-only: status and client_status as stored. */
export async function agentRunStatusPair(admin: pg.Pool, runId: string): Promise<{ status: string; client_status: string | null } | undefined> {
  const r = await admin.query<{ status: string; client_status: string | null }>("SELECT status, client_status FROM agent_runs WHERE id = $1", [runId]);
  return r.rows[0];
}
/** Test-only: tries to force a status on a run behind the guard's back; resolves with the SQLSTATE (or "ok"). */
export async function forceAgentRunStatus(admin: pg.Pool, runId: string, status: string): Promise<string> {
  return admin.query("UPDATE agent_runs SET status = $2, client_status = $2 WHERE id = $1", [runId, status]).then(() => "ok", (e: { code?: string }) => e.code ?? "unknown");
}
