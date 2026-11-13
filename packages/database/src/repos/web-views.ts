import type { MoneyString } from "@flow-ai/contracts";
import { DbError } from "../errors";
import { iso, isoOrNull, moneyOut, moneyOutOrNull, run, runOne, uuid, type Queryable } from "../db";
/**
 * Read-only views for the owner dashboard (role flow_web, RLS keyed on app.business_id). Explicit column lists only:
 * payments.signed_blob is never selected. Paging is offset based (the tables have no sequence column) and bounded.
 */
export const INVOICE_STATUS_VALUES = ["draft", "open", "processing", "paid", "blocked", "cancelled"] as const;
export const PAYMENT_STATUS_VALUES = ["requested", "blocked", "reserved", "submitted", "pending_confirmation", "validated", "failed", "cancelled"] as const;
function pageArgs(opts: { limit?: number; page?: number }): { limit: number; offset: number } {
  const limit = opts.limit ?? 20;
  const page = opts.page ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new DbError("INVALID_INPUT");
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new DbError("INVALID_INPUT");
  return { limit, offset: (page - 1) * limit };
}
function statusArg(value: string | undefined, allowed: readonly string[]): string | null {
  if (value === undefined) return null;
  if (!allowed.includes(value)) throw new DbError("INVALID_INPUT");
  return value;
}
// ---------------------------------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------------------------------
export interface WebInvoiceRow {
  id: string;
  invoice_number: string;
  description: string | null;
  amount: MoneyString;
  currency: string;
  issue_date: string;
  due_date: string;
  status: string;
  supplier_id: string;
  supplier_name: string;
  supplier_country: string;
  supplier_address: string;
  business_country: string;
  latest_payment_id: string | null;
  latest_payment_status: string | null;
  latest_failure_code: string | null;
}
interface InvoiceDbRow extends Omit<WebInvoiceRow, "amount"> {
  amount: unknown;
}
const INVOICE_SELECT = `SELECT i.id, i.invoice_number, i.description, i.amount, i.currency,
       to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.status,
       s.id AS supplier_id, s.name AS supplier_name, s.country_code AS supplier_country, s.xrpl_address AS supplier_address,
       b.country_code AS business_country,
       lp.id AS latest_payment_id, lp.status AS latest_payment_status, lp.failure_code AS latest_failure_code
  FROM invoices i
  JOIN suppliers s ON s.id = i.supplier_id AND s.business_id = i.business_id
  JOIN businesses b ON b.id = i.business_id
  LEFT JOIN LATERAL (
    SELECT id, status, failure_code FROM payments p WHERE p.invoice_id = i.id AND p.business_id = i.business_id ORDER BY p.requested_at DESC, p.id DESC LIMIT 1
  ) lp ON true`;
const mapInvoice = (r: InvoiceDbRow): WebInvoiceRow => ({ ...r, amount: moneyOut(r.amount) });
/** One extra row is fetched so the caller knows whether another page exists. */
export async function listInvoicesForWeb(q: Queryable, businessId: string, opts: { status?: string; page?: number; limit?: number } = {}): Promise<{ rows: WebInvoiceRow[]; has_more: boolean }> {
  const { limit, offset } = pageArgs(opts);
  const status = statusArg(opts.status, INVOICE_STATUS_VALUES);
  const rows = await run<InvoiceDbRow>(
    q,
    `${INVOICE_SELECT} WHERE i.business_id = $1 AND ($2::text IS NULL OR i.status = $2) ORDER BY i.due_date, i.invoice_number, i.id LIMIT $3 OFFSET $4`,
    [uuid(businessId), status, limit + 1, offset],
  );
  return { rows: rows.slice(0, limit).map(mapInvoice), has_more: rows.length > limit };
}
/** Null for an unknown id or another tenant's id. */
export async function getInvoiceForWeb(q: Queryable, businessId: string, id: string): Promise<WebInvoiceRow | null> {
  const r = await runOne<InvoiceDbRow>(q, `${INVOICE_SELECT} WHERE i.business_id = $1 AND i.id = $2`, [uuid(businessId), uuid(id)]);
  return r ? mapInvoice(r) : null;
}
// ---------------------------------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------------------------------
export interface WebPaymentRow {
  id: string;
  status: string;
  amount: MoneyString;
  asset_currency: string;
  destination_address: string;
  tx_hash: string | null;
  ledger_index: number | null;
  validated_at: string | null;
  delivered_amount: MoneyString | null;
  fee_drops: string | null;
  failure_code: string | null;
  failure_message: string | null;
  policy_version: number;
  agent_reason: string | null;
  requested_at: string;
  invoice_id: string;
  invoice_number: string;
  supplier_name: string;
}
interface PaymentDbRow extends Omit<WebPaymentRow, "amount" | "delivered_amount" | "validated_at" | "requested_at"> {
  amount: unknown;
  delivered_amount: unknown;
  validated_at: unknown;
  requested_at: unknown;
}
const PAYMENT_SELECT = `SELECT p.id, p.status, p.amount, p.asset_currency, p.destination_address, p.tx_hash, p.ledger_index, p.validated_at,
       p.delivered_amount, p.fee_drops::text AS fee_drops, p.failure_code, p.failure_message, p.policy_version, p.agent_reason, p.requested_at,
       i.id AS invoice_id, i.invoice_number, s.name AS supplier_name
  FROM payments p
  JOIN invoices i ON i.id = p.invoice_id AND i.business_id = p.business_id
  JOIN suppliers s ON s.id = p.supplier_id AND s.business_id = p.business_id`;
const mapPayment = (r: PaymentDbRow): WebPaymentRow => ({
  ...r,
  amount: moneyOut(r.amount),
  delivered_amount: moneyOutOrNull(r.delivered_amount),
  validated_at: isoOrNull(r.validated_at),
  requested_at: iso(r.requested_at),
});
export async function listPaymentsForWeb(q: Queryable, businessId: string, opts: { status?: string; page?: number; limit?: number } = {}): Promise<{ rows: WebPaymentRow[]; has_more: boolean }> {
  const { limit, offset } = pageArgs(opts);
  const status = statusArg(opts.status, PAYMENT_STATUS_VALUES);
  const rows = await run<PaymentDbRow>(
    q,
    `${PAYMENT_SELECT} WHERE p.business_id = $1 AND ($2::text IS NULL OR p.status = $2) ORDER BY p.requested_at DESC, p.id DESC LIMIT $3 OFFSET $4`,
    [uuid(businessId), status, limit + 1, offset],
  );
  return { rows: rows.slice(0, limit).map(mapPayment), has_more: rows.length > limit };
}
export async function getPaymentForWeb(q: Queryable, businessId: string, id: string): Promise<WebPaymentRow | null> {
  const r = await runOne<PaymentDbRow>(q, `${PAYMENT_SELECT} WHERE p.business_id = $1 AND p.id = $2`, [uuid(businessId), uuid(id)]);
  return r ? mapPayment(r) : null;
}
// ---------------------------------------------------------------------------------------------------------------------
// Overview extras
// ---------------------------------------------------------------------------------------------------------------------
/** Open invoices by due date, for the Overview queue. */
export async function listInvoiceQueueForWeb(q: Queryable, businessId: string, limit = 5): Promise<WebInvoiceRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new DbError("INVALID_INPUT");
  const rows = await run<InvoiceDbRow>(
    q,
    `${INVOICE_SELECT} WHERE i.business_id = $1 AND i.status IN ('open', 'blocked', 'processing') ORDER BY i.due_date, i.invoice_number, i.id LIMIT $2`,
    [uuid(businessId), limit],
  );
  return rows.map(mapInvoice);
}
/** The newest decision code the payment service stored for this business (blocked payments carry it as failure_code). */
export async function getLatestDecisionCode(q: Queryable, businessId: string): Promise<{ code: string; at: string } | null> {
  const r = await runOne<{ failure_code: string; at: unknown }>(
    q,
    "SELECT failure_code, requested_at AS at FROM payments WHERE business_id = $1 AND failure_code IS NOT NULL ORDER BY requested_at DESC, id DESC LIMIT 1",
    [uuid(businessId)],
  );
  return r ? { code: r.failure_code, at: iso(r.at) } : null;
}
// ---------------------------------------------------------------------------------------------------------------------
// Housekeeping (migration 0009 grants DELETE on login_attempts to flow_web, limited by RLS to old windows)
// ---------------------------------------------------------------------------------------------------------------------
/** Deletes rate-limit windows that started before `before`. The database also refuses anything newer than one day old. */
export async function pruneLoginAttempts(q: Queryable, before: Date): Promise<number> {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) throw new DbError("INVALID_INPUT");
  const rows = await run<{ key_hash: string }>(q, "DELETE FROM login_attempts WHERE window_start < $1 RETURNING key_hash", [before]);
  return rows.length;
}
// ---------------------------------------------------------------------------------------------------------------------
// Owner "Run treasury agent" request queue (migration 0009)
// ---------------------------------------------------------------------------------------------------------------------
export const RUN_REQUEST_TTL_MINUTES = 10;
export interface WebRunRequestRow {
  id: string;
  status: string;
  requested_at: string;
  claimed_at: string | null;
}
/** Web side. A second open request for the same business raises UNIQUE_VIOLATION (one open request per business). */
export async function createAgentRunRequest(q: Queryable, businessId: string, requestedBy: string): Promise<{ id: string }> {
  // A stale open request would block a new one; the web role may only expire such rows (policy web_expire).
  await run(q, `UPDATE agent_run_requests SET status = 'expired' WHERE business_id = $1 AND status = 'open' AND requested_at < now() - make_interval(mins => ${String(RUN_REQUEST_TTL_MINUTES)})`, [uuid(businessId)]);
  const r = await runOne<{ id: string }>(q, "INSERT INTO agent_run_requests (business_id, requested_by) VALUES ($1, $2) RETURNING id", [uuid(businessId), requestedBy.slice(0, 64)]);
  if (!r) throw new DbError("DB_ERROR");
  return r;
}
/** Web side: the newest request and its state, for the Overview panel. */
export async function getLatestAgentRunRequest(q: Queryable, businessId: string): Promise<WebRunRequestRow | null> {
  const r = await runOne<{ id: string; status: string; requested_at: unknown; claimed_at: unknown }>(
    q,
    `SELECT id, CASE WHEN status = 'open' AND requested_at < now() - make_interval(mins => ${String(RUN_REQUEST_TTL_MINUTES)}) THEN 'expired' ELSE status END AS status, requested_at, claimed_at
       FROM agent_run_requests WHERE business_id = $1 ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [uuid(businessId)],
  );
  return r ? { id: r.id, status: r.status, requested_at: iso(r.requested_at), claimed_at: isoOrNull(r.claimed_at) } : null;
}
/**
 * Guard side. Expires stale open requests, then atomically claims the oldest fresh one (FOR UPDATE SKIP LOCKED), so two
 * concurrent claimers can never both win. Returns the request id, or null when nothing is open.
 */
export async function claimAgentRunRequest(q: Queryable, businessId: string): Promise<string | null> {
  const r = await runOne<{ id: string }>(
    q,
    `WITH expired AS (
       UPDATE agent_run_requests SET status = 'expired'
        WHERE business_id = $1 AND status = 'open' AND requested_at < now() - make_interval(mins => ${String(RUN_REQUEST_TTL_MINUTES)}) RETURNING id
     ), pick AS (
       SELECT id FROM agent_run_requests
        WHERE business_id = $1 AND status = 'open' AND requested_at >= now() - make_interval(mins => ${String(RUN_REQUEST_TTL_MINUTES)})
        ORDER BY requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE agent_run_requests r SET status = 'claimed', claimed_at = now() FROM pick WHERE r.id = pick.id RETURNING r.id`,
    [uuid(businessId)],
  );
  return r ? r.id : null;
}
